// test/prices.test.js - unit tests for lib/prices.js
//
// lib/prices.js touches <DSH_HOME>, so every test points DSH_HOME at a fresh
// temp dir before importing. Run: npm test (node --test test/).

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function freshPricesModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owui-prices-'))
  process.env.DSH_HOME = dir
  // The query string makes each import a distinct module instance, so the
  // module-level price state (and the lazily-computed file path) is isolated
  // per test even though lib/config.js itself is only loaded once.
  return import('../lib/prices.js?case=' + dir.replace(/\\/g, '/'))
}

test('savePrices/loadPrices: round-trip with validation and all-zero drop', async () => {
  const { savePrices, loadPrices } = await freshPricesModule()
  const saved = savePrices({
    currency: '$ ',
    prices: {
      'model-a': { input: 2, cached: 0.2, output: 8 },
      'model-b': { input: 0, cached: 0, output: 0 }, // all-zero rows are dropped
      'model-c': { input: -5, cached: NaN, output: 'x' }, // invalid -> 0 -> dropped
    },
  })
  assert.equal(saved.currency, '$')
  assert.deepEqual(Object.keys(saved.prices), ['model-a'])
  const loaded = loadPrices()
  assert.deepEqual(loaded.prices['model-a'], { input: 2, cached: 0.2, output: 8 })
})

test('costFor: fresh+cached+output formula matches console-style pricing', async () => {
  const { savePrices, costFor } = await freshPricesModule()
  savePrices({ currency: '¥', prices: { 'glm-5.3-flash': { input: 2, cached: 0.2, output: 8 } } })
  // (1M - 400k) fresh prompt * 2 + 400k cached * 0.2 + 0.5M output * 8 = 5.28
  const r = costFor('glm-5.3-flash', 1_000_000, 500_000, 400_000)
  assert.equal(r.priced, true)
  assert.equal(Math.round(r.cost * 1e9) / 1e9, 5.28)
})

test('costFor: cached tokens are clamped to prompt tokens and fall back to input price', async () => {
  const { savePrices, costFor } = await freshPricesModule()
  savePrices({ currency: '¥', prices: { 'm': { input: 1, cached: null, output: 2 } } })
  // cached reported (500) above prompt (100): clamp to 100; cached price unset -> input price
  // cost = 0 + 100/1e6*1 + 100/1e6*2 = 0.0003
  const r = costFor('m', 100, 100, 500)
  assert.equal(r.priced, true)
  assert.equal(Math.round(r.cost * 1e9) / 1e9, 0.0003)
})

test('costFor: unpriced models are reported, never billed', async () => {
  const { costFor } = await freshPricesModule()
  const r = costFor('never-priced', 9999, 9999, 0)
  assert.equal(r.priced, false)
  assert.equal(r.cost, null)
})

test('loadPrices: survives a corrupt file (defaults kept)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owui-prices-'))
  process.env.DSH_HOME = dir
  fs.writeFileSync(path.join(dir, 'dsh-owui-chat2api-prices.json'), '{ not json !', 'utf8')
  const { loadPrices } = await import('../lib/prices.js?case=' + dir.replace(/\\/g, '/'))
  const loaded = loadPrices()
  assert.equal(loaded.currency, '¥')
  assert.deepEqual(loaded.prices, {})
})
