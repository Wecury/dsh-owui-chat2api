#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
openwebui-chat2api — expose any Open WebUI instance as a local OpenAI-compatible API.

How it works:
  1. Open WebUI keeps its session token in `localStorage` on the site's origin.
  2. On first run this script opens a visible browser window (Playwright, dedicated
     profile) where you sign in once (SSO/username/password). The token is saved
     to `token.json` and reused afterwards — no browser needed for later runs.
  3. A local HTTP server forwards OpenAI-style requests to the instance's native
     `/api/chat/completions` endpoint. Streaming (SSE) and non-streaming are
     both supported, as are Open WebUI API keys (long-lived, preferred over the
     expiring JWT).

Usage:
  python3 chat2api.py --login               # first run: sign in via the browser
  python3 chat2api.py --list-models         # list available models
  python3 chat2api.py                       # start the API server (127.0.0.1:8000)

  # Or provide a token directly (browser DevTools -> Application -> Local Storage)
  python3 chat2api.py --token "eyJ..." --no-browser

OpenAI-compatible endpoints:
  GET  /v1/models             list models
  POST /v1/chat/completions   chat completions (stream=true returns SSE)
  GET  /v1/version            version info

Thinking-level variants:
  For reasoning models served behind vLLM that honour the OpenAI
  `reasoning_effort` parameter, you can register "virtual models" that bake a
  fixed thinking level into the request, e.g.:

    python3 chat2api.py --effort-model reasoning-model-a

  This exposes reasoning-model-a-Fast / -Low / -Medium / -High alongside the base
  model, so any OpenAI client can pick a thinking level by picking a model.
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.parse
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

# Optional token estimator. tiktoken is NOT a hard dependency: users without it
# still get real usage when the upstream returns one, and an `estimated=true`
# row of zeros otherwise. Importing lazily means a missing tiktoken never
# blocks the proxy.
_TIKTOKEN = None
try:
    import tiktoken as _tiktoken_mod  # type: ignore
    _TIKTOKEN = _tiktoken_mod
except Exception:
    _TIKTOKEN = None

# Force UTF-8 on stdout/stderr so printing emojis / non-GBK text (e.g. model
# replies) never raises UnicodeEncodeError on a Windows console stuck on GBK.
for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Default Open WebUI endpoint. Override with --base-url.
BASE_URL = "http://localhost:3000"

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN_FILE = os.path.join(HERE, "token.json")          # NEVER commit this file
PROFILE_DIR = os.path.join(HERE, ".chrome-profile")    # browser profile with login state

# Base models that get thinking-level virtual variants (see docstring).
# You can also add them on the command line with --effort-model.
EFFORT_MODELS: list[str] = []

# Suffix -> OpenAI `reasoning_effort` value. The backend must support the
# parameter (vLLM does); otherwise requests still go through unchanged.
EFFORT_LEVELS = {
    "Fast": "none",     # disable thinking, fastest
    "Low": "low",
    "Medium": "medium",
    "High": "high",
}

CHROME_PATHS = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    # Windows
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]


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
    error       TEXT       NOT NULL DEFAULT ''
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
            " latency_ms, status, is_stream, estimated, error) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
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


def _effort_cache_get(model: str) -> int | None:
    """Cached --auto-effort-probe result: 1 supported, 0 not, None unknown."""
    conn = _usage_db_connect()
    try:
        row = conn.execute("SELECT support FROM effort_probe WHERE model = ?", (model,)).fetchone()
        return int(row["support"]) if row is not None else None
    except Exception:
        return None
    finally:
        conn.close()


def _effort_cache_set(model: str, support: int, err: str = ""):
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
                "latency_ms, status, is_stream, estimated, error "
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
            "  COALESCE(SUM(status != 200),0) AS errors "
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
            "  COALESCE(SUM(status != 200),0) AS errors "
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

_SSE_DATA_RE = re.compile(r"^data:\s*(.+)$", re.DOTALL)


def _extract_usage_block(obj: dict) -> dict | None:
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
    }

    used_upstream = False
    if isinstance(upstream_usage, dict):
        pt = upstream_usage.get("prompt_tokens")
        ct = upstream_usage.get("completion_tokens")
        if isinstance(pt, (int, float)) or isinstance(ct, (int, float)):
            row["in_tokens"] = int(pt or 0)
            row["out_tokens"] = int(ct or 0)
            row["cached_tokens"] = _cached_tokens_from_usage(upstream_usage)
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


