// lib/process-kill.js - make "Stop" actually stop the python child (HOST half).
//
// Why this module exists. `child.kill()` is fire-and-forget and only ever knows
// the child THIS module instance spawned. Two routine situations break that:
//
//   1. The DSH host restarts (update, crash, plugin reload) while python runs.
//      Windows does not kill children with their parent, so the old python keeps
//      listening; the fresh module starts with handle === null and runtimeStatus
//      'stopped'. The panel therefore showed "Stopped" while a python was still
//      serving on the port.
//   2. python's ThreadingHTTPServer sets SO_REUSEADDR, and on Windows
//      SO_REUSEADDR lets a second process bind a port that is already bound. A
//      leftover plus a freshly spawned child can both "listen" on the same port,
//      which makes "the UI says stopped but the port still answers" reproducible
//      even with a live handle.
//
// So stopping has to be verified, not assumed: kill, wait for the exit, and if the
// process survives, force-kill it. On top of that, sweep any chat2api.py process
// still bound to our configured port, whatever spawned it.

import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'

const IS_WIN = process.platform === 'win32'

// Run a short-lived helper and collect its output. Resolves (never rejects) so the
// callers can treat any failure as "could not tell" instead of throwing.
function run(cmd, args, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      resolve({ code: -1, out: '', err: String((e && e.message) || e) })
      return
    }
    let out = ''
    let err = ''
    let settled = false
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(to); resolve(r) } }
    const to = setTimeout(() => {
      try { child.kill() } catch (e) { /* gone */ }
      finish({ code: -1, out, err: err + ' (timeout)', timedOut: true })
    }, timeoutMs)
    try { if (child.stdout) child.stdout.on('data', (b) => { out += String(b) }) } catch (e) {}
    try { if (child.stderr) child.stderr.on('data', (b) => { err += String(b) }) } catch (e) {}
    child.on('error', (e) => finish({ code: -1, out, err: String((e && e.message) || e) }))
    child.on('close', (code) => finish({ code, out, err }))
  })
}

function psArgs(script) {
  return IS_WIN
    ? ['-NoProfile', '-NonInteractive', '-Command', script]
    : ['-NoProfile', '-Command', script]
}

// Parse the "<pid>\t<cmdline>" lines the enumeration prints. Pure so it can be
// tested without spawning powershell.
export function parsePidLines(out, { includeLogin = false, port = null } = {}) {
  const pids = []
  const wantPort = port ? String(port) : ''
  for (const line of String(out || '').split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    const m = s.match(/^(\d+)\s+(.*)$/)
    if (!m) continue
    const pid = Number(m[1])
    if (!pid || pid === process.pid) continue
    const cmdline = m[2]
    // The powershell/ps side already filters on the script name, but this module
    // decides what to KILL: re-check here so a broadened query can never make Stop
    // reap an unrelated python.
    if (cmdline.indexOf('chat2api.py') === -1) continue
    if (!includeLogin && /(^|\s)--login(\s|$)/.test(cmdline)) continue
    // Port scoping keeps Stop from reaching into another profile's proxy (two DSH
    // installs, each with its own chat2api on its own port). A process with no
    // --port runs on python's default, which is only "ours" when we are on 8000.
    if (wantPort) {
      const pm = cmdline.match(/--port[=\s]+(\d+)/)
      const itsPort = pm ? pm[1] : '8000'
      if (itsPort !== wantPort) continue
    }
    pids.push({ pid, cmdline })
  }
  return pids
}

