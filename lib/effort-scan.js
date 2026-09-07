// lib/effort-scan.js - one-shot "sync models & reasoning levels" (HOST half).
//
// Probes every model through chat2api (reusing its saved token + cached
// results), then adds missing models plus reasoningEfforts to the matching
// entries in ~/.dsh/settings.yaml (back up first). Text-level merge contract
// lives in settings-patch.js; DSH restart is required to apply. Split out of
// index.js (refactor step 5); behaviour is unchanged.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { addModels, addReasoningEfforts, ensureProvider } from './settings-patch.js'
import { DSH_HOME, baseUrlUnset, loadConfig, resolveDir } from './config.js'
import { diag } from './diagnostics.js'
import { childEnv } from './proxy-process.js'

// Upper bound for one effort scan: probes are concurrent (8 workers), each up to
// ~45s, so 20 minutes covers hundreds of unknown models. Must exceed the panel's
// long withBusy timeout minus margin.
const EFFORT_SCAN_TIMEOUT_MS = 20 * 60 * 1000

let effortScanBusy = false

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

// Scan bookkeeping for the async response pattern (mirrors loginState): the
// POST /api/effort-scan* returns immediately and the panel converges via
// /api/status, which carries { running, startedAt, resultAt, result }.
export const scanState = { running: false, startedAt: 0, result: null, resultAt: 0 }

export async function runEffortScan(force = false) {
  // Guard: a scan can run for minutes; refuse concurrent scans so two clicks
  // can never patch settings.yaml at the same time.
  if (effortScanBusy) {
    return { ok: false, message: 'a scan is already running - let it finish first' }
  }
  effortScanBusy = true
  scanState.running = true
  scanState.startedAt = Date.now()
  try {
    scanState.result = await runEffortScanInner(force)
  } catch (e) {
    scanState.result = { ok: false, message: 'scan crashed: ' + String((e && e.message) || e) }
  }
  effortScanBusy = false
  scanState.running = false
  scanState.resultAt = Date.now()
  return scanState.result
}

// Kick off a scan off the request path (mirrors startImpl/loginImpl): returns
// immediately; the panel announces the final result through its status poll.
export function startEffortScan(force = false) {
  if (effortScanBusy || scanState.running) {
    return { ok: false, message: 'a scan is already running - let it finish first' }
  }
  runEffortScan(force).catch(() => {}) // never rejects (crashes become results); belt and braces
  return { ok: true, async: true, message: 'scan started - the panel shows the result when it finishes' }
}

async function runEffortScanInner(force) {
  const cfg = loadConfig()
  if (baseUrlUnset(cfg)) return { ok: false, message: 'baseUrl is not set - set your Open WebUI URL in the panel first' }
  if (diag.python !== 'ok') return { ok: false, message: (diag.message || 'python unavailable') }
  const dir = resolveDir(cfg)
  if (!fs.existsSync(path.join(dir, 'chat2api.py'))) return { ok: false, message: 'chat2api.py not found in ' + dir }

  const r = await spawnCollect(diag.pythonPath, [
    'chat2api.py',
    '--base-url', String(cfg.baseUrl).trim(),
    '--effort-scan',
    ...(force ? ['--effort-force'] : []),
  ], { cwd: dir, env: childEnv(), timeoutMs: EFFORT_SCAN_TIMEOUT_MS })

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
  let verify = null
  if (changed) {
    // Keep only the newest few backups so <DSH_HOME> is not buried over years.
    try {
      const olds = fs.readdirSync(DSH_HOME)
        .filter((f) => /^settings\.yaml\.bak-reasoning-/.test(f))
        .sort()
      olds.slice(0, Math.max(0, olds.length - 4)).forEach((f) => {
        try { fs.unlinkSync(path.join(DSH_HOME, f)) } catch (e) { /* ignore */ }
      })
    } catch (e) { /* ignore */ }

    backup = settingsPath + '.bak-reasoning-' + new Date().toISOString().replace(/[:.]/g, '-')
    try { fs.writeFileSync(backup, source, 'utf8') } catch (e) {
      return { ok: false, message: 'settings backup failed: ' + String((e && e.message) || e) }
    }
    try { fs.writeFileSync(settingsPath, res.text, 'utf8') } catch (e) {
      return { ok: false, message: 'settings write failed: ' + String((e && e.message) || e) }
    }
    // Verify after write: re-reading the file and re-running the same patches
    // must now find the provider, every model and every effort already present.
    try {
      const reread = fs.readFileSync(settingsPath, 'utf8')
      const v1 = ensureProvider(reread, { baseUrl: proxyUrl })
      const v2 = addModels(reread, { baseUrl: proxyUrl, modelIds: allModels })
      const v3 = addReasoningEfforts(reread, { baseUrl: proxyUrl, modelIds: supported })
      if (v1.code !== 'EXISTS' || v2.code !== 'NO_CHANGE' || v3.added.length > 0) {
        verify = 'verify-after-write: settings.yaml did not round-trip cleanly - check the provider block'
      }
    } catch (e) {
      verify = 'verify-after-write failed: ' + String((e && e.message) || e)
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
    verify,
    restartNeeded: true,
  }
}