class TokenStore:
    """Persist/load the Open WebUI session token."""

    def __init__(self, path: str, url: str):
        self.path = path
        self.url = url

    def load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("url") != self.url:
                return None
            return data
        except Exception:
            return None

    def save(self, token: str, api_key: str = None):
        data = {"url": self.url, "token": token, "api_key": api_key,
                "saved_at": time.strftime("%Y-%m-%d %H:%M:%S")}
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.chmod(self.path, 0o600)
        return data


def find_chrome() -> str | None:
    for p in CHROME_PATHS:
        if os.path.exists(p):
            return p
    return None


def browser_login(base_url: str, profile_dir: str, timeout_s: int) -> str:
    """Open a visible browser window, wait for the user to sign in, then read
    the Open WebUI token from localStorage."""
    from playwright.sync_api import sync_playwright  # lazy import

    chrome = find_chrome()
    print("=" * 60)
    print(f"Opening browser: {base_url}")
    print("Sign in in the window that pops up (skipped if already logged in).")
    print(f"Waiting up to {timeout_s}s for the session token...")
    print("=" * 60)

    with sync_playwright() as p:
        if chrome:
            ctx = p.chromium.launch_persistent_context(
                profile_dir, headless=False, executable_path=chrome)
        else:
            print("No system browser found, using Playwright Chromium "
                  "(run `playwright install chromium` first)")
            ctx = p.chromium.launch_persistent_context(profile_dir, headless=False)

        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            page.goto(base_url, wait_until="domcontentloaded", timeout=30000)
        except Exception as e:
            print(f"[warn] Failed to load page (may still be redirecting): {e}")

        deadline = time.time() + timeout_s
        while time.time() < deadline:
            try:
                token = page.evaluate("localStorage.getItem('token')")
                if token:
                    print("\nSigned in, token acquired.")
                    return token
            except Exception:
                pass
            page.wait_for_timeout(1000)

        raise RuntimeError(
            f"Timed out after {timeout_s}s. Run --login again and complete "
            "the sign-in in the browser window."
        )


def fetch_api_key(base_url: str, token: str) -> str | None:
    """Fetch the existing Open WebUI API key (long-lived, replaces the JWT).

    GET-only on purpose: POST on /api/v1/auths/api_key would *create* a brand
    new key on the instance, and an ordinary login flow should not mint API
    keys the user never asked for. Returns None when none exists yet (the proxy
    then falls back to the JWT token, see Proxy.bearer)."""
    try:
        r = requests.get(
            f"{base_url}/api/v1/auths/api_key",
            headers={"Authorization": f"Bearer {token}"}, timeout=15)
        if r.status_code == 200:
            key = r.json().get("api_key")
            if key:
                print(f"Got Open WebUI API key: {key[:12]}...")
                return key
    except Exception:
        pass
    return None


def authenticate(args, force_browser: bool = False) -> dict:
    """Return {'token': ..., 'api_key': ...}, opening the browser when needed.

    With force_browser (used by --login) the sign-in window always opens: the
    dedicated profile usually still holds the session, so the token is picked up
    within a second; when it expired, the user signs in again right there.
    """
    store = TokenStore(TOKEN_FILE, args.base_url)
    saved = store.load()

    if args.token:
        return {"token": args.token, "api_key": None}

    if saved and saved.get("token") and not force_browser:
        return {"token": saved["token"], "api_key": saved.get("api_key")}

    token = browser_login(args.base_url, args.profile, args.login_timeout)
    api_key = fetch_api_key(args.base_url, token) if args.use_api_key else None
    store.save(token, api_key)
    return {"token": token, "api_key": api_key}


def resolve_effort(requested: str):
    """Map a virtual model id (<base>-<Suffix>) to (base_model, effort|None)."""
    for base in EFFORT_MODELS:
        if requested == base:
            return base, None
        prefix = base + "-"
        if requested.startswith(prefix):
            suffix = requested[len(prefix):]
            if suffix in EFFORT_LEVELS:
                return base, EFFORT_LEVELS[suffix]
    return None, None


# ---------------------------------------------------------------- HTTP server

