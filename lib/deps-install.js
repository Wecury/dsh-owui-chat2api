// lib/deps-install.js - one-click runtime dependency install (HOST half).
//
// The panel's diagnostics card can report "missing deps: pip install requests
// playwright" - telling a user who just installed a plugin to open a terminal and
// type that is exactly the friction this module removes. POST
// /api/install-deps runs the same three commands the README lists, in order:
//
//   1. <python> -m pip install requests playwright   (+ --user on a system python)
//   2. <python> -m playwright install chromium
//   3. <python> -m pip install tiktoken               (optional, best effort)
//
// Same async response pattern as start/login/effort-scan: the POST returns at once,
// the work runs off the request path, and the panel converges through its normal
// status poll (the `depsInstall` field). Every command's output is streamed into
// the shared process log, so a slow pip is visible instead of a frozen button.
//
// Invariant (shared with every other host route): no web handler ever blocks.

import { spawn } from 'node:child_process'
import { diag, probe } from './diagnostics.js'
import { pushLog, isRunning } from './proxy-process.js'

// pip can legitimately take minutes on a slow link (playwright pulls a wheel plus
// its greenlet/pyee deps); the browser download is larger still. Both are bounded
// so a hung network call cannot leave the button spinning forever.
const PIP_TIMEOUT_MS = 8 * 60 * 1000
const BROWSER_TIMEOUT_MS = 15 * 60 * 1000
const PROBE_TIMEOUT_MS = 30 * 1000
const LOG_PREFIX = '[deps]'

let busy = false

// Mirrors loginState/scanState: the panel reads this through /api/status.
export const depsState = {
  running: false,
  startedAt: 0,
  step: '',        // the step currently running, e.g. 'pip install requests playwright'
  steps: [],       // [{label, ok, skipped, detail}] in completion order
  result: '',      // 'ok' | 'fail' | ''
  resultAt: 0,
  message: '',     // one line for the notice bar (English; the panel translates)
}

// Run one child, stream its output into the process log, collect it, and resolve
// (never reject) with the outcome. A timeout kills the child and is reported as a
// failure with the partial output, so the panel can show what pip said last.
function runStreaming(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String((e && e.message) || e), timedOut: false, spawnError: true })
      return
    }
    let out = ''
    let errOut = ''
    let settled = false
    let to = null
    const finish = (r) => {
      if (settled) return
      settled = true
      if (to) clearTimeout(to)
      resolve(r)
    }
    to = setTimeout(() => {
      try { child.kill() } catch (e) { /* already gone */ }
      finish({ code: null, stdout: out, stderr: errOut, timedOut: true })
    }, timeoutMs)
    // stdout and stderr are collected separately (pip writes its real errors to
    // stderr, and the PEP 668 / no-pip checks below match on stderr) but both are
    // streamed into the shared log, so the panel shows the whole story.
    const stream = (b, intoStderr) => {
      const text = String(b)
      if (intoStderr) errOut += text
      else out += text
      for (const line of text.split(/\r?\n/)) {
        const s = line.trim()
        if (s) pushLog(LOG_PREFIX + ' ' + s)
      }
    }
    try { if (child.stdout) child.stdout.on('data', (b) => stream(b, false)) } catch (e) {}
    try { if (child.stderr) child.stderr.on('data', (b) => stream(b, true)) } catch (e) {}
    child.on('error', (e) => finish({ code: null, stdout: out, stderr: String((e && e.message) || e), timedOut: false, spawnError: true }))
    child.on('close', (code) => finish({ code, stdout: out, stderr: errOut, timedOut: false }))
  })
}

// Last non-empty line of a child's output - the one line worth showing when a
// step fails (pip's actual error, not the whole wall of progress bars).
function lastLine(r) {
  const text = String((r && (r.stderr || r.stdout)) || '')
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  return lines.length ? lines[lines.length - 1].slice(0, 240) : ''
}

// A system Python usually cannot write to its own site-packages (Program Files on
// Windows, /usr/lib on Linux), so pip needs --user there; inside a venv --user is
// refused outright. Ask the interpreter rather than guessing.
async function isVenv(py) {
  const r = await runStreaming(py, ['-c', "import sys;print('venv' if sys.prefix!=sys.base_prefix else 'system')"], {
    timeoutMs: PROBE_TIMEOUT_MS,
  })
  return r.code === 0 && /venv/.test(String(r.stdout))
}

async function pipInstall(py, pkgs, userFlag, timeoutMs) {
  const args = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input']
  if (userFlag) args.push('--user')
  args.push(...pkgs)
  return runStreaming(py, args, { timeoutMs })
}

