// lib/proxy-process.js - chat2api.py subprocess lifecycle (HOST half).
//
// Owns the python child: proxy start/stop, the one-shot login flow and its
// result bookkeeping, the trimmed process-log tail, and the curated env
// whitelist the vendored third-party child is allowed to see. Split out of
// index.js (refactor step 5); behaviour is unchanged.
//
// Invariant carried over from index.js: starting/login never blocks a web
// handler - when the cached python/deps probe is stale the async probe runs in
// the background and the panel converges through its normal status poll.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { CHAT2API_DIR, DSH_HOME, baseUrlUnset, loadConfig, resolveDir } from './config.js'
import { diag, diagReady, probe } from './diagnostics.js'
import { chat2apiPids, killTree, killTreeSync, portOpen, reapStragglers, waitGone } from './process-kill.js'

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
// The child a Stop is currently tearing down: its 'exit' event must not overwrite
// the "stopped by user" state with "exited".
let stopping = null
// True from the moment startImpl begins (its reap runs before the spawn): reconcile
// must not label that window 'orphaned', or the panel would briefly show a leftover
// that is already being replaced.
let starting = false
export const logTail = []
export const runtimeStatus = { state: 'stopped', startedAt: 0, exitCode: null, signal: null, message: '', pid: null }

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

// Plugin teardown: kill the python child if one is alive. Synchronous on purpose -
// this runs from the host's dispose hook, and an async taskkill fired here can be
// cut off when the host process exits, leaving python behind (which is exactly the
// leftover that later made Stop look broken).
export function shutdown() {
  const child = handle
  handle = null
  if (!child) return
  const pid = child.pid
  if (pid) killTreeSync(pid)
  try { child.kill() } catch (e) { /* already gone */ }
}

// Adopt the truth on startup: a python left behind by a previous host run (DSH
// update, crash, plugin reload) is still listening on our port, but this module
// instance starts with no handle and would otherwise report "Stopped". Called
// once when the plugin is applied; never blocks startup.
export function reconcile() {
  const cfg = loadConfig()
  chat2apiPids({ port: cfg.port || 8000 }).then((found) => {
    if (!found.length) return
    if (handle || starting) return
    runtimeStatus.state = 'orphaned'
    runtimeStatus.pid = found[0].pid
    runtimeStatus.message = 'leftover chat2api.py from a previous run (pid ' +
      found.map((p) => p.pid).join(', ') + ') - press Stop to clear it'
    pushLog('[reconcile] found ' + found.length + ' leftover chat2api.py process(es): ' +
      found.map((p) => p.pid).join(', '))
  }).catch((e) => {
    // Enumeration unavailable: fall back to the port. If something answers, the
    // proxy is up but this instance does not own the handle - report that instead
    // of a silent "Stopped".
    if (handle || starting) return
    portOpen(cfg.host || '127.0.0.1', cfg.port || 8000).then((open) => {
      if (!open || handle || starting) return
      runtimeStatus.state = 'orphaned'
      runtimeStatus.message = 'something already serves ' + (cfg.host || '127.0.0.1') + ':' +
        (cfg.port || 8000) + ' but this session did not start it - press Stop to clear it'
      pushLog('[reconcile] ' + runtimeStatus.message)
    }).catch(() => {})
  })
}

// Launch chat2api.py without ever blocking a web handler: when the cached
// python/deps result is fresh and healthy we spawn immediately; otherwise the
// async probe (worst case ~27s of awaited child runs, zero loop blocking) runs
// in the background and the panel picks up the final state through its poll.
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
    starting = true
    // A leftover from a previous host run holds the port. python's
    // ThreadingHTTPServer uses SO_REUSEADDR, which on Windows lets the new child
    // bind anyway - so two processes end up "listening" and Stop only ever killed
    // one of them. Reap first, then spawn.
    reapStragglers(0, { port: cfg.port || 8000 }).then((r) => {
      if (r.killed.length) pushLog('[start] reaped leftover chat2api.py pid(s): ' + r.killed.join(', '))
      if (r.remaining.length) pushLog('[start] could not reap pid(s): ' + r.remaining.join(', '))
      if (handle) return
      if (diag.python === 'ok' && diag.deps === 'ok') {
        const s = spawnProxy(cfg, dir)
        if (!s.ok && !handle) runtimeStatus.message = s.message
      } else {
        runtimeStatus.state = 'stopped'
        runtimeStatus.message = 'start skipped: ' + diag.message
      }
    }).catch((e) => {
      // Enumeration unavailable: still spawn (the port probe path below is not
      // needed - python's SO_REUSEADDR lets it bind even beside a leftover, and
      // Stop can reap it later).
      pushLog('[start] ' + String((e && e.message) || e))
      if (handle) return
      if (diag.python === 'ok' && diag.deps === 'ok') spawnProxy(cfg, dir)
      else { runtimeStatus.state = 'stopped'; runtimeStatus.message = 'start skipped: ' + diag.message }
    }).finally(() => { starting = false })
  }
  if (diagReady()) {
    launch()
    return { ok: true }
  }
  probe(true)
    .then(() => { launch() })
    .catch((e) => { pushLog('[start] ' + String((e && e.message) || e)) })
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
    runtimeStatus.pid = child.pid || null
    const onData = (b) => { for (const line of String(b).split(/\r?\n/)) pushLog(line) }
    try { if (child.stdout) child.stdout.on('data', onData) } catch (e) {}
    try { if (child.stderr) child.stderr.on('data', onData) } catch (e) {}
    child.on('exit', (code, sig) => {
      // A stop we asked for must stay "stopped", not flip to "exited" when the
      // exit event lands a moment later. `handle` is already null by then, so this
      // check has to come before the handle test.
      if (stopping === child) { stopping = null; return }
      if (handle !== child) return
      handle = null
      runtimeStatus.pid = null
      runtimeStatus.state = 'exited'
      runtimeStatus.exitCode = code
      runtimeStatus.signal = sig
      runtimeStatus.message = 'process exited'
    })
    child.on('error', (err) => {
      if (handle !== child) return
      handle = null
      runtimeStatus.pid = null
      runtimeStatus.state = 'crashed'
      runtimeStatus.message = String((err && err.message) || err)
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, message: 'spawn failed: ' + String((e && e.message) || e) }
  }
}

