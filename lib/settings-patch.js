// lib/settings-patch.js - text-level patcher for DSH settings.yaml
//
// Adds a reasoningEfforts mapping to the model entries of the provider(s) whose
// baseURL points at the local chat2api proxy (matched by host:port), so it works
// for any deployment without hard-coding a provider name. It operates on the raw
// text - no YAML round-trip - so comments, ordering, unrelated providers and
// every other byte of the file are preserved. DSH merges `reasoningEfforts` at
// the same level as `name`, which is exactly what this produces. Returns what
// changed so the caller can back up and report.

const EFFORT_LINES = ['reasoningEfforts:', '  off: null', '  low: low', '  medium: medium', '  high: high']
const PROVIDER_KEY = /^(\s+)([A-Za-z0-9_.-]+)\s*:\s*(?:#.*)?$/
const MODEL_ID_RE = /^(\s+)- id:\s*([^#\s]+)\s*(?:#.*)?$/
const BASE_URL_RE = /^(\s+)(baseURL|baseUrl)\s*:\s*(.+?)\s*(?:#.*)?$/

// Normalise a URL to "host[:port]" (localhost treated as 127.0.0.1) so baseURL
// comparisons are immune to scheme, trailing slashes and the /v1 path suffix.
function hostKey(u) {
  const mm = String(u || '').match(/^(?:https?:\/\/)?([^/:]+)(?::(\d+))?/)
  if (!mm) return ''
  return (mm[1] === 'localhost' ? '127.0.0.1' : mm[1]) + (mm[2] ? ':' + mm[2] : '')
}

export function addReasoningEfforts(text, { provider = null, baseUrl = '', modelIds = [] } = {}) {
  const targets = new Set((modelIds || []).filter((m) => typeof m === 'string' && m.trim()))
  if (typeof text !== 'string' || targets.size === 0) {
    return { ok: false, code: 'NOOP', added: [], already: [], skipped: [...targets], message: 'nothing to patch' }
  }

  const nl = (text.match(/\r?\n/) || ['\n'])[0]
  const lines = String(text).split(/\r\n|\n|\r/)
  const wantKey = provider && provider !== '' ? null : hostKey(baseUrl)
  const blocks = []

  // Find provider blocks: an explicit name, or every mapping whose direct
  // children include a matching baseURL and a `models` list.
  for (let i = 0; i < lines.length; i++) {
    const pm = lines[i].match(PROVIDER_KEY)
    if (!pm) continue
    const ind = pm[1].length
    let kid = -1
    let url = null
    let hasModels = false
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j]
      const t = raw.trim()
      if (!t || t.startsWith('#')) continue
      const ind2 = raw.match(/^ */)[0].length
      if (ind2 <= ind) break
      if (kid === -1) kid = ind2
      if (ind2 !== kid) continue // only direct children of this mapping
      const bm = raw.match(BASE_URL_RE)
      if (bm) url = hostKey(bm[3])
      if (/^\s+models\s*:\s*$/.test(raw)) hasModels = true
    }
    if (!hasModels || kid === -1) continue
    const nameHit = wantKey === null && pm[2] === provider
    const urlHit = wantKey !== null && url === wantKey
    if (nameHit || urlHit) blocks.push({ index: i, indent: ind })
  }

  if (blocks.length === 0) {
    const message = wantKey === null
      ? 'provider "' + provider + ':" not found in settings'
      : 'no provider in settings points at ' + (baseUrl || 'the local proxy')
    return { ok: false, code: 'NO_PROVIDER', added: [], already: [], skipped: [...targets], message }
  }

  // Collect every `- id:` entry inside the matched blocks, and remember whether
  // its block already declares reasoningEfforts (a block ends at the next
  // `- id:` line or at any line indented no deeper than the provider line).
  const entries = []
  for (const blk of blocks) {
    let open = null
    for (let i = blk.index + 1; i < lines.length; i++) {
      const raw = lines[i]
      const t = raw.trim()
      if (!t || t.startsWith('#')) continue
      const ind = raw.match(/^ */)[0].length
      if (ind <= blk.indent) break
      const idm = raw.match(MODEL_ID_RE)
      if (idm) {
        open = { index: i, id: idm[2], indent: idm[1].length, hasEffort: false }
        entries.push(open)
        continue
      }
      if (open && /^\s+reasoningEfforts\s*:\s*$/.test(raw)) open.hasEffort = true
    }
  }

  const added = []
  const already = []
  const seen = new Set()
  for (const item of entries) {
    if (!targets.has(item.id)) continue
    seen.add(item.id)
    if (item.hasEffort) { if (already.indexOf(item.id) === -1) already.push(item.id) }
    else if (added.indexOf(item.id) === -1) added.push(item.id)
  }
  const skipped = [...targets].filter((id) => !seen.has(id))

  if (added.length === 0) {
    return { ok: true, code: 'NO_CHANGE', added, already, skipped }
  }

  const out = lines.slice()
  // Bottom-up so earlier inserts do not shift later indexes.
  for (const item of [...entries].reverse()) {
    if (!targets.has(item.id) || item.hasEffort) continue
    const pad = ' '.repeat(item.indent + 2)
    out.splice(item.index + 1, 0, ...EFFORT_LINES.map((l) => pad + l))
  }

  const result = out.join(nl)
  return { ok: true, code: result === text ? 'NO_CHANGE' : 'CHANGED', text: result, added, already, skipped }
}
