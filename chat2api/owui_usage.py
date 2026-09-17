"""Usage store + token estimation + effort-probe cache for the DSH plugin.

Moved verbatim out of chat2api.py (DSH addition) so the proxy core stays
close to upstream for diffing. Self-contained: SQLite per-call accounting
(usage.db), optional tiktoken estimation, and the effort_probe cache
backing --auto-effort-probe.

The DB location follows the DSH plugin contract: the host passes
DSH_OWUI_USAGE_DB so history lives in <DSH_HOME> and survives plugin
updates and renames; standalone runs (no env var) keep the legacy
in-place usage.db.
"""

import os
import re
import sqlite3
import time

# Optional token estimator. tiktoken is NOT a hard dependency: users without
# it still get real usage when the upstream returns one, and an
# `estimated=true` row of zeros otherwise. Importing lazily means a missing
# tiktoken never blocks the proxy.
_TIKTOKEN = None
try:
    import tiktoken as _tiktoken_mod  # type: ignore
    _TIKTOKEN = _tiktoken_mod
except Exception:
    _TIKTOKEN = None

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------- usage store
# SQLite-backed per-call token accounting. Lives in `usage.db` next to the
# script; chat2api's own private asset, never read by DSH directly (DSH reads
# it through the proxy's `/v1/usage` endpoint). Short-lived connections per
# op keep it thread-safe without an extra lock.

# DSH plugin: the host passes DSH_OWUI_USAGE_DB so history lives in a stable
# location (<DSH_HOME>/dsh-owui-chat2api-usage.db) that survives plugin updates
# and renames. Standalone runs (no env var) keep the legacy in-place path.
USAGE_DB = os.environ.get("DSH_OWUI_USAGE_DB") or os.path.join(HERE, "usage.db")

_USAGE_SCHEMA = """
CREATE TABLE IF NOT EXISTS usage (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          REAL       NOT NULL,            -- unix seconds
    model       TEXT       NOT NULL,
    in_tokens   INTEGER    NOT NULL DEFAULT 0,
    out_tokens  INTEGER    NOT NULL DEFAULT 0,
    cached_tokens INTEGER  NOT NULL DEFAULT 0,
    latency_ms  INTEGER    NOT NULL DEFAULT 0,
    status      INTEGER    NOT NULL,            -- HTTP status (200 on success)
    is_stream   INTEGER    NOT NULL DEFAULT 0,  -- 0/1
    estimated   INTEGER    NOT NULL DEFAULT 0,  -- 1 when usage was not in the
                                                -- upstream response and was
                                                -- zero-filled or estimated
    error       TEXT       NOT NULL DEFAULT '',
    cache_reported INTEGER NOT NULL DEFAULT 0   -- 1 when the upstream response
                                                -- itself carried a cache-token
                                                -- field (cached_tokens or
                                                -- prompt_tokens_details.*), so
                                                -- a cached_tokens of 0 means
                                                -- "no hits" rather than "not
                                                -- tracked". See
                                                -- _cache_reported_from_usage.
);
CREATE INDEX IF NOT EXISTS usage_ts_idx   ON usage(ts);
CREATE INDEX IF NOT EXISTS usage_model_idx ON usage(model);
CREATE TABLE IF NOT EXISTS effort_probe (
    model   TEXT PRIMARY KEY,
    support INTEGER NOT NULL,          -- 1 = backend accepted reasoning_effort, 0 = rejected
    at      REAL    NOT NULL,          -- unix seconds of the probe
    err     TEXT    NOT NULL DEFAULT ''
);
"""


