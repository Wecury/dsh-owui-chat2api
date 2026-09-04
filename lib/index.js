// dsh-owui-chat2api - HOST half (persistent DSH bundle).
//
// Loaded on every DSH start via cordis.patch.yml. Bundles chat2api.py, owns the
// python subprocess, exposes JSON routes over webServer, and injects a control
// panel into the DSH web shell via webServer.tapIndex. Survives restarts; no
// cordis_define/cordis_run needed.
//
// Invariant: no web handler may ever block. Python/deps probing is cached and
// re-probed in the background when stale; start/login launch it off the request
// path too, so the panel poll cannot stall the event loop. Routes are listed in
// README.md; config lives in <DSH_HOME>/dsh-owui-chat2api-control.json.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { addReasoningEfforts, addModels, ensureProvider } from './settings-patch.js'

const name = 'dsh-owui-chat2api'
const inject = ['webServer']

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CHAT2API_DIR = path.join(PACKAGE_ROOT, 'chat2api')
const PANEL_JS_PATH = path.join(PACKAGE_ROOT, 'lib', 'panel.js')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONTROL_FILE = path.join(DSH_HOME, 'dsh-owui-chat2api-control.json')
// Usage history lives OUTSIDE the plugin dir (which can change on updates/renames),
// so cumulative stats survive every restart and upgrade. chat2api.py honours this
// via the DSH_OWUI_USAGE_DB env var (falling back to its local usage.db standalone).
const USAGE_DB_PATH = path.join(DSH_HOME, 'dsh-owui-chat2api-usage.db')
const ROUTE = '/dsh-owui-chat2api'
const PYTHONS = ['python', 'python3', 'py']
const LOG_MAX = 80
const PROBE_TTL = 20000
const REQ_BODY_MAX = 256 * 1024

// Minimal, curated env for the python child: deliberately NOT the whole
// process.env (DSH may hold API keys/tokens for other services that a vendored
// third-party proxy must not see). Only what python/playwright need on Windows,
// plus our own usage-db pointer and UTF-8 output.
function childEnv() {
  const pick = (k, d = '') => (process.env[k] !== undefined ? process.env[k] : d)
  return {
    PATH: pick('PATH'), SYSTEMROOT: pick('SYSTEMROOT'), ComSpec: pick('ComSpec'),
    PATHEXT: pick('PATHEXT'), HOMEDRIVE: pick('HOMEDRIVE'), HOMEPATH: pick('HOMEPATH'),
    USERPROFILE: pick('USERPROFILE'), LOCALAPPDATA: pick('LOCALAPPDATA'),
    APPDATA: pick('APPDATA'), TEMP: pick('TEMP'), TMP: pick('TMP'), LANG: pick('LANG'),
    PYTHONIOENCODING: 'utf-8',
    DSH_OWUI_USAGE_DB: USAGE_DB_PATH,
  }
}

// A fresh, opened-source install ships a placeholder baseUrl; treat it (and
// obviously bogus values) as "not configured" so autostart does not launch a
// proxy against a URL nobody can reach.
function baseUrlUnset(cfg) {
  const s = String((cfg && cfg.baseUrl) || '').trim().toLowerCase()
  return !s || s === 'https://your-open-webui.example.com' || /^(https?:\/\/)?(your-|example\.|<)/.test(s)
}

const defaultConfig = () => ({
  chat2apiDir: CHAT2API_DIR,
  baseUrl: 'https://your-open-webui.example.com', // set to your Open WebUI instance
  host: '127.0.0.1',
  port: 8000,
  autoStart: true, // bundled proxy starts with DSH; panel Start/Stop still available
})

let config = null
let handle = null
const logTail = []
const runtimeStatus = { state: 'stopped', startedAt: 0, exitCode: null, signal: null, message: '' }
const diag = { python: 'unknown', pythonPath: null, deps: 'unknown', message: '', checkedAt: 0 }
let pythonCmd = null
let pythonChecked = false

function loadConfig() {
  if (config) return config
  config = defaultConfig()
  try {
    const parsed = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      for (const k of Object.keys(config)) if (parsed[k] !== undefined) config[k] = parsed[k]
    }
  } catch (e) { /* keep defaults */ }
  return config
}

