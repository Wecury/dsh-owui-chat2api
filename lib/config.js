// lib/config.js - control-file config + shared paths (HOST half).
//
// Owns the plugin's persistent knobs (chat2apiDir / baseUrl / host / port /
// autoStart) stored in <DSH_HOME>/dsh-owui-chat2api-control.json, plus the
// path constants and directory helpers every other lib module needs. Split
// out of index.js (refactor step 5); behaviour is unchanged.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CHAT2API_DIR = path.join(PACKAGE_ROOT, 'chat2api')
export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONTROL_FILE = path.join(DSH_HOME, 'dsh-owui-chat2api-control.json')

// A fresh, opened-source install ships a placeholder baseUrl; treat it (and
// obviously bogus values) as "not configured" so autostart does not launch a
// proxy against a URL nobody can reach.
export function baseUrlUnset(cfg) {
  const s = String((cfg && cfg.baseUrl) || '').trim().toLowerCase()
  return !s || s === 'https://your-open-webui.example.com' || /^(https?:\/\/)?(your-|example\.|<)/.test(s)
}

const defaultConfig = () => ({
  // Empty = run the copy bundled with THIS package (PACKAGE_ROOT/chat2api), which is
  // the right answer for every normal install: the python half ships inside the
  // package, so nobody has to type a path. Only a developer pointing at a separate
  // checkout sets it, and then it is a deliberate, visible override.
  chat2apiDir: '',
  baseUrl: 'https://your-open-webui.example.com', // set to your Open WebUI instance
  host: '127.0.0.1',
  port: 8000,
  autoStart: true, // bundled proxy starts with DSH; panel Start/Stop still available
})

let config = null

export function loadConfig() {
  if (config) return config
  config = defaultConfig()
  try {
    const parsed = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'))
    if (parsed && typeof parsed === 'object') {
      for (const k of Object.keys(config)) if (parsed[k] !== undefined) config[k] = parsed[k]
    }
  } catch (e) { /* keep defaults */ }
  return config
}

export function saveConfig(patch) {
  const base = loadConfig()
  const next = defaultConfig()
  for (const k of Object.keys(next)) next[k] = (patch && patch[k] !== undefined) ? patch[k] : base[k]
  next.chat2apiDir = String(next.chat2apiDir || '').trim()
  next.baseUrl = String(next.baseUrl || '').trim()
  next.host = String(next.host || '127.0.0.1').trim() || '127.0.0.1'
  next.port = Number(next.port) || 8000
  next.autoStart = !!next.autoStart
  config = next
  try { fs.writeFileSync(CONTROL_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8') } catch (e) { /* best effort */ }
  return next
}

// The package name, used to recognise the OLD manual-install layout below. Read from
// package.json so renaming the package cannot desync the check.
let pkgName = 'dsh-owui-chat2api'
try { pkgName = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).name || pkgName } catch (e) { /* keep the fallback */ }

// The old install flow (pack.ps1 before 0.10.1) copied the repo into
// <DSH_HOME>/plugins/<name>-<version> and pointed the profile at that copy. A
// control file saved back then still points inside it, and switching to the packaged
// layout never refreshes that value - so the proxy would silently keep running the old
// python forever (and the panel's effort scan would keep returning old results).
// That exact layout is therefore treated as "no override"; a deliberate override is a
// checkout somewhere else.
const LEGACY_INSTALL_COPY = new RegExp(
  '[\\\\/]plugins[\\\\/]' + pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-[^\\\\/]+[\\\\/]chat2api[\\\\/]?$',
  'i'
)

function hasEntry(dir) {
  try { return fs.existsSync(path.join(dir, 'chat2api.py')) } catch (e) { return false }
}

// Where the python half actually runs from, and why. The panel shows this, so a
// configured path is never a mystery. `source` is one of:
//   bundled         - nothing configured: the copy shipped inside this package
//   custom          - the configured directory exists and has chat2api.py
//   bundled-stale   - the configured path is an old install copy; ignored
//   bundled-missing - the configured path has no chat2api.py; ignored
export function dirInfo(cfg) {
  const configured = String((cfg && cfg.chat2apiDir) || '').trim()
  if (!configured) return { dir: CHAT2API_DIR, source: 'bundled', configured: '' }
  if (LEGACY_INSTALL_COPY.test(configured)) {
    return { dir: CHAT2API_DIR, source: hasEntry(configured) ? 'bundled-stale' : 'bundled-missing', configured }
  }
  if (!hasEntry(configured)) return { dir: CHAT2API_DIR, source: 'bundled-missing', configured }
  return { dir: configured, source: 'custom', configured }
}

export function resolveDir(cfg) {
  return dirInfo(cfg).dir
}