def _usage_db_connect():
    """Open a per-op connection. `check_same_thread=False` is belt-and-braces
    since we open/close within each call, never share a connection."""
    conn = sqlite3.connect(USAGE_DB, timeout=5, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _usage_init():
    """Create the schema once on import / first run."""
    conn = _usage_db_connect()
    try:
        conn.executescript(_USAGE_SCHEMA)
        # Lightweight migration for DBs created before 0.10: same table, new
        # cache_reported column (old rows default to 0 = treated as unknown).
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(usage)")}
        if "cache_reported" not in cols:
            conn.execute(
                "ALTER TABLE usage ADD COLUMN cache_reported INTEGER NOT NULL DEFAULT 0"
            )
        conn.commit()
    finally:
        conn.close()


_usage_init()


_USAGE_INSERT_COUNT = 0  # rows written so far; retention pruning stays occasional


def usage_insert(row: dict):
    global _USAGE_INSERT_COUNT
    _USAGE_INSERT_COUNT += 1
    conn = _usage_db_connect()
    try:
        conn.execute(
            "INSERT INTO usage "
            "(ts, model, in_tokens, out_tokens, cached_tokens, "
            " latency_ms, status, is_stream, estimated, error, cache_reported) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                row["ts"],
                row["model"],
                int(row.get("in_tokens") or 0),
                int(row.get("out_tokens") or 0),
                int(row.get("cached_tokens") or 0),
                int(row.get("latency_ms") or 0),
                int(row.get("status") or 0),
                1 if row.get("is_stream") else 0,
                1 if row.get("estimated") else 0,
                str(row.get("error") or "")[:500],
                1 if row.get("cache_reported") else 0,
            ),
        )
        # Bounded history: occasionally drop rows older than the retention
        # window (env DSH_OWUI_USAGE_RETENTION_DAYS, default 365) so the table
        # cannot grow without bound. Runs every 100 inserts, not per row.
        if _USAGE_INSERT_COUNT % 100 == 0:
            days = int(os.environ.get("DSH_OWUI_USAGE_RETENTION_DAYS", "365"))
            conn.execute("DELETE FROM usage WHERE ts < ?", (time.time() - days * 86400,))
        conn.commit()
    finally:
        conn.close()


def effort_cache_get(model: str) -> int | None:
    """Cached --auto-effort-probe result: 1 supported, 0 not, None unknown."""
    conn = _usage_db_connect()
    try:
        row = conn.execute("SELECT support FROM effort_probe WHERE model = ?", (model,)).fetchone()
        return int(row["support"]) if row is not None else None
    except Exception:
        return None
    finally:
        conn.close()


def effort_cache_set(model: str, support: int, err: str = ""):
    conn = _usage_db_connect()
    try:
        conn.execute(
            "INSERT INTO effort_probe (model, support, at, err) VALUES (?,?,?,?) "
            "ON CONFLICT(model) DO UPDATE SET support = excluded.support, "
            "at = excluded.at, err = excluded.err",
            (model, 1 if support else 0, time.time(), (err or "")[:200]),
        )
        conn.commit()
    except Exception:
        pass
    finally:
        conn.close()


