/* dsh-owui-chat2api panel - vanilla JS, injected into the DSH web shell via tapIndex.
 *
 * - UI uses DSH's theme tokens (--dsw-alias-* / --dsw-specific-sidebar-fill);
 *   radius / spacing / shadows are this panel's own conventions.
 * - Talks to same-origin host routes at /dsh-owui-chat2api/api/*; usage is
 *   proxied through /api/usage so it also works over HTTPS and when DSH is
 *   accessed remotely (no mixed content, no CORS dependency on the proxy).
 * - i18n: en + zh-CN dictionaries live in lib/panel-i18n.js (injected right
 *   before this script). First load follows navigator.language
 *   (which mirrors the DSH GUI language); a header toggle switches and is
 *   remembered in localStorage. The locale service cannot be used here: this is
 *   a page-injected script, not a Cordis client module.
 *
 * Polling only re-renders the dynamic regions (status / diagnostics / usage /
 * log); the config form is built once so typing never loses focus. busy is a
 * guard that can never wedge the buttons - it force-clears after a timeout.
 * All timers are gated: full re-render only while the panel is open, the boot
 * anchor poll stops once the shell is pinned (ResizeObserver takes over), and
 * everything pauses while the page is hidden.
 */
(function () {
  if (window.__dshOwuiMounted) return
  window.__dshOwuiMounted = true

  var ROUTE = '/dsh-owui-chat2api'
  var LS_KEY = 'dsh-owui-lang'

  // Dictionaries live in lib/panel-i18n.js, injected by the host right before
  // this script (defer preserves order). Degrade to empty dicts if it ever
  // fails to load - t() then shows the key itself instead of crashing.
  var I18N = (window.__dshOwuiI18n || {}).dict || { en: {}, zh: {} }

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
  // The table lives in panel-i18n.js (msg); KEYS use ASCII '...' - the lookup
  // normalises the host's U+2026 ellipsis.
  var MSG = (window.__dshOwuiI18n || {}).msg || { en: {}, zh: {} }
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

  // Styles come from lib/panel.css, served by the host at
  // /dsh-owui-chat2api/panel.css and injected via tapIndex as a <link>.

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
    '<div class="ow-notice" style="display:none"></div>' +
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
  window.addEventListener('resize', anchorOverlay)

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
  // role="button" affordances: Enter/Space activate like a click (keyboard a11y)
  ;[['.ow-close', function () { panel.classList.remove('open') }], ['.ow-lang', function () { setLang(lang === 'zh' ? 'en' : 'zh') }]].forEach(function (pair) {
    panel.querySelector(pair[0]).addEventListener('keydown', function (e) {
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
      if (banner && !busy && Date.now() - bannerAt > 6000) { banner = ''; bannerType = '' }
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
    // Long busy window: a full scan (esp. force re-probe) can take minutes; the
    // 8s default would unlock the button mid-scan and allow a second concurrent
    // run that corrupts settings.yaml writes. Feedback rides the sticky notice
    // (the loading state persists for the whole run - poll won't clear it while
    // busy), results land there too on completion.
    withBusy(function () {
      setBanner(t('loading'), 'info')
      return api(force ? 'effort-scan-force' : 'effort-scan', { method: 'POST' }).then(function (r) {
        if (!r || !r.ok) { setBanner((r && r.message) || (t('effortScan') + '?'), 'err'); return }
        var bits = []
        if (r.providerCreated) bits.push(t('effortScanProviderCreated') + ' ' + (r.providerName || ''))
        if (r.modelsAdded && r.modelsAdded.length) bits.push(t('effortScanModelsAdded') + ' ' + r.modelsAdded.join(', '))
        if (r.modelsAlready && r.modelsAlready.length) bits.push(t('effortScanModelsAlready') + ' ' + r.modelsAlready.join(', '))
        if (r.added && r.added.length) bits.push(t('effortScanPatched') + ' ' + r.added.join(', '))
        if (r.already && r.already.length) bits.push(t('effortScanAlready') + ' ' + r.already.join(', '))
        if (r.skipped && r.skipped.length) bits.push(t('effortScanSkipped') + ' ' + r.skipped.join(', '))
        var done = bits.length ? bits.join('\n') + (r.changed ? t('effortScanRestart') : '') : t('effortScanDone')
        setBanner(done, r.verify ? 'warn' : (r.changed ? 'ok' : 'info'))
      }).catch(function (e) { setBanner(String((e && e.message) || e), 'err') })
    }, 1800000)
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
        '<div class="ow-flex ow-gap ow-wrap">' +
          '<div class="ow-state" style="--ow-state:' + m.color + '">' +
            '<span class="ow-state-dot"></span><span class="ow-state-lbl ' + m.cls + '">' + esc(t(m.key)) + '</span>' +
          '</div>' +
          '<div class="ow-status-actions">' +
            '<button class="ow-btn ghost" data-a="login"' + (busy ? ' disabled' : '') + '>' + esc(t('login')) + '</button>' +
            '<button class="ow-btn" data-a="start"' + (busy || isRunning ? ' disabled' : '') + '>' + esc(t('start')) + '</button>' +
            '<button class="ow-btn danger" data-a="stop"' + (busy || !isRunning ? ' disabled' : '') + '>' + esc(t('stop')) + '</button>' +
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
    var html = '<div class="ow-card ow-diag">' +
      '<span class="ow-badge ' + (ok ? 'ok' : 'warn') + '">' + (ok ? t('ready') : t('attention')) + '</span>' +
      '<div class="ow-diag-list">' +
        '<div class="ow-diag-row"><span class="ow-k">' + t('python') + '</span><b class="' + (d.python === 'ok' ? 'ok' : 'err') + '">' + esc(String(d.python)) + '</b></div>' +
        '<div class="ow-diag-row"><span class="ow-k">' + t('deps') + '</span><b class="' + (d.deps === 'ok' ? 'ok' : 'err') + '">' + esc(String(d.deps)) + '</b></div>' +
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
    var html = '<div class="ow-sec-h">' + esc(t('config')) + '</div>' +
      '<div class="ow-card ow-config">' +
        fieldHtml('chat2apiDir', t('dir'), t('dirHint')) +
        fieldHtml('baseUrl', t('baseUrl'), '') +
        '<div class="ow-grid2">' +
          fieldHtml('host', t('host'), '', '127.0.0.1') +
          fieldHtml('port', t('port'), '', '8000') +
        '</div>' +
        '<label class="ow-switch-row ow-flex ow-gap"><input type="checkbox" data-cb="autoStart"' + (form && form.autoStart ? ' checked' : '') + '><span class="ow-switch"></span><span>' + esc(t('autoStart')) + '</span></label>' +
        '<div class="ow-scan-row"><div class="ow-flex ow-gap ow-wrap"><button class="ow-btn" data-effort-scan="1" type="button">' + esc(t('effortScan')) + '</button><button class="ow-btn ow-btn-ghost" data-effort-force="1" type="button" title="' + esc(t('effortRescanHint')) + '">' + esc(t('effortRescan')) + '</button></div><div class="ow-hint">' + esc(t('effortScanHint')) + '</div></div>' +
        '<div class="ow-config-foot ow-flex ow-end"><button class="ow-btn" data-save="1">' + esc(t('save')) + '</button></div>' +
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
        '<div class="ow-sec-h">' + esc(t('log')) + '</div>' +
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
      '<div class="ow-sec-h">' + esc(t('log')) + '</div>' +
      '<details class="ow-log"' + (logOpen ? ' open' : '') + '>' +
        '<summary class="ow-flex ow-gap ow-between"><span class="ow-log-sum-lbl">' + esc(t('log')) + ' · ' + lines.length + '</span>' +
          '<span class="ow-log-acts">' +
            '<button type="button" class="ow-log-btn' + (logFollow ? ' on' : '') + '" data-lg-act="follow" title="' + esc(t('followLog')) + '">\u21D3</button>' +
            '<button type="button" class="ow-log-btn" data-lg-act="copy" title="' + esc(t('copyLog')) + '">\u29C9</button>' +
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
  // Polling policy: full re-render every 3s ONLY while the panel is open; the
  // closed panel keeps just the pill dot honest with a slow 10s status fetch;
  // usage refreshes every 8s while open; everything pauses when the page is
  // hidden behind other windows/tabs.
  function usageTick() {
    if (document.hidden || !panel.classList.contains('open')) return
    var cfg = (snap && snap.config) || form || {}
    if (String(cfg.chat2apiDir || '').trim()) loadUsage()
  }
  setInterval(function () {
    if (document.hidden || !panel.classList.contains('open')) return
    poll()
  }, 3000)
  setInterval(function () {
    if (document.hidden || panel.classList.contains('open')) return
    api('status').then(function (r) {
      snap = r || snap
      updatePill(stateMeta())
    }).catch(function () { /* keep last known */ })
  }, 10000)
  setInterval(usageTick, 8000)
})()
