# Development — 开发指南

## 代码结构

- `lib/index.js` —— **HOST 接线层**：只做 `webServer` 路由注册、`tapIndex`
  面板注入、HTTP 小工具与 autostart/清理；逻辑全部在下面四个模块里。
- `lib/config.js` —— 控制文件配置（`dsh-owui-chat2api-control.json`）与共享
  路径常量（`PACKAGE_ROOT` / `CHAT2API_DIR` / `DSH_HOME`）。
- `lib/diagnostics.js` —— 缓存式 python/依赖探测（唯一探测 python 的地方，
  TTL 20s，过期后台重探）。
- `lib/proxy-process.js` —— `chat2api.py` 子进程生命周期：proxy 启停、登录
  流程与结果记账、进程日志尾部、python 子进程的 env 白名单。
- `lib/effort-scan.js` —— 一键扫描后端模型，把模型 + `reasoningEfforts`
  写入 `~/.dsh/settings.yaml`（自动备份、写后自验证）。档位是**逐个探测**出来的：
  后端对 `reasoning_effort` 的接受与否不是区间（DeepSeek V4.1 收
  low/high/xhigh/max 但拒 medium，Qwen3.8-27B 收 xhigh 却拒 high），声明了
  后端不认的档位，一选就是 HTTP 400。
- `lib/prices.js` —— 手动价格表（每百万 tokens、单一货币符号），host 在
  `/api/usage` 上叠加逐模型成本；未填价的模型只统计、不计费。
- `lib/panel.js` —— **CLIENT** 半区：注入 DSH 网页壳的 Vanilla JS 面板逻辑
  （车头自包含，不使用 Cordis 客户端模块）；图标为内联 Tabler SVG
  （`ICONS` 表 + `ic()` 助手，零外部请求，stroke 跟随主题色）。
- `lib/panel-i18n.js` —— **只有 host 消息的中英对照**（`window.__dshOwuiI18n.msg`），host 在
  `panel.js` 之前注入；面板自己的 UI 文案一律以 `panel.js` 里的 `FALLBACK` 为唯一来源
  （曾经两处重复、注入的那份覆盖前者，导致新加的 key 静默失效）。`test/i18n-sync.test.js`
  守住这个分工：served 文件不许再出现 `dict`，且 `panel.js` 里每个 `t('key')` 都要有文案。
- `lib/panel.css` —— 面板样式，由 host 经 `/dsh-owui-chat2api/panel.css`
  提供，`tapIndex` 以 `<link>` 注入（独立文件，浏览器可缓存）。
- `lib/settings-patch.js` —— 文本级 YAML 补丁器：向 `~/.dsh/settings.yaml`
  写入/更新 `reasoningEfforts` 与模型列表（保留注释和顺序，不整文件回写）。
- `chat2api/chat2api.py` —— 内置的 Open WebUI 反代（一个上游项目的快照，见
  THIRD_PARTY_NOTICES.md）。DSH 侧新增的用量统计/估算已抽到同目录
  `owui_usage.py`，内嵌 dashboard 已抽到 `dashboard.html`（运行期读取一次后
  缓存），使本文件保持贴近上游、便于 diff。
- `chat2api/token.json`、`usage.db`、`.chrome-profile/` —— **运行期产物**，
  绝不允许进入提交或发布物。

## 目录布局（仓库 = 安装源）

DSH 0.2 起插件由 **plugin manager** 安装：它把仓库**链接**进 profile（依赖写成
`link:<repo>`），并自己维护 profile 的 `package.json`、`node_modules` 与
`dsh.profile.bundles`。所以下面这棵树**就是**运行时读到的那棵树，没有"安装副本"
这一步（旧流程的 `~/.dsh/plugins/dsh-owui-chat2api-<version>` 拷贝已废弃）：

