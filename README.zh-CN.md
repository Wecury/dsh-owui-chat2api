[English](README.md) | **简体中文**

# dsh-owui-chat2api

把 [Open WebUI](https://github.com/open-webui/open-webui) 里的模型接进 [DSH Desktop](https://github.com/anywhere-labs/dsh-desktop)：一个把 Open WebUI 变成
标准 OpenAI 兼容 `/v1` API 的本地反向代理，外加一个内置在 DSH 里的用量面板。

它内置了 [chat2api](https://github.com/Sozbo-Tang/openwebui-chat2api)，以本地
反向代理的方式运行，并在 DSH 的页面里注入一个控制面板：

```
DeepSeek Harness（或任何 OpenAI 兼容客户端）
        │       标准 /v1 接口 → http://127.0.0.1:8000
        ▼
   dsh-owui-chat2api   （本地反向代理，自带登录凭据）
        ▼
   你的 Open WebUI     （浏览器登录一次，之后自动复用）
```

<p align="center">
  <img width="710" height="565" alt="DSH 里的 dsh-owui-chat2api 控制面板：状态、配置、用量看板与进程日志" src="https://github.com/user-attachments/assets/4c59820b-e82a-45bc-9979-b202bed6d3cd" />
</p>

## 功能 ✨

- ▶️ 从面板启动 / 停止代理
- 🩺 环境检查：Python 是否可用、依赖是否装好
- ⚙️ 配置 Open WebUI 地址、主机、端口
- 📊 用量面板：今天 / 昨天 / 本月 / 累计，按模型排行
- 🧠 一键同步模型与推理等级（见[推理等级](#推理等级-)）
- 📜 进程日志：错误高亮、跟随最新、一键复制

## 安装 📦

三种方式任选：**A** 一条命令（推荐）、**B** 不需要 git、**C** 直接让 DSH 帮你装。

### ⚡ 方式 A —— 一条命令（推荐）

DSH Desktop 自带插件管理器，一条命令完成安装 **和** profile 注册
（依赖声明 + bundles 自动写入，不用手改 package.json）：

```powershell
dsh plugin --profile desktop add github:Wecury/dsh-owui-chat2api#v0.8.0
```

- `#v0.8.0` 锁定 Release tag，换成你想要的版本（不写则跟踪 `main` 分支）。
- 需要本机有 `git`（pnpm 走 git 拉取）；网络需要代理时先设
  `http_proxy` / `https_proxy` 再执行。
- 装完重启 DSH Desktop 即可。以后升级：
  `dsh plugin --profile desktop update dsh-owui-chat2api`。

### 📦 方式 B —— 从 Release 的 tgz 手动装（无需 git）

1. 到 [Releases](https://github.com/Wecury/dsh-owui-chat2api/releases) →
   **Assets** 下载 `dsh-owui-chat2api-<版本>.tgz`。
2. 解压到插件目录。tgz 解出来是一个 `package/` 文件夹，把它改名挪过去
   （Windows 10+ 自带 `tar` 命令）：

   ```powershell
   tar -xzf dsh-owui-chat2api-0.8.0.tgz
   Move-Item package "$env:USERPROFILE\.dsh\plugins\dsh-owui-chat2api-0.8.0"
   ```

3. 在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 里注册：

   ```jsonc
   "dependencies": {
     "dsh-owui-chat2api": "link:%USERPROFILE%\\.dsh\\plugins\\dsh-owui-chat2api-0.8.0"
   },
   "dsh": { "profile": { "bundles": [ /* ... */ "dsh-owui-chat2api" ] } }
   ```

   版本号、文件夹名换成你实际下载的版本即可。

### 🤖 方式 C —— 直接喊你的 DSH 装

把下面这段发给你的 DSH 助手，剩下的它来做：

```text
请帮我安装 DSH 插件 dsh-owui-chat2api（GitHub 仓库 Wecury/dsh-owui-chat2api）。

步骤：
1. 执行：dsh plugin --profile desktop add github:Wecury/dsh-owui-chat2api#v0.8.0
   （需要本机有 git。如果 dsh plugin 不可用，改用手动方式：从仓库 Releases 的
   Assets 下载 dsh-owui-chat2api-<版本>.tgz，解压得到 package/ 文件夹，移动并
   改名为 %USERPROFILE%\.dsh\plugins\dsh-owui-chat2api-<版本>；然后在
   %USERPROFILE%\.dsh\profiles\desktop\package.json 的 dependencies 里加
   "dsh-owui-chat2api": "link:<该目录的绝对路径>",并把 "dsh-owui-chat2api"
   加进 dsh.profile.bundles 数组）
2. 重启 DSH Desktop。
3. 验证：DSH 页面右上角出现 OWUI 圆标；点开面板，Status 区能显示状态即成功。
```

## 快速开始 🚀

1. 重启 DSH Desktop（任一方式装完后），右上角出现 **OWUI** 圆标。
2. 打开面板，把 **Open WebUI 地址**改成你自己的（默认是占位符）。
3. 点 **Start**。第一次运行会弹出浏览器窗口，登录一次你的 Open WebUI，
   之后自动复用。

## 常见问题 🔧

| 现象 | 处理 |
| --- | --- |
| Diagnostics 显示 **Attention** | 装依赖：`pip install requests playwright`，再 `playwright install` |
| 登录失败 / 提示重新登录 | 面板里点 **Login**，在弹窗里登一次即可 |
| 模型不在 DSH 模型列表里 | 配置区点 **Sync models & reasoning levels**，然后重启 DSH |
| 地址还是 `your-open-webui.example.com` | 那是占位符，改成本机实际地址再 Start |

## 推理等级 🧠

推理模型（比如 vLLM 网关后面那种）支持 `reasoning_effort`，DSH 的模型选择器
里对应有 **Off / Low / Medium / High** 四档。

最省事：在面板配置区点一次 **Sync models & reasoning levels**。它会自动探测
模型、给支持推理的模型声明好等级，并且先写一份备份。以后后端上了新模型再
点一次即可（已探测过的会走缓存）。

想手动声明，或独立使用 `chat2api.py`，见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 数据与安全 🔒

- 你的 Open WebUI 登录会话（`.chrome-profile`、`token.json`、用量库）
  只保存在本机，已排除出 git 和发布包。
- 用量数据库、代理配置放在 `~/.dsh`（插件目录之外），升级插件不会丢。
- 代理默认只监听 `127.0.0.1`。

## 面向开发者 🛠️

代码结构、核心约定、如何本地测试改动 → [DEVELOPMENT.md](DEVELOPMENT.md)。

## 许可证 ⚖️

- 插件本体（`chat2api/` 之外）：MIT — 见 [LICENSE](LICENSE)。
- 内置 `chat2api/` 代理：MIT © openwebui-chat2api contributors — 见
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与
  [Sozbo-Tang/openwebui-chat2api](https://github.com/Sozbo-Tang/openwebui-chat2api)。