function saveConfig(patch) {
  const base = loadConfig()
  const next = defaultConfig()
  for (const k of Object.keys(next)) next[k] = (patch && patch[k] !== undefined) ? patch[k] : base[k]
  next.chat2apiDir = String(next.chat2apiDir || CHAT2API_DIR).trim() || CHAT2API_DIR
  next.baseUrl = String(next.baseUrl || '').trim()
  next.host = String(next.host || '127.0.0.1').trim() || '127.0.0.1'
  next.port = Number(next.port) || 8000
  next.autoStart = !!next.autoStart
  config = next
  try { fs.writeFileSync(CONTROL_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8') } catch (e) { /* best effort */ }
  return next
}

// Run a short-lived python command, collect stdout/stderr, kill on timeout.
// Used only for the one-shot effort scan; never blocks the event loop body.
function spawnCollect(cmd, args, { cwd, env, timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ ok: false, message: String((e && e.message) || e) })
      return
    }
    let out = ''
    let errOut = ''
    const to = setTimeout(() => { try { child.kill() } catch (e) { /* gone */ } }, timeoutMs)
    const done = (state) => { clearTimeout(to); resolve(state) }
    if (child.stdout) child.stdout.on('data', (b) => { out += String(b) })
    if (child.stderr) child.stderr.on('data', (b) => { errOut += String(b) })
    child.on('error', (e) => done({ ok: false, message: String((e && e.message) || e), stderr: errOut }))
    child.on('close', (code, signal) => done({ ok: true, code, signal, stdout: out, stderr: errOut }))
  })
}

// One-shot "auto-configure DSH reasoning levels": probe every model through
// chat2api (reusing its saved token + cached results), then add reasoningEfforts
// to the matching entries in ~/.dsh/settings.yaml (back up first). Text-level
// merge contract lives in settings-patch.js; DSH restart is required to apply.
async function runEffortScan() {
  const cfg = loadConfig()
  if (baseUrlUnset(cfg)) return { ok: false, message: 'baseUrl is not set - set your Open WebUI URL in the panel first' }
  if (diag.python !== 'ok') return { ok: false, message: (diag.message || 'python unavailable') }
  const dir = resolveDir(cfg)
  if (!fs.existsSync(path.join(dir, 'chat2api.py'))) return { ok: false, message: 'chat2api.py not found in ' + dir }

  const r = await spawnCollect(diag.pythonPath, [
    'chat2api.py',
    '--base-url', String(cfg.baseUrl).trim(),
    '--effort-scan',
  ], { cwd: dir, env: childEnv() })

  let scan = null
  try { scan = JSON.parse(String(r.stdout || '').trim()) } catch (e) { scan = null }
  if (!r.ok || r.code !== 0 || !scan || typeof scan !== 'object') {
    const detail = String(r.stderr || '').trim().split('\n').slice(-3).join(' ') || String(r.stdout || '').trim().slice(0, 120)
    return { ok: false, message: 'effort scan failed: ' + (detail || ('exit ' + r.code)).trim().slice(0, 220) }
  }

  const allModels = Object.keys(scan).filter((m) => m && typeof m === 'string')
  const supported = allModels.filter((m) => scan[m])
  const settingsPath = path.join(DSH_HOME, 'settings.yaml')
  let source = ''
  try { source = fs.readFileSync(settingsPath, 'utf8') } catch (e) {
    return { ok: false, message: 'cannot read ' + settingsPath + ': ' + String((e && e.message) || e) }
  }
  const proxyUrl = 'http://' + String(cfg.host || '127.0.0.1') + ':' + (cfg.port || 8000) + '/v1'

  // 0) Create the provider (llm-pi-ai > providers > <name>) if none points at
  //    the proxy yet - a fresh DSH install has no provider here by default.
  const prv = ensureProvider(source, { baseUrl: proxyUrl })
  if (!prv.ok) return { ok: false, message: (prv.message || 'provider ensure failed') + ' - nothing written' }
  const baseText = prv.text
  // 1) Declare every backend model in DSH settings (first, so DSH can list it);
  // 2) then set reasoningEfforts for the models that actually accept the param.
  const mres = addModels(baseText, { baseUrl: proxyUrl, modelIds: allModels })
  if (!mres.ok) return { ok: false, message: (mres.message || 'model sync failed') + ' - nothing written' }
  const res = addReasoningEfforts(mres.text, { baseUrl: proxyUrl, modelIds: supported })
  if (!res.ok) return { ok: false, message: (res.message || 'settings patch failed') + ' - nothing written' }

  const changed = prv.code === 'CREATED' || mres.code === 'CHANGED' || res.code === 'CHANGED'
  let backup = null
  if (changed) {
    backup = settingsPath + '.bak-reasoning-' + new Date().toISOString().replace(/[:.]/g, '-')
    try { fs.writeFileSync(backup, source, 'utf8') } catch (e) {
      return { ok: false, message: 'settings backup failed: ' + String((e && e.message) || e) }
    }
    try { fs.writeFileSync(settingsPath, res.text, 'utf8') } catch (e) {
      return { ok: false, message: 'settings write failed: ' + String((e && e.message) || e) }
    }
  }

  return {
    ok: true,
    scan,
    supported,
    providerCreated: prv.code === 'CREATED',
    providerName: prv.name,
    modelsAdded: mres.added,
    modelsAlready: mres.already,
    added: res.added,
    already: res.already,
    skipped: res.skipped,
    settingsPath,
    backup,
    changed,
    restartNeeded: true,
  }
}

