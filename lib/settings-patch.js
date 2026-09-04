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

// Locate the provider block(s) to patch: an explicit name, or every mapping
// whose direct children include a matching baseURL and a `models` list.
function findProviderBlocks(lines, provider = null, baseUrl = '') {
  const wantKey = provider && provider !== '' ? null : hostKey(baseUrl)
  const blocks = []
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
    if (kid === -1 || !hasModels) continue
    const nameHit = wantKey === null && pm[2] === provider
    const urlHit = wantKey !== null && url === wantKey
    if (nameHit || urlHit) blocks.push({ index: i, indent: ind })
  }
  return blocks
}

// Append missing `- id:` entries to the `models` list(s) of the matching
// provider(s). A missing model gets `- id: <id>` plus a `name:` line, matching
// the file's existing entry shape. Text-level only: comments, ordering and every
// unrelated byte are preserved.
export function addModels(text, { provider = null, baseUrl = '', modelIds = [] } = {}) {
  const wanted = new Set((modelIds || []).filter((m) => typeof m === 'string' && m.trim()))
  if (typeof text !== 'string' || wanted.size === 0) {
    return { ok: false, code: 'NOOP', added: [], already: [], skipped: [...wanted], text, message: 'nothing to patch' }
  }
  const nl = (text.match(/\r?\n/) || ['\n'])[0]
  const lines = String(text).split(/\r\n|\n|\r/)
  const blocks = findProviderBlocks(lines, provider, baseUrl)
  if (blocks.length === 0) {
    const message = provider && provider !== ''
      ? 'provider "' + provider + ':" not found in settings'
      : 'no provider in settings points at ' + (baseUrl || 'the local proxy')
    return { ok: false, code: 'NO_PROVIDER', added: [], already: [], skipped: [...wanted], text, message }
  }

  const added = []
  const already = []
  const out = lines.slice()
  // Blocks bottom-up so an insert never shifts a later block's indexes.
  for (const blk of [...blocks].reverse()) {
    // Locate the direct-child `models:` key of this provider block.
    let modelsIdx = -1
    let modelsIndent = -1
    let kid = -1
    for (let i = blk.index + 1; i < lines.length; i++) {
      const raw = lines[i]
      const t = raw.trim()
      if (!t || t.startsWith('#')) continue
      const ind = raw.match(/^ */)[0].length
      if (ind <= blk.indent) break
      if (kid === -1) kid = ind
      if (ind !== kid) continue
      if (/^(\s+)models\s*:\s*$/.test(raw)) { modelsIdx = i; modelsIndent = raw.match(/^ */)[0].length; break }
    }
    if (modelsIdx < 0) continue

    // Existing ids, the list-item indent, and where the list ends.
    const ids = []
    let itemIndent = -1
    let lastItemStart = -1
    let listEnd = lines.length
    for (let i = modelsIdx + 1; i < lines.length; i++) {
      const raw = lines[i]
      const t = raw.trim()
      if (!t || t.startsWith('#')) continue
      const ind = raw.match(/^ */)[0].length
      if (ind <= modelsIndent) { if (lastItemStart >= 0) listEnd = i; break }
      const im = raw.match(MODEL_ID_RE)
      if (im) {
        if (itemIndent === -1) itemIndent = im[1].length
        if (im[1].length === itemIndent) { ids.push(im[2]); lastItemStart = i }
      }
    }
    if (itemIndent === -1) itemIndent = modelsIndent + 2

    const toAdd = [...wanted].filter((id) => ids.indexOf(id) === -1)
    for (const id of wanted) {
      if (ids.indexOf(id) !== -1 && already.indexOf(id) === -1) already.push(id)
    }
    if (toAdd.length === 0) continue

    const pad = ' '.repeat(itemIndent)
    const pad2 = ' '.repeat(itemIndent + 2)
    const newLines = []
    for (const id of toAdd) {
      newLines.push(pad + '- id: ' + id, pad2 + 'name: ' + id)
      added.push(id)
    }
    const insertAt = lastItemStart === -1 ? modelsIdx + 1 : listEnd
    out.splice(Math.min(insertAt, out.length), 0, ...newLines)
  }

  const result = out.join(nl)
  return { ok: true, code: result === text ? 'NO_CHANGE' : 'CHANGED', text: result, added, already, skipped: [] }
}

