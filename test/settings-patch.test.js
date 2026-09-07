// test/settings-patch.test.js - unit tests for lib/settings-patch.js
//
// settings-patch.js is the only code that edits the user's core DSH config
// (settings.yaml), and it is pure text-in/text-out - ideal for table tests.
// Run: node --test test/
//
// Fixtures mirror the real DSH schema: llm-pi-ai > providers > <name> >
// (api / baseURL / headers / models > - id: / name:).

import test from 'node:test'
import assert from 'node:assert/strict'
import { addModels, ensureProvider, addReasoningEfforts } from '../lib/settings-patch.js'

const FIXTURE = [
  '# my settings - a comment that must survive every patch',
  'llm-pi-ai:',
  '  providers:',
  '    local-owui:',
  '      api: openai-completions',
  '      baseURL: http://127.0.0.1:8000/v1  # the local proxy',
  '      headers:',
  '        Authorization: Bearer chat2api-local',
  '      models:',
  '        - id: deepseek-chat',
  '          name: deepseek-chat',
  '        - id: deepseek-reasoner',
  '          name: deepseek-reasoner',
  '    other-provider:',
  '      api: openai-completions',
  '      baseURL: https://api.example.com/v1',
  '      models:',
  '        - id: gpt-x',
  '          name: gpt-x',
  '',
].join('\n')

// ---- addReasoningEfforts ----

test('addReasoningEfforts: adds effort block under matching provider models', () => {
  const r = addReasoningEfforts(FIXTURE, { baseUrl: 'http://localhost:8000/v1', modelIds: ['deepseek-chat', 'deepseek-reasoner'] })
  assert.equal(r.ok, true)
  assert.equal(r.code, 'CHANGED')
  assert.deepEqual(r.added.sort(), ['deepseek-chat', 'deepseek-reasoner'])
  assert.deepEqual(r.skipped, [])
  // Effort block sits at the same level as `name:` (item indent + 2 = 10).
  assert.ok(r.text.includes('          reasoningEfforts:'), 'effort key line present')
  assert.ok(r.text.includes('            off: null'), 'effort sub-key present')
  // It is spliced right after the `- id:` line, still inside the same list
  // item mapping (before `name:`) - valid YAML either way.
  assert.ok(
    /- id: deepseek-chat\n          reasoningEfforts:\n            off: null\n            low: low\n            medium: medium\n            high: high\n          name: deepseek-chat/.test(r.text),
    'effort block lands inside the deepseek-chat item'
  )
})

test('addReasoningEfforts: localhost normalises to 127.0.0.1 (hostKey match)', () => {
  // Fixture declares 127.0.0.1; patching by localhost:8000 must still match.
  const r = addReasoningEfforts(FIXTURE, { baseUrl: 'http://localhost:8000/v1', modelIds: ['deepseek-chat'] })
  assert.equal(r.code, 'CHANGED')
})

test('addReasoningEfforts: idempotent - second run is NO_CHANGE and reports already', () => {
  const first = addReasoningEfforts(FIXTURE, { baseUrl: 'http://127.0.0.1:8000/v1', modelIds: ['deepseek-chat'] })
  assert.equal(first.code, 'CHANGED')
  const second = addReasoningEfforts(first.text, { baseUrl: 'http://127.0.0.1:8000/v1', modelIds: ['deepseek-chat'] })
  assert.equal(second.ok, true)
  assert.equal(second.code, 'NO_CHANGE')
  assert.deepEqual(second.added, [])
  assert.deepEqual(second.already, ['deepseek-chat'])
})

test('addReasoningEfforts: preserves comments, ordering and unrelated providers byte-for-byte', () => {
  const r = addReasoningEfforts(FIXTURE, { baseUrl: 'http://127.0.0.1:8000/v1', modelIds: ['deepseek-chat'] })
  const lines = r.text.split('\n')
  assert.equal(lines[0], '# my settings - a comment that must survive every patch')
  assert.ok(r.text.includes('baseURL: http://127.0.0.1:8000/v1  # the local proxy'), 'inline comment preserved')
  // The unrelated provider block is untouched: find it and check its slice.
  const i = r.text.indexOf('    other-provider:')
  const slice = r.text.slice(i, r.text.indexOf('\n', r.text.indexOf('name: gpt-x', i)))
  assert.equal(slice, '    other-provider:\n      api: openai-completions\n      baseURL: https://api.example.com/v1\n      models:\n        - id: gpt-x\n          name: gpt-x')
})