function pushLog(line) {
  const s = String(line || '').trim()
  if (!s) return
  logTail.push(s)
  if (logTail.length > LOG_MAX) logTail.splice(0, logTail.length - LOG_MAX)
}

// ---- cached diagnostics (the only place python is spawned) ----
function findPython(refresh) {
  if (pythonChecked && !refresh) return pythonCmd
  pythonChecked = true
  pythonCmd = null
  for (const candidate of PYTHONS) {
    try {
      const r = spawnSync(candidate, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 4000 })
      if (r.status === 0) { pythonCmd = candidate; break }
      const out = String((r.stdout || '') + (r.stderr || ''))
      if (/python/i.test(out)) { pythonCmd = candidate; break }
    } catch (e) { /* try next */ }
  }
  return pythonCmd
}

function probe(refresh) {
  if (!refresh && diag.checkedAt && (Date.now() - diag.checkedAt < PROBE_TTL)) return diag
  diag.checkedAt = Date.now()
  const py = findPython(refresh)
  if (!py) {
    diag.python = 'missing'; diag.pythonPath = null; diag.deps = 'unknown'
    diag.message = 'python not found in PATH'
    return diag
  }
  diag.python = 'ok'; diag.pythonPath = py
  let err = ''
  try {
    const r = spawnSync(py, ['-c', 'import requests, playwright'], { cwd: CHAT2API_DIR, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 })
    if (r.status !== 0) err = String((r.stderr || r.stdout || '').toString().split('\n')[0] || 'import failed')
  } catch (e) { err = String((e && e.message) || e) }
  if (!err) {
    diag.deps = 'ok'
    diag.message = 'python + requests + playwright reachable'
  } else {
    diag.deps = 'missing'
    diag.message = 'missing deps: pip install requests playwright'
  }
  return diag
}

function probeAsync() {
  try { setImmediate(() => { try { probe(true) } catch (e) {} }) } catch (e) {}
}

function diagnostics() {
  if (!diag.checkedAt || (Date.now() - diag.checkedAt >= PROBE_TTL)) probeAsync()
  return diag
}

function resolveDir(cfg) {
  const dir = String(cfg.chat2apiDir || CHAT2API_DIR).trim() || CHAT2API_DIR
  return fs.existsSync(path.join(dir, 'chat2api.py')) ? dir : CHAT2API_DIR
}

// ---- lifecycle ----

// Launch chat2api.py without ever blocking a web handler: when the cached
// python/deps result is fresh and healthy we spawn immediately; otherwise the
// probe (up to ~27s worst case) is deferred to a setImmediate and the panel
// picks up the final state through its normal poll.
function startImpl() {
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
  const fresh = diag.checkedAt && (Date.now() - diag.checkedAt < PROBE_TTL)
  if (fresh && diag.python === 'ok' && diag.deps === 'ok') {
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

function stopImpl() {
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

function loginImpl() {
  const cfg = loadConfig()
  if (baseUrlUnset(cfg)) return { ok: false, message: 'baseUrl is not set - set your Open WebUI URL in the panel first' }
  const dir = resolveDir(cfg)
  if (!fs.existsSync(path.join(dir, 'chat2api.py'))) {
    return { ok: false, message: 'chat2api.py not found in ' + dir }
  }
  const fresh = diag.checkedAt && (Date.now() - diag.checkedAt < PROBE_TTL)
  if (fresh && diag.python === 'ok' && diag.deps === 'ok') return spawnLogin(cfg, dir)
  setImmediate(() => { try { probe(true); if (diag.python === 'ok' && diag.deps === 'ok') spawnLogin(cfg, dir) } catch (e) { pushLog('[login] ' + String((e && e.message) || e)) } })
  return { ok: true, message: 'login starting - checking python/deps …', async: true }
}

function spawnLogin(cfg, dir) {
  try {
    const child = spawn(diag.pythonPath, [
      'chat2api.py', '--login',
      '--base-url', String(cfg.baseUrl).trim(),
      '--use-api-key', // prefer the long-lived key when one exists (JWTs expire)
      '--login-timeout', '240',
    ], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv() })
    const onData = (b) => { for (const line of String(b).split(/\r?\n/)) pushLog(line) }
    try { if (child.stdout) child.stdout.on('data', onData) } catch (e) {}
    try { if (child.stderr) child.stderr.on('data', onData) } catch (e) {}
    child.on('exit', () => pushLog('[login] flow finished'))
    pushLog('[login] browser opening - sign in to Open WebUI ...')
    return { ok: true, message: 'login flow started - complete it in the browser window' }
  } catch (e) {
    return { ok: false, message: 'login spawn failed: ' + String((e && e.message) || e) }
  }
}

// ---- HTTP helpers ----
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = ''
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > REQ_BODY_MAX) {
        try { req.destroy() } catch (e) {}
        resolve('{}')
        return
      }
      buf += c.toString('utf8')
    })
    req.on('end', () => resolve(buf))
    req.on('error', () => resolve(''))
  })
}

