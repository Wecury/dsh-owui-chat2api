// lib/settings-patch.js - text-level patcher for DSH settings.yaml
//
// Adds a reasoningEfforts mapping to the model entries of the provider(s) whose
// baseURL points at the local chat2api proxy (matched by host:port), so it works
// for any deployment without hard-coding a provider name. It operates on the raw
// text - no YAML round-trip - so comments, ordering, unrelated providers and
// every other byte of the file are preserved. DSH merges `reasoningEfforts` at
// the same level as `name`, which is exactly what this produces. Returns what
// changed so the caller can back up and report.

// A reasoningEfforts mapping declares the levels DSH offers for one model: each key
// is a thinking level and its value the spelling sent on the wire. `off` always
// means "send no reasoning_effort at all"; every other key must be a level the
// backend actually took, because acceptance is NOT a range - DeepSeek V4.1 takes
// low/high/xhigh/max but rejects medium, and Qwen3.8-27B takes xhigh but rejects
// high. Declaring a level the backend rejects turns that pick into an HTTP 400.
const OFF_LEVEL = 'off: null'
// Levels assumed when the caller only knows "the probe passed" - the pre-0.10.2 scan
// probed the single spelling "high", so that is the only verified one.
const LEGACY_LEVELS = ['high']

// The mapping block for one model, indented relative to the model item line.
function effortLines(levels) {
  return ['reasoningEfforts:', '  ' + OFF_LEVEL, ...levels.map((l) => '  ' + l + ': ' + l)]
}

// Same declared level set? Order-insensitive so a hand-written mapping in another
// order is left alone (only a wrong *set* is worth rewriting).
function sameLevels(declared, want) {
  if (declared.length !== want.length) return false
  const seen = new Set(declared)
  return want.every((l) => seen.has(l))
}
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

