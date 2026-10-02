/* dsh-owui-chat2api panel - host-message translations.
 *
 * A plain script the host injects BEFORE panel.js (defer keeps the order), exposing
 * one namespace object:
 *
 *   window.__dshOwuiI18n = { msg: { en, zh } }
 *
 * - msg: translations for the stable English messages the host replies with, read
 *   through panel.js's trMsg(). KEYS use ASCII '...' - the lookup normalises the
 *   host's U+2026 ellipsis before looking a message up. panel.js degrades
 *   gracefully (shows the English message) if this file fails to load.
 *
 * The panel's OWN UI strings are NOT here: they live in the FALLBACK object inside
 * lib/panel.js, which is their single source of truth. They used to be duplicated
 * here as a `dict` section merged over that fallback, which meant a stale copy of
 * this file silently won and a newly added key never showed up.
 * test/i18n-sync.test.js guards that split.
 */
(function () {
  window.__dshOwuiI18n = {
    msg: {
      en: {},
      zh: {
        'chat2api is already running': 'chat2api 已在运行',
        'chat2api is not running': 'chat2api 未在运行',
        'a login flow is already running': '已有登录流程在进行中',
        'a scan is already running - let it finish first': '已有扫描在进行中 - 请等它完成',
        'prices must be non-negative numbers': '价格必须是非负数字',
        'baseUrl is not set - set your Open WebUI URL in the panel first': '尚未设置 baseUrl - 请先在面板中填写你的 Open WebUI 地址',
        'starting - checking python/deps in background ...': '启动中 - 后台检查 python/依赖...',
        'login starting - checking python/deps ...': '登录启动中 - 检查 python/依赖...',
        'login flow started - complete it in the browser window': '登录流程已开始 - 请在打开的浏览器窗口中完成登录',
        'process exited': '进程已退出',
        'stopped by user': '已手动停止',
        'python not found in PATH': '未在 PATH 中找到 Python',
        'python + requests + playwright reachable': 'Python + requests + playwright 就绪',
        'missing deps: pip install requests playwright': '缺少依赖:请执行 pip install requests playwright',
      },
    },
  }
})()
