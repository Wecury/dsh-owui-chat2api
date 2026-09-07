// lib/proxy-process.js - chat2api.py subprocess lifecycle (HOST half).
//
// Owns the python child: proxy start/stop, the one-shot login flow and its
// result bookkeeping, the trimmed process-log tail, and the curated env
// whitelist the vendored third-party child is allowed to see. Split out of
// index.js (refactor step 5); behaviour is unchanged.
//
// Invariant carried over from index.js: starting/login never blocks a web
// handler - when the cached python/deps probe is stale the work is deferred
// to a setImmediate and the panel converges through its normal status poll.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { CHAT2API_DIR, DSH_HOME, baseUrlUnset, loadConfig, resolveDir } from './config.js'
import { diag, diagReady, probe } from './diagnostics.js'

// Usage history lives OUTSIDE the plugin dir (which can change on updates/renames),
// so cumulative stats survive every restart and upgrade. chat2api.py honours this
// via the DSH_OWUI_USAGE_DB env var (falling back to its local usage.db standalone).
const USAGE_DB_PATH = path.join(DSH_HOME, 'dsh-owui-chat2api-usage.db')
// Same idea as the usage DB: the Open WebUI JWT never lives inside the plugin
// (version-swappable, packable) dir. chat2api.py honours DSH_OWUI_TOKEN_FILE and
// migrates a legacy bundle->token.json here on first run.
const TOKEN_FILE_PATH = path.join(DSH_HOME, 'dsh-owui-chat2api-token.json')
const LOG_MAX = 80

let handle = null
export const logTail = []
export const runtimeStatus = { state: 'stopped', startedAt: 0, exitCode: null, signal: null, message: '' }

// Login flow bookkeeping: the subprocess is async (opens a browser, waits for
// the user), so the panel learns the final result by polling /api/status.
// Success = the login process exited with code 0 AND rewrote the token file
// after this attempt started (chat2api.py only saves on a real sign-in).
export const loginState = { running: false, startedAt: 0, tokenBefore: 0, result: '', resultAt: 0, message: '' }

export function pushLog(line) {
  const s = String(line || '').trim()
  if (!s) return
  logTail.push(s)
  if (logTail.length > LOG_MAX) logTail.splice(0, logTail.length - LOG_MAX)
}

// Minimal, curated env for the python child: deliberately NOT the whole
// process.env (DSH may hold API keys/tokens for other services that a vendored
// third-party proxy must not see). Only what python/playwright need on Windows,
// plus our own usage-db pointer and UTF-8 output.
export function childEnv() {
  const pick = (k, d = '') => (process.env[k] !== undefined ? process.env[k] : d)
  return {
    PATH: pick('PATH'), SYSTEMROOT: pick('SYSTEMROOT'), ComSpec: pick('ComSpec'),
    PATHEXT: pick('PATHEXT'), HOMEDRIVE: pick('HOMEDRIVE'), HOMEPATH: pick('HOMEPATH'),
    USERPROFILE: pick('USERPROFILE'), LOCALAPPDATA: pick('LOCALAPPDATA'),
    APPDATA: pick('APPDATA'), TEMP: pick('TEMP'), TMP: pick('TMP'), LANG: pick('LANG'),
    PYTHONIOENCODING: 'utf-8',
    DSH_OWUI_USAGE_DB: USAGE_DB_PATH,
    DSH_OWUI_TOKEN_FILE: TOKEN_FILE_PATH,
  }
}

export function isRunning() { return !!handle }

// Plugin teardown: kill the python child if one is alive.
export function shutdown() {
  if (handle) { try { handle.kill() } catch (e) {} handle = null }
}

// Launch chat2api.py without ever blocking a web handler: when the cached
// python/deps result is fresh and healthy we spawn immediately; otherwise the
// probe (up to ~27s worst case) is deferred to a setImmediate and the panel
// picks up the final state through its normal poll.
export function startImpl() {
  if (handle) return { ok: false, message: 'chat2api is already running' }
  const cfg = loadConfig()
  if (baseUrlUnset(cfg)) return { ok: false, message: 'baseUrl is not set - set your Open WebUI URL in the panel first' }
  const dir = resolveDir(cfg)
  if (!fs.existsSync(path.join(dir, 'chat2api.py'))) {
    return { ok: false, message: 'chat2api.py not found in ' + dir }
  }
  const launch = () => {
    if (handle) return
    if (diag.python === 'ok' && diag.deps === 'ok') {
      const r = spawnProxy(cfg, dir)
      if (!r.ok && !handle) runtimeStatus.message = r.message
    } else {
      runtimeStatus.state = 'stopped'
      runtimeStatus.message = 'start skipped: ' + diag.message
    }
  }
  if (diagReady()) {
    launch()
    return { ok: true }
  }
  setImmediate(() => { try { probe(true); launch() } catch (e) { pushLog('[start] ' + String((e && e.message) || e)) } })
  return { ok: true, message: 'starting - checking python/deps in background …', async: true }
}

