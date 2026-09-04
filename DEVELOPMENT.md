# Development — 开发指南

## 代码结构

- `lib/index.js` —— **HOST** 半区：负责 `chat2api.py` 子进程生命周期、缓存式
  诊断探测、`webServer` 路由、以及通过 `webServer.tapIndex` 注入面板。
- `lib/panel.js` —— **CLIENT** 半区：注入 DSH 网页壳的 Vanilla JS 面板（含
  中英 i18n，车头自包含，不使用 Cordis 客户端模块）。
- `lib/settings-patch.js` —— 文本级 YAML 补丁器：向 `~/.dsh/settings.yaml`
  写入/更新 `reasoningEfforts` 与模型列表（保留注释和顺序，不整文件回写）。
- `chat2api/chat2api.py` —— 内置的 Open WebUI 反代（一个上游项目的快照，见
  THIRD_PARTY_NOTICES.md）。
- `chat2api/token.json`、`usage.db`、`.chrome-profile/` —— **运行期产物**，
  绝不允许进入提交或发布物。

## 目录布局（安装副本）

```
~/.dsh/plugins/dsh-owui-chat2api-<version>/
  package.json        name: dsh-owui-chat2api, dsh.bundle.patch -> cordis.patch.yml
  cordis.patch.yml    把插件行插入 profile 的组合文件
  lib/index.js        HOST：子进程 / 诊断缓存 / 路由 / tapIndex
  lib/panel.js        CLIENT：自包含控制面板
  lib/settings-patch.js   settings.yaml 文本补丁器
  chat2api/           chat2api.py + requirements.txt（.chrome-profile 运行期才有）
```

## 运行期数据放哪

- 配置：`<DSH_HOME>/dsh-owui-chat2api-control.json`（`node_modules` 可只读）。
- 用量库：`<DSH_HOME>/dsh-owui-chat2api-usage.db`——通过环境变量
  `DSH_OWUI_USAGE_DB` 传给 python（独立运行时回退到目录内 `usage.db`）。
- 登录凭据：`<DSH_HOME>/dsh-owui-chat2api-token.json`——通过环境变量
  `DSH_OWUI_TOKEN_FILE` 传给 python（首次运行会把旧版插件目录里的
  `token.json` 迁移过来）。

## 路由（同源）

| Method | Path | 用途 |
| ------ | ---- | ---- |
| GET  | `/dsh-owui-chat2api/panel.js` | 面板脚本（经 tapIndex） |
| GET  | `/dsh-owui-chat2api/api/status` | 配置 + 运行状态 + 诊断 + 日志尾部 |
| GET/POST | `/dsh-owui-chat2api/api/config` | 读取 / 保存配置（false→true 时自动启动） |
| POST | `/dsh-owui-chat2api/api/start` | 启动 `chat2api.py` |
| POST | `/dsh-owui-chat2api/api/stop` | 停止 `chat2api.py` |
| POST | `/dsh-owui-chat2api/api/login` | 一次性 Open WebUI 登录 |
| POST | `/dsh-owui-chat2api/api/effort-scan` / `effort-scan-force` | 探测模型 + 写入 settings.yaml |
| GET  | `/dsh-owui-chat2api/api/usage?range=` | 同源代理到 `http://<host>:<port>/v1/usage` |

用量走同源（经 `/api/usage`），所以 HTTPS 与外网访问 DSH 时也没有混合内容 /
CORS 问题。

## 核心约定（改代码前先读）

- **任何 web handler 都不得阻塞事件循环**：python/依赖探测是缓存式的
  （TTL 20s），过期后只在 `setImmediate` 里后台重探；start/login 也在请求路径
  之外启动子进程。改这块时保持这个不变量。
- `startImpl` / `loginImpl` 返回 `{ async: true }`，面板靠轮询收敛最终状态。
- 给 python 子进程的 env 是**白名单**（`childEnv()`），不是整个 `process.env`
  ——以免把 DSH 里其它服务的密钥泄漏给第三方代理。
- `settings-patch.js` 只做文本级修补（保留注释/顺序）。写完要能通过自身的
  verify 步骤；schema 若随 DSH 变动，这里会静默失效，改动时要留意。
- 日志尾部 `LOG_MAX = 80` 行，逐行接受（面板会按行做严重度着色），不要改成
  整体字符串。
- 面板的**一切动作反馈都走吸顶 `.ow-notice`**（`setBanner`），不要另起一套
  内联提示。

## 本地测试你的改动（源码 → 安装副本）

仓库是**唯一真源（source of truth）**。DSH 真正跑的是
`~/.dsh/plugins/dsh-owui-chat2api-<version>` 的安装副本（活的 `.chrome-profile`
也在这里，**绝不能提交**）。改完代码，把改动装进安装副本：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\pack.ps1          # 用 package.json 的当前版本
powershell -ExecutionPolicy Bypass -File scripts\pack.ps1 -Version 0.8.0   # 或指定版本
```

脚本用 `robocopy /MIR` 组装到 `~/.dsh/plugins/dsh-owui-chat2api-<version>`
并打印下一步。它**按构造排除** `.chrome-profile/`、`usage.db`、`token.json`、
`__pycache__`、`.git` 与构建噪声——因为 `/MIR` 不会删除目标根目录，也不碰
`/XD` 排除的目录，所以代理正在跑时也能安全重打包，也不会误删在线登录态。

link + 重启（pack 脚本也会打印精确命令）：

```powershell
New-Item -ItemType Junction "$ENV:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-owui-chat2api" -Target "$dest"
# 并把 profile 依赖 + bundles 行改成新版本号（见 README 安装示例）
```

重启 DSH 后 `lib/*` 生效；**只改了 `chat2api.py` 不用重启**（它每次 spawn 都从
磁盘读）。

## 备注

- 面板是经 `webServer.tapIndex` 注入的覆盖层，**不是** Settings 导航槽（那个
  槽只给 Cordis 动态插件用）。
- 如果 DSH 的 agent 会话本身走这条代理，停掉它会把当前聊天打断——控件已有
  保护，这必须是有意的操作。
- `scripts/pack.ps1` 是 Windows 路径；如需 mac/linux，加一个对等脚本。
