// lib/diagnostics.js - cached python/deps probing (HOST half).
//
// The only place python is probed. Results are cached for PROBE_TTL and
// re-probed in the background when stale. Probing is fully ASYNC (spawn, not
// spawnSync): even a cold probe never blocks the event loop - route handlers
// only ever read the cached snapshot and let the background probe converge.
// Overlapping probes share one in-flight promise. Split out of index.js
// (refactor step 5); made async in step 6.

import { spawn } from 'node:child_process'
import { CHAT2API_DIR } from './config.js'

const PYTHONS = ['python', 'python3', 'py']
const PROBE_TTL = 20000

export const diag = { python: 'unknown', pythonPath: null, deps: 'unknown', message: '', checkedAt: 0 }
let pythonCmd = null
let pythonChecked = false
let probePromise = null

// Run a short-lived child and collect its outcome; resolve (never reject) so
// probe() can treat any failure as "unavailable". Semantics mirror the
// spawnSync call this replaced: status===0 success, anything else (including
// timeout kill / spawn error) failure, stdout/stderr preserved for messages.
function runProbeCmd(cmd, args, { cwd, timeoutMs } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ status: 1, stdout: '', stderr: String((e && e.message) || e) })
      return
    }
    let out = ''
    let errOut = ''
    let settled = false
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(to); resolve(r) } }
    const to = setTimeout(() => {
      try { child.kill() } catch (e) { /* gone */ }
      finish({ status: null, stdout: out, stderr: errOut, timedOut: true })
    }, timeoutMs)
    if (child.stdout) child.stdout.on('data', (b) => { out += String(b) })
    if (child.stderr) child.stderr.on('data', (b) => { errOut += String(b) })
    child.on('error', (e) => finish({ status: 1, stdout: out, stderr: String((e && e.message) || e) }))
    child.on('close', (code) => finish({ status: code, stdout: out, stderr: errOut }))
  })
}

async function findPython(refresh) {
  if (pythonChecked && !refresh) return pythonCmd
  pythonChecked = true
  pythonCmd = null
  for (const candidate of PYTHONS) {
    const r = await runProbeCmd(candidate, ['--version'], { timeoutMs: 4000 })
    if (r.status === 0) { pythonCmd = candidate; break }
    const out = String((r.stdout || '') + (r.stderr || ''))
    if (/python/i.test(out)) { pythonCmd = candidate; break }
  }
  return pythonCmd
}

// Probe python + deps. Returns a promise resolving to the shared diag object.
// Concurrent callers share the in-flight probe; with a fresh cache and no
// refresh flag this resolves immediately without spawning anything.
export function probe(refresh) {
  if (!refresh && diag.checkedAt && (Date.now() - diag.checkedAt < PROBE_TTL)) return Promise.resolve(diag)
  if (probePromise) return probePromise
  probePromise = doProbe().finally(() => { probePromise = null })
  return probePromise
}

async function doProbe() {
  diag.checkedAt = Date.now()
  const py = await findPython(true)
  if (!py) {
    diag.python = 'missing'; diag.pythonPath = null; diag.deps = 'unknown'
    diag.message = 'python not found in PATH'
    return diag
  }
  diag.python = 'ok'; diag.pythonPath = py
  let err = ''
  try {
    const r = await runProbeCmd(py, ['-c', 'import requests, playwright'], { cwd: CHAT2API_DIR, timeoutMs: 15000 })
    if (r.status !== 0) err = String((r.stderr || r.stdout || '').split('\n')[0] || 'import failed')
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

// Fire-and-forget background probe; never blocks anything (async spawn).
export function probeAsync() {
  probe(true).catch(() => {})
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