class Proxy:
    """Holds credentials and forwards requests to the Open WebUI backend."""

    def __init__(self, creds: dict, args):
        self.creds = creds
        self.base_url = args.base_url
        self.models_cache = {"at": 0, "data": None}
        self.args = args
        self.started_at = time.time()
        self._lock = threading.Lock()
        self.errors = deque(maxlen=50)
        self.stats = {
            "chat_requests": 0,
            "stream_requests": 0,
            "errors": 0,
            "last_model": None,
            "last_status": None,
            "last_request_at": 0,
        }

    # ---------- stats / observability (in-memory, thread-safe) ----------
    def _record_chat(self, model: str, stream: bool, status: int):
        # Counts every chat attempt (ok or not) and tracks last_*; error
        # counting + the error ring buffer are handled solely by _record_error.
        with self._lock:
            self.stats["chat_requests"] += 1
            if stream:
                self.stats["stream_requests"] += 1
            self.stats["last_model"] = model
            self.stats["last_status"] = status
            self.stats["last_request_at"] = time.time()

    def _record_error(self, source: str, status, detail: str = ""):
        with self._lock:
            self.stats["errors"] += 1
            self.errors.append({
                "t": time.strftime("%Y-%m-%d %H:%M:%S"),
                "source": source,
                "status": status,
                "detail": (detail or "")[:300],
            })

    def stats_snapshot(self) -> dict:
        with self._lock:
            last_req = self.stats["last_request_at"]
            return {
                "stats": dict(self.stats),
                "recent_errors": list(self.errors),
                "started_at": time.strftime("%Y-%m-%d %H:%M:%S",
                                             time.localtime(self.started_at)),
                "uptime_s": int(time.time() - self.started_at),
                "last_request_at": (time.strftime("%Y-%m-%d %H:%M:%S",
                                                   time.localtime(last_req))
                                    if last_req else None),
            }

    def status_snapshot(self) -> dict:
        # Never expose the token / api_key values, only their presence.
        return {
            "backend": self.base_url,
            "token_present": bool(self.creds.get("token")),
            "api_key_present": bool(self.creds.get("api_key")),
            "started_at": time.strftime("%Y-%m-%d %H:%M:%S",
                                         time.localtime(self.started_at)),
            "uptime_s": int(time.time() - self.started_at),
            "models_cached": len((self.models_cache.get("data") or {}).get("data", []))
                              if self.models_cache.get("data") else 0,
        }

    def bearer(self) -> str:
        # Prefer the API key (does not expire), fall back to the JWT.
        return self.creds.get("api_key") or self.creds["token"]

    def refresh(self) -> bool:
        """Re-run the browser login when the token is rejected."""
        if self.args.no_browser:
            return False
        print("\n[chat2api] Token rejected, trying to re-authenticate...")
        try:
            token = browser_login(self.base_url, self.args.profile, self.args.login_timeout)
        except Exception as e:
            print(f"[chat2api] Re-login failed: {e}")
            return False
        api_key = fetch_api_key(self.base_url, token) if self.args.use_api_key else None
        TokenStore(TOKEN_FILE, self.base_url).save(token, api_key)
        self.creds = {"token": token, "api_key": api_key}
        return True

    def call(self, method: str, path: str, stream: bool = False, **kwargs):
        """Request with a single 401 -> re-auth retry. For streaming endpoints
        you MUST pass stream=True, otherwise requests buffers the whole SSE
        body until the upstream closes the connection."""
        for attempt in (0, 1):
            r = requests.request(
                method, f"{self.base_url}{path}",
                headers={"Authorization": f"Bearer {self.bearer()}",
                         **kwargs.pop("headers", {})},
                timeout=kwargs.pop("timeout", 600), stream=stream, **kwargs)
            if r.status_code == 401 and attempt == 0 and self.refresh():
                continue
            return r
        return r

    def list_models(self, force=False):
        now = time.time()
        if self.models_cache["data"] is None or force or now - self.models_cache["at"] > 60:
            r = self.call("GET", "/api/models")
            if r.status_code == 200:
                self.models_cache = {"at": now, "data": r.json()}
            else:
                self._record_error("list_models", r.status_code, r.text[:200])
        data = self.models_cache["data"]
        if data is None:
            return None
        data = dict(data)
        data["data"] = list(data.get("data", []))
        # Append thinking-level virtual models for each registered base model.
        for base in EFFORT_MODELS:
            src = next((m for m in data["data"] if m.get("id") == base), None)
            for suffix in EFFORT_LEVELS:
                vid = f"{base}-{suffix}"
                if any(m.get("id") == vid for m in data["data"]):
                    continue
                m = dict(src) if src else {}
                m["id"] = vid
                m["name"] = vid
                data["data"].append(m)
        return data

    def _probe_effort(self, model: str) -> tuple[bool, str]:
        """Cheap max_tokens=1 request with reasoning_effort=high; True when the
        backend answers 200. 'Accepts' may mean 'ignores' for some models - this
        only filters out backends that would reject the parameter wholesale."""
        try:
            r = self.call("POST", "/api/chat/completions", json={
                "model": model,
                "messages": [{"role": "user", "content": "p"}],
                "max_tokens": 1,
                "reasoning_effort": "high",
            }, timeout=45)
            if r.status_code == 200:
                return True, ""
            return False, f"HTTP {r.status_code}: {r.text[:160]}"
        except Exception as e:
            return False, str(e)[:160]


