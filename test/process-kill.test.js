// test/process-kill.test.js - the pure half of lib/process-kill.js.
//
// The bug this module fixes was "Stop only stops the UI": the host killed the
// child it remembered, never checked that the process died, and could not touch a
// python left behind by a previous host run. The enumeration below decides which
// processes Stop is allowed to reap, so its parsing rules get a test: they are the
// difference between clearing a leftover and killing a login flow the user is
// still using.

import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { parsePidLines, portOpen } from '../lib/process-kill.js'

// Shape of the Windows output: "<pid>\t<full command line>".
const sample = [
  '19604\tpython chat2api.py --base-url https://chat.example.edu --host 127.0.0.1 --port 8000',
  '43712\tpython chat2api.py --login --base-url https://chat.example.edu --use-api-key --login-timeout 240',
  '1234\tpython -c "print(1)"',
  '',
  '   ',
  'not-a-pid\tpython chat2api.py',
].join('\r\n')

test('parsePidLines keeps the proxy and drops the login flow', () => {
  const pids = parsePidLines(sample)
  assert.deepEqual(pids.map((p) => p.pid), [19604])
  assert.match(pids[0].cmdline, /--port 8000$/)
})

test('parsePidLines can include the login flow when asked', () => {
  const pids = parsePidLines(sample, { includeLogin: true })
  assert.deepEqual(pids.map((p) => p.pid), [19604, 43712])
})

test('parsePidLines ignores blank, malformed and non-chat2api lines', () => {
  const pids = parsePidLines('19604\tpython chat2api.py\n\n  \nnot-a-pid\tx\nowner\tpython other.py')
  assert.deepEqual(pids.map((p) => p.pid), [19604])
})

test('parsePidLines tolerates empty and null output', () => {
  assert.deepEqual(parsePidLines(''), [])
  assert.deepEqual(parsePidLines(null), [])
  assert.deepEqual(parsePidLines(undefined), [])
})

test('parsePidLines drops this process (never reap ourselves)', () => {
  const out = String(process.pid) + '\tpython chat2api.py --port 8000'
  assert.deepEqual(parsePidLines(out), [])
})

test('parsePidLines keeps a leftover on a different port (port is not the key)', () => {
  const out = '9001\tpython chat2api.py --host 127.0.0.1 --port 8123'
  assert.deepEqual(parsePidLines(out).map((p) => p.pid), [9001])
})

// Two DSH installs can each run their own proxy; Stop must only reap OUR port.
test('parsePidLines scopes to one port when asked', () => {
  const out = [
    '19604\tpython chat2api.py --host 127.0.0.1 --port 8000',
    '20001\tpython chat2api.py --host 127.0.0.1 --port 8123',
    '20002\tpython chat2api.py --base-url https://x', // no --port: python's default
  ].join('\n')
  assert.deepEqual(parsePidLines(out, { port: 8000 }).map((p) => p.pid), [19604, 20002])
  assert.deepEqual(parsePidLines(out, { port: 8123 }).map((p) => p.pid), [20001])
  // No port given: everything, which is what reconcile's broad pass wants.
  assert.deepEqual(parsePidLines(out).map((p) => p.pid), [19604, 20001, 20002])
})

test('parsePidLines does not mistake --login-timeout for --login', () => {
  const out = '7001\tpython chat2api.py --login-timeout 240'
  assert.deepEqual(parsePidLines(out).map((p) => p.pid), [7001])
})

// portOpen is the fallback liveness check used when process enumeration is
// unavailable (no powershell, locked-down host). It must answer for both cases
// without throwing.
test('portOpen sees a real listener and reports a closed port as false', async () => {
  const server = net.createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  assert.equal(await portOpen('127.0.0.1', port), true)
  await new Promise((resolve) => server.close(resolve))
  assert.equal(await portOpen('127.0.0.1', port), false)
})

test('portOpen resolves false (never rejects) for a bad host', async () => {
  assert.equal(await portOpen('127.0.0.1', 1), false)
})