```
<repo>/
  package.json        name: dsh-owui-chat2api, dsh.bundle.patch -> cordis.patch.yml
  client.js           esbuild 产物：DSH 网页壳加载的 CLIENT 入口（npm run build 生成）
  cordis.patch.yml    把插件行插入 profile 的组合文件
  lib/index.js        HOST：路由 / tapIndex / autostart（接线层）
  lib/config.js       HOST：控制文件配置 + 共享路径
  lib/diagnostics.js  HOST：python/依赖缓存探测
  lib/proxy-process.js  HOST：子进程生命周期 / env 白名单 / 日志尾部 / 登录记账
  lib/effort-scan.js  HOST：模型与 reasoningEfforts 写入 settings.yaml
  lib/prices.js       HOST：手动价格表 + 逐模型成本估算
  lib/panel.js        CLIENT：自包含控制面板（逻辑，内联进 client.js）
  lib/panel-i18n.js   CLIENT：仅 host 消息中英对照（先于 panel.js 注入）
  lib/panel.css       CLIENT：面板样式（/panel.css 提供）
  lib/settings-patch.js   settings.yaml 文本补丁器
  chat2api/           chat2api.py + owui_usage.py + dashboard.html + requirements.txt
  test/ scripts/      仅开发用，不进 npm 发布包（files 白名单 + .npmignore）
```

## 运行期数据放哪

- 配置：`<DSH_HOME>/dsh-owui-chat2api-control.json`（`node_modules` 可只读）。
- 用量库：`<DSH_HOME>/dsh-owui-chat2api-usage.db`——通过环境变量
  `DSH_OWUI_USAGE_DB` 传给 python（独立运行时回退到目录内 `usage.db`）。
- 登录凭据：`<DSH_HOME>/dsh-owui-chat2api-token.json`——通过环境变量
  `DSH_OWUI_TOKEN_FILE` 传给 python（首次运行会把旧版插件目录里的
  `token.json` 迁移过来）。
- 价格表：`<DSH_HOME>/dsh-owui-chat2api-prices.json`——每模型
  `{input, cached, output}` 单价（每百万 tokens）+ 货币符号，面板可直接编辑。

## settings.yaml 与新版 DSH（重要）

`lib/settings-patch.js` 写的是 `<DSH_HOME>/settings.yaml`，但 **DSH 0.2 起不再
直接读这个文件**：启动时它把该文件按 section **深合并**进当前 profile 的
`profiles/<name>/cordis.patch.yml`，然后把文件改名成 `settings.yaml.imported`。
由此：

- 文件通常**不存在**（已经导入过了），这不是错误：`effort-scan.js` 把 ENOENT 当
  "空文档"从零开始（`ensureProvider` 会把整条链建出来），并且不写备份（没东西可
  备份）；其它读错误仍然中止扫描。
- 面板上"重启 DSH 生效"是字面意思：扫描只是写了 settings.yaml，真正的合并发生
  在下一次启动。
- 深合并对**普通对象递归、对数组整体替换**——所以 `models:` 列表是整体替换而不是
  合并，这正是"同步会移除后端已不提供的模型"能生效的原因。
- 反过来，`m365` 等其它 provider 不受影响：我们的文件里没有它们的 section，合并
  时保持原样。
- `reasoningEfforts` 的值只能是**字符串或 null**（`off: null` = 不发这个参数），
  所以映射不出整数档位（后端收 1–100，DSH 侧只能声明命名档位）。

## 路由（同源）

