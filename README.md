**English** | [简体中文](README.zh-CN.md)

# dsh-owui-chat2api

An adapter that exposes the models in your [Open WebUI](https://github.com/open-webui/open-webui) as a standard
OpenAI-compatible `/v1` API for [DSH Desktop](https://github.com/anywhere-labs/dsh-desktop), plus a usage
dashboard that lives inside DSH.

It bundles [chat2api](https://github.com/Sozbo-Tang/openwebui-chat2api), runs it
as a local reverse proxy, and adds a control panel to the DSH web shell:

```
DeepSeek Harness (or any OpenAI-compatible client)
        │        standard /v1 API → http://127.0.0.1:8000
        ▼
   dsh-owui-chat2api    (local reverse proxy, keeps its own login)
        ▼
   your Open WebUI      (browser sign-in once, session reused afterwards)
```

## Features ✨

- ▶️ Start / stop the proxy from the panel
- 🩺 Environment check: is Python available, are the dependencies installed?
- ⚙️ Configure your Open WebUI URL, host and port
- 📊 Usage dashboard: today / yesterday / month / total, ranked per model
- 🧠 One-click model and reasoning-level sync (see [Reasoning effort](#reasoning-effort-))
- 📜 Process log with error highlighting, follow mode and copy

## Install 📦

Pick one of three ways: **A** is a single command, **B** needs no `git`, **C**
lets your DSH assistant do the whole thing.

### ⚡ Option A — one command (recommended)

DSH Desktop ships a plugin manager. One command installs the plugin **and**
registers it in your profile (dependencies + bundles):

```powershell
dsh plugin --profile desktop add github:Wecury/dsh-owui-chat2api#v0.8.0
```

- `#v0.8.0` pins the release tag — use the version you want (omit it to
  follow `main`).
- Requires `git` on PATH (pnpm clones the repo). Behind a proxy? Export
  `http_proxy` / `https_proxy` first.
- Restart DSH Desktop when it finishes. Later updates:
  `dsh plugin --profile desktop update dsh-owui-chat2api`.

### 📦 Option B — from the release tarball (no git needed)

1. From [Releases](https://github.com/Wecury/dsh-owui-chat2api/releases) →
   **Assets**, download `dsh-owui-chat2api-<version>.tgz`.
   (The **Source code (zip)** button is the development tree — for
   contributing, not for installing.)
2. Unpack it into the plugins folder. The tarball extracts to a `package/`
   directory — move and rename it (`tar` ships with Windows 10+):

   ```powershell
   tar -xzf dsh-owui-chat2api-0.8.0.tgz
   Move-Item package "$env:USERPROFILE\.dsh\plugins\dsh-owui-chat2api-0.8.0"
   ```

3. Register it in `%USERPROFILE%\.dsh\profiles\desktop\package.json`:

   ```jsonc
   "dependencies": {
     "dsh-owui-chat2api": "link:%USERPROFILE%\\.dsh\\plugins\\dsh-owui-chat2api-0.8.0"
   },
   "dsh": { "profile": { "bundles": [ /* ... */ "dsh-owui-chat2api" ] } }
   ```

   Match the folder name to the version you downloaded.

### 🤖 Option C — let your DSH install it

Paste this to your DSH assistant and it will do the rest:

```text
请帮我安装 DSH 插件 dsh-owui-chat2api(GitHub 仓库 Wecury/dsh-owui-chat2api)。

步骤:
1. 执行:dsh plugin --profile desktop add github:Wecury/dsh-owui-chat2api#v0.8.0
   (需要本机有 git。如果 dsh plugin 不可用,改用手动方式:从仓库 Releases 的
   Assets 下载 dsh-owui-chat2api-<版本>.tgz,解压得到 package/ 文件夹,移动并
   改名为 %USERPROFILE%\.dsh\plugins\dsh-owui-chat2api-<版本>;然后在
   %USERPROFILE%\.dsh\profiles\desktop\package.json 的 dependencies 里加
   "dsh-owui-chat2api": "link:<该目录的绝对路径>",并把 "dsh-owui-chat2api"
   加进 dsh.profile.bundles 数组)
2. 重启 DSH Desktop。
3. 验证:DSH 页面右上角出现 OWUI 圆标;点开面板,Status 区能显示状态即成功。
```

## Quick start 🚀

1. Restart DSH Desktop (after any install option above). The **OWUI** pill
   appears in the top-right corner.
2. Open the panel and set your Open WebUI URL (the default is a placeholder).
3. Click **Start**. The first run opens a browser window for a one-time
   sign-in; the session is reused afterwards.

## Troubleshooting 🔧

| Symptom | What to do |
| --- | --- |
| Diagnostics shows **Attention** | Install the dependencies: `pip install requests playwright`, then `playwright install` |
| Login fails / asks to sign in again | Click **Login** in the panel and sign in once in the window |
| Models missing from the DSH picker | Click **Sync models & reasoning levels**, then restart DSH |
| The URL is `your-open-webui.example.com` | That's the placeholder — set your real address, then Start |

## Reasoning effort 🧠

Reasoning models (e.g. served behind a vLLM gateway) honour `reasoning_effort`,
so DSH's model picker can show **Off / Low / Medium / High**.

The easiest way is the **Sync models & reasoning levels** button in the
Configuration section: it probes your models, declares the supported level for
each, and writes a backup first. When your backend gains a model, click it
again — already-probed models hit the cache.

For manual declaration or using `chat2api.py` standalone, see
[DEVELOPMENT.md](DEVELOPMENT.md).

## Data & security 🔒

- Your Open WebUI session (`.chrome-profile`, `token.json`, the usage database)
  stays on this machine and is excluded from git and from the package.
- The usage database and the proxy config live under `~/.dsh`, outside the
  plugin directory, so they survive plugin updates.
- The proxy listens on `127.0.0.1` only.

## Development 🛠️

See [DEVELOPMENT.md](DEVELOPMENT.md) for the code layout, conventions and how
to test a change locally.

## License ⚖️

- Plugin code (outside `chat2api/`): MIT — see [LICENSE](LICENSE).
- The bundled `chat2api/` proxy: MIT © openwebui-chat2api contributors — see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
  [Sozbo-Tang/openwebui-chat2api](https://github.com/Sozbo-Tang/openwebui-chat2api).
