/* dsh-owui-chat2api panel - vanilla JS, injected into the DSH web shell via tapIndex.
 *
 * - UI uses DSH's theme tokens (--dsw-alias-* / --dsw-specific-sidebar-fill);
 *   radius / spacing / shadows are this panel's own conventions.
 * - Talks to same-origin host routes at /dsh-owui-chat2api/api/*; usage is
 *   proxied through /api/usage so it also works over HTTPS and when DSH is
 *   accessed remotely (no mixed content, no CORS dependency on the proxy).
 * - i18n: built-in en + zh-CN dictionaries. First load follows navigator.language
 *   (which mirrors the DSH GUI language); a header toggle switches and is
 *   remembered in localStorage. The locale service cannot be used here: this is
 *   a page-injected script, not a Cordis client module.
 *
 * Polling only re-renders the dynamic regions (status / diagnostics / usage /
 * log); the config form is built once so typing never loses focus. busy is a
 * guard that can never wedge the buttons - it force-clears after a timeout.
 */
(function () {
  if (window.__dshOwuiMounted) return
  window.__dshOwuiMounted = true

  var ROUTE = '/dsh-owui-chat2api'
  var LS_KEY = 'dsh-owui-lang'

  var I18N = {
    en: {
      title: 'Open WebUI chat2api', subtitle: 'Manage the bundled reverse proxy and watch its usage.',
      running: 'Running', stopped: 'Stopped', exited: 'Exited', crashed: 'Crashed', unknown: 'Unknown',
      started: 'started', exitInfo: 'exit {0} sig {1}',
      ready: 'Ready', attention: 'Attention', python: 'Python', deps: 'Deps',
      config: 'Configuration', dir: 'chat2api directory', dirHint: 'Bundled directory is pre-filled. Only change to point at another copy.',
      baseUrl: 'Open WebUI URL', host: 'Host', port: 'Port',
      autoStart: 'Start automatically with DSH', save: 'Save', saved: 'Saved',
      effortScan: 'Sync models & reasoning levels',
      effortScanHint: 'Discovers models through the proxy, adds any missing ones plus reasoningEfforts into ~/.dsh/settings.yaml (backed up first). Restart DSH to apply.',
      effortScanPatched: 'Patched:', effortScanAlready: 'already:', effortScanSkipped: 'not in a matched provider:',
      effortScanModelsAdded: 'Models added:', effortScanModelsAlready: 'models already present:',
      effortScanProviderCreated: 'Auto-created provider:',
      effortScanDone: 'Nothing to change.', effortScanRestart: ' - restart DSH to apply.',
      usage: 'Usage', status: 'Status', today: 'Today', yesterday: 'Yesterday', month: 'Month', cumulative: 'Cumulative',
      calls: 'Calls', inTok: 'In', outTok: 'Out', cached: 'Cached', latency: 'Avg latency', errs: 'Errors',
      m: 'Model', ctx: 'Count', tin: 'In', tout: 'Out', tcached: 'Cached', tavg: 'Avg ms', terr: 'Err',
      log: 'Process log', noCalls: 'No calls in this range.', loading: 'Loading...', others: 'Other {0}',
      unreachable: 'Usage endpoint unreachable at {url}', saveFirst: 'Save configuration to enable the dashboard.',
      start: 'Start', stop: 'Stop', login: 'Login', open: 'Open WebUI chat2api',
      already: 'already running', notRunning: 'not running',
    },
    zh: {
      title: 'Open WebUI chat2api', subtitle: '管理内置反代并查看用量。',
      running: '运行中', stopped: '已停止', exited: '已退出', crashed: '崩溃', unknown: '未知',
      started: '启动于', exitInfo: '退出 {0} 信号 {1}',
      ready: '就绪', attention: '需注意', python: 'Python', deps: '依赖',
      config: '配置', dir: 'chat2api 目录', dirHint: '默认已指向内置目录；如需使用其他副本再修改。',
      baseUrl: 'Open WebUI 地址', host: '主机', port: '端口',
      autoStart: '随 DSH 自动启动', save: '保存', saved: '已保存',
      effortScan: '一键同步模型与推理等级',
      effortScanHint: '扫描后端模型,把缺失的模型和 reasoningEfforts 写入 ~/.dsh/settings.yaml(自动备份)。重启 DSH 生效。',
      effortScanPatched: '已写入:', effortScanAlready: '已有:', effortScanSkipped: '不在匹配的 provider 列表:',
      effortScanModelsAdded: '已添加模型:', effortScanModelsAlready: '模型已存在:',
      effortScanProviderCreated: '已自动创建模型提供方:',
      effortScanDone: '无需改动。', effortScanRestart: ' - 重启 DSH 生效。',
      usage: '用量', status: '状态', today: '今天', yesterday: '昨天', month: '本月', cumulative: '累计',
      calls: '调用', inTok: '输入', outTok: '输出', cached: '缓存', latency: '平均延迟', errs: '错误',
      m: '模型', ctx: '次数', tin: '入', tout: '出', tcached: '缓存', tavg: '平均 ms', terr: '误',
      log: '进程日志', noCalls: '该时间段暂无调用。', loading: '加载中...', others: '其他 {0} 个',
      unreachable: '用量地址无法访问:{url}', saveFirst: '保存配置后即可查看用量。',
      start: '启动', stop: '停止', login: '登录', open: 'Open WebUI chat2api',
      already: '已在运行', notRunning: '未在运行',
    },
  }

  var lang = detectLang()
  function t(k) {
    var d = I18N[lang] || I18N.en
    return d[k] != null ? d[k] : (I18N.en[k] != null ? I18N.en[k] : k)
  }
  function detectLang() {
    try {
      var s = localStorage.getItem(LS_KEY)
      if (s === 'en' || s === 'zh') return s
    } catch (e) {}
    return (/^zh/i.test(navigator.language || '') ? 'zh' : 'en')
  }

  // Host replies carry English messages; translate the stable ones per locale.
  // KEYS use ASCII '...' - the lookup normalises the host's U+2026 ellipsis.
  var MSG = {
    en: {},
    zh: {
      'chat2api is already running': 'chat2api 已在运行',
      'chat2api is not running': 'chat2api 未在运行',
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
  }
  function normMsg(s) { return String(s).replace(/\u2026/g, '...') }
  function trMsg(s) {
    if (typeof s !== 'string' || !s) return s
    var d = (MSG[lang] || MSG.en)[normMsg(s)]
    return d !== undefined ? d : s
  }
  function setLang(l) {
    lang = l
    try { localStorage.setItem(LS_KEY, l) } catch (e) {}
    renderAll()
  }

  var style = document.createElement('style')
  style.textContent = cssText()
  document.head.appendChild(style)

  // ---- static chrome: floating pill + panel shell ----
  var btn = document.createElement('button')
  btn.id = 'dsh-owui-btn'
  btn.type = 'button'
  btn.innerHTML = '<span class="ow-pill-dot"></span><span class="ow-pill-lbl">OWUI</span>'
  btn.title = t('open')
  document.body.appendChild(btn)
  var dotEl = btn.querySelector('.ow-pill-dot')

  var panel = document.createElement('div')
  panel.id = 'dsh-owui-panel'
  panel.innerHTML =
    '<div class="ow-hd">' +
      '<div class="ow-hd-t"><div class="ow-hd-title"></div><div class="ow-hd-sub"></div></div>' +
      '<div class="ow-hd-actions"><span class="ow-lang" role="button" tabindex="0"></span><span class="ow-close" role="button" tabindex="0">&times;</span></div>' +
    '</div>' +
    '<div class="ow-body">' +
      '<section class="ow-sec" data-sec="status"></section>' +
      '<section class="ow-sec" data-sec="diag"></section>' +
      '<section class="ow-sec" data-sec="usage"></section>' +
      '<section class="ow-sec" data-sec="config"></section>' +
      '<section class="ow-sec" data-sec="log"></section>' +
    '</div>'
  document.body.appendChild(panel)

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
    return document.body
  }
  function anchorOverlay() {
    try {
      var s = findShell()
      var r = s.getBoundingClientRect()
      if (!r || !r.width || !r.height) return
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
    } catch (e) { /* keep the CSS fallback */ }
  }
  window.addEventListener('resize', anchorOverlay)

  var secStatus = panel.querySelector('[data-sec="status"]')
  var secDiag = panel.querySelector('[data-sec="diag"]')
  var secConfig = panel.querySelector('[data-sec="config"]')
  var secUsage = panel.querySelector('[data-sec="usage"]')
  var secLog = panel.querySelector('[data-sec="log"]')

  // Click the pill toggles the panel; click anywhere outside closes it.
  btn.addEventListener('click', function () {
    var willOpen = !panel.classList.contains('open')
    panel.classList.toggle('open')
    if (willOpen) poll() // catch up immediately when the panel opens
    anchorOverlay()
  })
  btn.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); btn.click() } })
  document.addEventListener('pointerdown', function (e) {
    if (!panel.classList.contains('open')) return
    if (panel.contains(e.target) || btn.contains(e.target)) return
    panel.classList.remove('open')
  })
  panel.querySelector('.ow-close').addEventListener('click', function () { panel.classList.remove('open') })
  panel.querySelector('.ow-lang').addEventListener('click', function () { setLang(lang === 'zh' ? 'en' : 'zh') })

  // ---- state ----
  var snap = null
  var form = null
  var busy = false
  var banner = ''
  var bannerType = ''
  var bannerAt = 0
  var logOpen = (function () { try { return localStorage.getItem('dsh-owui-logopen') === '1' } catch (e) { return false } })()
  var range = 'today'
  var usage = null
  var usageOffline = false
  var loadSeq = 0 // bumped per loadUsage; stale (superseded) responses are dropped

  function setBanner(m, type) { banner = trMsg(m); bannerType = type || ''; bannerAt = Date.now() }

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
      if (banner && Date.now() - bannerAt > 6000) { banner = ''; bannerType = '' }
      safeRefresh()
    }).catch(function (e) { /* keep last */ })
  }

  function loadUsage() {
    var my = ++loadSeq
    api('usage?range=' + encodeURIComponent(range)).then(function (r) {
      if (my !== loadSeq) return // a newer range request superseded this one
      if (!r || r.ok === false) { usageOffline = true; refreshUsage(); return }
      usage = r; usageOffline = false; refreshUsage()
    }).catch(function () {
      if (my !== loadSeq) return
      usageOffline = true; refreshUsage()
    })
  }

  // ---- actions (busy can never wedge the buttons) ----
  function withBusy(fn) {
    busy = true; banner = ''; safeRefresh()
    var cleared = false
    var guard = setTimeout(function () {
      if (!cleared) { cleared = true; busy = false; safeRefresh() }
    }, 8000)
    Promise.resolve().then(fn).then(function () { safeRefresh() }).finally(function () {
      clearTimeout(guard)
      if (cleared) return
      cleared = true; busy = false; safeRefresh()
    })
  }
  function showSaveResult(m, type) {
    if (!secConfig) return
    var el = secConfig.querySelector('.ow-save-result')
    if (!el) return
    if (m) {
      el.className = 'ow-save-result ' + (type || '')
      el.textContent = m
      el.style.display = ''
    } else {
      el.textContent = ''
      el.style.display = 'none'
    }
  }
  function doSave() {
    withBusy(api('config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form || {}) }).then(function (r) {
      snap = r || snap
      var bad = r && r.startResult && !r.startResult.ok
      var msg = bad ? (r.startResult.message || t('save')) : t('saved')
      if (r && r.config) { form = Object.assign({}, r.config); renderConfigRegion() }
      showSaveResult(msg, bad ? 'err' : 'ok') // text stays inline under Save, right where the click is
      if (!bad) loadUsage()
    }).catch(function (e) { showSaveResult(String((e && e.message) || e), 'err') }))
  }
  function doEffortScan() {
    var resEl = secConfig ? secConfig.querySelector('.ow-effort-result') : null
    function show(m, type) {
      if (!resEl) return
      if (m) {
        resEl.className = 'ow-effort-result ' + (type || '')
        resEl.textContent = m
        resEl.style.display = ''
      } else {
        resEl.textContent = ''
        resEl.style.display = 'none'
      }
    }
    show(t('loading'))
    withBusy(api('effort-scan', { method: 'POST' }).then(function (r) {
      if (!r || !r.ok) { show((r && r.message) || (t('effortScan') + '?'), 'err'); return }
      var bits = []
      if (r.providerCreated) bits.push(t('effortScanProviderCreated') + ' ' + (r.providerName || ''))
      if (r.modelsAdded && r.modelsAdded.length) bits.push(t('effortScanModelsAdded') + ' ' + r.modelsAdded.join(', '))
      if (r.modelsAlready && r.modelsAlready.length) bits.push(t('effortScanModelsAlready') + ' ' + r.modelsAlready.join(', '))
      if (r.added && r.added.length) bits.push(t('effortScanPatched') + ' ' + r.added.join(', '))
      if (r.already && r.already.length) bits.push(t('effortScanAlready') + ' ' + r.already.join(', '))
      if (r.skipped && r.skipped.length) bits.push(t('effortScanSkipped') + ' ' + r.skipped.join(', '))
      show(bits.length ? bits.join('\n') + (r.changed ? t('effortScanRestart') : '') : t('effortScanDone'), 'ok')
    }).catch(function (e) { show(String((e && e.message) || e), 'err') }))
  }
  function doStart() {
    withBusy(api('start', { method: 'POST' }).then(function (r) {
      if (!r || !r.ok) setBanner((r && r.message) || (t('start') + '?'), 'err')
      else { poll(); setTimeout(poll, 400) } // re-check shortly after start so an instant crash is seen as such
    }).catch(function (e) { setBanner(String((e && e.message) || e), 'err') }))
  }
  function doStop() {
    withBusy(api('stop', { method: 'POST' }).then(function (r) {
      if (!r || !r.ok) setBanner((r && r.message) || (t('stop') + '?'), 'err')
      else poll()
    }).catch(function (e) { setBanner(String((e && e.message) || e), 'err') }))
  }
  function doLogin() {
    withBusy(api('login', { method: 'POST' }).then(function (r) {
      setBanner((r && r.message) || t('login'), (r && !r.ok) ? 'err' : 'ok')
      if (!r || !r.ok) return
      setTimeout(poll, 1500)
    }).catch(function (e) { setBanner(String((e && e.message) || e), 'err') }))
  }

  // ---- rendering (regions) ----
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
    try { dotEl.style.setProperty('--ow-pill', m.color) } catch (e) {}
  }

  function renderHeader() {
    panel.querySelector('.ow-hd-title').textContent = t('title')
    panel.querySelector('.ow-hd-sub').textContent = t('subtitle')
    panel.querySelector('.ow-lang').textContent = (lang === 'zh' ? 'EN' : '中文')
    btn.title = t('open')
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
    var html = '<div class="ow-sec-h">' + esc(t('status')) + '</div>' +
      '<div class="ow-card ow-status">' +
        '<div class="ow-state" style="--ow-state:' + m.color + '">' +
          '<span class="ow-state-dot"></span><span class="ow-state-lbl ' + m.cls + '">' + esc(t(m.key)) + '</span>' +
        '</div>' +
        '<div class="ow-status-actions">' +
          '<button class="ow-btn ghost" data-a="login"' + (busy ? ' disabled' : '') + '>' + esc(t('login')) + '</button>' +
          '<button class="ow-btn" data-a="start"' + (busy || isRunning ? ' disabled' : '') + '>' + esc(t('start')) + '</button>' +
          '<button class="ow-btn danger" data-a="stop"' + (busy || !isRunning ? ' disabled' : '') + '>' + esc(t('stop')) + '</button>' +
        '</div>' +
        (meta.length ? '<div class="ow-meta">' + meta.map(esc).join(' · ') + '</div>' : '') +
        (banner ? '<div class="ow-banner ' + bannerType + '">' + esc(banner) + '</div>' : '') +
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
    var html = '<div class="ow-card ow-diag">' +
      '<span class="ow-badge ' + (ok ? 'ok' : 'warn') + '">' + (ok ? t('ready') : t('attention')) + '</span>' +
      '<div class="ow-diag-list">' +
        '<div class="ow-diag-row"><span class="ow-k">' + t('python') + '</span><b class="' + (d.python === 'ok' ? 'ok' : 'err') + '">' + esc(String(d.python)) + '</b></div>' +
        (realPath ? '<div class="ow-diag-path">' + esc(d.pythonPath) + '</div>' : '') +
        '<div class="ow-diag-row"><span class="ow-k">' + t('deps') + '</span><b class="' + (d.deps === 'ok' ? 'ok' : 'err') + '">' + esc(String(d.deps)) + '</b></div>' +
        (d.message ? '<div class="ow-muted ow-diag-msg">' + esc(trMsg(d.message)) + '</div>' : '') +
      '</div>' +
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
    var html = '<div class="ow-sec-h">' + esc(t('config')) + '</div>' +
      '<div class="ow-card ow-config">' +
        fieldHtml('chat2apiDir', t('dir'), t('dirHint')) +
        fieldHtml('baseUrl', t('baseUrl'), '') +
        '<div class="ow-grid2">' +
          fieldHtml('host', t('host'), '', '127.0.0.1') +
          fieldHtml('port', t('port'), '', '8000') +
        '</div>' +
        '<label class="ow-switch-row"><input type="checkbox" data-cb="autoStart"' + (form && form.autoStart ? ' checked' : '') + '><span class="ow-switch"></span><span>' + esc(t('autoStart')) + '</span></label>' +
        '<div class="ow-scan-row"><button class="ow-btn" data-effort-scan="1" type="button">' + esc(t('effortScan')) + '</button><div class="ow-hint">' + esc(t('effortScanHint')) + '</div><div class="ow-effort-result" style="display:none"></div></div>' +
        '<div class="ow-config-foot"><button class="ow-btn" data-save="1">' + esc(t('save')) + '</button><div class="ow-save-result" style="display:none"></div></div>' +
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
    if (es) es.addEventListener('click', doEffortScan)
  }

  function setField(k, v) {
    form = Object.assign({}, form || {}, { [k]: v })
  }

  function renderUsageRegion() {
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
      var s = usage.summary || { calls: 0, in_tokens: 0, out_tokens: 0, cached_tokens: 0, latency_ms: 0, errors: 0 }
      var stats = [
        [t('calls'), fmt(s.calls)], [t('inTok'), fmt(s.in_tokens)], [t('outTok'), fmt(s.out_tokens)],
        [t('cached'), fmt(s.cached_tokens)],
        [t('latency'), s.calls ? fmt(Math.round(s.latency_ms / s.calls)) + ' ms' : '-'],
        [t('errs'), fmt(s.errors)],
      ]
      body = '<div class="ow-stats">'
      for (var i = 0; i < stats.length; i++) {
        body += '<div class="ow-stat"><div class="v">' + esc(stats[i][1]) + '</div><div class="l">' + esc(stats[i][0]) + '</div></div>'
      }
      body += '</div>'
      // Per-model usage as a compact "share bar" leaderboard - a 7-column table
      // does not fit a 468px overlay. Top 6 models by tokens; the rest fold into
      // "Other N"; hover a row for the full per-model breakdown.
      var rows = usage.per_model || []
      if (rows.length) {
        var list = rows.map(function (m) {
          return { model: m.model, calls: m.calls || 0, in: m.in_tokens || 0, out: m.out_tokens || 0, cached: m.cached_tokens || 0, lat: m.latency_ms || 0, err: m.errors || 0 }
        })
        list.sort(function (a, b) { return (b.in + b.out) - (a.in + a.out) })
        var total = 0
        for (var gi = 0; gi < list.length; gi++) total += list[gi].in + list[gi].out
        var shown = list.slice(0, 6)
        var restN = list.length - shown.length
        if (restN > 0) {
          var o = { model: t('others').replace('{0}', restN), calls: 0, in: 0, out: 0, cached: 0, lat: 0, err: 0 }
          for (var gj = 0; gj < restN; gj++) { var x = list[shown.length + gj]; o.calls += x.calls; o.in += x.in; o.out += x.out; o.cached += x.cached; o.lat += x.lat; o.err += x.err }
          shown.push(o)
        }
        body += '<div class="ow-mbar-list">'
        for (var gk = 0; gk < shown.length; gk++) {
          var mm = shown[gk]
          var tk = mm.in + mm.out
          var pct = total ? (tk / total * 100) : 0
          var avgs = mm.calls ? fmt(Math.round(mm.lat / mm.calls)) + ' ms' : '-'
          var title = (mm.model || '') + ' · ' + fmtC(mm.calls) + ' ' + t('calls') + ' · ' + t('inTok') + ' ' + fmtC(mm.in) + ' · ' + t('outTok') + ' ' + fmtC(mm.out) + ' · ' + t('cached') + ' ' + fmtC(mm.cached) + ' · ' + t('latency') + ' ' + avgs + ' · ' + t('errs') + ' ' + fmtC(mm.err)
          body += '<div class="ow-mbar" title="' + esc(title) + '">' +
            '<div class="ow-mbar-top"><span class="ow-mbar-nm">' + esc(mm.model || '-') + '</span>' +
            '<span class="ow-mbar-tk">' + fmtC(tk) + '</span>' +
            '<span class="ow-mbar-pct">' + Math.round(pct) + '%</span></div>' +
            '<div class="ow-mbar-track"><div class="ow-mbar-fill" style="width:' + Math.max(0.5, Math.min(100, pct)) + '%"></div></div>' +
            '</div>'
        }
        body += '</div>'
      } else {
        body += '<p class="ow-muted">' + esc(t('noCalls')) + '</p>'
      }
    }

    var tabs = ''
    var ranges = ['today', 'yesterday', 'month', 'cumulative']
    for (var i2 = 0; i2 < ranges.length; i2++) {
      tabs += '<button class="ow-tab' + (ranges[i2] === range ? ' on' : '') + '" data-rg="' + ranges[i2] + '">' + esc(t(ranges[i2])) + '</button>'
    }

    secUsage.innerHTML =
      '<div class="ow-sec-h">' + esc(t('usage')) + '</div>' +
      '<div class="ow-card ow-usage">' +
        '<div class="ow-tabs">' + tabs + '</div>' + body +
      '</div>'
    secUsage.querySelectorAll('button[data-rg]').forEach(function (b) {
      b.addEventListener('click', function () { range = b.getAttribute('data-rg'); usage = null; loadUsage() })
    })
  }
  function refreshUsage() { renderUsageRegion() }

  function renderLogRegion() {
    var lines = (snap && snap.log) || []
    if (!lines.length) { secLog.innerHTML = ''; return }
    secLog.innerHTML =
      '<div class="ow-sec-h">' + esc(t('log')) + '</div>' +
      '<details class="ow-log"' + (logOpen ? ' open' : '') + '><summary>' + esc(t('log')) + ' · ' + lines.length + '</summary><pre>' + esc(lines.join('\n')) + '</pre></details>'
    var de = secLog.querySelector('.ow-log')
    if (de) de.addEventListener('toggle', function () {
      logOpen = de.open
      try { localStorage.setItem('dsh-owui-logopen', logOpen ? '1' : '0') } catch (e) { /* ignore */ }
    })
  }

  function refreshDynamic() {
    renderStatusRegion()
    renderDiagRegion()
    renderUsageRegion()
    renderLogRegion()
  }
  function renderAll() {
    renderHeader()
    renderStatusRegion()
    renderDiagRegion()
    renderConfigRegion()
    renderUsageRegion()
    renderLogRegion()
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  }
  function fmt(n) { return (n || 0).toLocaleString() }
  // Compact formatter for the per-model table: 139,062 -> 139.1K, 58,132,042 -> 58.1M.
  function fmtC(n) {
    n = n || 0
    if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B'
    if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M'
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.?0+$/, '') + 'K'
    return String(n)
  }

  function cssText() {
    return (
      ':root { --ow-r: 14px; --ow-r-sm: 9px; --ow-gap: 12px; --ow-shadow: 0 14px 44px rgba(0,0,0,.5); }' +
      '#dsh-owui-btn { position: fixed; right: 28px; top: 18px; z-index: 2147483000;' +
        ' display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; cursor: pointer; user-select: none;' +
        ' background: var(--dsw-alias-bg-layer-1, rgba(40,40,40,.95)); color: var(--dsw-alias-label-primary, #e5e7eb);' +
        ' border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.4)); border-radius: 999px;' +
        ' font: 600 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: var(--ow-shadow); }' +
      '#dsh-owui-btn:hover { background: var(--dsw-alias-bg-layer-2, rgba(60,60,60,.98)); }' +
      '#dsh-owui-btn .ow-pill-dot { width: 8px; height: 8px; border-radius: 50%;' +
        ' background: var(--ow-pill, var(--dsw-alias-label-secondary, #888));' +
        ' box-shadow: 0 0 0 3px color-mix(in srgb, var(--ow-pill, var(--dsw-alias-label-secondary)) 20%, transparent);' +
        ' transition: background .2s; }' +
      '#dsh-owui-panel { position: fixed; right: 28px; top: 66px; z-index: 2147483001; width: 468px;' +
        ' max-width: calc(100vw - 36px); max-height: min(680px, calc(100vh - 100px)); overflow: auto;' +
        ' display: none; flex-direction: column;' +
        ' background: var(--dsw-specific-sidebar-fill, #202020); color: var(--dsw-alias-label-primary, #e5e7eb);' +
        ' border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.55)); border-radius: var(--ow-r);' +
        ' font: 13px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: var(--ow-shadow); }' +
      '#dsh-owui-panel.open { display: flex; }' +
      '#dsh-owui-panel .ow-hd { display: flex; align-items: flex-start; gap: 10px; padding: 18px 20px 12px; }' +
      '#dsh-owui-panel .ow-hd-t { flex: 1; min-width: 0; }' +
      '#dsh-owui-panel .ow-hd-title { font-size: 15px; font-weight: 600; }' +
      '#dsh-owui-panel .ow-hd-sub { font-size: 12px; color: var(--dsw-alias-label-secondary, #9ca3af); margin-top: 2px; }' +
      '#dsh-owui-panel .ow-hd-actions { display: flex; align-items: center; gap: 6px; user-select: none; }' +
      '#dsh-owui-panel .ow-lang, #dsh-owui-panel .ow-close { font-size: 11px; padding: 3px 8px; border-radius: 6px;' +
        ' color: var(--dsw-alias-label-secondary, #9ca3af); cursor: pointer; border: 1px solid transparent; }' +
      '#dsh-owui-panel .ow-lang:hover, #dsh-owui-panel .ow-close:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.15)); color: var(--dsw-alias-label-primary, #fff); }' +
      '#dsh-owui-panel .ow-body { padding: 4px 20px 20px; }' +
      '#dsh-owui-panel .ow-sec { margin-top: 14px; }' +
      '#dsh-owui-panel .ow-sec-h { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em;' +
        ' color: var(--dsw-alias-label-secondary, #9ca3af); margin: 0 2px 8px; }' +
      '#dsh-owui-panel .ow-card { background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.04));' +
        ' border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28)); border-radius: var(--ow-r-sm); padding: 14px; }' +
      '#dsh-owui-panel .ow-status { display: flex; flex-direction: column; gap: 12px; }' +
      '#dsh-owui-panel .ow-state { display: inline-flex; align-items: center; gap: 8px; }' +
      '#dsh-owui-panel .ow-state-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--ow-state, var(--dsw-alias-label-secondary));' +
        ' box-shadow: 0 0 0 4px color-mix(in srgb, var(--ow-state) 20%, transparent); }' +
      '#dsh-owui-panel .ow-state-lbl { font-size: 13px; font-weight: 600; }' +
      '#dsh-owui-panel .ow-state-lbl.ok { color: var(--dsw-alias-state-success-primary); }' +
      '#dsh-owui-panel .ow-state-lbl.warn { color: var(--dsw-alias-state-warn-primary); }' +
      '#dsh-owui-panel .ow-state-lbl.err { color: var(--dsw-alias-state-error-primary); }' +
      '#dsh-owui-panel .ow-status-actions { display: flex; gap: 8px; }' +
      '#dsh-owui-panel .ow-meta { font-size: 11px; color: var(--dsw-alias-label-secondary, #9ca3af); }' +
      '#dsh-owui-panel .ow-banner { font-size: 12px; padding: 7px 10px; border-radius: 8px; }' +
      '#dsh-owui-panel .ow-banner.ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent); color: var(--dsw-alias-state-success-primary); }' +
      '#dsh-owui-panel .ow-banner.err { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); color: var(--dsw-alias-state-error-primary); }' +
      '#dsh-owui-panel .ow-btn { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent);' +
        ' color: var(--dsw-alias-brand-primary);' +
        ' border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent);' +
        ' border-radius: 8px; padding: 8px 16px; font: 600 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; cursor: pointer; }' +
      '#dsh-owui-panel .ow-btn.ghost { background: transparent; color: var(--dsw-alias-label-primary, #e5e7eb); border-color: var(--dsw-alias-border-l2, rgba(128,128,128,.5)); font-weight: 500; }' +
      '#dsh-owui-panel .ow-btn.danger { background: transparent; color: var(--dsw-alias-state-error-primary, #f87171);' +
        ' border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent); }' +
      '#dsh-owui-panel .ow-btn:not(:disabled):hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 28%, transparent); }' +
      '#dsh-owui-panel .ow-btn.ghost:not(:disabled):hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent); }' +
      '#dsh-owui-panel .ow-btn.danger:not(:disabled):hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); }' +
      '#dsh-owui-panel .ow-btn:disabled { opacity: .45; cursor: not-allowed; }' +
      '#dsh-owui-panel .ow-diag { display: flex; align-items: flex-start; gap: 10px; font-size: 12px; }' +
      '#dsh-owui-panel .ow-diag-list { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }' +
      '#dsh-owui-panel .ow-badge { font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 999px; }' +
      '#dsh-owui-panel .ow-badge.ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent); color: var(--dsw-alias-state-success-primary); }' +
      '#dsh-owui-panel .ow-badge.warn { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent); color: var(--dsw-alias-state-warn-primary); }' +
      '#dsh-owui-panel .ow-diag-row { display: flex; align-items: baseline; gap: 6px; }' +
      '#dsh-owui-panel .ow-diag-row .ow-k { color: var(--dsw-alias-label-secondary, #9ca3af); }' +
      '#dsh-owui-panel .ow-diag-row b.ok { color: var(--dsw-alias-state-success-primary); font-weight: 600; }' +
      '#dsh-owui-panel .ow-diag-row b.err { color: var(--dsw-alias-state-error-primary); font-weight: 600; }' +
      '#dsh-owui-panel .ow-diag-path { font-size: 11px; word-break: break-all; color: var(--dsw-alias-label-secondary, #9ca3af); }' +
      '#dsh-owui-panel .ow-diag-msg { font-size: 11px; }' +
      '#dsh-owui-panel .ow-field { margin-bottom: 12px; }' +
      '#dsh-owui-panel .ow-scan-row { margin: 14px 0 0; }' +
      '#dsh-owui-panel .ow-scan-row .ow-btn { width: 100%; }' +
      '#dsh-owui-panel .ow-effort-result { margin-top: 8px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }' +
      '#dsh-owui-panel .ow-effort-result.ok { color: var(--dsw-alias-state-success-primary); }' +
      '#dsh-owui-panel .ow-effort-result.err { color: var(--dsw-alias-state-error-primary); }' +
      '#dsh-owui-panel .ow-effort-result:empty { display: none; }' +
      '#dsh-owui-panel .ow-save-result { margin-top: 10px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }' +
      '#dsh-owui-panel .ow-save-result.ok { color: var(--dsw-alias-state-success-primary); }' +
      '#dsh-owui-panel .ow-save-result.err { color: var(--dsw-alias-state-error-primary); }' +
      '#dsh-owui-panel .ow-save-result:empty { display: none; }' +
      '#dsh-owui-panel .ow-field label { display: block; font-size: 12px; color: var(--dsw-alias-label-secondary, #9ca3af); margin-bottom: 5px; }' +
      '#dsh-owui-panel .ow-field input[type=text] { width: 100%; box-sizing: border-box; padding: 8px 10px; font: inherit;' +
        ' background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.35)); color: var(--dsw-alias-label-primary, #e5e7eb);' +
        ' border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35)); border-radius: 8px; outline: none; }' +
      '#dsh-owui-panel .ow-field input[type=text]:focus { border-color: var(--dsw-alias-brand-primary);' +
        ' box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 25%, transparent); }' +
      '#dsh-owui-panel .ow-hint { font-size: 11px; color: var(--dsw-alias-label-secondary, #9ca3af); margin-top: 4px; }' +
      '#dsh-owui-panel .ow-grid2 { display: grid; grid-template-columns: 1fr 118px; gap: 12px; }' +
      '#dsh-owui-panel .ow-switch-row { display: flex; align-items: center; gap: 9px; font-size: 12px; cursor: pointer; margin-top: 4px; color: var(--dsw-alias-label-primary); user-select: none; }' +
      '#dsh-owui-panel .ow-switch-row input { display: none; }' +
      '#dsh-owui-panel .ow-switch { position: relative; width: 32px; height: 18px; flex: 0 0 auto; border-radius: 999px;' +
        ' background: var(--ow-swoff, #3E3E3F); transition: background .15s; }' +
      '#dsh-owui-panel .ow-switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 12px; height: 12px; border-radius: 50%;' +
        ' background: var(--ow-swk, #0F1115); box-shadow: 0 1px 2px rgba(0,0,0,.35); transition: transform .15s, background .15s; }' +
      '#dsh-owui-panel .ow-switch-row input:checked + .ow-switch { background: var(--ow-swon, #F9FAFB); }' +
      '#dsh-owui-panel .ow-switch-row input:checked + .ow-switch::after { transform: translateX(14px); }' +
      '#dsh-owui-panel.ow-dark .ow-switch { --ow-swoff: #3E3E3F; --ow-swon: #F9FAFB; --ow-swk: #0F1115; }' +
      '#dsh-owui-panel.ow-light .ow-switch { --ow-swoff: #E5E5E5; --ow-swon: #0F1115; --ow-swk: #FFFFFF; }' +
      '#dsh-owui-panel .ow-config-foot { display: flex; justify-content: flex-end; margin-top: 14px; }' +
      '#dsh-owui-panel .ow-tabs { display: inline-flex; gap: 2px; padding: 3px; border-radius: 9px;' +
        ' background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.3)); border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); margin-bottom: 14px; user-select: none; }' +
      '#dsh-owui-panel .ow-tab { border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary, #9ca3af);' +
        ' font: 500 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 5px 11px; border-radius: 7px; cursor: pointer; }' +
      '#dsh-owui-panel .ow-tab:not(.on):hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 9%, transparent); }' +
      '#dsh-owui-panel .ow-tab.on { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent);' +
        ' color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 42%, transparent); }' +
      '#dsh-owui-panel .ow-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px 8px; margin-bottom: 14px; }' +
      '#dsh-owui-panel .ow-stat .v { font-size: 17px; font-weight: 650; letter-spacing: .2px; }' +
      '#dsh-owui-panel .ow-stat .l { font-size: 10px; color: var(--dsw-alias-label-secondary, #9ca3af); margin-top: 1px; text-transform: uppercase; letter-spacing: .03em; }' +
      '#dsh-owui-panel .ow-mbar-list { margin-top: 4px; }' +
      '#dsh-owui-panel .ow-mbar { padding: 7px 0 8px; }' +
      '#dsh-owui-panel .ow-mbar + .ow-mbar { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.14)); }' +
      '#dsh-owui-panel .ow-mbar-top { display: flex; align-items: baseline; gap: 8px; font-size: 11.5px; }' +
      '#dsh-owui-panel .ow-mbar-nm { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;' +
        ' font-weight: 600; color: var(--dsw-alias-label-primary, #e5e7eb); }' +
      '#dsh-owui-panel .ow-mbar-tk { color: var(--dsw-alias-label-primary, #e5e7eb); font-variant-numeric: tabular-nums; }' +
      '#dsh-owui-panel .ow-mbar-pct { width: 38px; text-align: right; font-size: 10.5px;' +
        ' color: var(--dsw-alias-label-secondary, #9ca3af); font-variant-numeric: tabular-nums; }' +
      '#dsh-owui-panel .ow-mbar-track { height: 4px; margin-top: 5px; border-radius: 999px;' +
        ' background: var(--dsw-alias-border-l2, rgba(128,128,128,.22)); overflow: hidden; }' +
      '#dsh-owui-panel .ow-mbar-fill { height: 100%; border-radius: 999px;' +
        ' background: color-mix(in srgb, var(--dsw-alias-brand-primary) 65%, transparent); }' +
      '#dsh-owui-panel .ow-log summary { font-size: 11px; color: var(--dsw-alias-label-secondary, #9ca3af); cursor: pointer;' +
        ' padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); border-radius: 8px;' +
        ' background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03)); user-select: none; }' +
      '#dsh-owui-panel .ow-log pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px;' +
        ' white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-secondary, #9ca3af);' +
        ' background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.28)); border-radius: 8px; padding: 10px; margin-top: 6px;' +
        ' max-height: 160px; overflow: auto; }' +
      '#dsh-owui-panel .ow-muted { color: var(--dsw-alias-label-secondary, #9ca3af); font-size: 12px; margin: 4px 0; }' +
      '#dsh-owui-panel .ow-warn { color: var(--dsw-alias-state-warn-primary, #fbbf24); font-size: 12px; margin: 4px 0; }' +
      '#dsh-owui-panel ::-webkit-scrollbar { width: 9px; height: 9px; }' +
      '#dsh-owui-panel ::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2, rgba(128,128,128,.4)); border-radius: 99px; border: 2px solid transparent; background-clip: content-box; }'
    )
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
  applyMode()
  if (typeof MutationObserver !== 'undefined' && document.body) {
    try {
      new MutationObserver(function () { applyMode(); anchorOverlay() }).observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    } catch (e) { /* ignore */ }
  }
  renderAll()
  poll()
  anchorOverlay()
  setTimeout(anchorOverlay, 400) // re-pin once layout/fonts have settled
  setInterval(anchorOverlay, 800) // keep re-anchoring while the app mounts/changes
  // Cheap polling policy: full re-renders only while the panel is open; just
  // keep the pill dot honest (one small status fetch) while it is closed; and
  // pause entirely when the page is hidden behind other windows/tabs.
  function pollTick() {
    if (document.hidden) return
    if (panel.classList.contains('open')) { poll(); return }
    api('status').then(function (r) {
      snap = r || snap
      updatePill(stateMeta())
    }).catch(function () { /* keep last known */ })
  }
  function usageTick() {
    if (document.hidden || !panel.classList.contains('open')) return
    var cfg = (snap && snap.config) || form || {}
    if (String(cfg.chat2apiDir || '').trim()) loadUsage()
  }
  setInterval(pollTick, 3000)
  setInterval(usageTick, 8000)
})()