test('addReasoningEfforts: models absent from settings are reported as skipped', () => {
  const r = addReasoningEfforts(FIXTURE, { baseUrl: 'http://127.0.0.1:8000/v1', modelIds: ['deepseek-chat', 'not-declared'] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.added, ['deepseek-chat'])
  assert.deepEqual(r.skipped, ['not-declared'])
  assert.ok(!r.text.includes('not-declared'))
})

test('addReasoningEfforts: explicit provider name match', () => {
  const r = addReasoningEfforts(FIXTURE, { provider: 'local-owui', modelIds: ['deepseek-chat'] })
  assert.equal(r.code, 'CHANGED')
})

test('addReasoningEfforts: NO_PROVIDER when nothing points at the baseUrl', () => {
  const r = addReasoningEfforts(FIXTURE, { baseUrl: 'http://10.0.0.9:1234/v1', modelIds: ['deepseek-chat'] })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_PROVIDER')
  assert.equal(r.text, FIXTURE, 'input text untouched on failure')
})

test('addReasoningEfforts: NOOP on empty model list', () => {
  const r = addReasoningEfforts(FIXTURE, { baseUrl: 'http://127.0.0.1:8000/v1', modelIds: [] })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NOOP')
})

test('addReasoningEfforts: CRLF line endings are detected and preserved', () => {
  const crlf = FIXTURE.replace(/\n/g, '\r\n')
  const r = addReasoningEfforts(crlf, { baseUrl: 'http://127.0.0.1:8000/v1', modelIds: ['deepseek-chat'] })
  assert.equal(r.code, 'CHANGED')
  assert.ok(!r.text.includes('\r\n\n'), 'no mixed endings introduced')
  assert.equal(r.text.split('\r\n').length, r.text.split('\n').length, 'every newline is CRLF')
})

// ---- addModels ----

test('addModels: appends missing entries at the end of the models list', () => {
  const r = addModels(FIXTURE, { baseUrl: 'http://127.0.0.1:8000/v1', modelIds: ['deepseek-chat', 'new-model'] })
  assert.equal(r.ok, true)
  assert.equal(r.code, 'CHANGED')
  assert.deepEqual(r.added, ['new-model'])
  assert.deepEqual(r.already, ['deepseek-chat'])
  assert.ok(/- id: new-model\n          name: new-model/.test(r.text), 'id+name pair with the list-item indent')
  // Inserted after the last existing entry, before the next provider.
  const idxNew = r.text.indexOf('- id: new-model')
  const idxOther = r.text.indexOf('    other-provider:')
  assert.ok(idxNew > 0 && idxNew < idxOther)
})

test('addModels: idempotent - all present means NO_CHANGE', () => {
  const r = addModels(FIXTURE, { baseUrl: 'http://127.0.0.1:8000/v1', modelIds: ['deepseek-chat', 'deepseek-reasoner'] })
  assert.equal(r.code, 'NO_CHANGE')
  assert.deepEqual(r.added, [])
  assert.deepEqual(r.already.sort(), ['deepseek-chat', 'deepseek-reasoner'])
})

test('addModels: handles an empty models list (insert right after `models:`)', () => {
  const src = [
    'llm-pi-ai:',
    '  providers:',
    '    empty-p:',
    '      api: openai-completions',
    '      baseURL: http://127.0.0.1:8000/v1',
    '      models:',
    '    other:',
    '      baseURL: https://x.example.com/v1',
    '      models:',
    '        - id: keep-me',
    '          name: keep-me',
  ].join('\n')
  const r = addModels(src, { baseUrl: 'http://127.0.0.1:8000/v1', modelIds: ['fresh-model'] })
  assert.equal(r.code, 'CHANGED')
  assert.ok(/models:\n        - id: fresh-model\n          name: fresh-model\n    other:/.test(r.text))
})

test('addModels: NO_PROVIDER without a match', () => {
  const r = addModels(FIXTURE, { provider: 'no-such-provider', modelIds: ['m'] })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'NO_PROVIDER')
  assert.ok(r.message.includes('no-such-provider'))
})