// Graceful kill, then forced, and report what actually happened instead of
// assuming `child.kill()` worked.
async function killChild(child) {
  const pid = child && child.pid ? Number(child.pid) : 0
  if (!pid) { try { child.kill() } catch (e) {} return null }
  try { child.kill() } catch (e) { /* already gone */ }
  if (await waitGone(pid, 2500)) return { pid, how: 'signal' }
  await killTree(pid)
  if (await waitGone(pid, 3000)) return { pid, how: 'taskkill' }
  return { pid, how: 'failed' }
}

export async function stopImpl() {
  const child = handle
  const out = { ok: true, killed: [], strays: [], message: '', survivors: [] }
  if (child) {
    stopping = child
    handle = null
    let r = null
    try {
      r = await killChild(child)
    } catch (e) {
      // Never let a kill error leave `stopping` stuck: a stale value would swallow
      // the next child's exit event.
      pushLog('[stop] kill failed: ' + String((e && e.message) || e))
    } finally {
      if (stopping === child) stopping = null
    }
    if (r && r.how === 'failed') out.survivors.push(r.pid)
    else if (r) out.killed.push(r.pid)
  }
  // Whatever is left running chat2api.py was not spawned by this module instance
  // (a leftover from a previous host run, or a duplicate that bound the port via
  // SO_REUSEADDR). Stop must clear those too - that is the whole complaint. The
  // sweep already verifies each pid is really gone, so its 'remaining' list is the
  // authoritative answer; no second enumeration needed (each one costs a
  // powershell start).
  let enumerated = true
  try {
    const reaped = await reapStragglers(0, { port: loadConfig().port || 8000 })
    out.strays = reaped.killed
    out.survivors = out.survivors.concat(reaped.remaining)
  } catch (e) {
    enumerated = false
    pushLog('[stop] process enumeration unavailable: ' + String((e && e.message) || e))
  }
  if (!enumerated) {
    // No way to ask "is any chat2api.py alive?", so fall back to the one thing that
    // still answers: is our port still accepting connections?
    const cfg = loadConfig()
    if (await portOpen(cfg.host || '127.0.0.1', cfg.port || 8000)) {
      runtimeStatus.state = 'running'
      runtimeStatus.message = 'stop failed: something still serves ' +
        (cfg.host || '127.0.0.1') + ':' + (cfg.port || 8000) + ' (could not list processes)'
      out.ok = false
      out.message = runtimeStatus.message
      pushLog('[stop] ' + runtimeStatus.message)
      return out
    }
  }
  if (out.survivors.length) {
    // Do not claim success we cannot back up: the panel would show "Stopped"
    // while python keeps serving, which is exactly the bug being fixed.
    runtimeStatus.state = 'running'
    runtimeStatus.pid = out.survivors[0]
    runtimeStatus.message = 'stop failed: python still alive (pid ' + out.survivors.join(', ') + ')'
    out.ok = false
    out.message = runtimeStatus.message
    pushLog('[stop] ' + runtimeStatus.message)
    return out
  }
  runtimeStatus.state = 'stopped'
  runtimeStatus.pid = null
  runtimeStatus.message = 'stopped by user'
  runtimeStatus.exitCode = null
  runtimeStatus.signal = null
  out.message = 'stopped by user'
  if (out.strays.length) pushLog('[stop] reaped leftover chat2api.py pid(s): ' + out.strays.join(', '))
  return out
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
  probe(true).then(() => {
    if (diag.python === 'ok' && diag.deps === 'ok') spawnLogin(cfg, dir)
    else loginFailed('python/deps unavailable - login did not start')
  }).catch((e) => { loginFailed('login deferred start failed: ' + String((e && e.message) || e)) })
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
