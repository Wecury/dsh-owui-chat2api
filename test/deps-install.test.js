// test/deps-install.test.js - the spawn-free contract of lib/deps-install.js
//
// The install itself runs pip/playwright, so the happy path cannot live in the
// unit suite. What CAN be pinned here is everything the panel depends on without
// downloading anything: the shape of the state it polls, and the two refusals (no
// python, and a second concurrent install) that must never start a second child.
//
// Run: npm test (node --test test/).

import test from 'node:test'
import assert from 'node:assert/strict'
import { diag } from '../lib/diagnostics.js'
import { depsState, startDepsInstall } from '../lib/deps-install.js'

// Wait for the in-flight install to settle. Every case here points the installer at
// an interpreter that does not exist, so each step fails immediately - this is a
// sub-second wait, not a network call.
async function settle() {
  const t0 = Date.now()
  while (depsState.running && Date.now() - t0 < 20000) await new Promise((r) => setTimeout(r, 50))
}

test('depsState: exposes every field the panel reads through /api/status', () => {
  // index.js copies these exact keys into the status payload, and panel.js reads
  // them back - a rename here would silently blank the diagnostics card.
  for (const key of ['running', 'startedAt', 'step', 'steps', 'result', 'resultAt', 'message']) {
    assert.ok(key in depsState, 'depsState is missing "' + key + '"')
  }
  assert.equal(Array.isArray(depsState.steps), true)
  assert.equal(depsState.running, false)
})

test('startDepsInstall: refuses when no python was found, and spawns nothing', () => {
  const before = { running: depsState.running, startedAt: depsState.startedAt, steps: depsState.steps.length }
  diag.python = 'missing'
  diag.pythonPath = null
  const r = startDepsInstall()
  assert.equal(r.ok, false)
  assert.match(r.message, /python not found/i)
  // The refusal must be a no-op: the panel shows the reason, and a later click
  // (once python is installed) still starts a real install.
  assert.equal(depsState.running, before.running)
  assert.equal(depsState.startedAt, before.startedAt)
  assert.equal(depsState.steps.length, before.steps)
})

test('startDepsInstall: a second call while running is refused', async () => {
  // The guard that stops two pip processes from racing over the same
  // site-packages. Point the installer at an interpreter that does not exist so
  // the first run fails instantly and never touches the network.
  const saved = { python: diag.python, pythonPath: diag.pythonPath }
  diag.python = 'ok'
  diag.pythonPath = 'dsh-owui-no-such-python'
  try {
    const first = startDepsInstall()
    assert.equal(first.ok, true)
    assert.equal(depsState.running, true)
    const second = startDepsInstall()
    assert.equal(second.ok, false)
    assert.match(second.message, /already running/i)
    await settle()
  } finally {
    diag.python = saved.python
    diag.pythonPath = saved.pythonPath
  }
})

test('a failed install reports a usable reason, not "exit null"', async () => {
  // A spawn failure has no exit code, so the naive detail ("exit " + code) would
  // read "exit null" and tell the user nothing. It must name the real problem.
  const saved = { python: diag.python, pythonPath: diag.pythonPath }
  diag.python = 'ok'
  diag.pythonPath = 'dsh-owui-no-such-python'
  try {
    assert.equal(startDepsInstall().ok, true)
    await settle()
    assert.equal(depsState.result, 'fail')
    assert.match(depsState.message, /could not run it|ENOENT|no such/i)
    assert.doesNotMatch(depsState.message, /exit null/)
    assert.equal(depsState.steps.length > 0, true)
    assert.equal(depsState.steps[0].ok, false)
  } finally {
    diag.python = saved.python
    diag.pythonPath = saved.pythonPath
  }
})