// ---- ensureProvider ----

test('ensureProvider: EXISTS when a provider already points at the proxy', () => {
  const r = ensureProvider(FIXTURE, { baseUrl: 'http://127.0.0.1:8000/v1' })
  assert.equal(r.ok, true)
  assert.equal(r.code, 'EXISTS')
  assert.equal(r.text, FIXTURE, 'EXISTS never rewrites the file')
})

test('ensureProvider: creates the whole chain on a fresh settings file', () => {
  const fresh = '# brand new settings\n\n'
  const r = ensureProvider(fresh, { baseUrl: 'http://127.0.0.1:8000/v1' })
  assert.equal(r.ok, true)
  assert.equal(r.code, 'CREATED')
  assert.equal(r.name, 'chat2api')
  assert.ok(r.text.includes('llm-pi-ai:'))
  assert.ok(r.text.includes('  providers:'))
  assert.ok(r.text.includes('    chat2api:'))
  assert.ok(r.text.includes('      baseURL: http://127.0.0.1:8000/v1'))
  assert.ok(r.text.includes('        Authorization: Bearer chat2api-local'))
  assert.ok(r.text.includes('      models:'))
  assert.ok(r.text.endsWith('\n'), 'trailing newline kept')
})

test('ensureProvider: second run after creation is EXISTS (round-trip stable)', () => {
  const created = ensureProvider('# new\n', { baseUrl: 'http://127.0.0.1:8000/v1' })
  const again = ensureProvider(created.text, { baseUrl: 'http://127.0.0.1:8000/v1' })
  assert.equal(again.code, 'EXISTS')
})

test('ensureProvider: picks a free name when the default is taken', () => {
  // "chat2api" is taken by a provider that points ELSEWHERE, and nothing
  // points at the proxy -> a new provider must be created under a free name.
  const taken = FIXTURE
    .replace('local-owui:', 'chat2api:')
    .replace('http://127.0.0.1:8000/v1', 'https://elsewhere.example.com/v1')
  const r = ensureProvider(taken, { baseUrl: 'http://127.0.0.1:8000/v1' })
  assert.equal(r.code, 'CREATED')
  assert.equal(r.name, 'chat2api-1')
  assert.ok(r.text.includes('    chat2api-1:'))
  assert.ok(r.text.includes('      baseURL: http://127.0.0.1:8000/v1'))
  // The taken provider is untouched.
  assert.ok(r.text.includes('    chat2api:\n      api: openai-completions\n      baseURL: https://elsewhere.example.com/v1'))
})

// ---- the full effort-scan pipeline invariant (verify-after-write) ----

test('pipeline: ensureProvider + addModels + addReasoningEfforts re-run finds everything already present', () => {
  const proxyUrl = 'http://127.0.0.1:8000/v1'
  const allModels = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-new']
  const supported = ['deepseek-chat', 'deepseek-reasoner']

  // Round 1 on a fresh file (no provider at all yet).
  let text = FIXTURE
  const p1 = ensureProvider(text, { baseUrl: proxyUrl })
  assert.equal(p1.code, 'EXISTS') // fixture already points at the proxy
  text = p1.text
  const m1 = addModels(text, { baseUrl: proxyUrl, modelIds: allModels })
  assert.equal(m1.code, 'CHANGED')
  text = m1.text
  const e1 = addReasoningEfforts(text, { baseUrl: proxyUrl, modelIds: supported })
  assert.equal(e1.code, 'CHANGED')
  text = e1.text

  // Round 2 = exactly what effort-scan's verify-after-write does: everything
  // must now report as already present, with zero further edits.
  const p2 = ensureProvider(text, { baseUrl: proxyUrl })
  const m2 = addModels(text, { baseUrl: proxyUrl, modelIds: allModels })
  const e2 = addReasoningEfforts(text, { baseUrl: proxyUrl, modelIds: supported })
  assert.equal(p2.code, 'EXISTS')
  assert.equal(m2.code, 'NO_CHANGE')
  assert.equal(e2.code, 'NO_CHANGE')
  assert.deepEqual(e2.added, [])
})