def usage_query(range_kind: str = "today", limit: int = 0) -> dict:
    """Aggregate usage rows for a time range plus per-model breakdown.

    range_kind: 'today' | 'yesterday' | 'month' | 'cumulative' | 'recent'
    limit: when range_kind == 'recent', how many individual rows to return.
    """
    now = time.time()
    today_local = time.localtime(now)
    # local midnight as unix seconds
    midnight = time.mktime(
        time.struct_time(
            (today_local.tm_year, today_local.tm_mon, today_local.tm_mday,
             0, 0, 0, 0, 0, -1)
        )
    )

    params: tuple = ()
    where = ""
    if range_kind == "today":
        where = "WHERE ts >= ?"
        params = (midnight,)
    elif range_kind == "yesterday":
        where = "WHERE ts >= ? AND ts < ?"
        params = (midnight - 86400, midnight)
    elif range_kind == "month":
        # first day of this month, local midnight
        month_start = time.mktime(
            time.struct_time(
                (today_local.tm_year, today_local.tm_mon, 1, 0, 0, 0, 0, 0, -1)
            )
        )
        where = "WHERE ts >= ?"
        params = (month_start,)
    elif range_kind == "recent":
        pass  # no WHERE; returns individual rows below

    conn = _usage_db_connect()
    try:
        if range_kind == "recent":
            rows = conn.execute(
                "SELECT ts, model, in_tokens, out_tokens, cached_tokens, "
                "latency_ms, status, is_stream, estimated, error, cache_reported "
                "FROM usage ORDER BY ts DESC LIMIT ?",
                (int(limit) if limit else 100,),
            ).fetchall()
            return {"range": range_kind, "rows": [dict(r) for r in rows]}

        agg = conn.execute(
            "SELECT "
            "  COUNT(*)                       AS calls, "
            "  COALESCE(SUM(in_tokens),0)     AS in_tokens, "
            "  COALESCE(SUM(out_tokens),0)    AS out_tokens, "
            "  COALESCE(SUM(cached_tokens),0) AS cached_tokens, "
            "  COALESCE(SUM(latency_ms),0)    AS latency_ms, "
            "  COALESCE(SUM(status != 200),0) AS errors, "
            "  COALESCE(SUM(estimated),0)     AS estimated_calls, "
            "  COALESCE(SUM(cache_reported),0) AS cache_reported_calls "
            f"FROM usage {where}",
            params,
        ).fetchone()

        per_model = conn.execute(
            "SELECT model, "
            "  COUNT(*)                       AS calls, "
            "  COALESCE(SUM(in_tokens),0)     AS in_tokens, "
            "  COALESCE(SUM(out_tokens),0)    AS out_tokens, "
            "  COALESCE(SUM(cached_tokens),0) AS cached_tokens, "
            "  COALESCE(SUM(latency_ms),0)    AS latency_ms, "
            "  COALESCE(SUM(status != 200),0) AS errors, "
            "  COALESCE(SUM(estimated),0)     AS estimated_calls, "
            "  COALESCE(SUM(cache_reported),0) AS cache_reported_calls "
            f"FROM usage {where} GROUP BY model ORDER BY calls DESC",
            params,
        ).fetchall()

        # Daily series (local date -> per-day totals) for charts.
        daily = conn.execute(
            "SELECT date(ts, 'unixepoch', 'localtime') AS day, "
            "  COUNT(*)                       AS calls, "
            "  COALESCE(SUM(in_tokens),0)     AS in_tokens, "
            "  COALESCE(SUM(out_tokens),0)    AS out_tokens, "
            "  COALESCE(SUM(cached_tokens),0) AS cached_tokens "
            f"FROM usage {where} GROUP BY day ORDER BY day",
            params,
        ).fetchall()

        return {
            "range": range_kind,
            "since": int(params[0]) if params else None,
            "summary": dict(agg) if agg else None,
            "per_model": [dict(r) for r in per_model],
            "daily": [dict(r) for r in daily],
        }
    finally:
        conn.close()


# ---------------------------------------------- usage parsing (per-call)
# We extract the upstream `usage` object from three positions, in priority:
#   1. final streamed chunk's `usage` field (OpenAI/vLLM cumulative snapshot)
#   2. non-streamed JSON response's `usage` field
#   3. tiktoken estimation on the request messages + completion text
# If none of the above yields anything, we zero-fill and mark `estimated=true`.

SSE_DATA_RE = re.compile(r"^data:\s*(.+)$", re.DOTALL)


def extract_usage_block(obj: dict) -> dict | None:
    """Pull the canonical usage object out of an OpenAI-shaped response body.
    Returns None if no usable usage is present."""
    if not isinstance(obj, dict):
        return None
    usage = obj.get("usage")
    if not isinstance(usage, dict):
        return None
    return usage


def _cached_tokens_from_usage(usage: dict) -> int:
    """vLLM/OpenAI report cache hits in a few shapes; normalise them."""
    if not isinstance(usage, dict):
        return 0
    details = usage.get("prompt_tokens_details")
    if isinstance(details, dict):
        v = details.get("cached_tokens")
        if isinstance(v, (int, float)):
            return int(v)
    # vLLM sometimes flattens it to the top level.
    v = usage.get("cached_tokens")
    if isinstance(v, (int, float)):
        return int(v)
    return 0


def _cache_reported_from_usage(usage: dict) -> int:
    """1 when the upstream response itself carried a cache-token field, so a
    cached_tokens of 0 means "no cache hits" rather than "cache untracked".
    Mirrors _cached_tokens_from_usage's accepted shapes."""
    if not isinstance(usage, dict):
        return 0
    details = usage.get("prompt_tokens_details")
    if isinstance(details, dict) and "cached_tokens" in details:
        return 1
    if "cached_tokens" in usage:
        return 1
    return 0


