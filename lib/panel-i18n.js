/* dsh-owui-chat2api panel - i18n dictionaries.
 *
 * A plain script injected by the host BEFORE panel.js (defer keeps the order),
 * so panel.js stays logic-only and this file can grow without touching it.
 * Exposes a single namespace object:
 *
 *   window.__dshOwuiI18n = { dict: {en, zh}, msg: {en, zh} }
 *
 * - dict: panel UI strings, read via panel.js's t(key).
 * - msg:  translations for the stable English messages the host replies with
 *   (trMsg). KEYS use ASCII '...' - panel.js normalises the host's U+2026
 *   ellipsis before lookup.
 * panel.js degrades gracefully (shows raw keys) if this file fails to load.
 */
(function () {
  window.__dshOwuiI18n = {
    dict: {
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
        effortRescan: 'Force re-scan',
        effortRescanHint: 'Ignore cached probe results and re-probe every model - use after the backend gains or renames models.',
        effortScanPatched: 'Patched:', effortScanAlready: 'already:', effortScanSkipped: 'not in a matched provider:',
        effortScanModelsAdded: 'Models added:', effortScanModelsAlready: 'models already present:',
        effortScanProviderCreated: 'Auto-created provider:',
        effortScanDone: 'Nothing to change.', effortScanRestart: ' - restart DSH to apply.',
        usage: 'Usage', status: 'Status', today: 'Today', yesterday: 'Yesterday', month: 'Month', cumulative: 'Cumulative',
        calls: 'Calls', inTok: 'In', outTok: 'Out', cached: 'Cached', latency: 'Avg latency', errs: 'Errors',
        m: 'Model', ctx: 'Count', tin: 'In', tout: 'Out', tcached: 'Cached', tavg: 'Avg ms', terr: 'Err',
        log: 'Process log', noCalls: 'No calls in this range.', loading: 'Loading...', others: 'Other {0}',
        noLog: 'No process output yet.', copyLog: 'Copy', copied: 'Copied', followLog: 'Follow',
        unreachable: 'Usage endpoint unreachable at {url}', saveFirst: 'Save configuration to enable the dashboard.',
        start: 'Start', stop: 'Stop', login: 'Login', open: 'Open WebUI chat2api',
        already: 'already running', notRunning: 'not running',
        loginOk: 'Logged in - Open WebUI credential saved.', loginFail: 'Login did not save a new credential - check the process log.',
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
        effortRescan: '强制重扫',
        effortRescanHint: '忽略缓存,重新探测所有模型 - 后端新增或改名模型后使用。',
        effortScanPatched: '已写入:', effortScanAlready: '已有:', effortScanSkipped: '不在匹配的 provider 列表:',
        effortScanModelsAdded: '已添加模型:', effortScanModelsAlready: '模型已存在:',
        effortScanProviderCreated: '已自动创建模型提供方:',
        effortScanDone: '无需改动。', effortScanRestart: ' - 重启 DSH 生效。',
        usage: '用量', status: '状态', today: '今天', yesterday: '昨天', month: '本月', cumulative: '累计',
        calls: '调用', inTok: '输入', outTok: '输出', cached: '缓存', latency: '平均延迟', errs: '错误',
        m: '模型', ctx: '次数', tin: '入', tout: '出', tcached: '缓存', tavg: '平均 ms', terr: '误',
        log: '进程日志', noCalls: '该时间段暂无调用。', loading: '加载中...', others: '其他 {0} 个',
        noLog: '暂无进程输出。', copyLog: '复制', copied: '已复制', followLog: '跟随',
        unreachable: '用量地址无法访问:{url}', saveFirst: '保存配置后即可查看用量。',
        start: '启动', stop: '停止', login: '登录', open: 'Open WebUI chat2api',
        already: '已在运行', notRunning: '未在运行',
        loginOk: '登录成功 - Open WebUI 凭据已保存。', loginFail: '登录未保存新凭据 - 请查看进程日志。',
      },
    },
    msg: {
      en: {},
      zh: {
        'chat2api is already running': 'chat2api 已在运行',
        'chat2api is not running': 'chat2api 未在运行',
        'a login flow is already running': '已有登录流程在进行中',
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
