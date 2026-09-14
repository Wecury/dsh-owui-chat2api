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
import sys
import threading
import time
import urllib.parse
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests
# Usage store, token estimation and the effort-probe cache live in a
# sibling module (DSH addition) so this file stays close to upstream's
# proxy core for diffing.
from owui_usage import (SSE_DATA_RE, build_usage_row, effort_cache_get,
                        effort_cache_set, extract_usage_block, usage_insert,
                        usage_query)


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
# The session token is a live Open WebUI JWT. When the DSH plugin drives us, it
# points at <DSH_HOME>/dsh-owui-chat2api-token.json so the credential never
# lives inside the plugin/version directory (which is swapped on upgrade and can
# otherwise leak into a packed tarball). Standalone runs keep the legacy
# ./token.json next to this file.
TOKEN_FILE = os.environ.get("DSH_OWUI_TOKEN_FILE") or os.path.join(HERE, "token.json")
PROFILE_DIR = os.path.join(HERE, ".chrome-profile")    # browser profile with login state


def _migrate_legacy_token() -> None:
    """DSH installs: move a leftover bundle-dir token.json into <DSH_HOME> once,
    so the plugin directory ends up credential-free. No-op for standalone runs."""
    target = TOKEN_FILE
    if not os.environ.get("DSH_OWUI_TOKEN_FILE"):
        return
    legacy = os.path.join(HERE, "token.json")
    if target == legacy or os.path.exists(target) or not os.path.exists(legacy):
        return
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(legacy, "r", encoding="utf-8") as f:
            data = f.read()
        with open(target, "w", encoding="utf-8") as f:
            f.write(data)
        try:
            os.chmod(target, 0o600)
        except Exception:
            pass
        os.remove(legacy)
        print("[chat2api] migrated token out of the plugin dir to",
              target, file=sys.stderr)
    except Exception:
        pass


_migrate_legacy_token()

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


def _token_state(base_url: str, token: str) -> str:
    """Classify a token: 'ok' (accepted), 'stale' (401/403), 'retry' (unknown)."""
    try:
        r = requests.get(f"{base_url}/api/models",
                         headers={"Authorization": f"Bearer {token}"}, timeout=15)
        if r.status_code == 200:
            return "ok"
        if r.status_code in (401, 403):
            return "stale"
        return "retry"
    except Exception:
        return "retry"


def browser_login(base_url: str, profile_dir: str, timeout_s: int) -> str:
    """Open a visible browser window and wait for a *valid* session token.

    A token sitting in localStorage is not proof it still works, so each
    candidate is checked against the backend. A stale/revoked token is cleared
    and the page reloaded to force a real sign-in; the window stays open until a
    token the backend actually accepts appears (or the timeout hits).
    """
    from playwright.sync_api import sync_playwright  # lazy import

    chrome = find_chrome()
    print("=" * 60)
    print(f"Opening browser: {base_url}")
    print("Sign in in the window that pops up (skipped if already logged in).")
    print(f"Waiting up to {timeout_s}s for a valid session token...")
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
        last_reload = 0.0
        while time.time() < deadline:
            try:
                token = page.evaluate("localStorage.getItem('token')")
            except Exception:
                token = None
            if token:
                state = _token_state(base_url, token)
                if state == "ok":
                    print("\nSigned in, token acquired.")
                    return token
                if state == "stale":
                    print("\n[login] existing token was rejected - clearing it "
                          "and reloading for a fresh sign-in...")
                    try:
                        page.evaluate("localStorage.removeItem('token')")
                    except Exception:
                        pass
                    if time.time() - last_reload > 5:
                        last_reload = time.time()
                        try:
                            page.goto(base_url, wait_until="domcontentloaded",
                                      timeout=30000)
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

    Saved credentials are validated at startup (ported from upstream fix
    32df4a5) so a revoked token cannot boot the proxy into a silent 401 loop:
    a definitely rejected credential falls back to the sign-in window just
    like a missing one. When the backend cannot be reached at all, the saved
    credential is kept — a transient outage must not kill autostart; the
    proxy reports 401/5xx per request until the backend is back.
    """
    store = TokenStore(TOKEN_FILE, args.base_url)
    saved = store.load()

    if args.token:
        return {"token": args.token, "api_key": None}

    if saved and (saved.get("api_key") or saved.get("token")) and not force_browser:
        bearer = saved.get("api_key") or saved.get("token")
        state = _token_state(args.base_url, bearer)
        if state == "ok":
            return {"token": saved.get("token"), "api_key": saved.get("api_key")}
        if state == "stale":
            print(f"[chat2api] Saved credentials rejected by {args.base_url}, "
                  "opening the sign-in window...")
        # state == 'retry' (backend unreachable): keep the saved credential and
        # start serving anyway — the backend may just be restarting.

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
    only probes each model once (use force=True to re-probe). Uncached models
    are probed concurrently so a large backend doesn't stall for minutes."""
    out: list[str] = []
    r = proxy.call("GET", "/api/models")
    if r.status_code != 200:
        print(f"[auto-effort-probe] could not list models (HTTP {r.status_code})",
              file=sys.stderr)
        return out
    base_ids = [m.get("id") for m in (r.json().get("data") or []) if m.get("id")]
    if not base_ids:
        return out
    pending: list[str] = []
    for m in base_ids:
        if m in EFFORT_MODELS:
            continue  # already registered manually
        cached = None if force else effort_cache_get(m)
        if cached == 1:
            out.append(m)
            continue
        if cached == 0:
            print(f"[auto-effort-probe] {m}: unsupported (cached)")
            continue
        pending.append(m)

    from concurrent.futures import ThreadPoolExecutor

    def probe(m: str) -> tuple[str, bool, str]:
        ok, err = proxy._probe_effort(m)
        effort_cache_set(m, 1 if ok else 0, err)
        return m, ok, err

    with ThreadPoolExecutor(max_workers=8) as ex:
        for m, ok, err in ex.map(probe, pending):  # preserves input order
            if ok:
                out.append(m)
                print(f"[auto-effort-probe] {m}: accepts reasoning_effort -> variants exposed")
            else:
                print(f"[auto-effort-probe] {m}: rejected ({err})")
    return out


