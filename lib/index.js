// dsh-owui-chat2api - HOST half (persistent DSH bundle).
//
// A normal Cordis plugin loaded on DSH startup via cordis.patch.yml. It bundles
// chat2api.py, owns the python subprocess, exposes JSON over webServer routes,
// and injects a clean control panel into the DSH web shell via webServer.tapIndex.
// Survives restarts; no cordis_define/cordis_run needed.
//
// Diagnostics are cached: python/deps probing is the only thing that spawns a
// python process, and it must never block a web request. The probe runs once at
// startup and re-probes in the background when the cache goes stale, so the
// /api/status poll cannot stall the event loop.
//
// Routes (same origin, served by the DSH web carrier):
//   GET  /dsh-owui-chat2api/panel.js        -> the client panel script
//   GET  /dsh-owui-chat2api/api/status      -> { config, runtimeStatus, diagnostics, log, bundledChat2apiDir }
//   GET  /dsh-owui-chat2api/api/config      -> { config, runtimeStatus, diagnostics }
//   POST /dsh-owui-chat2api/api/config      -> save config (JSON body), auto-starts on false->true
//   POST /dsh-owui-chat2api/api/start       -> launch chat2api.py
//   POST /dsh-owui-chat2api/api/stop        -> stop chat2api.py
//   POST /dsh-owui-chat2api/api/login       -> one-time Open WebUI browser login
//
// Config lives in <DSH_HOME>/dsh-owui-chat2api-control.json, pre-filled so a
// fresh install needs no manual entry. autoStart defaults to true: bundled
// chat2api starts with DSH (reuses the copied .chrome-profile).

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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
function startImpl() {
  if (handle) return { ok: false, message: 'chat2api is already running' }
  const cfg = loadConfig()
  probe(true) // fresh python/deps check when the user actually starts
  if (diag.python !== 'ok') return { ok: false, message: diag.message }
  const dir = resolveDir(cfg)
  if (!fs.existsSync(path.join(dir, 'chat2api.py'))) {
    return { ok: false, message: 'chat2api.py not found in ' + dir }
  }
  try {
    const child = spawn(diag.pythonPath, [
      'chat2api.py',
      '--base-url', String(cfg.baseUrl).trim(),
      '--host', String(cfg.host || '127.0.0.1').trim(),
      '--port', String(cfg.port || 8000),
    ], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { DSH_OWUI_USAGE_DB: USAGE_DB_PATH }) })
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
  probe(true)
  if (diag.python !== 'ok') return { ok: false, message: diag.message }
  const dir = resolveDir(cfg)
  if (!fs.existsSync(path.join(dir, 'chat2api.py'))) {
    return { ok: false, message: 'chat2api.py not found in ' + dir }
  }
  try {
    const child = spawn(diag.pythonPath, [
      'chat2api.py', '--login',
      '--base-url', String(cfg.baseUrl).trim(),
      '--login-timeout', '240',
    ], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { DSH_OWUI_USAGE_DB: USAGE_DB_PATH }) })
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
    req.on('data', (c) => { buf += c.toString('utf8') })
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

  disposers.push(web.tapIndex((html) => {
    if (html.indexOf(ROUTE + '/panel.js') !== -1) return html
    const tag = '<script defer src="' + ROUTE + '/panel.js"></script>'
    if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
    return html + tag
  }))

  try {
    loadConfig()
    if (config && config.autoStart && !handle) {
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