function spawnProxy(cfg, dir) {
  try {
    const child = spawn(diag.pythonPath, [
      'chat2api.py',
      '--base-url', String(cfg.baseUrl).trim(),
      '--host', String(cfg.host || '127.0.0.1').trim(),
      '--port', String(cfg.port || 8000),
    ], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() })
    handle = child
    runtimeStatus.state = 'running'
    runtimeStatus.startedAt = Date.now()
    runtimeStatus.exitCode = null
    runtimeStatus.signal = null
    runtimeStatus.message = ''
    const onData = (b) => { for (const line of String(b).split(/\r?\n/)) pushLog(line) }
    try { if (child.stdout) child.stdout.on('data', onData) } catch (e) {}
    try { if (child.stderr) child.stderr.on('data', onData) } catch (e) {}
    child.on('exit', (code, sig) => {
      if (handle !== child) return
      handle = null
      runtimeStatus.state = 'exited'
      runtimeStatus.exitCode = code
      runtimeStatus.signal = sig
      runtimeStatus.message = 'process exited'
    })
    child.on('error', (err) => {
      if (handle !== child) return
      handle = null
      runtimeStatus.state = 'crashed'
      runtimeStatus.message = String((err && err.message) || err)
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, message: 'spawn failed: ' + String((e && e.message) || e) }
  }
}

export function stopImpl() {
  const child = handle
  if (!child) return { ok: false, message: 'chat2api is not running' }
  try { child.kill() } catch (e) { /* already gone */ }
  if (handle === child) handle = null
  runtimeStatus.state = 'stopped'
  runtimeStatus.message = 'stopped by user'
  runtimeStatus.exitCode = null
  runtimeStatus.signal = null
  return { ok: true }
}

export function loginImpl() {
  const cfg = loadConfig()
  if (baseUrlUnset(cfg)) return { ok: false, message: 'baseUrl is not set - set your Open WebUI URL in the panel first' }
  const dir = resolveDir(cfg)
  if (!fs.existsSync(path.join(dir, 'chat2api.py'))) {
    return { ok: false, message: 'chat2api.py not found in ' + dir }
  }
  if (loginState.running) return { ok: false, message: 'a login flow is already running' }
  if (diagReady()) return spawnLogin(cfg, dir)
  setImmediate(() => { try {
    probe(true)
    if (diag.python === 'ok' && diag.deps === 'ok') spawnLogin(cfg, dir)
    else loginFailed('python/deps unavailable - login did not start')
  } catch (e) { loginFailed('login deferred start failed: ' + String((e && e.message) || e)) } })
  return { ok: true, message: 'login starting - checking python/deps …', async: true }
}

function tokenMtime() {
  try { return fs.statSync(TOKEN_FILE_PATH).mtimeMs } catch (e) { return 0 }
}

function loginFailed(message) {
  loginState.running = false
  loginState.result = 'fail'
  loginState.resultAt = Date.now()
  loginState.message = message
  pushLog('[login] ' + message)
}

function spawnLogin(cfg, dir) {
  try {
    const child = spawn(diag.pythonPath, [
      'chat2api.py', '--login',
      '--base-url', String(cfg.baseUrl).trim(),
      '--use-api-key', // prefer the long-lived key when one exists (JWTs expire)
      '--login-timeout', '240',
    ], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() })
    loginState.running = true
    loginState.startedAt = Date.now()
    loginState.tokenBefore = tokenMtime()
    loginState.result = ''
    loginState.resultAt = 0
    loginState.message = ''
    const onData = (b) => { for (const line of String(b).split(/\r?\n/)) pushLog(line) }
    try { if (child.stdout) child.stdout.on('data', onData) } catch (e) {}
    try { if (child.stderr) child.stderr.on('data', onData) } catch (e) {}
    child.on('exit', (code) => {
      const saved = tokenMtime() > loginState.tokenBefore
      loginState.running = false
      loginState.result = (code === 0 && saved) ? 'ok' : 'fail'
      loginState.resultAt = Date.now()
      loginState.message = loginState.result === 'ok'
        ? 'token saved'
        : (code === 0 ? 'finished without saving a new token' : 'login exited with code ' + code)
      pushLog('[login] ' + loginState.message)
    })
    child.on('error', (err) => {
      loginState.running = false
      loginState.result = 'fail'
      loginState.resultAt = Date.now()
      loginState.message = 'login spawn error: ' + String((err && err.message) || err)
      pushLog('[login] ' + loginState.message)
    })
    pushLog('[login] browser opening - sign in to Open WebUI ...')
    return { ok: true, message: 'login flow started - complete it in the browser window' }
  } catch (e) {
    return { ok: false, message: 'login spawn failed: ' + String((e && e.message) || e) }
  }
}