// Every process whose command line runs chat2api.py.
//
// `--login` children are excluded by default: the login flow opens a browser and
// waits for the user, and a Start (which reaps before spawning) must not tear that
// down behind the user's back. `includeLogin: true` returns them too.
//
// `port` scopes the answer to OUR proxy. Two DSH installs (web + desktop, or two
// profiles) each run their own chat2api.py; without this, Stop in one would kill
// the other's proxy.
export async function chat2apiPids({ includeLogin = false, port = null } = {}) {
  const script = IS_WIN
    ? "Get-CimInstance Win32_Process -Filter \"Name='python.exe' OR Name='pythonw.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*chat2api.py*' } | " +
      "ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"
    : "ps -eo pid=,args= | grep '[c]hat2api\\.py'"
  const cmd = IS_WIN ? 'powershell' : 'sh'
  const args = IS_WIN ? psArgs(script) : ['-c', script]
  const r = await run(cmd, args)
  // "No output and an error" means the enumeration itself failed (no powershell, a
  // policy block, a timeout) - NOT "nothing is running". Reporting [] in that case
  // would let Stop claim success while python keeps serving, so the callers must be
  // able to tell the difference and fall back to a port probe.
  const saidNothing = !String(r.out || '').trim()
  if (saidNothing && (r.timedOut || String(r.err || '').trim())) {
    throw new Error('process enumeration failed: ' + (r.timedOut ? 'timeout' : String(r.err).trim().split(/\r?\n/)[0]))
  }
  return parsePidLines(r.out, { includeLogin, port })
}

// Is this pid still alive? Works for processes we did not spawn.
export function isAlive(pid) {
  try { process.kill(Number(pid), 0); return true } catch (e) { return e && e.code === 'EPERM' }
}

// Hard kill. `child.kill()` only signals the direct child; taskkill /T also takes
// the tree (a py.exe launcher shim has python as its own child).
export async function killTree(pid) {
  const n = Number(pid)
  if (!n || n === process.pid) return false
  if (IS_WIN) {
    const r = await run('taskkill', ['/PID', String(n), '/T', '/F'], { timeoutMs: 8000 })
    if (r.code === 0) return true
    // taskkill says "not found" when it is already gone - not a failure for us.
    if (/not found|not running/i.test(String(r.err || '') + String(r.out || ''))) return false
  }
  try { process.kill(n, 'SIGKILL'); return true } catch (e) { return false }
}

// Synchronous variant, for teardown paths that must finish before the host process
// exits (a killed parent does NOT take its python child with it on Windows, so an
// async taskkill fired from a shutdown hook can be cut off mid-flight).
export function killTreeSync(pid, timeoutMs = 5000) {
  const n = Number(pid)
  if (!n || n === process.pid) return false
  try {
    if (IS_WIN) {
      const r = spawnSync('taskkill', ['/PID', String(n), '/T', '/F'], { timeout: timeoutMs, windowsHide: true })
      return !!(r && r.status === 0)
    }
    process.kill(n, 'SIGKILL')
    return true
  } catch (e) {
    return false
  }
}

// Is something accepting TCP connections on host:port? A direct connect is fast
// (single-digit ms) and needs no powershell, so it is the check that still works
// when process enumeration is unavailable. Note `netstat` is NOT usable here: on
// Windows a python listener often shows up without a LISTENING state line.
export function portOpen(host, port, ms = 600) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      try { socket.destroy() } catch (e) {}
      resolve(v)
    }
    socket.setTimeout(ms)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    try { socket.connect(Number(port), host || '127.0.0.1') } catch (e) { finish(false) }
  })
}

// Resolve once the pid disappears (or the deadline passes).
export function waitGone(pid, ms) {
  return new Promise((resolve) => {
    const deadline = Date.now() + Math.max(0, ms)
    const tick = () => {
      if (!isAlive(pid)) { resolve(true); return }
      if (Date.now() >= deadline) { resolve(false); return }
      setTimeout(tick, 120)
    }
    tick()
  })
}

// Kill every chat2api.py process that is NOT the child we already handled, and
// report what was reaped plus what refused to die. This is the piece that fixes
// "Stop only stops the UI".
export async function reapStragglers(keepPid, { port = null } = {}) {
  const killed = []
  const remaining = []
  const found = await chat2apiPids({ port })
  for (const p of found) {
    if (keepPid && p.pid === Number(keepPid)) continue
    await killTree(p.pid)
    // taskkill's exit code is not proof: verify the pid is really gone.
    if (await waitGone(p.pid, 2000)) killed.push(p.pid)
    else remaining.push(p.pid)
  }
  return { killed, remaining }
}

export { IS_WIN }
