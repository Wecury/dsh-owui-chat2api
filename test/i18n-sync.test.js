// test/i18n-sync.test.js - the panel's strings must have exactly one owner.
//
// lib/panel.js's FALLBACK object is the source of truth for the panel's own UI
// strings. lib/panel-i18n.js used to duplicate them as a `dict` section merged OVER
// that fallback, so a stale served copy silently won and a key added to panel.js never
// showed up. The served file now carries host-message translations (msg) only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8')

// The FALLBACK object literal, bounded by two stable anchors (no parser needed).
function fallbackSource() {
  const src = read('lib/panel.js')
  const from = src.indexOf('var FALLBACK = {')
  const to = src.indexOf('function dicts()', from)
  assert.ok(from > 0 && to > from, 'lib/panel.js no longer contains the FALLBACK ... dicts() anchors')
  return src.slice(from, to)
}

test('the served i18n script carries host messages only (panel.js owns UI strings)', () => {
  const src = read('lib/panel-i18n.js')
  assert.match(src, /window\.__dshOwuiI18n\s*=/, 'panel-i18n.js must assign window.__dshOwuiI18n')
  assert.match(src, /msg\s*:/, 'panel-i18n.js must define the msg table')
  assert.ok(!/\bdict\s*:/.test(src), 'panel-i18n.js must not duplicate panel UI strings - they live in lib/panel.js FALLBACK')
})

test('every t(key) used by panel.js exists in its FALLBACK object', () => {
  const src = read('lib/panel.js')
  const fallback = fallbackSource()
  const used = new Set()
  for (const m of src.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'\s*\)/g)) used.add(m[1])
  assert.ok(used.size > 20, 'expected to find the panel\'s t() calls, found ' + used.size)
  const missing = [...used].filter((k) => !new RegExp('(^|[\\s{,])' + k + ':').test(fallback))
  assert.deepEqual(missing, [], 'these t() keys have no string in lib/panel.js FALLBACK')
})

test('host message keys stay ASCII (panel.js normalises U+2026 before lookup)', () => {
  const src = read('lib/panel-i18n.js')
  const msg = src.slice(src.indexOf('msg: {'))
  const bad = [...msg.matchAll(/'([^']*[\u2026][^']*)'\s*:/g)].map((m) => m[1])
  assert.deepEqual(bad, [], 'msg keys must use ASCII "..." - U+2026 keys never match')
})