let panelCache = null
function servePanel(res) {
  try {
    if (!panelCache) panelCache = fs.readFileSync(PANEL_JS_PATH, 'utf8')
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(panelCache)
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('panel.js unavailable: ' + String((e && e.message) || e))
  }
}

function apply(ctx) {
  const disposers = []
  const web = ctx.webServer

  probeAsync() // warm python/deps cache without blocking startup

  disposers.push(web.register({ kind: 'exact', path: ROUTE + '/panel.js', handler: (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
    servePanel(res)
  }}))

  disposers.push(web.register({ kind: 'exact', path: ROUTE + '/api/status', handler: (req, res) => {
    sendJson(res, 200, {
      config: loadConfig(),
      runtimeStatus,
      diagnostics: diagnostics(),
      log: logTail.slice(-25),
      bundledChat2apiDir: CHAT2API_DIR,
    })
  }}))

  disposers.push(web.register({ kind: 'exact', path: ROUTE + '/api/config', handler: async (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, { config: loadConfig(), runtimeStatus, diagnostics: diagnostics() })
      return
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    try {
      const patch = JSON.parse((await readBody(req)) || '{}')
      const prevAuto = !!(config && config.autoStart)
      const saved = saveConfig(patch || {})
      let startResult = null
      if (saved.autoStart && !prevAuto && !handle) startResult = startImpl()
      sendJson(res, 200, { config: saved, runtimeStatus, diagnostics: diagnostics(), startResult })
    } catch (e) {
      sendJson(res, 400, { ok: false, message: String((e && e.message) || e) })
    }
  }}))

  disposers.push(web.register({ kind: 'exact', path: ROUTE + '/api/start', handler: (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    sendJson(res, 200, startImpl())
  }}))

  disposers.push(web.register({ kind: 'exact', path: ROUTE + '/api/stop', handler: (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    sendJson(res, 200, stopImpl())
  }}))

  disposers.push(web.register({ kind: 'exact', path: ROUTE + '/api/login', handler: (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    sendJson(res, 200, loginImpl())
  }}))

  disposers.push(web.register({ kind: 'exact', path: ROUTE + '/api/effort-scan', handler: async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    try {
      const out = await runEffortScan()
      sendJson(res, 200, out)
    } catch (e) {
      sendJson(res, 200, { ok: false, message: String((e && e.message) || e) })
    }
  }}))

  // Same-origin usage proxy: keeps the dashboard working over HTTPS and when
  // DSH is accessed remotely (no mixed content, no CORS dependency on the proxy).
  disposers.push(web.register({ kind: 'exact', path: ROUTE + '/api/usage', handler: async (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return }
    const cfg = loadConfig()
    let target = ''
    try {
      const u = new URL(req.url, 'http://localhost')
      const rng = String(u.searchParams.get('range') || 'today')
      target = 'http://' + String(cfg.host || '127.0.0.1') + ':' + (cfg.port || 8000) + '/v1/usage?range=' + encodeURIComponent(rng)
      const ac = new AbortController()
      const to = setTimeout(() => ac.abort(), 8000)
      let r
      try {
        r = await fetch(target, { signal: ac.signal, headers: { Accept: 'application/json' } })
      } finally { clearTimeout(to) }
      if (!r.ok) { sendJson(res, 200, { ok: false, message: 'usage endpoint returned HTTP ' + r.status }); return }
      sendJson(res, 200, await r.json())
    } catch (e) {
      sendJson(res, 200, { ok: false, message: 'usage endpoint unreachable at ' + (target || '?') })
    }
  }}))

  disposers.push(web.tapIndex((html) => {
    if (html.indexOf(ROUTE + '/panel.js') !== -1) return html
    const tag = '<script defer src="' + ROUTE + '/panel.js"></script>'
    if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
    return html + tag
  }))

  try {
    loadConfig()
    if (config && config.autoStart && !baseUrlUnset(config) && !handle) {
      const r = startImpl()
      if (!r || !r.ok) console.error('[dsh-owui-chat2api] autostart failed: ' + ((r && r.message) || ''))
    }
  } catch (e) { /* ignore */ }

  ctx.effect(() => () => {
    if (handle) { try { handle.kill() } catch (e) {} handle = null }
    for (const d of disposers) { try { d() } catch (e) {} }
  })
}

export { name, inject, apply }
