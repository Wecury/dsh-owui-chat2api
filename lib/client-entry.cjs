/* dsh-owui-chat2api - Cordis client half (right-sidebar dock tab).
 *
 * Built by scripts/build-client.mjs into ./client.js, a bundle in the
 * window.__ModuleLoader__.load({ id, factory }) face that the DSH web shell's
 * client module system consumes (dsh.client.platform = "web" +
 * exports["./client"] make the boot wire pick this file up automatically).
 *
 * Registers the console as a right-sidebar (rightbar dock) TAB TYPE - the
 * same public path the shipped Files / Preview types use, verified against
 * @deepseek-ai/dsh-client-ui-sidebar-files on DSH Desktop 2.0.10:
 *   1. ctx.sidebarRightTabs.register({ id, kind, title, guide }) - the tab
 *      type; its `guide` entry is the clickable card inside the dock's guide
 *      page (clicking calls tab.actions.openTab(kind) for us).
 *   2. sidebar.right.pane.tab       (keyed by the TYPE id) -> tab body.
 *   3. sidebar.right.pane.tab.title (keyed by the TYPE id) -> chip title.
 * The body mounts the same panel engine as the overlay (panel.js,
 * mode "embedded"), so both mounts always behave identically, and the panel
 * never covers the conversation: the rightbar docks beside it.
 *
 * Compatibility: on DSH versions without the rightbar the "sidebarRightTabs"
 * service does not exist, so this half waits in inject forever and never
 * applies - the tapIndex overlay pill remains the only UI there, exactly as
 * before. Registration calls are still guarded so a partial shell degrades
 * loudly in the console instead of breaking the page.
 */
var React = require('react')
var panelCore = require('./panel.js')

var ROUTE = '/dsh-owui-chat2api'
var OWUI_TYPE_ID = 'dsh-owui-chat2api' // tab type id AND the pane.tab slot key
var OWUI_KIND = 'owui-console'

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
    // card and the open tab's home.
    ctx.effect(function () {
      return ctx.sidebarRightTabs.register({
        id: OWUI_TYPE_ID,
        kind: OWUI_KIND,
        title: owuiTitle,
        guide: [{ order: 30, title: owuiTitle, description: owuiDescription, icon: OwuiGlyph }]
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
