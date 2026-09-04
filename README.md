**English** | [简体中文](README.zh-CN.md)

# dsh-owui-chat2api

An adapter that exposes the models in your Open WebUI as a standard
OpenAI-compatible `/v1` API for DeepSeek Harness Desktop, plus a usage
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

## Features

- Start / stop the proxy from the panel
- Environment check: is Python available, are the dependencies installed?
- Configure your Open WebUI URL, host and port
- Usage dashboard: today / yesterday / month / total, ranked per model
- One-click model and reasoning-level sync (see [Reasoning effort](#reasoning-effort))
- Process log with error highlighting, follow mode and copy

## Quick start

Requires DeepSeek Harness Desktop.

1. Put the plugin folder in `%USERPROFILE%\.dsh\plugins\`
   (e.g. `dsh-owui-chat2api-0.7.1`).
2. Add it as a dependency in `%USERPROFILE%\.dsh\profiles\desktop\package.json`:

   ```jsonc
   "dependencies": {
     "dsh-owui-chat2api": "link:%USERPROFILE%\\.dsh\\plugins\\dsh-owui-chat2api-0.7.1"
   },
   "dsh": { "profile": { "bundles": [ /* ... */ "dsh-owui-chat2api" ] } }
   ```

   Use the folder name you actually installed.
3. Restart DSH Desktop. The **OWUI** pill appears in the top-right corner.
4. Open the panel and set your Open WebUI URL (the default is a placeholder).
5. Click **Start**. The first run opens a browser window for a one-time
   sign-in; the session is reused afterwards.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| Diagnostics shows **Attention** | Install the dependencies: `pip install requests playwright`, then `playwright install` |
| Login fails / asks to sign in again | Click **Login** in the panel and sign in once in the window |
| Models missing from the DSH picker | Click **Sync models & reasoning levels**, then restart DSH |
| The URL is `your-open-webui.example.com` | That's the placeholder — set your real address, then Start |

## Reasoning effort

Reasoning models (e.g. served behind a vLLM gateway) honour `reasoning_effort`,
so DSH's model picker can show **Off / Low / Medium / High**.

The easiest way is the **Sync models & reasoning levels** button in the
Configuration section: it probes your models, declares the supported level for
each, and writes a backup first. When your backend gains a model, click it
again — already-probed models hit the cache.

For manual declaration or using `chat2api.py` standalone, see
[DEVELOPMENT.md](DEVELOPMENT.md).

## Data & security

- Your Open WebUI session (`.chrome-profile`, `token.json`, the usage database)
  stays on this machine and is excluded from git and from the package.
- The usage database and the proxy config live under `~/.dsh`, outside the
  plugin directory, so they survive plugin updates.
- The proxy listens on `127.0.0.1` only.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for the code layout, conventions and how
to test a change locally.

## License

- Plugin code (outside `chat2api/`): MIT — see [LICENSE](LICENSE).
- The bundled `chat2api/` proxy: MIT © openwebui-chat2api contributors — see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
  [Sozbo-Tang/openwebui-chat2api](https://github.com/Sozbo-Tang/openwebui-chat2api).