def scan_efforts(proxy: "Proxy", force: bool = False) -> dict[str, bool]:
    """Probe every backend model and return {id: accepts_reasoning_effort}.

    Honors the usage-DB cache unless force=True. Uncached models are probed
    concurrently (a probe can take up to ~45s, so a serial walk would blow past
    the host's spawn timeout once there are more than two unknowns). Prints no
    usage rows (the probe is a direct upstream call, not a recorded chat)."""
    result: dict[str, bool] = {}
    r = proxy.call("GET", "/api/models")
    if r.status_code != 200:
        raise RuntimeError(f"could not list models (HTTP {r.status_code})")
    uncached: list[str] = []
    for m in r.json().get("data") or []:
        mid = m.get("id")
        if not mid:
            continue
        cached = None if force else effort_cache_get(mid)
        if cached == 1 or cached == 0:
            result[mid] = bool(cached)
            continue
        uncached.append(mid)

    from concurrent.futures import ThreadPoolExecutor

    def probe(mid: str) -> tuple[str, bool]:
        ok, err = proxy._probe_effort(mid)
        effort_cache_set(mid, 1 if ok else 0, err)
        return mid, ok

    with ThreadPoolExecutor(max_workers=8) as ex:
        for mid, ok in ex.map(probe, uncached):  # preserves input order
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
        if length > 8 * 1024 * 1024:  # refuse oversized bodies before reading
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
        if stream and not body.get("stream_options"):
            # DSH addition (borrowed from the author's openwebui-console):
            # streamed replies often carry no usage block unless the client
            # asks for one, and the usage DB would have to fall back to
            # estimates. Clients that set their own stream_options win.
            body["stream_options"] = {"include_usage": True}
        model = body.get("model")
        call_start = time.time()
        try:
            r = proxy.call("POST", "/api/chat/completions", json=body, stream=stream)
        except Exception as e:
            # Upstream unreachable or hung (connect failure / read timeout):
            # answer cleanly instead of letting the handler die with the
            # connection unanswered - otherwise every retry just looks like
            # "no response".
            latency_ms = int((time.time() - call_start) * 1000)
            proxy._record_error("chat", 0, f"{type(e).__name__}: {str(e)[:300]}")
            usage_insert(build_usage_row(
                model=model, status=0, is_stream=stream,
                latency_ms=latency_ms, body=body,
                upstream_usage=None, error=f"{type(e).__name__}: {str(e)[:200]}"))
            self._error(502, "Upstream request failed",
                        f"{type(e).__name__}: {str(e)[:300]}")
            return
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
                upstream_usage=extract_usage_block(payload),
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
        saw_done = False
        last_finish_reason: str | None = None
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
                    saw_done = True
                    break
                # Cheap inline usage scan — only attempt JSON parse on
                # `data: {...}` lines, never on comments or `data: ` empty.
                if raw.lstrip().startswith("data:") and "{" in raw:
                    m = SSE_DATA_RE.match(raw.strip())
                    if m:
                        try:
                            chunk = json.loads(m.group(1))
                            u = extract_usage_block(chunk)
                            if u is not None:
                                last_usage = u
                            try:
                                fr = (chunk.get("choices") or [{}])[0].get("finish_reason")
                                if fr:
                                    last_finish_reason = fr
                            except Exception:
                                pass
                        except Exception:
                            pass  # not every data: line is JSON; ignore
        except (BrokenPipeError, ConnectionResetError,
                requests.exceptions.RequestException):
            pass  # client disconnected, or the upstream stream was cut mid-read
        finally:
            # Long upstream responses (big context, long generations) are
            # sometimes cut by an idle/stream timeout before the terminal
            # `data: [DONE]` — or even before the chunk carrying finish_reason.
            # Closing the downstream connection right there makes strict clients
            # fail with "Stream ended without finish_reason". So end the stream
            # gracefully instead: repeat a final chunk with the finish_reason
            # we saw (or "stop") plus any usage, then emit [DONE].
            if not saw_done:
                try:
                    if not last_finish_reason:
                        self.wfile.write(("data: " + json.dumps({
                            "id": "chatcmpl-" + str(int(time.time() * 1000)),
                            "object": "chat.completion.chunk",
                            "created": int(time.time()),
                            "model": model,
                            "choices": [{"index": 0, "delta": {},
                                         "finish_reason": "stop"}],
                            "usage": last_usage,
                        }) + "\n\n").encode("utf-8"))
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
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
# A zero-build static page served at GET /dashboard. Lives in dashboard.html
# next to this script (read once, then cached) so the HTML/JS/CSS get real
# syntax highlighting and lint instead of living inside a python string. The
# page is fully static and fetches data itself via fetch().

_DASHBOARD_CACHE = None


def _render_dashboard_html() -> str:
    """Return the bundled dashboard page (dashboard.html beside this script)."""
    global _DASHBOARD_CACHE
    if _DASHBOARD_CACHE is None:
        with open(os.path.join(HERE, "dashboard.html"), "r", encoding="utf-8") as f:
            _DASHBOARD_CACHE = f.read()
    return _DASHBOARD_CACHE
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