def auto_probe_efforts(proxy: "Proxy", force: bool) -> list[str]:
    """Probe the backend's base models for reasoning_effort acceptance and
    return the ids that passed. Results are cached in the usage DB, so 'auto'
    only probes each model once (use force=True to re-probe)."""
    out: list[str] = []
    r = proxy.call("GET", "/api/models")
    if r.status_code != 200:
        print(f"[auto-effort-probe] could not list models (HTTP {r.status_code})",
              file=sys.stderr)
        return out
    base_ids = [m.get("id") for m in (r.json().get("data") or []) if m.get("id")]
    if not base_ids:
        return out
    for m in base_ids:
        if m in EFFORT_MODELS:
            continue  # already registered manually
        cached = None if force else _effort_cache_get(m)
        if cached == 1:
            out.append(m)
            continue
        if cached == 0:
            print(f"[auto-effort-probe] {m}: unsupported (cached)")
            continue
        ok, err = proxy._probe_effort(m)
        _effort_cache_set(m, 1 if ok else 0, err)
        if ok:
            out.append(m)
            print(f"[auto-effort-probe] {m}: accepts reasoning_effort -> variants exposed")
        else:
            print(f"[auto-effort-probe] {m}: rejected ({err})")
    return out


def scan_efforts(proxy: "Proxy", force: bool = False) -> dict[str, bool]:
    """Probe every backend model and return {id: accepts_reasoning_effort}.

    Honors the usage-DB cache unless force=True. Prints no usage rows (the probe
    is a direct upstream call, not a recorded chat)."""
    result: dict[str, bool] = {}
    r = proxy.call("GET", "/api/models")
    if r.status_code != 200:
        raise RuntimeError(f"could not list models (HTTP {r.status_code})")
    for m in r.json().get("data") or []:
        mid = m.get("id")
        if not mid:
            continue
        cached = None if force else _effort_cache_get(mid)
        if cached == 1 or cached == 0:
            result[mid] = bool(cached)
            continue
        ok, err = proxy._probe_effort(mid)
        _effort_cache_set(mid, 1 if ok else 0, err)
        result[mid] = ok
    return result


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # ---------- helpers ----------
    def _json(self, code: int, obj: dict):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, code: int, message: str, detail=None):
        self._json(code, {"error": {"message": message,
                                    "type": "chat2api_error",
                                    "detail": detail}})

    def _html(self, code: int, html: str):
        body = html.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length == 0:
            return {}
        try:
            return json.loads(self.rfile.read(length))
        except Exception:
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ---------- GET ----------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query or "")
        proxy: Proxy = self.server.proxy

        if path in ("/", "/health"):
            models = proxy.list_models()
            n = len(models.get("data", [])) if models else 0
            self._json(200, {"status": "ok", "backend": proxy.base_url,
                             "models": n, "docs": "POST /v1/chat/completions"})
        elif path == "/v1/version":
            r = requests.get(f"{proxy.base_url}/api/version", timeout=15)
            self._json(200, {"openwebui": r.json() if r.status_code == 200 else None,
                             "chat2api": "1.0.0"})
        elif path in ("/v1/models", "/api/models"):
            models = proxy.list_models(force=True)
            if models is None:
                self._error(502, "Failed to fetch model list (auth may have expired)")
                return
            self._json(200, models)
        elif path == "/v1/usage":
            # Token usage aggregates. Range comes from ?range=
            # (today|yesterday|month|cumulative|recent). Defaults to today.
            rng = (qs.get("range") or ["today"])[0]
            if rng == "recent":
                limit_raw = (qs.get("limit") or ["100"])[0]
                try:
                    limit = max(1, min(int(limit_raw), 1000))
                except Exception:
                    limit = 100
                self._json(200, usage_query("recent", limit))
            else:
                if rng not in ("today", "yesterday", "month", "cumulative"):
                    rng = "today"
                self._json(200, usage_query(rng))
        elif path in ("/v1/stats", "/v1/status"):
            # Lightweight observability: usage counters + recent errors / login state.
            # Never exposes the token or api_key values.
            snap = (proxy.stats_snapshot() if path == "/v1/stats"
                    else proxy.status_snapshot())
            snap["docs"] = ("status: token/login state | stats: usage counters "
                            "+ recent errors")
            self._json(200, snap)
        elif path == "/dashboard" or path.startswith("/dashboard/"):
            self._html(200, _render_dashboard_html())
        elif path.startswith("/api/"):
            # Read-only passthrough for other backend endpoints.
            r = proxy.call("GET", path)
            self._passthrough(r)
        else:
            self._error(404, f"Unknown path: {path}")

    # ---------- POST ----------
    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        proxy: Proxy = self.server.proxy

        if path in ("/v1/chat/completions", "/api/chat/completions"):
            self._chat()
        elif path.startswith("/api/"):
            r = proxy.call("POST", path, json=self._read_body())
            self._passthrough(r)
        else:
            self._error(404, f"Unknown path: {path}")

    def _chat(self):
        proxy: Proxy = self.server.proxy
        body = self._read_body()
        if not body.get("messages"):
            self._error(400, "Request body is missing the messages field")
            return

        # Virtual model -> real model + reasoning effort.
        base, effort = resolve_effort(body.get("model") or "")
        if base and effort is not None:
            body = dict(body)
            body["model"] = base
            body["reasoning_effort"] = effort

        stream = bool(body.get("stream"))
        model = body.get("model")
        call_start = time.time()
        r = proxy.call("POST", "/api/chat/completions", json=body, stream=stream)
        latency_ms = int((time.time() - call_start) * 1000)
        if r.status_code != 200:
            proxy._record_chat(model, stream, r.status_code)
            proxy._record_error("chat", r.status_code, r.text[:300])
            # Failed call: still record a usage row so the dashboard can show
            # retried/failed attempts per model, with zero tokens.
            usage_insert(build_usage_row(
                model=model, status=r.status_code, is_stream=stream,
                latency_ms=latency_ms, body=body,
                upstream_usage=None,
                error=f"HTTP {r.status_code}: {r.text[:200]}"))
            r.close()
            self._error(502, "Upstream request failed",
                        f"HTTP {r.status_code}: {r.text[:300]}")
            return

        proxy._record_chat(model, stream, 200)

        if not stream:
            payload = r.json()
            r.close()
            # Extract completion text for the estimation fallback (streaming
            # doesn't have one because we never buffer the whole stream).
            completion_text = ""
            try:
                choices = payload.get("choices") or []
                if choices:
                    msg = choices[0].get("message") or {}
                    completion_text = msg.get("content") or ""
            except Exception:
                pass
            usage_insert(build_usage_row(
                model=model, status=200, is_stream=False,
                latency_ms=latency_ms, body=body,
                upstream_usage=_extract_usage_block(payload),
                completion_text=completion_text))
            self._json(200, payload)
            return

        # Streaming: forward SSE lines as-is. Two gotchas that break strict
        # clients (e.g. the eventsource-parser used by several agents):
        #   1. SSE events MUST be separated by a blank line (\n\n); otherwise
        #      the parser accumulates every `data:` line into one event and the
        #      whole stream fails to parse (silent "empty response").
        #   2. Some upstreams keep the connection alive after [DONE], so we stop
        #      reading at [DONE] and close the downstream connection to give the
        #      client a prompt end-of-stream.
        #
        # While forwarding we also watch each `data: {...}` line for a `usage`
        # field. OpenAI/vLLM put the cumulative snapshot on the final chunk
        # before [DONE]; we keep the last non-null one we saw.
        last_usage: dict | None = None
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            for raw in r.iter_lines(decode_unicode=True):
                if not raw:
                    continue
                self.wfile.write((raw + "\n\n").encode("utf-8"))
                self.wfile.flush()
                if raw.strip() == "data: [DONE]":
                    break
                # Cheap inline usage scan — only attept JSON parse on
                # `data: {...}` lines, never on comments or `data: ` empty.
                if raw.lstrip().startswith("data:") and "{" in raw:
                    m = _SSE_DATA_RE.match(raw.strip())
                    if m:
                        try:
                            chunk = json.loads(m.group(1))
                            u = _extract_usage_block(chunk)
                            if u is not None:
                                last_usage = u
                        except Exception:
                            pass  # not every data: line is JSON; ignore
        except (BrokenPipeError, ConnectionResetError):
            pass  # client disconnected
        finally:
            r.close()
            self.close_connection = True
            usage_insert(build_usage_row(
                model=model, status=200, is_stream=True,
                latency_ms=latency_ms, body=body,
                upstream_usage=last_usage,
                error="" if last_usage is not None else "no-usage-in-stream"))

    def _passthrough(self, r: requests.Response):
        try:
            self.send_response(r.status_code)
            for k, v in r.headers.items():
                if k.lower() in ("content-type", "content-length", "cache-control"):
                    self.send_header(k, v)
            self.end_headers()
            self.wfile.write(r.content)
        except (BrokenPipeError, ConnectionResetError):
            pass


