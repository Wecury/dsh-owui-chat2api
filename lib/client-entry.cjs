/* dsh-owui-chat2api - Cordis client half (right-sidebar dock tab).
 *
 * Built by scripts/build-client.mjs into ./client.js, a bundle in the
 * window.__ModuleLoader__.load({ id, factory }) face that the DSH web shell's
 * client module system consumes (dsh.client.platform = "web" +
 * exports["./client"] make the boot wire pick this file up automatically).
 *
 * Registers the console as a right-sidebar (rightbar dock) TAB TYPE - the same
 * public path the shipped Files / Terminal / Plan types use. Two stages, each in
 * its own ctx.effect so it dies with the plugin:
 *
 *   1. the TYPE - ctx.sidebarRightTabs.register({ id, kind, priority, title,
 *      guide }): `id` is this implementation's identity in the tab system (it
 *      must be unique - the package name is the natural value), `kind` is the page
 *      kind the tab system opens it by, and `guide` lists the cards the right
 *      sidebar's guide page offers. Every guide entry needs its own `id`, unique
 *      within the provider: the guide page renders `sidebar.right.tab.guide.entry`
 *      keyed by the definition id and falls back to its default icon + title
 *      button, so an entry without an id never becomes clickable.
 *   2. the BODY - ctx.slots.register({ name: 'sidebar.right.pane.tab', key:
 *      definition.id }, Body), which reads { sidebar, panel, tab } through the
 *      framework-injected useTabInfo() hook.
 *   3. the CHIP TITLE - the same key in sidebar.right.pane.tab.title.
 *
 * ctx.sidebarRightTabs is NOT a statically declared Service: the shipped
 * @deepseek-ai/dsh-client-ui-sidebar-right provides it (with ctx.sidebarRight)
 * via ctx.reflect.provide inside one effect, which is why it does not show up in a
 * Service catalog listing. The client boot wire waits for it through `inject`, so
 * this half applies as soon as the right sidebar is up.
 *
 * The body mounts the same panel engine as the overlay (panel.js, mode
 * "embedded"), so both mounts always behave identically, and the panel never
 * covers the conversation: the rightbar docks beside it.
 *
 * This tab is the DESKTOP mount. The Electron client (dsh-app://app/) gets only
 * this one - the tapIndex overlay bootstrap skips itself when it detects the
 * desktop shell, because a floating pill there would cover the conversation the
 * rightbar is meant to sit beside. The plain web UI has no right sidebar in older
 * versions, so it keeps the pill as its only mount; where both exist, both work
 * and share the same engine.
 */
var React = require('react')
var panelCore = require('./panel.js')

var ROUTE = '/dsh-owui-chat2api'
var OWUI_TYPE_ID = 'dsh-owui-chat2api' // tab type id AND the pane.tab slot key
var OWUI_KIND = 'owui-console'
var OWUI_GUIDE_ID = 'console' // guide entry id, unique within this provider

// Glyph: the same Tabler "activity" outline the panel headers use (MIT,
// Tabler Icons v3 by Paweł Kuna). props may carry {size}.
function OwuiGlyph(props) {
  var size = (props && props.size) || 18
  return React.createElement('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    style: { display: 'block', flex: '0 0 auto' }
  }, React.createElement('path', { d: 'M3 12h4l3 8l4 -16l3 8h4' }))
}

// Language follows the panel's own memory (localStorage first, then the DSH
// GUI language), read fresh on every call so a toggle inside the panel is
// picked up by the chip/guide on their next render.
function owuiLang() {
  try {
    var s = localStorage.getItem('dsh-owui-lang')
    return (s === 'en' || s === 'zh') ? s : (/^zh/i.test(navigator.language || '') ? 'zh' : 'en')
  } catch (e) { return 'en' }
}
function owuiTitle() { return owuiLang() === 'zh' ? 'OWUI 控制台' : 'OWUI Console' }
function owuiDescription() {
  return owuiLang() === 'zh'
    ? 'Open WebUI 代理的状态、配置与用量'
    : 'Open WebUI proxy status, config and usage'
}

// Tab body: one embedded panel instance per mount, destroyed on unmount
// (tab close / session switch / plugin stop). StrictMode double-invocation
// is safe: the first instance is fully destroyed before the second mounts.
function OwuiPanelBody() {
  var ref = React.useRef(null)
  React.useEffect(function () {
    var el = ref.current
    if (!el) return undefined
    // The panel stylesheet is served by the host; the tapIndex <link> is
    // usually already present, but the client half must not rely on it.
    if (!document.querySelector('link[data-owui-panel-css]')) {
      var link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = ROUTE + '/panel.css'
      link.setAttribute('data-owui-panel-css', '1')
      document.head.appendChild(link)
    }
    var inst = null
    try {
      inst = panelCore.createPanelInstance({ mode: 'embedded', mount: el })
    } catch (e) {
      console.error('[dsh-owui-chat2api] embedded panel failed to mount', e)
    }
    return function () {
      if (inst) { try { inst.destroy() } catch (e) { /* already gone */ } }
    }
  }, [])
  return React.createElement('div', { ref: ref, className: 'ow-embedded-root' })
}

// Tab chip title: the shell's tabInfo hook carries the title chosen at open
// time (definition.title()); we add our glyph in front, like FilesTitle does.
function OwuiTitleChip(props) {
  var title = owuiTitle()
  var useTabInfo = props && props.useTabInfo
  if (typeof useTabInfo === 'function') {
    try {
      var tab = useTabInfo().tab
      if (tab && tab.title) title = tab.title
    } catch (e) { /* fall back to the live label */ }
  }
  return React.createElement(React.Fragment, null, OwuiGlyph({ size: 16 }), title)
}

module.exports = {
  inject: ['slots', 'sidebarRightTabs'],
  apply: function (ctx) {
    // The tab TYPE. The registry lives as long as this plugin (the disposer
    // rides ctx.effect), so plugin stop/update removes the type, the guide
    // card and the open tab's home. `priority: 'extension'` marks it as a type
    // outside the product (the documented default for an unnamed rung).
    ctx.effect(function () {
      return ctx.sidebarRightTabs.register({
        id: OWUI_TYPE_ID,
        kind: OWUI_KIND,
        priority: 'extension',
        title: owuiTitle,
        guide: [{
          id: OWUI_GUIDE_ID,
          order: 30,
          title: owuiTitle,
          description: owuiDescription,
          icon: OwuiGlyph
        }]
      })
    }, 'owui: rightbar tab type')
    // Tab body + chip title, keyed by the type id (the shell renders the
    // occupant whose key equals the tab's type id, exactly as Files does).
    ctx.effect(function () {
      return ctx.slots.inject('sidebar.right.pane.tab', function () {
        return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: OWUI_TYPE_ID }, OwuiPanelBody)
      })
    }, 'owui: rightbar tab body')
    ctx.effect(function () {
      return ctx.slots.inject('sidebar.right.pane.tab.title', function () {
        return ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: OWUI_TYPE_ID }, OwuiTitleChip)
      })
    }, 'owui: rightbar tab title')
  }
}
