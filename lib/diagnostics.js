// lib/diagnostics.js - cached python/deps probing (HOST half).
//
// The only place python is probed. Results are cached for PROBE_TTL and
// re-probed in the background (setImmediate) when stale, so route handlers
// only ever read the cached snapshot. Split out of index.js (refactor step 5);
// behaviour is unchanged.

import { spawnSync } from 'node:child_process'
import { CHAT2API_DIR } from './config.js'

const PYTHONS = ['python', 'python3', 'py']
const PROBE_TTL = 20000

export const diag = { python: 'unknown', pythonPath: null, deps: 'unknown', message: '', checkedAt: 0 }
let pythonCmd = null
let pythonChecked = false

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

export function probe(refresh) {
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

export function probeAsync() {
  try { setImmediate(() => { try { probe(true) } catch (e) {} }) } catch (e) {}
}

export function diagnostics() {
  if (!diag.checkedAt || (Date.now() - diag.checkedAt >= PROBE_TTL)) probeAsync()
  return diag
}

// True when the cached probe is fresh AND reports python + deps healthy;
// start/login use it to decide between spawning now and deferring.
export function diagReady() {
  const fresh = diag.checkedAt && (Date.now() - diag.checkedAt < PROBE_TTL)
  return !!(fresh && diag.python === 'ok' && diag.deps === 'ok')
}
