// lib/prices.js - manual per-model price table for cost estimation (HOST half).
//
// Borrowed from the upstream author's openwebui-console: the user enters prices
// by hand (per million tokens, in one currency label of their choice); nothing
// is fetched or guessed. Cached prompt tokens are billed at their own price
// (falling back to the input price when unset), non-cached prompt at the input
// price, completion tokens (reasoning included) at the output price. Models
// without a price are counted but never billed.
//
// Storage lives OUTSIDE the plugin dir: <DSH_HOME>/dsh-owui-chat2api-prices.json
// (survives plugin updates/renames, same contract as the usage DB).

import fs from 'node:fs'
import path from 'node:path'
import { DSH_HOME } from './config.js'

// Computed lazily (not at import time) so tests can point DSH_HOME at a fresh
// temp dir per case; at runtime the env var never changes.
function pricesFile() {
  return path.join(process.env.DSH_HOME || DSH_HOME, 'dsh-owui-chat2api-prices.json')
}

const state = { currency: '¥', prices: {} }

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

export function loadPrices() {
  try {
    const parsed = JSON.parse(fs.readFileSync(pricesFile(), 'utf8'))
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.currency === 'string' && parsed.currency.trim()) state.currency = parsed.currency.trim().slice(0, 8)
      if (parsed.prices && typeof parsed.prices === 'object') {
        const clean = {}
        for (const [m, p] of Object.entries(parsed.prices)) {
          if (!m || typeof p !== 'object') continue
          clean[m] = {
            input: num(p.input),
            cached: num(p.cached),
            output: num(p.output),
          }
        }
        state.prices = clean
      }
    }
  } catch (e) { /* keep defaults */ }
  return { currency: state.currency, prices: state.prices }
}

export function savePrices(patch) {
  loadPrices() // ensure state is hydrated
  if (patch && typeof patch.currency === 'string' && patch.currency.trim()) {
    state.currency = patch.currency.trim().slice(0, 8)
  }
  if (patch && patch.prices && typeof patch.prices === 'object') {
    const clean = {}
    for (const [m, p] of Object.entries(patch.prices)) {
      if (!m || typeof p !== 'object') continue
      const row = { input: num(p.input), cached: num(p.cached), output: num(p.output) }
      if (row.input || row.cached || row.output) clean[m] = row // all-zero rows are dropped
    }
    state.prices = clean
  }
  try {
    fs.writeFileSync(pricesFile(), JSON.stringify({ currency: state.currency, prices: state.prices }, null, 2) + '\n', 'utf8')
  } catch (e) { /* best effort, like the control file */ }
  return { currency: state.currency, prices: state.prices }
}

export function priceFor(model) {
  const row = state.prices[String(model || '')]
  return row || null
}

// Estimate the cost of one aggregated usage row. Cached prompt tokens fall
// back to the input price when no cached price was entered.
export function costFor(model, inTokens, outTokens, cachedTokens) {
  const p = priceFor(model)
  if (!p) return { cost: null, priced: false }
  const cached = Math.min(Math.max(0, Number(cachedTokens) || 0), Math.max(0, Number(inTokens) || 0))
  const fresh = Math.max(0, (Number(inTokens) || 0) - cached)
  const cachedPrice = p.cached > 0 ? p.cached : p.input
  const cost = fresh / 1e6 * p.input + cached / 1e6 * cachedPrice + (Number(outTokens) || 0) / 1e6 * p.output
  return { cost, priced: true }
}