def _tiktoken_for(model: str):
    """Return an encoder for a model id, tolerate unknown model names by
    falling back to the cl100k/o200k base. Returns None if tiktoken missing."""
    if _TIKTOKEN is None:
        return None
    try:
        return _TIKTOKEN.encoding_for_model(model)
    except Exception:
        try:
            # `o200k_base` covers GPT-4o / o1; `cl100k_base` covers GPT-4/3.5.
            return _TIKTOKEN.get_encoding("o200k_base")
        except Exception:
            try:
                return _TIKTOKEN.get_encoding("cl100k_base")
            except Exception:
                return None


def _stringify_message(msg) -> str:
    """Flatten one chat message to a rough string for tiktoken estimation."""
    if not isinstance(msg, dict):
        return str(msg or "")
    parts = [str(msg.get("role") or "")]
    content = msg.get("content")
    if isinstance(content, str):
        parts.append(content)
    elif isinstance(content, list):
        for c in content:
            if isinstance(c, dict):
                parts.append(str(c.get("text") or c.get("content") or ""))
            else:
                parts.append(str(c))
    if msg.get("name"):
        parts.append(str(msg["name"]))
    return "\n".join(parts)


def _estimate_prompt_tokens(messages, model: str) -> int:
    enc = _tiktoken_for(model)
    if enc is None or not isinstance(messages, list):
        return 0
    total = 0
    try:
        for m in messages:
            total += len(enc.encode(_stringify_message(m)))
        # ~3 per message overhead (role/sep) is a decent rule of thumb.
        total += 3 * len(messages)
    except Exception:
        return 0
    return int(total)


def _estimate_completion_tokens(text: str, model: str) -> int:
    enc = _tiktoken_for(model)
    if enc is None or not text:
        return 0
    try:
        return int(len(enc.encode(text)))
    except Exception:
        return 0


def build_usage_row(
    *,
    model: str,
    status: int,
    is_stream: bool,
    latency_ms: int,
    body: dict,
    upstream_usage: dict | None = None,
    completion_text: str = "",
    error: str = "",
) -> dict:
    """Compose one usage row from everything we know about a call.

    `upstream_usage` is the parsed `usage` object (streamed chunk or
    non-streamed body); may be None on the no-usage branch.
    `completion_text` is only used by the estimation fallback path; for
    streaming we don't buffer the whole completion, so that estimate stays 0.
    """
    row = {
        "ts": time.time(),
        "model": model or "",
        "in_tokens": 0,
        "out_tokens": 0,
        "cached_tokens": 0,
        "latency_ms": int(latency_ms or 0),
        "status": int(status or 0),
        "is_stream": bool(is_stream),
        "estimated": False,
        "error": error or "",
        "cache_reported": 0,
    }

    used_upstream = False
    if isinstance(upstream_usage, dict):
        pt = upstream_usage.get("prompt_tokens")
        ct = upstream_usage.get("completion_tokens")
        if isinstance(pt, (int, float)) or isinstance(ct, (int, float)):
            row["in_tokens"] = int(pt or 0)
            row["out_tokens"] = int(ct or 0)
            row["cached_tokens"] = _cached_tokens_from_usage(upstream_usage)
            row["cache_reported"] = _cache_reported_from_usage(upstream_usage)
            used_upstream = True

    if not used_upstream and status == 200:
        # Estimation fallback: only about the prompt (we never buffer the
        # whole streamed completion; for non-stream we have completion_text).
        messages = body.get("messages") if isinstance(body, dict) else None
        est_in = _estimate_prompt_tokens(messages, model)
        est_out = _estimate_completion_tokens(completion_text, model)
        row["in_tokens"] = est_in
        row["out_tokens"] = est_out
        row["estimated"] = True
    elif not used_upstream and status != 200:
        # Failed call: nothing to estimate, leave zeros, mark estimated=false.
        row["estimated"] = False

    return row

