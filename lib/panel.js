/* dsh-owui-chat2api panel - vanilla JS, injected into the DSH web shell via tapIndex.
 *
 * - UI uses DSH's theme tokens (--dsw-alias-* / --dsw-specific-sidebar-fill);
 *   radius / spacing / shadows are this panel's own conventions.
 * - Talks to same-origin host routes at /dsh-owui-chat2api/api/* and reads usage
 *   straight from the proxy's CORS-enabled /v1/usage.
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
      usage: 'Usage', status: 'Status', today: 'Today', yesterday: 'Yesterday', month: 'Month', cumulative: 'Cumulative',
      calls: 'Calls', inTok: 'In', outTok: 'Out', cached: 'Cached', latency: 'Avg latency', errs: 'Errors',
      m: 'Model', ctx: 'Count', tin: 'In', tout: 'Out', tcached: 'Cached', tavg: 'Avg ms', terr: 'Err',
      log: 'Process log', noCalls: 'No calls in this range.', loading: 'Loading...',
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
      usage: '用量', status: '状态', today: '今天', yesterday: '昨天', month: '本月', cumulative: '累计',
      calls: '调用', inTok: '输入', outTok: '输出', cached: '缓存', latency: '平均延迟', errs: '错误',
      m: '模型', ctx: '次数', tin: '入', tout: '出', tcached: '缓存', tavg: '平均 ms', terr: '误',
      log: '进程日志', noCalls: '该时间段暂无调用。', loading: '加载中...',
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

  var secStatus = panel.querySelector('[data-sec="status"]')
  var secDiag = panel.querySelector('[data-sec="diag"]')
  var secConfig = panel.querySelector('[data-sec="config"]')
  var secUsage = panel.querySelector('[data-sec="usage"]')
  var secLog = panel.querySelector('[data-sec="log"]')

  // Click the pill toggles the panel; click anywhere outside closes it.
  btn.addEventListener('click', function () { panel.classList.toggle('open') })
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
  var range = 'today'
  var usage = null
  var usageOffline = false

  function setBanner(m, type) { banner = m; bannerType = type || ''; bannerAt = Date.now() }

  function api(p, opts) {
    return fetch(ROUTE + '/api/' + p, opts).then(function (r) { return r.json() })
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
    var cfg = (snap && snap.config) || form || {}
    fetch('http://' + (cfg.host || '127.0.0.1') + ':' + (cfg.port || 8000) + '/v1/usage?range=' + encodeURIComponent(range))
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
      .then(function (j) { usage = j; usageOffline = false; refreshUsage() })
      .catch(function () { usageOffline = true; refreshUsage() })
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
  function doSave() {
    withBusy(api('config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form || {}) }).then(function (r) {
      snap = r || snap
      if (r && r.config) { form = Object.assign({}, r.config); renderConfigRegion() }
      var bad = r && r.startResult && !r.startResult.ok
      setBanner(bad ? (r.startResult.message || t('save')) : t('saved'), bad ? 'err' : 'ok')
      if (!bad) loadUsage()
    }).catch(function (e) { setBanner(String((e && e.message) || e), 'err') }))
  }
  function doStart() {
    withBusy(api('start', { method: 'POST' }).then(function (r) {
      if (!r || !r.ok) setBanner((r && r.message) || (t('start') + '?'), 'err')
      else poll()
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
    if (st && st.message) meta.push(esc(st.message))

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
    var html = '<div class="ow-card ow-diag">' +
      '<span class="ow-badge ' + (ok ? 'ok' : 'warn') + '">' + (ok ? t('ready') : t('attention')) + '</span>' +
      '<span class="ow-diag-item"><span class="ow-k">' + t('python') + '</span> <b>' + esc(String(d.python)) + '</b></span>' +
      (d.pythonPath ? '<span class="ow-muted">' + esc(d.pythonPath) + '</span>' : '') +
      '<span class="ow-diag-item"><span class="ow-k">' + t('deps') + '</span> <b class="' + (d.deps === 'ok' ? 'ok' : 'err') + '">' + esc(String(d.deps)) + '</b></span>' +
      (d.message ? '<span class="ow-muted ow-diag-msg">' + esc(d.message) + '</span>' : '') +
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
        '<div class="ow-config-foot"><button class="ow-btn" data-save="1">' + esc(t('save')) + '</button></div>' +
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
  }

  function setField(k, v) {
    form = Object.assign({}, form || {}, { [k]: v })
  }

  function renderUsageRegion() {
    var cfg = (snap && snap.config) || form || null
    var cfgReady = Boolean(cfg && String(cfg.chat2apiDir || '').trim())
    var url = 'http://' + (cfg && cfg.host || '127.0.0.1') + ':' + (cfg && cfg.port || 8000) + '/v1/usage?range=' + range

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
      var rows = usage.per_model || []
      if (rows.length) {
        body += '<div class="ow-tbl-wrap"><table class="ow-tbl"><thead><tr>' +
          '<th class="l">' + t('m') + '</th><th>' + t('ctx') + '</th><th>' + t('tin') + '</th><th>' + t('tout') + '</th><th>' + t('tcached') + '</th><th>' + t('tavg') + '</th><th>' + t('terr') + '</th>' +
          '</tr></thead><tbody>'
        for (var r = 0; r < rows.length; r++) {
          var m = rows[r]
          body += '<tr><td class="l" title="' + esc(m.model || '') + '">' + esc(m.model || '-') + '</td>' +
            '<td>' + fmtC(m.calls) + '</td><td>' + fmtC(m.in_tokens) + '</td><td>' + fmtC(m.out_tokens) + '</td>' +
            '<td>' + fmtC(m.cached_tokens) + '</td><td>' + (m.calls ? fmtC(Math.round(m.latency_ms / m.calls)) : 0) + '</td>' +
            '<td>' + fmtC(m.errors) + '</td></tr>'
        }
        body += '</tbody></table></div>'
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
      '<details class="ow-log"><summary>' + esc(t('log')) + ' · ' + lines.length + '</summary><pre>' + esc(lines.join('\n')) + '</pre></details>'
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
      '#dsh-owui-btn { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;' +
        ' display: inline-flex; align-items: center; gap: 8px; padding: 8px 14px; cursor: pointer; user-select: none;' +
        ' background: var(--dsw-alias-bg-layer-1, rgba(40,40,40,.95)); color: var(--dsw-alias-label-primary, #e5e7eb);' +
        ' border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.4)); border-radius: 999px;' +
        ' font: 600 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; box-shadow: var(--ow-shadow); }' +
      '#dsh-owui-btn:hover { background: var(--dsw-alias-bg-layer-2, rgba(60,60,60,.98)); }' +
      '#dsh-owui-btn .ow-pill-dot { width: 8px; height: 8px; border-radius: 50%;' +
        ' background: var(--ow-pill, var(--dsw-alias-label-secondary, #888));' +
        ' box-shadow: 0 0 0 3px color-mix(in srgb, var(--ow-pill, var(--dsw-alias-label-secondary)) 20%, transparent);' +
        ' transition: background .2s; }' +
      '#dsh-owui-panel { position: fixed; right: 18px; bottom: 62px; z-index: 2147483001; width: 468px;' +
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
      '#dsh-owui-panel .ow-diag { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }' +
      '#dsh-owui-panel .ow-badge { font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 999px; }' +
      '#dsh-owui-panel .ow-badge.ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent); color: var(--dsw-alias-state-success-primary); }' +
      '#dsh-owui-panel .ow-badge.warn { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent); color: var(--dsw-alias-state-warn-primary); }' +
      '#dsh-owui-panel .ow-diag-item { color: var(--dsw-alias-label-primary); }' +
      '#dsh-owui-panel .ow-diag-item .ow-k { color: var(--dsw-alias-label-secondary, #9ca3af); }' +
      '#dsh-owui-panel .ow-diag-msg { width: 100%; }' +
      '#dsh-owui-panel .ow-field { margin-bottom: 12px; }' +
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
      '#dsh-owui-panel .ow-tbl-wrap { width: 100%; overflow-x: auto; }' +
      '#dsh-owui-panel .ow-tbl { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 10.5px; }' +
      '#dsh-owui-panel .ow-tbl th { color: var(--dsw-alias-label-secondary, #9ca3af); font-weight: 600; text-align: right;' +
        ' padding: 6px 3px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); white-space: nowrap;' +
        ' overflow: hidden; text-overflow: ellipsis; }' +
      '#dsh-owui-panel .ow-tbl td { padding: 6px 3px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.14)); text-align: right; white-space: nowrap;' +
        ' overflow: hidden; text-overflow: ellipsis; }' +
      '#dsh-owui-panel .ow-tbl th.l, #dsh-owui-panel .ow-tbl td.l { text-align: left; width: 36%; }' +
      '#dsh-owui-panel .ow-tbl tr:last-child td { border-bottom: 0; }' +
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
      new MutationObserver(applyMode).observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    } catch (e) { /* ignore */ }
  }
  renderAll()
  poll()
  setInterval(poll, 3000)
  setInterval(function () {
    var cfg = (snap && snap.config) || form || {}
    if (String(cfg.chat2apiDir || '').trim()) loadUsage()
  }, 8000)
})()
