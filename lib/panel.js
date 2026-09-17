/* dsh-owui-chat2api panel engine - vanilla JS, one factory, two mounts.
 *
 * createPanelInstance({ mode, mount }) builds one whole panel (header,
 * notice bar, status / diagnostics / usage / config / log sections) and its
 * 3s polling loop:
 *   - mode "overlay":   the classic floating pill + anchored overlay, mounted
 *                       on document.body by the tapIndex bootstrap module.
 *   - mode "embedded":  the panel fills a provided container element; used by
 *                       the Cordis client half (lib/client-entry.cjs) that
 *                       registers the panel as a DSH sidebar tab (main key
 *                       "owui" + a sidebar.panellist icon).
 * The same instance code serves both, so behaviour never drifts.
 *
 * - UI uses DSH's theme tokens (--dsw-alias-* / --dsw-specific-sidebar-fill);
 *   radius / spacing / shadows are this panel's own conventions.
 * - Talks to same-origin host routes at /dsh-owui-chat2api/api/*; usage is
 *   proxied through /api/usage so it also works over HTTPS and when DSH is
 *   accessed remotely (no mixed content, no CORS dependency on the proxy).
 * - i18n: en + zh-CN dictionaries live in lib/panel-i18n.js (injected right
 *   before this module is imported). First load follows navigator.language
 *   (which mirrors the DSH GUI language); a header toggle switches and is
 *   remembered in localStorage.
 *
 * Polling only re-renders the dynamic regions (status / diagnostics / usage /
 * log); the config form is built once so typing never loses focus. busy is a
 * guard that can never wedge the buttons - it force-clears after a timeout.
 * All timers are gated: full re-render only while the panel is open, the boot
 * anchor poll stops once the shell is pinned (ResizeObserver takes over), and
 * everything pauses while the page is hidden. destroy() tears one instance
 * down completely (timers, observers, listeners, DOM).
 */
