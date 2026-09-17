/* Build the Cordis client half into ./client.js.
 *
 * Output face (what the DSH web shell's client module system expects):
 *   window.__ModuleLoader__.load({ id: "dsh-owui-chat2api", factory: (require) => { ... return exports } })
 * The factory is a CommonJS module body: `require("react")` resolves against
 * the shell's static seed table at runtime (dsh.client.external lists it),
 * ./panel.js is bundled in, and `module.exports` is the plugin face
 * ({ inject, apply }) the vendored cordis client loader applies.
 *
 * Run by `npm run build`; pack.ps1 calls it before npm pack so the tarball
 * always ships a current bundle.
 */
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

const BANNER =
  'window.__ModuleLoader__.load({id:"dsh-owui-chat2api",factory:function(require){' +
  'var module={exports:{}};var exports=module.exports;'
const FOOTER = ';return module.exports;}})'

await build({
  entryPoints: ['lib/client-entry.cjs'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  external: ['react'],
  target: ['es2020'],
  charset: 'utf8',
  outfile: 'client.js',
  banner: { js: BANNER },
  footer: { js: FOOTER },
  logLevel: 'info',
})

// Sanity: the wire face must be intact, or the shell fails loudly at boot.
const out = readFileSync('client.js', 'utf8')
const checks = [
  ['loader registration head', out.startsWith('window.__ModuleLoader__.load({id:"dsh-owui-chat2api"')],
  ['require("react") external', /require\("react"\)/.test(out)],
  ['module.exports plugin face', /module\.exports\s*=/.test(out)],
  ['factory return trailer', out.trimEnd().endsWith(FOOTER)],
]
for (const [name, ok] of checks) {
  if (!ok) { console.error('client.js sanity FAILED: ' + name); process.exitCode = 1 } else { console.log('client.js sanity ok: ' + name) }
}
