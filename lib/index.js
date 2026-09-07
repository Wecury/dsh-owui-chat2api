// dsh-owui-chat2api - HOST half (persistent DSH bundle).
//
// Loaded on every DSH start via cordis.patch.yml. Bundles chat2api.py, owns the
// python subprocess, exposes JSON routes over webServer, and injects a control
// panel into the DSH web shell via webServer.tapIndex. Survives restarts; no
// cordis_define/cordis_run needed.
//
// This file is the wiring layer only (refactor step 5): it registers routes and
// delegates to lib/config.js (config + paths), lib/diagnostics.js (cached
// python/deps probe), lib/proxy-process.js (python child lifecycle) and
// lib/effort-scan.js (settings.yaml sync).
//
// Invariant: no web handler may ever block. Python/deps probing is cached and
// re-probed in the background when stale; start/login launch it off the request
// path too, so the panel poll cannot stall the event loop. Routes are listed in
// README.md; config lives in <DSH_HOME>/dsh-owui-chat2api-control.json.

import fs from 'node:fs'
import path from 'node:path'
import { PACKAGE_ROOT, CHAT2API_DIR, loadConfig, saveConfig, baseUrlUnset } from './config.js'
import { diagnostics, probeAsync } from './diagnostics.js'
import { runtimeStatus, loginState, logTail, startImpl, stopImpl, loginImpl, isRunning, shutdown } from './proxy-process.js'
import { runEffortScan } from './effort-scan.js'

const name = 'dsh-owui-chat2api'
const inject = ['webServer']

const PANEL_JS_PATH = path.join(PACKAGE_ROOT, 'lib', 'panel.js')
const PANEL_I18N_PATH = path.join(PACKAGE_ROOT, 'lib', 'panel-i18n.js')
const PANEL_CSS_PATH = path.join(PACKAGE_ROOT, 'lib', 'panel.css')
const ROUTE = '/dsh-owui-chat2api'
const REQ_BODY_MAX = 256 * 1024

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

// Static panel assets (panel.js script, panel-i18n.js dictionaries, panel.css
// stylesheet), read once and cached until restart - pack updates require a DSH
// restart anyway.
const panelAssetCache = new Map()
function serveAsset(res, filePath, contentType) {
  try {
    let body = panelAssetCache.get(filePath)
    if (body === undefined) {
      body = fs.readFileSync(filePath, 'utf8')
      panelAssetCache.set(filePath, body)
    }
    res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(body)
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(path.basename(filePath) + ' unavailable: ' + String((e && e.message) || e))
  }
}

function apply(ctx) {
  const disposers = []
  const web = ctx.webServer

  probeAsync() // warm python/deps cache without blocking startup

  disposers.push(web.register({ kind: 'exact', path: ROUTE + '/panel.js', handler: (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
    serveAsset(res, PANEL_JS_PATH, 'application/javascript')
  }}))

  disposers.push(web.register({ kind: 'exact', path: ROUTE + '/panel.css', handler: (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
    serveAsset(res, PANEL_CSS_PATH, 'text/css')
  }}))

  disposers.push(web.register({ kind: 'exact', path: ROUTE + '/panel-i18n.js', handler: (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
    serveAsset(res, PANEL_I18N_PATH, 'application/javascript')
  }}))

  disposers.push(web.register({ kind: 'exact', path: ROUTE + '/api/status', handler: (req, res) => {
    sendJson(res, 200, {
      config: loadConfig(),
      runtimeStatus,
      diagnostics: diagnostics(),
      login: { running: loginState.running, result: loginState.result, resultAt: loginState.resultAt, message: loginState.message },
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
      const prev = loadConfig()
      const prevAuto = !!(prev && prev.autoStart)
      const saved = saveConfig(patch || {})
      let startResult = null
      if (saved.autoStart && !prevAuto && !isRunning()) startResult = startImpl()
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
      const out = await runEffortScan(false)
      sendJson(res, 200, out)
    } catch (e) {
      sendJson(res, 200, { ok: false, message: String((e && e.message) || e) })
    }
  }}))

  // Force re-probe: ignores the effort cache (--effort-force) and re-scans every
  // model. Same runEffortScan pipeline, just force=true.
  disposers.push(web.register({ kind: 'exact', path: ROUTE + '/api/effort-scan-force', handler: async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    try {
      const out = await runEffortScan(true)
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
    // Stylesheet first so the first paint of the pill/panel is already styled;
    // then the i18n dictionaries (panel.js reads window.__dshOwuiI18n), then
    // the panel logic. All three are injected once (guarded on the css asset).
    if (html.indexOf(ROUTE + '/panel.css') !== -1) return html
    const link = '<link rel="stylesheet" href="' + ROUTE + '/panel.css">'
    const i18n = '<script defer src="' + ROUTE + '/panel-i18n.js"></script>'
    const tag = '<script defer src="' + ROUTE + '/panel.js"></script>'
    const inject = link + i18n + tag
    if (html.indexOf('</body>') !== -1) return html.replace('</body>', inject + '</body>')
    return html + inject
  }))

  try {
    const cfg = loadConfig()
    if (cfg && cfg.autoStart && !baseUrlUnset(cfg) && !isRunning()) {
      const r = startImpl()
      if (!r || !r.ok) console.error('[dsh-owui-chat2api] autostart failed: ' + ((r && r.message) || ''))
    }
  } catch (e) { /* ignore */ }

  ctx.effect(() => () => {
    shutdown() // kill the python child, if any
    for (const d of disposers) { try { d() } catch (e) {} }
  })
}

export { name, inject, apply }