| Method | Path | 用途 |
| ------ | ---- | ---- |
| GET  | `/dsh-owui-chat2api/panel.js` | 面板脚本（经 tapIndex） |
| GET  | `/dsh-owui-chat2api/panel-i18n.js` | host 消息对照表（先于 panel.js 注入） |
| GET  | `/dsh-owui-chat2api/panel.css` | 面板样式（经 tapIndex） |
| GET  | `/dsh-owui-chat2api/api/status` | 配置 + 运行状态 + 诊断 + 最近一次登录结果 + 日志尾部 + 实际使用的 chat2api 目录（`chat2apiDirInfo`） |
| GET/POST | `/dsh-owui-chat2api/api/config` | 读取 / 保存配置（false→true 时自动启动） |
| POST | `/dsh-owui-chat2api/api/start` | 启动 `chat2api.py` |
| POST | `/dsh-owui-chat2api/api/stop` | 停止 `chat2api.py` |
| POST | `/dsh-owui-chat2api/api/login` | 一次性 Open WebUI 登录 |
| POST | `/dsh-owui-chat2api/api/effort-scan` / `effort-scan-force` | 启动模型扫描（立即返回，结果经 status 轮询 + 面板通知） |
| GET  | `/dsh-owui-chat2api/api/usage?range=` | 同源代理到 `http://<host>:<port>/v1/usage`，host 侧叠加逐模型成本 |
| GET/POST | `/dsh-owui-chat2api/api/prices` | 读取 / 保存手动价格表 |

用量走同源（经 `/api/usage`），所以 HTTPS 与外网访问 DSH 时也没有混合内容 /
CORS 问题。

## 核心约定（改代码前先读）

- **任何 web handler 都不得阻塞事件循环**：python/依赖探测是缓存式的
  （TTL 20s），过期后由**真异步** probe（spawn，非 spawnSync）后台重探；
  start/login 也在请求路径之外启动子进程。改这块时保持这个不变量。
- `startImpl` / `loginImpl` / `startEffortScan` 返回 `{ async: true }`，面板靠
  轮询收敛最终状态（登录结果在 status 的 `login` 字段，扫描在 `effortScan`）。
- 给 python 子进程的 env 是**白名单**（`childEnv()`），不是整个 `process.env`
  ——以免把 DSH 里其它服务的密钥泄漏给第三方代理。
- `settings-patch.js` 只做文本级修补（保留注释/顺序）。写完要能通过自身的
  verify 步骤；schema 若随 DSH 变动，这里会静默失效，改动时要留意。
- 日志尾部 `LOG_MAX = 80` 行，逐行接受（面板会按行做严重度着色），不要改成
  整体字符串。
- 面板的**一切动作反馈都走吸顶 `.ow-notice`**（`setBanner`），不要另起一套
  内联提示。

## 安装 / 更新

仓库是**唯一真源（source of truth）**：`link:` 安装让 DSH 直接读这棵工作树，
所以改完代码**没有"拷进安装目录"这一步**。首次安装（或换机器）：

```powershell
dsh plugin --profile desktop add link:D:/Files/dsh-owui-chat2api
```

GUI 插件管理里的 install bundle 填这个仓库的绝对路径也是同一件事（本机就是这么
装的）。装完 profile 的 `package.json` 会多一行
`"dsh-owui-chat2api": "link:D:/Files/dsh-owui-chat2api"`，`dsh.profile.bundles`
里多一项。

**不要手改** profile 的 `package.json` / `node_modules` / `pnpm-lock.yaml`：这些
归 plugin manager，手写的状态会在下一次安装或卸载时被它按自己的记录 reconcile 掉
（曾经因此把 dshmarket 从 1.66.5 降回旧的 1.47.0 pin，被 DSH 的 peer 检查拒绝）。

## 本地测试你的改动

```powershell
npm run build                                              # 只重建 client.js
powershell -ExecutionPolicy Bypass -File scripts\pack.ps1     # 重建 + 出发布 tgz
```

`scripts\pack.ps1` 现在只做 manager 做不了的两件事：重建 `client.js`（esbuild
产物，DSH 网页壳加载的是它，不是 `lib/panel.js`）和 `npm pack`；末尾会打印每个
profile 当前链接到哪里，方便确认 DSH 跑的是这棵树而不是旧副本。

生效范围：