// Remove `- id:` entries whose id is NOT in keepIds from the `models` list(s) of
// the matching provider(s) - the mirror of addModels, so a model deleted in Open
// WebUI also disappears from settings.yaml on the next sync. Only provider blocks
// that point at the local proxy are considered; a models list belonging to any
// other provider, and every other byte of the file, is never touched. The whole
// list item goes with its id (name:, reasoningEfforts:, indented comments), while
// blank lines and comments that introduce the NEXT item stay with it.
// Refuses to prune against an empty keepIds: that would mean "the backend serves
// nothing", which is a failed probe rather than a real state, and would wipe the
// list.
export function removeModels(text, { provider = null, baseUrl = '', keepIds = [] } = {}) {
  const keep = new Set((keepIds || []).filter((m) => typeof m === 'string' && m.trim()))
  if (typeof text !== 'string' || keep.size === 0) {
    return { ok: false, code: 'NOOP', removed: [], text, message: 'nothing to prune (empty model list)' }
  }
  const nl = (text.match(/\r?\n/) || ['\n'])[0]
  const lines = String(text).split(/\r\n|\n|\r/)
  const blocks = findProviderBlocks(lines, provider, baseUrl)
  if (blocks.length === 0) {
    const message = provider && provider !== ''
      ? 'provider "' + provider + ':" not found in settings'
      : 'no provider in settings points at ' + (baseUrl || 'the local proxy')
    return { ok: false, code: 'NO_PROVIDER', removed: [], text, message }
  }

  const ranges = []
  const removed = []
  for (const blk of blocks) {
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

    // Top-level `- id:` item starts, their ids, and where the list ends.
    const starts = []
    const ids = []
    let itemIndent = -1
    let listEnd = lines.length
    for (let i = modelsIdx + 1; i < lines.length; i++) {
      const raw = lines[i]
      const t = raw.trim()
      if (!t || t.startsWith('#')) continue
      const ind = raw.match(/^ */)[0].length
      if (ind <= modelsIndent) { listEnd = i; break }
      const im = raw.match(MODEL_ID_RE)
      if (!im) continue
      if (itemIndent === -1) itemIndent = im[1].length
      if (im[1].length !== itemIndent) continue
      starts.push(i)
      ids.push(im[2])
    }

    for (let k = 0; k < starts.length; k++) {
      if (keep.has(ids[k])) continue
      const isLast = k + 1 >= starts.length
      let end = isLast ? listEnd : starts[k + 1]
      // Comments are never deleted: one directly above the NEXT item belongs to
      // that item, so it is handed back before the splice. Blank lines go too.
      while (end > starts[k] + 1) {
        const t = lines[end - 1].trim()
        if (t === '' || (!isLast && t.startsWith('#'))) end -= 1
        else break
      }
      ranges.push({ start: starts[k], end })
      removed.push(ids[k])
    }
  }

  if (removed.length === 0) return { ok: true, code: 'NO_CHANGE', removed: [], text }
  const out = lines.slice()
  ranges.sort((a, b) => b.start - a.start) // bottom-up: earlier splices cannot shift later ones
  for (const r of ranges) out.splice(r.start, r.end - r.start)
  const result = out.join(nl)
  return { ok: true, code: result === text ? 'NO_CHANGE' : 'CHANGED', removed, text: result }
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

export function addReasoningEfforts(text, { provider = null, baseUrl = '', models = null, modelIds = null } = {}) {
  // `models` maps a model id to the levels the backend accepted for it (the
  // per-level scan). `modelIds` is the legacy shape from a scan that only probed
  // "high": those models get exactly that one verified level.
  const wanted = new Map()
  if (models && typeof models === 'object') {
    for (const [id, levels] of Object.entries(models)) {
      if (typeof id !== 'string' || !id.trim()) continue
      const list = (Array.isArray(levels) ? levels : [])
        .map((l) => (typeof l === 'string' ? l.trim() : ''))
        .filter((l) => l && l !== 'off')
      // No level beyond "off" = the backend takes no reasoning_effort at all, so
      // the model must not get a mapping (DSH rejects an off-only block).
      if (list.length > 0) wanted.set(id.trim(), list)
    }
  } else if (Array.isArray(modelIds)) {
    for (const id of modelIds) {
      if (typeof id === 'string' && id.trim()) wanted.set(id.trim(), LEGACY_LEVELS)
    }
  }
  if (typeof text !== 'string' || wanted.size === 0) {
    return { ok: false, code: 'NOOP', added: [], already: [], repaired: [], skipped: [...wanted.keys()], text, message: 'nothing to patch' }
  }

  const nl = (text.match(/\r?\n/) || ['\n'])[0]
  const lines = String(text).split(/\r\n|\n|\r/)
  const blocks = findProviderBlocks(lines, provider, baseUrl)

  if (blocks.length === 0) {
    const message = provider && provider !== ''
      ? 'provider "' + provider + ':" not found in settings'
      : 'no provider in settings points at ' + (baseUrl || 'the local proxy')
    return { ok: false, code: 'NO_PROVIDER', added: [], already: [], repaired: [], skipped: [...wanted.keys()], text, message }
  }

  // Collect every `- id:` entry inside the matched blocks. A model entry ends at
  // the next `- id:` line or at any line indented no deeper than the provider
  // line; a `reasoningEfforts:` mapping belongs to the entry it follows, and its
  // own children are the lines indented deeper than the mapping key.
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
        open = { index: i, id: idm[2], indent: idm[1].length, effort: null }
        entries.push(open)
        continue
      }
      if (!open) continue
      const em = raw.match(/^(\s+)reasoningEfforts\s*:\s*(.*)$/)
      if (em) {
        if (!open.effort) {
          open.effort = {
            index: i,
            indent: em[1].length,
            inline: em[2].replace(/\s*#.*$/, '').trim(),
            children: [],
          }
        }
        continue
      }
      if (open.effort && !open.effort.inline && ind > open.effort.indent) {
        const lm = raw.match(/^(\s+)([A-Za-z0-9_-]+)\s*:/)
        if (lm) open.effort.children.push({ index: i, level: lm[2] })
      }
    }
  }

  const added = []
  const already = []
  const repaired = []
  const actions = []
  const seen = new Set()
  for (const item of entries) {
    const want = wanted.get(item.id)
    if (!want) continue
    seen.add(item.id)
    if (!item.effort) {
      if (added.indexOf(item.id) === -1) added.push(item.id)
      actions.push({ item, kind: 'insert' })
      continue
    }
    // Compare without `off`: it is always part of the mapping, so only the
    // thinking levels decide whether the declared set is still right.
    const declared = item.effort.children.map((c) => c.level).filter((l) => l !== 'off')
    if (sameLevels(declared, want)) {
      if (already.indexOf(item.id) === -1) already.push(item.id)
      continue
    }
    // The block declares a level this backend rejects (or misses one it takes),
    // so it is rebuilt: that is how a stale low/medium/high mapping from an
    // older scan kept offering "medium" to a backend that 400s on it.
    if (repaired.indexOf(item.id) === -1) repaired.push(item.id)
    actions.push({ item, kind: 'replace' })
  }
  const skipped = [...wanted.keys()].filter((id) => !seen.has(id))

  if (actions.length === 0) {
    return { ok: true, code: 'NO_CHANGE', added, already, repaired, skipped, text }
  }

  const out = lines.slice()
  // Bottom-up, by the first line each action touches, so earlier splices do not
  // shift the indexes of later ones.
  const firstLine = (a) => (a.kind === 'insert' ? a.item.index : a.item.effort.index)
  for (const act of actions.sort((a, b) => firstLine(b) - firstLine(a))) {
    const want = wanted.get(act.item.id)
    if (act.kind === 'insert') {
      const pad = ' '.repeat(act.item.indent + 2)
      out.splice(act.item.index + 1, 0, ...effortLines(want).map((l) => pad + l))
      continue
    }
    // Rebuild in place, keeping every level the model still offers exactly as it
    // was written (a renamed wire spelling such as `max: ultra` survives) and
    // dropping only the levels this backend rejects.
    const eff = act.item.effort
    const pad = ' '.repeat(eff.indent + 2)
    const declaredLines = new Map(eff.children.map((c) => [c.level, lines[c.index]]))
    const rebuilt = [eff.inline === '' ? lines[eff.index] : pad + 'reasoningEfforts:']
    rebuilt.push(declaredLines.get('off') || pad + OFF_LEVEL)
    for (const lvl of want) rebuilt.push(declaredLines.get(lvl) || pad + lvl + ': ' + lvl)
    const end = eff.children.length > 0 ? eff.children[eff.children.length - 1].index : eff.index
    out.splice(eff.index, end - eff.index + 1, ...rebuilt)
  }

  const result = out.join(nl)
  return { ok: true, code: result === text ? 'NO_CHANGE' : 'CHANGED', text: result, added, already, repaired, skipped }
}