// Ensure a provider whose baseURL points at the local proxy exists; when none
// matches, create the whole llm-pi-ai > providers > <name> chain so a fresh
// install needs no manual "add provider" step. The provider carries an inline
// Authorization header: pi-ai skips its "No API key" check when a route has an
// authorization header, and the proxy ignores incoming keys anyway - so no
// apiKeyEnv/env-var/credential-store round-trip is needed and the block is fully
// self-contained in settings.yaml.
// Returns { ok, code: 'EXISTS'|'CREATED'|'NO_CHANGE', text, ... }.
export function ensureProvider(text, { provider = 'chat2api', baseUrl = '' } = {}) {
  baseUrl = String(baseUrl || '').trim()
  if (typeof text !== 'string' || !baseUrl) {
    return { ok: false, code: 'NOOP', message: 'provider creation needs settings text and baseUrl', text }
  }
  const nl = (text.match(/\r?\n/) || ['\n'])[0]
  const lines = String(text).split(/\r\n|\n|\r/)

  // Already declared for this proxy?
  if (findProviderBlocks(lines, null, baseUrl).length > 0) {
    return { ok: true, code: 'EXISTS', name: null, baseUrl, text }
  }

  // Pick a name that isn't already taken at the provider nesting level.
  const chainRe = /^(\s*)llm-pi-ai\s*:\s*(?:#.*)?$/
  let chainIdx = -1
  let chainInd = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(chainRe)
    if (m) { chainIdx = i; chainInd = m[1].length; break }
  }
  const pInd = chainInd + 2
  const nInd = chainInd + 4
  let name = provider
  const taken = {}
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s+)([A-Za-z0-9_.-]+)\s*:\s*(?:#.*)?$/)
    if (m && m[1].length === nInd) taken[m[2]] = 1
  }
  let suffix = 0
  while (taken[name]) { suffix += 1; name = provider + '-' + suffix }

  const pad0 = ' '.repeat(chainInd)
  const padP = ' '.repeat(pInd)
  const padN = ' '.repeat(nInd)
  const padK = ' '.repeat(nInd + 2)
  const provLines = [
    padN + name + ':',
    padK + 'api: openai-completions',
    padK + 'baseURL: ' + baseUrl,
    padK + 'headers:',
    padK + '  Authorization: Bearer chat2api-local',
    padK + 'models:',
  ]

  const out = lines.slice()
  if (chainIdx === -1) {
    // No llm-pi-ai yet: append the whole chain (trailing blank kept intact).
    let at = out.length
    while (at > 0 && out[at - 1].trim() === '') at -= 1
    out.splice(at, 0, pad0 + 'llm-pi-ai:', padP + 'providers:', ...provLines)
  } else {
    // Find the direct-child `providers:` of llm-pi-ai.
    let provIdx = -1
    let provInd = -1
    let kid = -1
    for (let i = chainIdx + 1; i < lines.length; i++) {
      const raw = lines[i]
      const t = raw.trim()
      if (!t || t.startsWith('#')) continue
      const ind = raw.match(/^ */)[0].length
      if (ind <= chainInd) break
      if (kid === -1) kid = ind
      if (ind !== kid) continue
      if (/^(\s+)providers\s*:\s*$/.test(raw)) { provIdx = i; provInd = ind; break }
    }
    if (provIdx === -1) {
      // Insert `providers:` with the block right after llm-pi-ai's subtree.
      let end = lines.length
      for (let i = chainIdx + 1; i < lines.length; i++) {
        const t = lines[i].trim()
        if (!t) continue
        const ind = lines[i].match(/^ */)[0].length
        if (ind <= chainInd) { end = i; break }
      }
      out.splice(end, 0, padP + 'providers:', ...provLines)
    } else {
      // Append after the last existing provider (or right after `providers:`).
      let lastChild = -1
      for (let i = provIdx + 1; i < lines.length; i++) {
        const t = lines[i].trim()
        if (!t || t.startsWith('#')) continue
        const ind = lines[i].match(/^ */)[0].length
        if (ind <= provInd) break
        if (ind === provInd + 2) lastChild = i
      }
      if (lastChild === -1) {
        out.splice(provIdx + 1, 0, ...provLines)
      } else {
        let at = lines.length
        for (let i = lastChild + 1; i < lines.length; i++) {
          const t = lines[i].trim()
          if (!t) continue
          const ind = lines[i].match(/^ */)[0].length
          if (ind <= provInd) { at = i; break }
        }
        out.splice(at, 0, ...provLines)
      }
    }
  }

  const result = out.join(nl)
  return { ok: true, code: 'CREATED', name, baseUrl, text: result, message: 'provider created' }
}

export function addReasoningEfforts(text, { provider = null, baseUrl = '', modelIds = [] } = {}) {
  const targets = new Set((modelIds || []).filter((m) => typeof m === 'string' && m.trim()))
  if (typeof text !== 'string' || targets.size === 0) {
    return { ok: false, code: 'NOOP', added: [], already: [], skipped: [...targets], message: 'nothing to patch' }
  }

  const nl = (text.match(/\r?\n/) || ['\n'])[0]
  const lines = String(text).split(/\r\n|\n|\r/)
  const blocks = findProviderBlocks(lines, provider, baseUrl)

  if (blocks.length === 0) {
    const message = provider && provider !== ''
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