| 改动 | 生效方式 |
| --- | --- |
| `lib/*.js`（HOST 半区） | 重启 DSH |
| `lib/panel*.js` / `client.js`（CLIENT 半区） | `npm run build` + 重启 DSH（`pnpm run dev:web` 在跑时可热更新） |
| `chat2api/*.py` | **不用重启 DSH**，但要重启代理（面板 Stop → Start）：python 是长驻子进程 |

HOST 侧的面板资源在启动时读入 `panelAssetCache`，所以改了 `lib/panel.js` 即使
不重建 client.js，也要等 DSH 重启才生效。

## 测试

- `npm test`（即 `node --test test/`）——两个文件：
  - `test/settings-patch.test.js`：`lib/settings-patch.js` 的全部行为——effort 块的
    插入位置与缩进、**按验证档位生成映射**（只写后端接受的档位）、**漂移映射的
    就地修复**（去掉被拒档位、补上缺失档位、保留重命名拼写如 `max: ultra`）、
    `reasoningEfforts: false` 被替换、旧调用方 `modelIds` 只声明探测过的 `high`、
    幂等（二次运行 `NO_CHANGE`）、CRLF 检测与保持、注释/无关 provider 字节级
    保留、`NO_PROVIDER`/`NOOP` 失败路径、空 `models:` 列表、`ensureProvider`
    全链创建与重名避让（`chat2api-1`），以及 effort-scan "写后自验证"依赖的
    **三轮 round-trip 不变量**（create → patch → 再跑一遍全部报 already）。
  - `test/prices.test.js`：价格表读写、逐模型成本公式、cached 夹取与未定价模型。
- settings.yaml 是用户的核心配置，**改 `settings-patch.js` 必须先跑测试**；
  新增行为先加测试再改实现。
- `test/` 是纯开发工件：不进 npm 发布包（`files` 白名单 + `.npmignore`）。

## 备注

- 面板有两个挂载点：host 经 `webServer.tapIndex` 注入的**覆盖层**（悬浮球 + 面板），
  以及 client 半区注册的**右侧栏停靠 tab**（`ctx.sidebarRightTabs.register` 声明类型 +
  `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` 两个 keyed 席位，key 都是类型
  id）。**注意 `sidebarRightTabs` 不是静态声明的 Service**：它由
  `@deepseek-ai/dsh-client-ui-sidebar-right` 在 effect 里用 `ctx.reflect.provide` 提供，
  所以 Service 目录里查不到它——别据此判断"这版 DSH 不支持右侧栏"。同理，`guide` 入口
  各自需要唯一 `id`（`sidebar.right.tab.guide.entry` 按定义 id 派发，缺 id 时自定义卡片
  拿不到身份）。
- 如果 DSH 的 agent 会话本身走这条代理，停掉它会把当前聊天打断——控件已有
  保护，这必须是有意的操作。
- `scripts/pack.ps1` 是 Windows 路径；如需 mac/linux，加一个对等脚本。
- `chat2apiDir`（控制文件里的）是**可选覆盖**，默认空字符串：空 = 用本包自带的那份
  `chat2api/`（`PACKAGE_ROOT/chat2api`）。python 半区随包发布，所以 tgz / GitHub /
  link 三种装法都自动用对应包里那份，**没人需要手填路径**。面板「配置」里那行会显示
  实际使用的目录和来源（插件自带 / 你指定的副本）。
  只有开发者想指向另一份 checkout 时才填它，比如本仓库：`D:\Files\dsh-owui-chat2api\chat2api`。
- 旧流程（0.10.1 之前的 `pack.ps1`）会把仓库复制到
  `~/.dsh/plugins/dsh-owui-chat2api-<version>/`，那时的控制文件存的就是这个副本的路径；
  换成打包安装后这个值永远不会被刷新，代理和面板扫描就会一直跑旧代码。所以这种
  `plugins/<包名>-<版本>/chat2api` 形状的值现在被**当作没设置**（面板显示"已忽略旧的安装副本"），
  需要重启代理（面板 Stop → Start；**不用**重启 DSH）才会切到当前代码。