export function createPanelInstance(opts) {
  var mode = opts && opts.mode === 'embedded' ? 'embedded' : 'overlay'
  var mountEl = (opts && opts.mount) || null

  var ROUTE = '/dsh-owui-chat2api'
  var LS_KEY = 'dsh-owui-lang'

  // Built-in dictionaries so the panel NEVER shows a raw key: panel.js ships
  // inside client.js (reloads live via the plugin bundle), while the host
  // serves lib/panel-i18n.js from the packed lib until DSH restarts, so the
  // two can be briefly out of sync (a new key then rendered as raw "fail" ->
  // CSS upper-cases it to "FAIL"). The injected dict overrides these defaults
  // whenever it is fresh. Keep keys in sync with lib/panel-i18n.js.
  // Read lazily on every lookup: the client half (sidebar tab) may materialize
  // before the dictionaries script has run, so a snapshot here would be empty.
  var FALLBACK = {
    en: {
      title: 'Open WebUI chat2api', subtitle: 'Manage the bundled reverse proxy and watch its usage.',
      running: 'Running', stopped: 'Stopped', exited: 'Exited', crashed: 'Crashed', unknown: 'Unknown',
      started: 'started', exitInfo: 'exit {0} sig {1}',
      ready: 'Ready', attention: 'Attention', ok: 'OK', missing: 'Missing',
      python: 'Python', deps: 'Deps',
      config: 'Configuration', dir: 'chat2api directory', dirHint: 'Bundled directory is pre-filled. Only change to point at another copy.',
      baseUrl: 'Open WebUI URL', host: 'Host', port: 'Port',
      autoStart: 'Start automatically with DSH', save: 'Save', saved: 'Saved',
      effortScan: 'Sync models & reasoning levels',
      effortScanHint: 'Discovers models through the proxy, adds any missing ones plus reasoningEfforts into ~/.dsh/settings.yaml (backed up first). Restart DSH to apply.',
      effortRescan: 'Force re-scan',
      effortRescanHint: 'Ignore cached probe results and re-probe every model - use after the backend gains or renames models.',
      effortScanPatched: 'Patched:', effortScanAlready: 'already:', effortScanSkipped: 'not in a matched provider:',
      effortScanModelsAdded: 'Models added:', effortScanModelsAlready: 'models already present:',
      effortScanProviderCreated: 'Auto-created provider:',
      effortScanDone: 'Nothing to change.', effortScanRestart: ' - restart DSH to apply.',
      usage: 'Usage', status: 'Status', today: 'Today', yesterday: 'Yesterday', month: 'Month', cumulative: 'Cumulative',
      calls: 'Calls', inTok: 'In', outTok: 'Out', cached: 'Cached', latency: 'Avg latency',
      cacheHit: 'Cache hit', cacheHitTip: 'Cached tokens: {0} of {1} prompt', cacheNote: 'Backend does not report cache hits - cache not counted',
      est: 'Estimated', estTip: 'Calls whose usage was estimated because the backend returned no usage data',
      fail: 'Failed',
      m: 'Model', ctx: 'Count', tin: 'In', tout: 'Out', tcached: 'Cached', tavg: 'Avg ms', terr: 'Err',
      log: 'Process log', noCalls: 'No calls in this range.', loading: 'Loading...', others: 'Other {0}',
      noLog: 'No process output yet.', copyLog: 'Copy', copied: 'Copied', followLog: 'Follow',
      unreachable: 'Usage endpoint unreachable at {url}', saveFirst: 'Save configuration to enable the dashboard.',
      start: 'Start', stop: 'Stop', login: 'Login', open: 'Open WebUI chat2api',
      already: 'already running', notRunning: 'not running',
      loginOk: 'Logged in - Open WebUI credential saved.', loginFail: 'Login did not save a new credential - check the process log.',
      scanStarted: 'Scan started - many models can take a while; the result appears here when it finishes.',
      scanRunning: 'Scan running - the result will appear here when it finishes.',
      cost: 'Cost', pricing: 'Prices · per 1M tokens', currencyLbl: 'Currency symbol',
      priceIn: 'In', priceCached: 'Cached', priceOut: 'Out',
      priceHint: 'What you actually pay per million tokens. Unpriced models are counted but never billed.',
      unpricedNote: '{0} model(s) have no price yet.',
    },
    zh: {
      title: 'Open WebUI chat2api', subtitle: '管理内置反代并查看用量。',
      running: '运行中', stopped: '已停止', exited: '已退出', crashed: '崩溃', unknown: '未知',
      started: '启动于', exitInfo: '退出 {0} 信号 {1}',
      ready: '就绪', attention: '需注意', ok: '正常', missing: '缺失',
      python: 'Python', deps: '依赖',
      config: '配置', dir: 'chat2api 目录', dirHint: '默认已指向内置目录；如需使用其他副本再修改。',
      baseUrl: 'Open WebUI 地址', host: '主机', port: '端口',
      autoStart: '随 DSH 自动启动', save: '保存', saved: '已保存',
      effortScan: '一键同步模型与推理等级',
      effortScanHint: '扫描后端模型,把缺失的模型和 reasoningEfforts 写入 ~/.dsh/settings.yaml(自动备份)。重启 DSH 生效。',
      effortRescan: '强制重扫',
      effortRescanHint: '忽略缓存,重新探测所有模型 - 后端新增或改名模型后使用。',
      effortScanPatched: '已写入:', effortScanAlready: '已有:', effortScanSkipped: '不在匹配的 provider 列表:',
      effortScanModelsAdded: '已添加模型:', effortScanModelsAlready: '模型已存在:',
      effortScanProviderCreated: '已自动创建模型提供方:',
      effortScanDone: '无需改动。', effortScanRestart: ' - 重启 DSH 生效。',
      usage: '用量', status: '状态', today: '今天', yesterday: '昨天', month: '本月', cumulative: '累计',
      calls: '调用', inTok: '输入', outTok: '输出', cached: '缓存', latency: '平均延迟',
      cacheHit: '缓存命中', cacheHitTip: '命中 {0} / 输入 {1} tokens', cacheNote: '后端未上报缓存命中,缓存不计入统计',
      est: '估算', estTip: '后端未回传用量,按请求大小估算的调用数',
      fail: '失败',
      m: '模型', ctx: '次数', tin: '入', tout: '出', tcached: '缓存', tavg: '平均 ms', terr: '误',
      log: '进程日志', noCalls: '该时间段暂无调用。', loading: '加载中...', others: '其他 {0} 个',
      noLog: '暂无进程输出。', copyLog: '复制', copied: '已复制', followLog: '跟随',
      unreachable: '用量地址无法访问:{url}', saveFirst: '保存配置后即可查看用量。',
      start: '启动', stop: '停止', login: '登录', open: 'Open WebUI chat2api',
      already: '已在运行', notRunning: '未在运行',
      loginOk: '登录成功 - Open WebUI 凭据已保存。', loginFail: '登录未保存新凭据 - 请查看进程日志。',
      scanStarted: '扫描已开始 - 模型较多时需要一些时间，完成后会在这里提示。',
      scanRunning: '扫描进行中 - 完成后在这里提示结果。',
      cost: '成本', pricing: '价格表 · 每百万 tokens', currencyLbl: '货币符号',
      priceIn: '输入', priceCached: '缓存', priceOut: '输出',
      priceHint: '填写你实际支付的单价（每百万 tokens）。未填价的模型只统计、不计费。',
      unpricedNote: '还有 {0} 个模型未填价。',
    },
  }
  var i18nSig = null
  var i18nMerged = null
  function dicts() { return window.__dshOwuiI18n || {} }
  function mergedDict() {
    var I = dicts().dict || {}
    // Cheap signature: rebuild only when the injected dict sizes change (covers
    // the client-half "materializes later" case without recomputing per lookup).
    var sig = lang + '|' + (I.en ? Object.keys(I.en).length : -1) + '|' + (I.zh ? Object.keys(I.zh).length : -1)
    if (i18nMerged && i18nSig === sig) return i18nMerged
    var en = Object.assign({}, FALLBACK.en, I.en || {})
    i18nMerged = lang === 'zh' ? Object.assign({}, en, FALLBACK.zh, I.zh || {}) : en
    i18nSig = sig
    return i18nMerged
  }
  function t(k) {
    var m = mergedDict()
    return m[k] != null ? m[k] : k
  }
  function detectLang() {
    try {
      var s = localStorage.getItem(LS_KEY)
      if (s === 'en' || s === 'zh') return s
    } catch (e) {}
    return (/^zh/i.test(navigator.language || '') ? 'zh' : 'en')
  }
  var lang = detectLang()

  // Host replies carry English messages; translate the stable ones per locale.
  // The table lives in panel-i18n.js (msg); KEYS use ASCII '...' - the lookup
  // normalises the host's U+2026 ellipsis.
  function msgs() { return dicts().msg || { en: {}, zh: {} } }
  function normMsg(s) { return String(s).replace(/\u2026/g, '...') }
  function trMsg(s) {
    if (typeof s !== 'string' || !s) return s
    var MSG = msgs()
    var d = (MSG[lang] || MSG.en)[normMsg(s)]
    return d !== undefined ? d : s
  }
  function setLang(l) {
    lang = l
    try { localStorage.setItem(LS_KEY, l) } catch (e) {}
    renderAll()
  }

  // Styles come from lib/panel.css, served by the host at
  // /dsh-owui-chat2api/panel.css and injected via tapIndex as a <link>.

  // ---- static chrome: pill + panel shell (overlay) / plain panel (embedded) ----
  var btn = null
  var dotEl = null
  var panel = document.createElement('div')
  if (mode === 'overlay') panel.id = 'dsh-owui-panel' // embedded shares the CSS via .ow-panel, no id
  panel.className = 'ow-panel'
  panel.innerHTML =
    '<div class="ow-hd">' +
      '<div class="ow-hd-t"><div class="ow-hd-title"></div><div class="ow-hd-sub"></div></div>' +
      '<div class="ow-hd-actions"><span class="ow-lang" role="button" tabindex="0"></span><span class="ow-close" role="button" tabindex="0">&times;</span></div>' +
    '</div>' +
    '<div class="ow-notice" style="display:none"></div>' +
    '<div class="ow-body">' +
      '<section class="ow-sec" data-sec="status"></section>' +
      '<section class="ow-sec" data-sec="diag"></section>' +
      '<section class="ow-sec" data-sec="usage"></section>' +
      '<section class="ow-sec" data-sec="config"></section>' +
      '<section class="ow-sec" data-sec="log"></section>' +
    '</div>'
  var tracked = [] // [el, type, fn] pairs to undo in destroy()
  function track(el, type, fn) { el.addEventListener(type, fn); tracked.push([el, type, fn]); return fn }

  if (mode === 'overlay') {
    btn = document.createElement('button')
    btn.id = 'dsh-owui-btn'
    btn.className = 'ow-pill'
    btn.type = 'button'
    btn.innerHTML = '<span class="ow-pill-dot"></span><span class="ow-pill-lbl">OWUI</span>'
    btn.title = t('open')
    document.body.appendChild(btn)
    dotEl = btn.querySelector('.ow-pill-dot')
    document.body.appendChild(panel)
  } else {
    // Embedded (sidebar tab): always "open", no pill, no close button.
    panel.classList.add('open', 'ow-embedded')
    var closeEl0 = panel.querySelector('.ow-close')
    if (closeEl0) closeEl0.remove()
    ;(mountEl || document.body).appendChild(panel)
  }

  // Anchor the overlay to the DSH content scroller (wSkVaW_scrollBody) instead
  // of the raw viewport: the pill must sit inside the app area (below the top
  // bar), not under the window close button. The scroller is re-resolved on
  // every call - this script may run before the app mounts it - and the boot
  // poll re-anchors until the real shell exists.
  function findShell() {
    try {
      var el = document.querySelector('[class*="scrollBody"]')
      if (el && el.appendChild) return el
    } catch (e) {}
    if (!findShell._warned) {
      findShell._warned = true
      console.warn('[dsh-owui-chat2api] DSH scroll container not found; overlay anchored to body')
    }
    return document.body
  }
  function anchorOverlay() {
    try {
      var s = findShell()
      var r = s.getBoundingClientRect()
      if (!r || !r.width || !r.height) return false
      // Set ONLY top + right (never left): a fixed box with left AND right and
      // an auto width stretches instead of fitting its content, which collapses
      // the pill and forces its label out of view. Width stays content-sized.
      var gap = 28
      var rightAir = Math.round((window.innerWidth - r.right) + gap)
      btn.style.right = rightAir + 'px'
      btn.style.top = String(Math.round(r.top + 10)) + 'px'
      btn.style.left = ''
      panel.style.right = rightAir + 'px'
      panel.style.top = String(Math.round(r.top + 56)) + 'px'
      panel.style.left = ''
      watchShell(s)
      return true
    } catch (e) { return false /* keep the CSS fallback */ }
  }
  if (mode === 'overlay') track(window, 'resize', anchorOverlay)

  // Event-driven re-anchor on shell size changes (sidebar collapse, window
  // resize handled above): one ResizeObserver on the real scroller, re-armed
  // whenever anchorOverlay sees a (possibly remounted) shell. No timer needed.
  var shellObserver = null
  var observedShell = null
  function watchShell(s) {
    if (observedShell === s) return
    observedShell = s
    if (shellObserver) { try { shellObserver.disconnect() } catch (e) {} shellObserver = null }
    if (typeof ResizeObserver === 'undefined' || s === document.body) return
    try {
      shellObserver = new ResizeObserver(function () { if (!document.hidden) anchorOverlay() })
      shellObserver.observe(s)
    } catch (e) { shellObserver = null }
  }

  var secStatus = panel.querySelector('[data-sec="status"]')
  var secDiag = panel.querySelector('[data-sec="diag"]')
  var secConfig = panel.querySelector('[data-sec="config"]')
  var secUsage = panel.querySelector('[data-sec="usage"]')
  var secLog = panel.querySelector('[data-sec="log"]')
  var secNotice = panel.querySelector('.ow-notice')

  // Click the pill toggles the panel; click anywhere outside closes it.
  if (mode === 'overlay') {
    track(btn, 'click', function () {
      var willOpen = !panel.classList.contains('open')
      panel.classList.toggle('open')
      if (willOpen) poll() // catch up immediately when the panel opens
      anchorOverlay()
    })
    track(btn, 'keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); btn.click() } })
    track(document, 'pointerdown', function (e) {
      if (!panel.classList.contains('open')) return
      if (panel.contains(e.target) || btn.contains(e.target)) return
      panel.classList.remove('open')
    })
  }
  var closeEl = panel.querySelector('.ow-close')
  if (closeEl) track(closeEl, 'click', function () { panel.classList.remove('open') })
  var langEl = panel.querySelector('.ow-lang')
  if (langEl) track(langEl, 'click', function () { setLang(lang === 'zh' ? 'en' : 'zh') })
  // role="button" affordances: Enter/Space activate like a click (keyboard a11y)
  ;[[closeEl, function () { panel.classList.remove('open') }], [langEl, function () { setLang(lang === 'zh' ? 'en' : 'zh') }]].forEach(function (pair) {
    if (!pair[0]) return
    track(pair[0], 'keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pair[1]() }
    })
  })

  // ---- state ----
  var snap = null
  var form = null
  var busy = false
  var banner = ''
  var bannerType = ''
  var bannerAt = 0
  var logOpen = (function () { try { return localStorage.getItem('dsh-owui-logopen') === '1' } catch (e) { return false } })()
  // Price editor folds up like the log by default; remember a manual expand.
  var priceOpen = (function () { try { return localStorage.getItem('dsh-owui-priceopen') === '1' } catch (e) { return false } })()
  // Follow the newest output by default; remember a manual toggle.
  var logFollow = (function () {
    try {
      if (localStorage.getItem('dsh-owui-logfollow') !== null) return localStorage.getItem('dsh-owui-logfollow') === '1'
    } catch (e) { /* ignore */ }
    return true
  })()
  var range = 'today'
  var usage = null
  var usageOffline = false
  var loadSeq = 0 // bumped per loadUsage; stale (superseded) responses are dropped
  var seenLoginAt = 0 // last login result already surfaced as a notice
  var seenScanAt = 0 // last effort-scan result already surfaced as a notice

  function setBanner(m, type) { banner = trMsg(m); bannerType = type || ''; bannerAt = Date.now() }

  // ---- one shared notification language ----
  // Every message the panel shows (transient notice bar, save result, effort
  // scan result, diagnostics note) uses the same .ow-note box: an icon chip in
  // a coloured ring, coloured text, and a tinted background/border, with the
  // same four severities (ok / warn / err / info). This is what keeps the
  // "several different system notifications" feeling coordinated.
  var NOTE_IC = { ok: '\u2713', warn: '\u26A0', err: '\u2715', info: '\u2139' }
  function noteType(t) { return (t === 'ok' || t === 'warn' || t === 'err' || t === 'info') ? t : 'info' }
  function noteHtml(m, type) {
    var ty = noteType(type)
    return '<div class="ow-note ow-note-' + ty + '">' +
      '<span class="ow-note-ic">' + NOTE_IC[ty] + '</span>' +
      '<span class="ow-note-tx">' + esc(String(m == null ? '' : m)) + '</span></div>'
  }
  // Fallback severity guess from the raw host message only when a caller did
  // not pass an explicit type. Callers pass the explicit type where they know
  // the true semantics; this merely avoids a bare/inconsistent default.
  function noteOf(m) {
    if (!m) return 'info'
    if (/fail|error|crash|unreach|refus|denied|could not|not found|invalid|missing|spawn|timed out/i.test(m)) return 'err'
    if (/exited|stopped|already|not set|not running|skip|cached|deprecat|attention|background|starting|login|warn/i.test(m)) return 'warn'
    return 'ok'
  }

  function api(p, opts) {
    return fetch(ROUTE + '/api/' + p, opts).then(function (r) {
      return r.text().then(function (txt) {
        if (!txt) return { ok: false, message: 'API ' + p + ' answered HTTP ' + r.status + ' with an empty body' }
        try { return JSON.parse(txt) } catch (e) { return { ok: false, message: 'API ' + p + ' returned non-JSON (HTTP ' + r.status + '): ' + txt.slice(0, 120) } }
      })
    })
  }

  function safeRefresh() { try { refreshDynamic() } catch (e) {} }

  function poll() {
    api('status').then(function (r) {
      snap = r || snap
      if (form === null && r && r.config) { form = Object.assign({}, r.config); renderConfigRegion() }
      // Login flow result: the host reports one result per login attempt via
      // /api/status; surface it as a notice the first time it is seen (within
      // 10 minutes, so a page reopened hours later does not replay stale news).
      var lg = r && r.login
      if (lg && lg.resultAt && lg.resultAt !== seenLoginAt) {
        seenLoginAt = lg.resultAt
        if (Date.now() - lg.resultAt < 600000 && !busy) {
          setBanner(lg.result === 'ok' ? t('loginOk') : t('loginFail'), lg.result === 'ok' ? 'ok' : 'warn')
        }
      }
      // Effort scan: same one-shot result pattern. While the scan is running
      // keep a steady "running" info notice visible (poll re-sets it; the
      // banner auto-clear only wipes it when no scan is running).
      var sc = r && r.effortScan
      if (sc && sc.resultAt && sc.resultAt !== seenScanAt) {
        seenScanAt = sc.resultAt
        if (Date.now() - sc.resultAt < 600000 && !busy) {
          if (sc.result && sc.result.ok === false) setBanner(trMsg(sc.result.message) || t('effortScanDone'), 'err')
          else if (sc.result) announceScanResult(sc.result)
        }
      }
      if (sc && sc.running && !banner && !busy) setBanner(t('scanRunning'), 'info')
      if (banner && !busy && Date.now() - bannerAt > 6000) { banner = ''; bannerType = '' }
      safeRefresh()
    }).catch(function (e) { /* keep last */ })
  }

  function loadUsage() {
    var my = ++loadSeq
    api('usage?range=' + encodeURIComponent(range)).then(function (r) {
      if (my !== loadSeq) return // a newer range request superseded this one
      if (!r || r.ok === false) { usageOffline = true; refreshUsage(); return }
      usage = r; usageOffline = false
      if (!prices) loadPricesData() // first successful usage load: fetch the price table too
      refreshUsage()
    }).catch(function () {
      if (my !== loadSeq) return
      usageOffline = true; refreshUsage()
    })
  }

  // Manual price table (host keeps it in <DSH_HOME>): drives the cost column
  // and the editor under the dashboard. Null until the first load lands.
  var prices = null
  function loadPricesData() {
    api('prices').then(function (r) {
      prices = (r && r.prices) ? { currency: r.currency || '¥', prices: r.prices } : { currency: '¥', prices: {} }
      refreshUsage()
    }).catch(function () { prices = { currency: '¥', prices: {} } })
  }
  function savePricesAction() {
    var cur = secUsage.querySelector('[data-price-currency="1"]')
    var base = (prices && prices.prices) || {}
    var merged = {}
    for (var k in base) merged[k] = Object.assign({}, base[k])
    var ok = true
    secUsage.querySelectorAll('input[data-pm]').forEach(function (el) {
      var m = el.getAttribute('data-pm')
      var f = el.getAttribute('data-pf')
      var v = String(el.value || '').trim()
      if (v === '') { if (merged[m]) delete merged[m][f]; return } // cleared field = remove
      var n = Number(v)
      if (!isFinite(n) || n < 0) { ok = false; return }
      merged[m] = merged[m] || {}
      merged[m][f] = n
    })
    if (!ok) { setBanner(trMsg('prices must be non-negative numbers'), 'err'); return }
    withBusy(api('prices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ currency: cur ? cur.value.trim() : '', prices: merged }) }).then(function (r) {
      if (r && r.prices) prices = { currency: r.currency || '¥', prices: r.prices }
      setBanner(t('saved'), 'ok')
      loadUsage()
    }).catch(function (e) { setBanner(String((e && e.message) || e), 'err') }))
  }

  // ---- actions (busy can never wedge the buttons) ----
  function withBusy(fn, timeoutMs) {
    busy = true; banner = ''; safeRefresh()
    var cleared = false
    var guard = setTimeout(function () {
      if (!cleared) { cleared = true; busy = false; safeRefresh() }
    }, timeoutMs || 8000)
    Promise.resolve().then(fn).then(function () { safeRefresh() }).finally(function () {
      clearTimeout(guard)
      if (cleared) return
      cleared = true; busy = false; safeRefresh()
    })
  }
  function doSave() {
    withBusy(api('config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form || {}) }).then(function (r) {
      snap = r || snap
      var bad = r && r.startResult && !r.startResult.ok
      if (r && r.config) { form = Object.assign({}, r.config); renderConfigRegion() }
      // feedback rides the sticky notice bar, right up where it is always visible
      setBanner(bad ? (r.startResult.message || t('save')) : t('saved'), bad ? 'err' : 'ok')
      if (!bad) loadUsage()
    }).catch(function (e) { setBanner(String((e && e.message) || e), 'err') }))
  }
  function doEffortScan(force) {
    // Async response pattern (same as start/login): the POST returns at once
    // and the scan runs on the host; the final result arrives through the
    // status poll and is announced by announceScanResult() there. The short
    // busy window only covers the POST round-trip. Double clicks are refused
    // by the host guard ("a scan is already running").
    withBusy(function () {
      setBanner(t('scanStarted'), 'info')
      return api(force ? 'effort-scan-force' : 'effort-scan', { method: 'POST' }).then(function (r) {
        if (!r || !r.ok) setBanner(trMsg(r && r.message) || (t('effortScan') + '?'), 'err')
      }).catch(function (e) { setBanner(String((e && e.message) || e), 'err') })
    })
  }
  function announceScanResult(res) {
    var bits = []
    if (res.providerCreated) bits.push(t('effortScanProviderCreated') + ' ' + (res.providerName || ''))
    if (res.modelsAdded && res.modelsAdded.length) bits.push(t('effortScanModelsAdded') + ' ' + res.modelsAdded.join(', '))
    if (res.modelsAlready && res.modelsAlready.length) bits.push(t('effortScanModelsAlready') + ' ' + res.modelsAlready.join(', '))
    if (res.added && res.added.length) bits.push(t('effortScanPatched') + ' ' + res.added.join(', '))
    if (res.already && res.already.length) bits.push(t('effortScanAlready') + ' ' + res.already.join(', '))
    if (res.skipped && res.skipped.length) bits.push(t('effortScanSkipped') + ' ' + res.skipped.join(', '))
    var done = bits.length ? bits.join('\n') + (res.changed ? t('effortScanRestart') : '') : t('effortScanDone')
    setBanner(done, res.verify ? 'warn' : (res.changed ? 'ok' : 'info'))
  }
  function doStart() {
    withBusy(api('start', { method: 'POST' }).then(function (r) {
      if (!r || r.ok === false) { setBanner((r && r.message) || (t('start') + '?'), noteOf(r && r.message)); return }
      if (r.async && r.message) setBanner(r.message, 'info') // "starting - checking python/deps in background …"
      else poll()
      setTimeout(poll, 400) // re-check shortly after start so an instant crash is seen as such
    }).catch(function (e) { setBanner(String((e && e.message) || e), 'err') }))
  }
  function doStop() {
    withBusy(api('stop', { method: 'POST' }).then(function (r) {
      if (!r || r.ok === false) { setBanner((r && r.message) || (t('stop') + '?'), noteOf(r && r.message)); return }
      poll()
    }).catch(function (e) { setBanner(String((e && e.message) || e), 'err') }))
  }
  function doLogin() {
    withBusy(api('login', { method: 'POST' }).then(function (r) {
      // opening a browser window is an informational flow, not a success/error
      setBanner((r && r.message) || t('login'), (r && !r.ok) ? noteOf(r.message) : 'info')
      if (!r || !r.ok) return
      setTimeout(poll, 1500)
    }).catch(function (e) { setBanner(String((e && e.message) || e), 'err') }))
  }

  // ---- rendering (regions) ----

  // Transient system messages: start/stop/login feedback that must be visible
  // no matter where the user has scrolled, so it lives in a sticky bar right
  // under the panel header instead of at the bottom of the status card. It
  // auto-clears after a few seconds (see poll()), same as before.
  function renderNotice() {
    if (!secNotice) return
    if (!banner) { secNotice.style.display = 'none'; secNotice.innerHTML = ''; return }
    var ty = bannerType || noteOf(banner)
    secNotice.innerHTML = noteHtml(banner, ty)
    secNotice.style.display = ''
  }

  function stateMeta() {
    var st = (snap && snap.runtimeStatus) || null
    var s = (st && st.state) || 'unknown'
    if (s === 'running') return { key: 'running', cls: 'ok', color: 'var(--dsw-alias-state-success-primary)' }
    if (s === 'exited') return { key: 'exited', cls: 'warn', color: 'var(--dsw-alias-state-warn-primary)' }
    if (s === 'crashed') return { key: 'crashed', cls: 'err', color: 'var(--dsw-alias-state-error-primary)' }
    if (s === 'stopped') return { key: 'stopped', cls: 'dim', color: 'var(--dsw-alias-label-secondary)' }
    return { key: 'unknown', cls: 'dim', color: 'var(--dsw-alias-label-secondary)' }
  }

  function updatePill(m) {
    if (!dotEl) return // embedded mode has no pill
    try { dotEl.style.setProperty('--ow-pill', m.color) } catch (e) {}
  }

  function renderHeader() {
    panel.querySelector('.ow-hd-title').textContent = t('title')
    panel.querySelector('.ow-hd-sub').textContent = t('subtitle')
    panel.querySelector('.ow-lang').textContent = (lang === 'zh' ? 'EN' : '中文')
    if (btn) btn.title = t('open')
  }

  function renderStatusRegion() {
    var st = (snap && snap.runtimeStatus) || null
    var m = stateMeta()
    updatePill(m)
    var meta = []
    if (st && st.startedAt) meta.push(t('started') + ' ' + new Date(st.startedAt).toLocaleTimeString())
    if (st && (st.exitCode !== null || st.signal !== null)) meta.push(t('exitInfo').replace('{0}', String(st.exitCode)).replace('{1}', String(st.signal)))
    if (st && st.message) meta.push(esc(trMsg(st.message)))

    var isRunning = !!(st && st.state === 'running')
    var html = secHead('status', t('status')) +
      '<div class="ow-card ow-status">' +
        '<div class="ow-flex ow-gap ow-wrap">' +
          '<div class="ow-state" style="--ow-state:' + m.color + '">' +
            '<span class="ow-state-dot"></span><span class="ow-state-lbl ' + m.cls + '">' + esc(t(m.key)) + '</span>' +
          '</div>' +
          '<div class="ow-status-actions">' +
            '<button class="ow-btn ghost" data-a="login"' + (busy ? ' disabled' : '') + '>' + ic('key') + esc(t('login')) + '</button>' +
            '<button class="ow-btn" data-a="start"' + (busy || isRunning ? ' disabled' : '') + '>' + ic('player-play') + esc(t('start')) + '</button>' +
            '<button class="ow-btn danger" data-a="stop"' + (busy || !isRunning ? ' disabled' : '') + '>' + ic('player-stop') + esc(t('stop')) + '</button>' +
          '</div>' +
        '</div>' +
        (meta.length ? '<div class="ow-meta">' + meta.map(esc).join(' · ') + '</div>' : '') +
      '</div>'
    secStatus.innerHTML = html
    secStatus.querySelectorAll('button[data-a]').forEach(function (b) {
      b.addEventListener('click', function () {
        var a = b.getAttribute('data-a')
        if (a === 'start') doStart()
        else if (a === 'stop') doStop()
        else if (a === 'login') doLogin()
      })
    })
  }

  function renderDiagRegion() {
    var d = (snap && snap.diagnostics) || null
    if (!d || !d.python) { secDiag.innerHTML = ''; return }
    var ok = d.python === 'ok' && d.deps === 'ok'
    // pythonPath is the bare launcher name ('python'/'python3'/'py') unless a
    // real path was resolved - showing the launcher only adds noise, so show it
    // only when it is an actual path.
    var realPath = d.pythonPath && !/^(python|python3|py)(\.exe)?$/i.test(d.pythonPath)
    // Detail message: only surfaced as a note when things are NOT fully ready
    // ("Ready" badge already says the healthy case) - keeps the diagnostics
    // card from flashing a green box on every poll.
    var msgNote = (!ok && d.message)
      ? noteHtml(trMsg(d.message), d.python === 'missing' ? 'err' : 'warn')
      : ''
    // Translate the probe states ('ok' / 'missing' / 'unknown') so the card
    // never leaks raw English tokens into the localized panel.
    var diagLbl = { ok: t('ok'), missing: t('missing'), unknown: t('unknown') }
    var html = '<div class="ow-card ow-diag">' +
      '<span class="ow-badge ' + (ok ? 'ok' : 'warn') + '">' + (ok ? t('ready') : t('attention')) + '</span>' +
      '<div class="ow-diag-list">' +
        '<div class="ow-diag-row"><span class="ow-k">' + t('python') + '</span><b class="' + (d.python === 'ok' ? 'ok' : 'err') + '">' + esc(diagLbl[d.python] || d.python) + '</b></div>' +
        '<div class="ow-diag-row"><span class="ow-k">' + t('deps') + '</span><b class="' + (d.deps === 'ok' ? 'ok' : 'err') + '">' + esc(diagLbl[d.deps] || d.deps) + '</b></div>' +
      '</div>' +
      (realPath ? '<div class="ow-diag-path">' + esc(d.pythonPath) + '</div>' : '') +
      (msgNote ? '<div class="ow-diag-note">' + msgNote + '</div>' : '') +
    '</div>'
    secDiag.innerHTML = html
  }

  function fieldHtml(k, label, hint, placeholder) {
    return '<div class="ow-field" data-f="' + k + '">' +
      '<label>' + esc(label) + '</label>' +
      '<input type="text" value="' + esc(form && form[k] !== undefined ? String(form[k]) : '') + '" placeholder="' + esc(placeholder || '') + '">' +
      (hint ? '<div class="ow-hint">' + hint + '</div>' : '') +
      '</div>'
  }

  function renderConfigRegion() {
    var html = secHead('config', t('config')) +
      '<div class="ow-card ow-config">' +
        fieldHtml('chat2apiDir', t('dir'), t('dirHint')) +
        fieldHtml('baseUrl', t('baseUrl'), '') +
        '<div class="ow-grid2">' +
          fieldHtml('host', t('host'), '', '127.0.0.1') +
          fieldHtml('port', t('port'), '', '8000') +
        '</div>' +
        '<label class="ow-switch-row ow-flex ow-gap"><input type="checkbox" data-cb="autoStart"' + (form && form.autoStart ? ' checked' : '') + '><span class="ow-switch"></span><span>' + esc(t('autoStart')) + '</span></label>' +
        '<div class="ow-scan-row"><div class="ow-flex ow-gap ow-wrap"><button class="ow-btn" data-effort-scan="1" type="button">' + ic('refresh') + esc(t('effortScan')) + '</button><button class="ow-btn ow-btn-ghost" data-effort-force="1" type="button" title="' + esc(t('effortRescanHint')) + '">' + ic('bolt') + esc(t('effortRescan')) + '</button></div><div class="ow-hint">' + esc(t('effortScanHint')) + '</div></div>' +
        '<div class="ow-config-foot ow-flex ow-end"><button class="ow-btn" data-save="1">' + ic('device-floppy') + esc(t('save')) + '</button></div>' +
      '</div>'
    secConfig.innerHTML = html

    secConfig.querySelectorAll('input[type=text]').forEach(function (el) {
      el.addEventListener('input', function () {
        var k = el.closest('.ow-field').getAttribute('data-f')
        setField(k, el.value)
      })
    })
    var cb = secConfig.querySelector('input[data-cb="autoStart"]')
    if (cb) cb.addEventListener('change', function () { setField('autoStart', cb.checked) })
    var sv = secConfig.querySelector('[data-save="1"]')
    if (sv) sv.addEventListener('click', doSave)
    var es = secConfig.querySelector('[data-effort-scan="1"]')
    if (es) es.addEventListener('click', function () { doEffortScan(false) })
    var esf = secConfig.querySelector('[data-effort-force="1"]')
    if (esf) esf.addEventListener('click', function () { doEffortScan(true) })
  }

  function setField(k, v) {
    form = Object.assign({}, form || {}, { [k]: v })
  }

  function renderUsageRegion() {
    // Never stomp in-progress edits: while an input inside the usage card
    // (price table) has focus, leave the DOM untouched - the next poll after
    // blur re-renders with fresh data. Without this, every safeRefresh (3s
    // while open) wiped whatever the user was halfway through typing.
    var ae = document.activeElement
    if (ae && secUsage.contains(ae) && ae.tagName === 'INPUT') return
    var cfg = (snap && snap.config) || form || null
    var cfgReady = Boolean(cfg && String(cfg.chat2apiDir || '').trim())
    var url = 'http://' + ((cfg && cfg.host) || '127.0.0.1') + ':' + ((cfg && cfg.port) || 8000) + '/v1/usage?range=' + range

    var body = ''
    if (!cfgReady) {
      body = '<p class="ow-muted">' + esc(t('saveFirst')) + '</p>'
    } else if (usageOffline) {
      body = '<p class="ow-warn">' + esc(t('unreachable').replace('{url}', url)) + '</p>'
    } else if (!usage) {
      body = '<p class="ow-muted">' + esc(t('loading')) + '</p>'
    } else {
      var s = usage.summary || { calls: 0, in_tokens: 0, out_tokens: 0, cached_tokens: 0, latency_ms: 0, errors: 0, estimated_calls: 0, cache_reported_calls: 0 }
      // Cache is only a real number when the upstream chain reports it
      // (prompt_tokens_details.cached_tokens); otherwise a permanent "0" would
      // just look broken, so we hide the card and say so in one line instead.
      // `cache_reported_calls` only exists once the proxy exposes it - an older
      // proxy leaves it undefined, in which case we stay silent rather than
      // claiming the backend does not report cache.
      var cacheReported = s.cache_reported_calls
      var cacheKnown = typeof cacheReported === 'number' && cacheReported > 0
      var cacheFieldPresent = typeof cacheReported === 'number'
      var stats = [
        [t('calls'), fmtC(s.calls), STAT_COLORS.calls],
        [t('inTok'), fmtC(s.in_tokens), STAT_COLORS.inTok],
        [t('outTok'), fmtC(s.out_tokens), STAT_COLORS.outTok],
      ]
      // Cache hit rate (hit tokens / prompt), only when the backend reports it.
      if (cacheKnown) {
        var hitPct = s.in_tokens ? Math.round((s.cached_tokens || 0) / s.in_tokens * 100) : 0
        stats.push([t('cacheHit'), hitPct + '%', STAT_COLORS.cacheHit, t('cacheHitTip').replace('{0}', fmtC(s.cached_tokens || 0)).replace('{1}', fmtC(s.in_tokens || 0))])
      }
      stats.push([t('latency'), s.calls ? fmtDur(s.latency_ms / s.calls) : '-', STAT_COLORS.latency])
      // Calls whose tokens were estimated (upstream never returned usage) are a
      // real caveat, not noise - surface them only when they exist.
      if ((s.estimated_calls || 0) > 0) {
        stats.push([t('est'), fmtC(s.estimated_calls), STAT_COLORS.est, t('estTip')])
      }
      // Failed calls appear only when something actually failed.
      if ((s.errors || 0) > 0) {
        stats.push([t('fail'), fmtC(s.errors), STAT_COLORS.errs])
      }
      // Cost card only appears once at least one model has a price entered.
      if (usage.priced && typeof s.cost === 'number') {
        stats.push([t('cost'), (usage.currency || '¥') + ' ' + fmtMoney(s.cost), STAT_COLORS.cost])
      }
      body = '<div class="ow-stats">'
      for (var i = 0; i < stats.length; i++) {
        var sc = stats[i][2] ? ' style="--ow-sc:' + stats[i][2] + '"' : ''
        var tip = stats[i][3] ? ' title="' + esc(stats[i][3]) + '"' : ''
        body += '<div class="ow-stat"' + sc + tip + '><div class="v">' + esc(stats[i][1]) + '</div><div class="l">' + esc(stats[i][0]) + '</div></div>'
      }
      body += '</div>'
      if (!cacheKnown && cacheFieldPresent && s.calls) {
        body += '<p class="ow-muted ow-cache-note">' + esc(t('cacheNote')) + '</p>'
      }
      // Per-model usage as a compact "share bar" leaderboard - a 7-column table
      // does not fit a 468px overlay. Top 6 models by tokens; the rest fold into
      // "Other N"; hover a row for the full per-model breakdown.
      var rows = usage.per_model || []
      if (rows.length) {
        var list = rows.map(function (m) {
          return { model: m.model, calls: m.calls || 0, in: m.in_tokens || 0, out: m.out_tokens || 0, cached: m.cached_tokens || 0, lat: m.latency_ms || 0, err: m.errors || 0, cost: (typeof m.cost === 'number' ? m.cost : null) }
        })
        list.sort(function (a, b) { return (b.in + b.out) - (a.in + a.out) })
        var total = 0
        for (var gi = 0; gi < list.length; gi++) total += list[gi].in + list[gi].out
        var shown = list.slice(0, 6)
        var restN = list.length - shown.length
        if (restN > 0) {
          var o = { model: t('others').replace('{0}', restN), calls: 0, in: 0, out: 0, cached: 0, lat: 0, err: 0, cost: 0, other: true }
          for (var gj = 0; gj < restN; gj++) { var x = list[shown.length + gj]; o.calls += x.calls; o.in += x.in; o.out += x.out; o.cached += x.cached; o.lat += x.lat; o.err += x.err; if (x.cost != null) o.cost += x.cost }
          shown.push(o)
        }
        body += '<div class="ow-mbar-list">'
        for (var gk = 0; gk < shown.length; gk++) {
          var mm = shown[gk]
          var tk = mm.in + mm.out
          var pct = total ? (tk / total * 100) : 0
          var avgs = mm.calls ? fmtDur(mm.lat / mm.calls) : '-'
          var title = (mm.model || '') + ' · ' + fmtC(mm.calls) + ' ' + t('calls') + ' · ' + t('inTok') + ' ' + fmtC(mm.in) + ' · ' + t('outTok') + ' ' + fmtC(mm.out)
          if (cacheKnown) title += ' · ' + t('cached') + ' ' + fmtC(mm.cached)
          title += ' · ' + t('latency') + ' ' + avgs
          if (mm.err) title += ' · ' + t('fail') + ' ' + fmtC(mm.err)
          if (usage.priced && mm.model && mm.cost != null && mm.model.indexOf(t('others').split('{0}')[0]) !== 0) {
            title += ' · ' + t('cost') + ' ' + (usage.currency || '¥') + fmtMoney(mm.cost)
          }
          var barVar = mm.other ? '' : ' style="--ow-bar:' + BAR_COLORS[gk % BAR_COLORS.length] + '"'
          body += '<div class="ow-mbar"' + barVar + ' title="' + esc(title) + '">' +
            '<div class="ow-mbar-top"><span class="ow-mbar-nm">' + esc(mm.model || '-') + '</span>' +
            '<span class="ow-mbar-tk">' + fmtC(tk) + '</span>' +
            '<span class="ow-mbar-pct">' + Math.round(pct) + '%</span></div>' +
            '<div class="ow-mbar-track"><div class="ow-mbar-fill" style="width:' + Math.max(0.5, Math.min(100, pct)) + '%"></div></div>' +
            '</div>'
        }
        body += '</div>'

        // Price table editor: what you pay per million tokens, per model seen
        // in the current range. Folds up like the process log by default (open
        // state is remembered). Unpriced models stay in the stats but cost
        // nothing - their count is surfaced as a chip on the fold line.
        var pr = prices || { currency: '¥', prices: {} }
        var pmap = pr.prices || {}
        var pRows = ''
        for (var pj = 0; pj < list.length; pj++) {
          var pm = list[pj].model
          var pv = pmap[pm] || {}
          pRows += '<div class="ow-price-row">' +
            '<span class="ow-price-nm" title="' + esc(pm) + '">' + esc(pm) + '</span>' +
            '<input class="ow-price-in" type="number" min="0" step="any" inputmode="decimal" data-pm="' + esc(pm) + '" data-pf="input" value="' + (pv.input === undefined || pv.input === null ? '' : String(pv.input)) + '">' +
            '<input class="ow-price-in" type="number" min="0" step="any" inputmode="decimal" data-pm="' + esc(pm) + '" data-pf="cached" value="' + (pv.cached === undefined || pv.cached === null ? '' : String(pv.cached)) + '">' +
            '<input class="ow-price-in" type="number" min="0" step="any" inputmode="decimal" data-pm="' + esc(pm) + '" data-pf="output" value="' + (pv.output === undefined || pv.output === null ? '' : String(pv.output)) + '">' +
            '</div>'
        }
        var unpricedN = (usage.unpriced || []).length
        body += '<details class="ow-price"' + (priceOpen ? ' open' : '') + '>' +
          '<summary class="ow-price-sum"><span class="ow-log-sum-lbl">' + esc(t('pricing')) + '</span>' +
            (unpricedN ? '<span class="ow-badge warn" title="' + esc(t('unpricedNote').replace('{0}', unpricedN)) + '">' + unpricedN + '</span>' : '') +
          '</summary>' +
          '<div class="ow-price-body">' +
            '<div class="ow-price-h"><span class="ow-hint">' + esc(t('currencyLbl')) + '</span>' +
              '<input class="ow-price-cur" type="text" maxlength="8" data-price-currency="1" value="' + esc(pr.currency || '¥') + '" title="' + esc(t('currencyLbl')) + '"></div>' +
            '<div class="ow-price-cols"><span></span><span>' + esc(t('priceIn')) + '</span><span>' + esc(t('priceCached')) + '</span><span>' + esc(t('priceOut')) + '</span></div>' +
            pRows +
            '<div class="ow-price-foot"><span class="ow-hint">' + esc(t('priceHint') + (unpricedN ? ' ' + t('unpricedNote').replace('{0}', unpricedN) : '')) + '</span>' +
            '<button class="ow-btn ow-btn-ghost" data-save-prices="1">' + ic('device-floppy') + esc(t('save')) + '</button></div>' +
          '</div>' +
        '</details>'
      } else {
        body += '<p class="ow-muted">' + esc(t('noCalls')) + '</p>'
      }
    }

    var tabs = ''
    var ranges = ['today', 'yesterday', 'month', 'cumulative']
    for (var i2 = 0; i2 < ranges.length; i2++) {
      tabs += '<button class="ow-tab' + (ranges[i2] === range ? ' on' : '') + '" data-rg="' + ranges[i2] + '">' + esc(t(ranges[i2])) + '</button>'
    }

    // Carry unsaved in-progress values across the rebuild so a user who typed
    // but clicked elsewhere (no save yet) does not lose the numbers either.
    var prior = {}
    try {
      secUsage.querySelectorAll('input[data-pm],input[data-price-currency]').forEach(function (el) {
        prior[el.getAttribute('data-price-currency') ? '@cur' : (el.getAttribute('data-pm') + '|' + el.getAttribute('data-pf'))] = el.value
      })
    } catch (e) { /* fresh render, nothing to carry */ }

    secUsage.innerHTML =
      secHead('usage', t('usage')) +
      '<div class="ow-card ow-usage">' +
        '<div class="ow-tabs">' + tabs + '</div>' + body +
      '</div>'
    // Re-apply carried-over values onto the freshly built inputs. Only
    // non-empty old values count as an in-progress draft: an empty input in
    // the previous render just means "no price data had loaded yet", and
    // carrying it would wipe freshly loaded saved prices.
    try {
      secUsage.querySelectorAll('input[data-pm]').forEach(function (el) {
        var v = prior[el.getAttribute('data-pm') + '|' + el.getAttribute('data-pf')]
        if (v && el.value !== v) el.value = v
      })
      var curEl = secUsage.querySelector('input[data-price-currency="1"]')
      if (curEl && prior['@cur'] && curEl.value !== prior['@cur']) curEl.value = prior['@cur']
    } catch (e) { /* nothing carried */ }
    secUsage.querySelectorAll('button[data-rg]').forEach(function (b) {
      b.addEventListener('click', function () { range = b.getAttribute('data-rg'); usage = null; loadUsage() })
    })
    var sp = secUsage.querySelector('[data-save-prices="1"]')
    if (sp) sp.addEventListener('click', savePricesAction)
    var pe = secUsage.querySelector('.ow-price')
    if (pe) pe.addEventListener('toggle', function () {
      priceOpen = pe.open
      try { localStorage.setItem('dsh-owui-priceopen', priceOpen ? '1' : '0') } catch (e) { /* ignore */ }
    })
  }
  function refreshUsage() { renderUsageRegion() }

  // Per-line severity for the process log: errors and warnings get a coloured
  // side dot + tinted text so a crash/traceback stands out from the normal tail.
  function logSev(line) {
    if (/error|traceback|exception|failed|fail|refused|denied|could not|couldn't|not found|invalid|fatal|timed out|spawn/i.test(line)) return 'err'
    if (/warning|warn|attention|deprecat|exited|crash|skip/i.test(line)) return 'warn'
    return ''
  }

  function copyText(txt) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(String(txt)).catch(function () {})
        return
      }
    } catch (e) { /* fall through to textarea path */ }
    try {
      var ta = document.createElement('textarea')
      ta.value = String(txt)
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      if (document.execCommand) document.execCommand('copy')
      document.body.removeChild(ta)
    } catch (e) { /* ignore */ }
  }

  function renderLogRegion() {
    var lines = (snap && snap.log) || []
    if (!lines.length) {
      secLog.innerHTML =
        secHead('log', t('log')) +
        '<div class="ow-card"><p class="ow-muted">' + esc(t('noLog')) + '</p></div>'
      return
    }
    // Preserve scroll across the 3s re-render: remember where the user is, and
    // stick to the tail when they were already at the bottom (or follow is on).
    var box = secLog.querySelector('.ow-log-body')
    var prevTop = box ? box.scrollTop : 0
    var wasBottom = box ? (box.scrollTop + box.clientHeight >= box.scrollHeight - 8) : true

    var rows = ''
    for (var i = 0; i < lines.length; i++) {
      var sev = logSev(lines[i])
      rows += '<div class="ow-log-line' + (sev ? ' ow-log-line-' + sev : '') + '">' +
        '<span class="ow-log-dot"></span><span class="ow-log-txt">' + esc(lines[i]) + '</span></div>'
    }

    secLog.innerHTML =
      secHead('log', t('log')) +
      '<details class="ow-log"' + (logOpen ? ' open' : '') + '>' +
        '<summary class="ow-flex ow-gap ow-between"><span class="ow-log-sum-lbl">' + esc(t('log')) + ' · ' + lines.length + '</span>' +
          '<span class="ow-log-acts">' +
            '<button type="button" class="ow-log-btn' + (logFollow ? ' on' : '') + '" data-lg-act="follow" title="' + esc(t('followLog')) + '">' + ic('arrow-down') + '</button>' +
            '<button type="button" class="ow-log-btn" data-lg-act="copy" title="' + esc(t('copyLog')) + '">' + ic('copy') + '</button>' +
          '</span></summary>' +
        '<div class="ow-log-body">' + rows + '</div>' +
      '</details>'

    var de = secLog.querySelector('.ow-log')
    if (de) {
      de.addEventListener('toggle', function () {
        logOpen = de.open
        try { localStorage.setItem('dsh-owui-logopen', logOpen ? '1' : '0') } catch (e) { /* ignore */ }
      })
      var body = de.querySelector('.ow-log-body')
      if (body) body.scrollTop = (logFollow || wasBottom) ? body.scrollHeight : prevTop
      var fb = de.querySelector('[data-lg-act="follow"]')
      if (fb) fb.addEventListener('click', function (ev) {
        ev.preventDefault()
        logFollow = !logFollow
        try { localStorage.setItem('dsh-owui-logfollow', logFollow ? '1' : '0') } catch (e) { /* ignore */ }
        renderLogRegion()
      })
      var cp = de.querySelector('[data-lg-act="copy"]')
      if (cp) cp.addEventListener('click', function (ev) {
        ev.preventDefault()
        copyText(lines.join('\n'))
        var old = cp.textContent
        cp.textContent = t('copied')
        setTimeout(function () { cp.textContent = old }, 1200)
      })
    }
  }

  function refreshDynamic() {
    renderNotice()
    renderStatusRegion()
    renderDiagRegion()
    renderUsageRegion()
    renderLogRegion()
  }
  function renderAll() {
    renderHeader()
    renderNotice()
    renderStatusRegion()
    renderDiagRegion()
    renderConfigRegion()
    renderUsageRegion()
    renderLogRegion()
  }

  // Tabler Icons v3 (MIT license, https://tabler.io/icons) - inner markup of
  // the outline 24x24 set, inlined so the panel makes zero external requests.
  // stroke="currentColor" follows the DSH theme; size comes from CSS (.ow-ic).
  var ICONS = {
    'activity': '<path d="M3 12h4l3 8l4 -16l3 8h4" />',
    'arrow-down': '<path d="M12 5l0 14" /><path d="M18 13l-6 6" /><path d="M6 13l6 6" />',
    'bolt': '<path d="M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11" />',
    'chart-bar': '<path d="M3 13a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -6" /><path d="M15 9a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v10a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -10" /><path d="M9 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -14" /><path d="M4 20h14" />',
    'copy': '<path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667l0 -8.666" /><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1" />',
    'device-floppy': '<path d="M6 4h10l4 4v10a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2" /><path d="M10 14a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M14 4l0 4l-6 0l0 -4" />',
    'file-text': '<path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2" /><path d="M9 9l1 0" /><path d="M9 13l6 0" /><path d="M9 17l6 0" />',
    'key': '<path d="M16.555 3.843l3.602 3.602a2.877 2.877 0 0 1 0 4.069l-2.643 2.643a2.877 2.877 0 0 1 -4.069 0l-.301 -.301l-6.558 6.558a2 2 0 0 1 -1.239 .578l-.175 .008h-1.172a1 1 0 0 1 -.993 -.883l-.007 -.117v-1.172a2 2 0 0 1 .467 -1.284l.119 -.13l.414 -.414h2v-2h2v-2l2.144 -2.144l-.301 -.301a2.877 2.877 0 0 1 0 -4.069l2.643 -2.643a2.877 2.877 0 0 1 4.069 0" /><path d="M15 9h.01" />',
    'player-play': '<path d="M7 4v16l13 -8l-13 -8" />',
    'player-stop': '<path d="M5 7a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2l0 -10" />',
    'refresh': '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" /><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />',
    'settings': '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065" /><path d="M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0" />',
  }
  function ic(name, cls) {
    var body = ICONS[name]
    if (!body) return ''
    return '<svg class="ow-ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>'
  }

  // Accent hues: one colour family per section (header + its data), plus a
  // cycling palette for the per-model share bars. Fixed pastel-400 tones that
  // stay legible on both the light and dark DSH themes; everything tints via
  // CSS vars (--ow-hc / --ow-sc / --ow-bar) so the neutral layers keep using
  // the DSH theme tokens.
  var SEC_COLOR = { status: '#60a5fa', config: '#a78bfa', usage: '#34d399', log: '#fbbf24' }
  var SEC_ICON = { status: 'activity', config: 'settings', usage: 'chart-bar', log: 'file-text' }
  var BAR_COLORS = ['#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#f472b6', '#22d3ee']
  var STAT_COLORS = { calls: '#60a5fa', inTok: '#34d399', outTok: '#f472b6', cached: '#a78bfa', cacheHit: '#a78bfa', latency: '#94a3b8', errs: '#f87171', est: '#fb923c', cost: '#fbbf24' }
  function secHead(key, label) {
    var c = SEC_COLOR[key]
    return '<div class="ow-sec-h"' + (c ? ' style="--ow-hc:' + c + '"' : '') + '>' + ic(SEC_ICON[key] || '') + esc(label) + '</div>'
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  function fmt(n) { return (n || 0).toLocaleString() }
  // Money formatter for cost values: 0.42 -> "0.42", 12.5 -> "12.5", 130 -> "130".
  function fmtMoney(n) {
    n = Number(n) || 0
    if (n >= 100) return n.toFixed(0)
    if (n >= 1) return n.toFixed(2).replace(/\.?0+$/, '')
    return (n.toFixed(4).replace(/\.?0+$/, '')) || '0'
  }
  // Duration with unified short units: 800 ms / 12 s / 2.3 min (never a long
  // "130,000 ms"). Trade ~1% precision for a readable number.
  function fmtDur(ms) {
    ms = Number(ms) || 0
    if (ms < 1000) return Math.round(ms) + ' ms'
    if (ms < 60000) return (Math.round(ms / 100) / 10) + ' s'
    return (Math.round(ms / 6000) / 10) + ' min'
  }
  // Compact formatter for the per-model table: 139,062 -> 139.1K, 58,132,042 -> 58.1M.
  function fmtC(n) {
    n = n || 0
    if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B'
    if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M'
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.?0+$/, '') + 'K'
    return String(n)
  }

  // ---- boot ----
  // Follow the DSH shell's light/dark flag (toggled on <body data-ds-dark-theme>);
  // the panel switch picks its colours per mode and stays in sync at runtime.
  function isDark() {
    return !!(document.body && document.body.hasAttribute('data-ds-dark-theme'))
  }
  function applyMode() {
    var d = isDark()
    panel.classList.toggle('ow-dark', d)
    panel.classList.toggle('ow-light', !d)
  }
  var destroyed = false
  var timers = []
  var themeObserver = null
  applyMode()
  if (typeof MutationObserver !== 'undefined' && document.body) {
    try {
      themeObserver = new MutationObserver(function () { applyMode(); if (mode === 'overlay') anchorOverlay() })
      themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    } catch (e) { themeObserver = null /* ignore */ }
  }
  renderAll()
  poll()
  if (mode === 'overlay') {
    anchorOverlay()
    var repin = setTimeout(anchorOverlay, 400) // re-pin once layout/fonts have settled
    timers.push(repin)
    // Boot-only anchor poll: the shell mounts after this script, so re-anchor
    // every 800ms until the real scroller has been seen on 5 consecutive ticks,
    // then STOP the timer. Afterwards ResizeObserver + the window resize listener
    // keep the overlay pinned - no perpetual timer ever runs.
    var anchorHits = 0
    var anchorTimer = setInterval(function () {
      if (document.hidden) return
      if (anchorOverlay()) {
        anchorHits += 1
        if (anchorHits >= 5) { clearInterval(anchorTimer) }
      } else {
        anchorHits = 0 // shell lost (remount/reload): keep polling until stable again
      }
    }, 800)
    timers.push(anchorTimer)
  }
  // Polling policy: full re-render every 3s ONLY while the panel is open; the
  // closed panel keeps just the pill dot honest with a slow 10s status fetch;
  // usage refreshes every 8s while open; everything pauses when the page is
  // hidden behind other windows/tabs. The embedded panel is always "open".
  function usageTick() {
    if (destroyed || document.hidden || !panel.classList.contains('open')) return
    var cfg = (snap && snap.config) || form || {}
    if (String(cfg.chat2apiDir || '').trim()) loadUsage()
  }
  timers.push(setInterval(function () {
    if (destroyed || document.hidden || !panel.classList.contains('open')) return
    poll()
  }, 3000))
  if (mode === 'overlay') {
    timers.push(setInterval(function () {
      if (destroyed || document.hidden || panel.classList.contains('open')) return
      api('status').then(function (r) {
        snap = r || snap
        updatePill(stateMeta())
      }).catch(function () { /* keep last known */ })
    }, 10000))
  }
  timers.push(setInterval(usageTick, 8000))

  // Tear one instance down completely: timers, observers, listeners, DOM.
  // Used by the client half when the sidebar tab unmounts (plugin stop/update).
  function destroyInstance() {
    destroyed = true
    for (var i = 0; i < timers.length; i++) { try { clearInterval(timers[i]) } catch (e) {} }
    if (shellObserver) { try { shellObserver.disconnect() } catch (e) {} shellObserver = null }
    if (themeObserver) { try { themeObserver.disconnect() } catch (e) {} themeObserver = null }
    for (var j = 0; j < tracked.length; j++) {
      try { tracked[j][0].removeEventListener(tracked[j][1], tracked[j][2]) } catch (e) {}
    }
    tracked.length = 0
    try { if (btn && btn.parentNode) btn.parentNode.removeChild(btn) } catch (e) {}
    try { if (panel.parentNode) panel.parentNode.removeChild(panel) } catch (e) {}
  }
  return { destroy: destroyInstance, setLang: setLang }
}