# ---------------------------------------------------------------- dashboard
# A zero-build static page served at GET /dashboard. A ~40-line <script>
# fetches /v1/usage?range=... and renders summary cards, a per-day token bar
# chart (pure SVG, no charting lib), and a per-model table. No external
# libraries, no CDN dependency. Kept here as a single Python string so the
# proxy stays a one-file project.

_DASHBOARD_HTML = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>chat2api · usage dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: light dark; --muted: #888; --accent: #4f7cff; }
  * { box-sizing: border-box; }
  body { font: 14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; margin: 24px;
         max-width: 1100px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: var(--muted); margin-bottom: 20px; }
  .tabs { display: flex; gap: 6px; margin-bottom: 16px; }
  .tabs button { padding: 4px 10px; border: 1px solid #ccc; border-radius: 6px;
                 background: transparent; cursor: pointer; font: inherit; }
  .tabs button.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit,minmax(160px,1fr));
           gap: 12px; margin-bottom: 24px; }
  .card { border: 1px solid #ddd; border-radius: 10px; padding: 14px; }
  .card .v { font-size: 22px; font-weight: 600; }
  .card .l { color: var(--muted); font-size: 12px; margin-top: 2px; }
  section { margin-bottom: 24px; }
  section h2 { font-size: 14px; margin: 0 0 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { padding: 6px 8px; text-align: right; border-bottom: 1px solid #eee; }
  th:first-child, td:first-child { text-align: left; }
  .empty { color: var(--muted); font-style: italic; }
  svg { width: 100%; height: 120px; }
  a { color: var(--accent); }
</style>
</head>
<body>
<h1>chat2api · usage dashboard</h1>
<div class="sub" id="sub">Loading…</div>

<div class="tabs">
  <button data-r="today" class="active">Today</button>
  <button data-r="yesterday">Yesterday</button>
  <button data-r="month">This month</button>
  <button data-r="cumulative">Cumulative</button>
</div>

<div id="report"><span class="empty">Loading…</span></div>

<script>
let currentRange = "today";
const tabs = document.querySelectorAll(".tabs button");
tabs.forEach(b => b.onclick = () => {
  tabs.forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  currentRange = b.dataset.r;
  load();
});

function fmt(n) { return (n||0).toLocaleString(); }

async function load() {
  document.getElementById("sub").textContent = "range: " + currentRange + " · loading…";
  const r = await fetch("/v1/usage?range=" + currentRange);
  const d = await r.json();
  render(d);
}

function render(d) {
  const s = d.summary || {calls:0,in_tokens:0,out_tokens:0,cached_tokens:0,latency_ms:0,errors:0};
  document.getElementById("sub").textContent =
    "range=" + d.range + (d.since ? " · since " + new Date(d.since*1000).toLocaleString() : "");

  const cards = [
    ["Calls", fmt(s.calls)],
    ["Input tokens", fmt(s.in_tokens)],
    ["Output tokens", fmt(s.out_tokens)],
    ["Cached tokens", fmt(s.cached_tokens)],
    ["Avg latency", s.calls ? fmt(Math.round(s.latency_ms/s.calls)) + " ms" : "—"],
    ["Errors", fmt(s.errors)],
  ].map(([l,v]) => `<div class="card"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");

  const maxDay = Math.max(1, ...(d.daily||[]).map(x => (x.in_tokens||0)+(x.out_tokens||0)));
  const bars = (d.daily||[]).map((x,i) => {
    const total = (x.in_tokens||0) + (x.out_tokens||0);
    const h = Math.round(total / maxDay * 88);
    const x0 = 30 + i * Math.min(40, Math.max(8, 800/Math.max(1,d.daily.length) - 4));
    const color = x.out_tokens > x.in_tokens ? "#e86" : "#4f7cff";
    return `<rect x="${x0}" y="${100-h}" width="${Math.min(36, Math.max(6, 800/Math.max(1,d.daily.length) - 8))}" height="${h}" fill="${color}"><title>${x.day}: in ${fmt(x.in_tokens)} / out ${fmt(x.out_tokens)} / cached ${fmt(x.cached_tokens)}</title></rect>`;
  }).join("");
  const chart = d.daily && d.daily.length
    ? `<svg viewBox="0 0 900 110" preserveAspectRatio="xMinYMid meet">${bars}</svg>`
    : `<div class="empty">no data in this range</div>`;

  const rows = (d.per_model||[]).map(m =>
    `<tr><td>${m.model||"—"}</td><td>${fmt(m.calls)}</td><td>${fmt(m.in_tokens)}</td><td>${fmt(m.out_tokens)}</td><td>${fmt(m.cached_tokens)}</td><td>${m.calls ? Math.round(m.latency_ms/m.calls) : 0}</td><td>${fmt(m.errors)}</td></tr>`
  ).join("");
  const table = rows
    ? `<table><thead><tr><th>Model</th><th>Calls</th><th>In</th><th>Out</th><th>Cached</th><th>Avg ms</th><th>Err</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<div class="empty">no calls in this range</div>`;

  document.getElementById("report").innerHTML =
    `<div class="cards">${cards}</div>` +
    `<section><h2>Daily in+out tokens</h2>${chart}</section>` +
    `<section><h2>Per model</h2>${table}</section>`;
}

load();
setInterval(load, 10000); // auto-refresh every 10s
</script>
</body>
</html>
"""


def _render_dashboard_html() -> str:
    """Return the dashboard page. Wrapped in a function so we never interpolate
    user input into the HTML template — the page is fully static and fetches
    data itself via fetch()."""
    return _DASHBOARD_HTML


def _cmd_status(args):
    """Show token/login status (may re-open the browser to re-auth on 401)."""
    store = TokenStore(TOKEN_FILE, args.base_url)
    d = store.load()
    print(f"base_url : {args.base_url}")
    if not d:
        print("token    : NOT saved — run `--login` (or login.bat) first")
        return
    print(f"token    : saved {d.get('saved_at')}  ({'present' if d.get('token') else 'MISSING'})")
    print(f"api_key  : {'present (long-lived)' if d.get('api_key') else 'none (using JWT)'}")
    if not d.get("token"):
        return
    proxy = Proxy({"token": d["token"], "api_key": d.get("api_key")}, args)
    models = proxy.list_models(force=True)
    if models:
        ids = [m.get("id") for m in models.get("data", [])]
        print(f"backend  : reachable, {len(ids)} models")
        print(f"models   : {', '.join(ids)}")
    else:
        print("backend  : unreachable or token expired — re-login needed")


def _cmd_test(args):
    """Send one test chat request and report the result."""
    creds = authenticate(args)
    proxy = Proxy(creds, args)
    models = proxy.list_models(force=True)
    if not models or not models.get("data"):
        print("Failed to fetch models (token may have expired):", file=sys.stderr)
        sys.exit(1)
    mid = models["data"][0]["id"]
    print(f"Testing model: {mid}")
    r = proxy.call("POST", "/api/chat/completions",
                   json={"model": mid, "stream": False,
                         "messages": [{"role": "user", "content": "ping"}]},
                   stream=False)
    print(f"HTTP {r.status_code}")
    if r.status_code == 200:
        try:
            content = r.json()["choices"][0]["message"]["content"]
        except Exception:
            content = r.text
        print("reply:", (content or "").strip()[:200])
    else:
        print("error :", r.text[:300])


def main():
    ap = argparse.ArgumentParser(description="Open WebUI -> local OpenAI-compatible API")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--base-url", default=BASE_URL, help="Open WebUI instance URL")
    ap.add_argument("--token", help="Use this JWT directly instead of browser login")
    ap.add_argument("--no-browser", action="store_true",
                    help="Never open the browser (use with --token; no re-login on 401)")
    ap.add_argument("--profile", default=PROFILE_DIR, help="Chrome user-data directory")
    ap.add_argument("--login-timeout", type=int, default=180,
                    help="Seconds to wait for manual sign-in")
    ap.add_argument("--use-api-key", action="store_true",
                    help="Fetch the long-lived Open WebUI API key after login")
    ap.add_argument("--effort-model", action="append", default=[],
                    help="Register thinking-level variants for this model "
                         "(repeatable; e.g. --effort-model reasoning-model-a)")
    ap.add_argument("--auto-effort-probe", nargs="?", const="auto", default=None,
                    metavar="MODE",
                    help="Probe backend models and auto-register reasoning-level "
                         "variants for those that accept reasoning_effort. "
                         "MODE auto (default) probes each model once and caches "
                         "the result in the usage DB; force re-probes everything.")
    ap.add_argument("--effort-scan", action="store_true",
                    help="Probe models for reasoning_effort acceptance and print "
                         "a JSON {model: accepted} map, then exit (cached; no "
                         "usage rows are recorded)")
    ap.add_argument("--effort-force", action="store_true",
                    help="With --effort-scan, re-probe instead of using cached results")
    ap.add_argument("--login", action="store_true",
                    help="Sign in and save the token, then exit")
    ap.add_argument("--list-models", action="store_true",
                    help="List models and exit")
    ap.add_argument("--status", action="store_true",
                    help="Show token/login status (reads token.json, probes backend) and exit")
    ap.add_argument("--test", action="store_true",
                    help="Send one test chat request and report the result, then exit")
    args = ap.parse_args()
    if args.no_browser and not args.token:
        ap.error("--no-browser requires --token")
    if args.effort_scan and not args.token:
        saved = TokenStore(TOKEN_FILE, args.base_url).load()
        if not saved or not saved.get("token"):
            ap.error("--effort-scan requires a saved token (run --login once) or --token")

    EFFORT_MODELS.extend(args.effort_model)

    if args.status:
        _cmd_status(args)
        return
    if args.test:
        _cmd_test(args)
        return

    if args.login:
        # Always open the sign-in window (unless --no-browser): a saved token is
        # no proof the session is still valid, and clicking "login" means "let me
        # back in". The profile's own session makes this near-instant when valid.
        creds = authenticate(args, force_browser=not args.no_browser)
        print(f"Signed in, token saved to {TOKEN_FILE}")
        return

    creds = authenticate(args)

    proxy = Proxy(creds, args)

    if args.list_models:
        models = proxy.list_models(force=True)
        if models is None:
            print("Failed to fetch models (token may have expired):", file=sys.stderr)
            sys.exit(1)
        print("Available models:")
        for m in models.get("data", []):
            print(f"  - {m['id']}")
        return

    if args.effort_scan:
        try:
            scan = scan_efforts(proxy, force=args.effort_force)
        except Exception as e:
            print(str(e), file=sys.stderr)
            sys.exit(1)
        print(json.dumps(scan, sort_keys=True, separators=(",", ":")))
        return

    if args.auto_effort_probe:
        mode = args.auto_effort_probe
        if mode not in ("auto", "force"):
            mode = "auto"
        auto = auto_probe_efforts(proxy, force=(mode == "force"))
        for m in auto:
            if m not in EFFORT_MODELS:
                EFFORT_MODELS.append(m)
        if auto:
            print(f"[auto-effort-probe] {len(auto)} model(s) accept reasoning_effort: "
                  f"{', '.join(auto)}")
        else:
            print("[auto-effort-probe] no model accepted reasoning_effort")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.proxy = proxy
    models = proxy.list_models()
    n = len(models.get("data", [])) if models else 0
    print("-" * 60)
    print(f"chat2api listening on http://{args.host}:{args.port}")
    print(f"backend: {args.base_url}  |  models: {n}")
    print("  OpenAI-compatible endpoints:")
    print("    GET  /v1/models")
    print("    POST /v1/chat/completions   (stream=true supported)")
    print("    GET  /v1/status   |  GET /v1/stats   (observability)")
    print("    GET  /v1/usage?range=today|month|cumulative|recent")
    print("    GET  /dashboard   (usage UI in your browser)")
    print("  Ctrl+C to exit")
    print("-" * 60)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nBye.")


if __name__ == "__main__":
    main()
