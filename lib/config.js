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
  chat2apiDir: CHAT2API_DIR,
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
  next.chat2apiDir = String(next.chat2apiDir || CHAT2API_DIR).trim() || CHAT2API_DIR
  next.baseUrl = String(next.baseUrl || '').trim()
  next.host = String(next.host || '127.0.0.1').trim() || '127.0.0.1'
  next.port = Number(next.port) || 8000
  next.autoStart = !!next.autoStart
  config = next
  try { fs.writeFileSync(CONTROL_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8') } catch (e) { /* best effort */ }
  return next
}

export function resolveDir(cfg) {
  const dir = String(cfg.chat2apiDir || CHAT2API_DIR).trim() || CHAT2API_DIR
  return fs.existsSync(path.join(dir, 'chat2api.py')) ? dir : CHAT2API_DIR
}