function stepDone(label, r, { optional = false } = {}) {
  const ok = r.code === 0
  // A spawn failure (ENOENT/EINVAL - the interpreter vanished, or the path is not
  // executable) has no exit code, so reporting 'exit null' would be useless; name
  // the actual problem instead.
  const detail = ok ? ''
    : r.spawnError ? ('could not run it: ' + (lastLine(r) || 'spawn failed'))
    : r.timedOut ? 'timed out'
    : lastLine(r) || ('exit ' + r.code)
  depsState.steps.push({ label, ok, skipped: false, optional, detail })
  return ok
}

async function runInstall() {
  const py = diag.pythonPath
  const venv = await isVenv(py)
  const userFlag = !venv

  // 1) The two hard requirements from chat2api/requirements.txt.
  depsState.step = 'pip install requests playwright'
  let r = await pipInstall(py, ['requests', 'playwright'], userFlag, PIP_TIMEOUT_MS)
  if (r.code !== 0) {
    // PEP 668 systems (Debian/Ubuntu, some Windows Store Pythons) refuse a
    // system-wide install; the flag exists for exactly this refusal.
    if (/externally-managed-environment/i.test(String(r.stderr || ''))) {
      depsState.step = 'pip install requests playwright (--break-system-packages)'
      const args = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', '--break-system-packages', 'requests', 'playwright']
      r = await runStreaming(py, args, { timeoutMs: PIP_TIMEOUT_MS })
    }
    if (/No module named pip/i.test(String(r.stderr || ''))) {
      return fail('this Python has no pip - install Python from python.org (it bundles pip) and try again')
    }
    if (!stepDone('pip install requests playwright', r)) {
      return fail('pip install failed: ' + (r.timedOut ? 'timed out' : lastLine(r)))
    }
  } else {
    stepDone('pip install requests playwright', r)
  }

  // 2) The chromium build playwright drives; without it the first start opens
  //    nothing and the login flow fails with a confusing message.
  depsState.step = 'playwright install chromium'
  r = await runStreaming(py, ['-m', 'playwright', 'install', 'chromium'], { timeoutMs: BROWSER_TIMEOUT_MS })
  if (!stepDone('playwright install chromium', r)) {
    return fail('playwright browser download failed: ' + (r.timedOut ? 'timed out' : lastLine(r)))
  }

  // 3) tiktoken is optional (usage is estimated without it), so a failure here
  //    is recorded but never fails the install.
  depsState.step = 'pip install tiktoken (optional)'
  r = await pipInstall(py, ['tiktoken'], userFlag, PIP_TIMEOUT_MS)
  stepDone('pip install tiktoken (optional)', r, { optional: true })

  return ok()
}

function ok() {
  depsState.result = 'ok'
  depsState.resultAt = Date.now()
  depsState.message = 'dependencies installed'
  pushLog(LOG_PREFIX + ' done - requests + playwright + chromium ready')
  return { ok: true }
}

function fail(message) {
  depsState.result = 'fail'
  depsState.resultAt = Date.now()
  depsState.message = message
  pushLog(LOG_PREFIX + ' failed: ' + message)
  return { ok: false, message }
}

async function install() {
  try {
    return await runInstall()
  } catch (e) {
    return fail(String((e && e.message) || e))
  } finally {
    busy = false
    depsState.running = false
    depsState.step = ''
    // Re-probe so the diagnostics card flips to Ready without waiting for the
    // 20s cache to expire on its own.
    probe(true).catch(() => {})
  }
}

// Kick the install off the request path (mirrors startImpl/loginImpl). Returns
// immediately; the panel follows the progress through /api/status.
export function startDepsInstall() {
  if (busy) return { ok: false, message: 'a dependency install is already running' }
  if (!diag.pythonPath || diag.python !== 'ok') {
    return { ok: false, message: 'python not found in PATH - install Python 3 first, then retry' }
  }
  busy = true
  depsState.running = true
  depsState.startedAt = Date.now()
  depsState.step = ''
  depsState.steps = []
  depsState.result = ''
  depsState.resultAt = 0
  depsState.message = ''
  if (isRunning()) pushLog(LOG_PREFIX + ' note: the proxy is running - the new packages apply on its next start')
  pushLog(LOG_PREFIX + ' installing into ' + (diag.pythonPath || 'python') + ' - this can take a few minutes')
  install().catch(() => {})
  return { ok: true, async: true, message: 'dependency install started - this can take a few minutes' }
}
