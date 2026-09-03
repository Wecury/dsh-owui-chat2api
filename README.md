# dsh-owui-chat2api

Open WebUI chat2api controller for DSH Desktop. Runs the **bundled** `chat2api.py`
reverse proxy, lets you adjust its configuration, and shows per-call usage — all
from a small panel inside DSH. A persistent Profile Bundle: it survives restarts.

## What you get

- A floating **OWUI** pill (top-right). Its dot stays in sync with the chat2api
  process state (green = running, gray = stopped, yellow = exited, red = crashed).
  Click outside the panel to dismiss it.
- **Status** card: Running / Stopped / Exited / Crashed, plus Start / Stop / Login.
- **Diagnostics**: Python + `requests` + `playwright` reachability (cached - the
  panel polls are lightweight and never block the host).
- **Configuration**: chat2apiDir (pre-filled to the bundled copy), Open WebUI base
  URL, host / port, and "start automatically with DSH" (enabled by default).
- **Usage**: Today / Yesterday / Month / Cumulative tabs with calls, input/output
  tokens, cached tokens, average latency, errors, and a per-model table.
- **Process log**: collapsed expandable tail of the chat2api output.
- **i18n**: English and 中文 built in. Follows the GUI language on first open;
  toggle in the panel header (memorised in `localStorage`).
- Colors follow DSH's theme tokens (`--dsw-alias-*` / `--dsw-specific-sidebar-fill`)
  - panel background matches the DSH sidebar, light/dark themes are automatic.

## Install (local link)

Add to the desktop profile, then restart DSH Desktop:

```jsonc
// %USERPROFILE%\.dsh\profiles\<profile>\package.json
"dependencies": {
  "dsh-owui-chat2api": "link:%USERPROFILE%\.dsh\plugins\dsh-owui-chat2api-0.5.0",
}
// dsh.profile.bundles: add "dsh-owui-chat2api"
```

After restart an OWUI pill appears top-right. chat2api auto-starts with DSH
(`autoStart` defaults to true) and reuses the copied `.chrome-profile`, so it
normally works with no manual login.

## Layout

```
~/.dsh/plugins/dsh-owui-chat2api-0.5.0/
  package.json        name: dsh-owui-chat2api, dsh.bundle.patch -> cordis.patch.yml
  cordis.patch.yml    inserts the plugin row into the profile composition
  lib/index.js        HOST: owns the python subprocess, cached diagnostics,
                      webServer routes + tapIndex
  lib/panel.js        CLIENT: self-contained control panel (vanilla JS + i18n)
  chat2api/
    chat2api.py       bundled proxy (a copy of the Open WebUI chat2api)
    requirements.txt
    .chrome-profile/  your logged-in Open WebUI session (avoids re-login)
```

Config is stored in `<DSH_HOME>/dsh-owui-chat2api-control.json` (so `node_modules`
can be read-only). The bundled `chat2api/` directory is the default `chat2apiDir`.
Usage history lives in a **stable** location, `<DSH_HOME>/dsh-owui-chat2api-usage.db`,
independent of the plugin folder - so stats survive restarts, plugin updates and
renames (the host passes it to chat2api.py via `DSH_OWUI_USAGE_DB`, falling back
to the local `usage.db` when run standalone).

## First use

1. Restart DSH Desktop. chat2api auto-starts (or click Start in the OWUI pill).
2. Diagnostics should show Ready. If not, run once: `pip install requests playwright`
   and `playwright install`.
3. If you ever get login errors, click **Login** and sign in in the opened browser
   (one-time).
4. Toggle **Start automatically with DSH** and Save if you changed it.

## Routes (same origin)

| Method | Path                                   | Purpose                                  |
| ------ | -------------------------------------- | ---------------------------------------- |
| GET    | `/dsh-owui-chat2api/panel.js`          | the panel script (via tapIndex)          |
| GET    | `/dsh-owui-chat2api/api/status`        | config + runtime + diagnostics + log     |
| GET/POST| `/dsh-owui-chat2api/api/config`       | read / save config (auto-start on false->true) |
| POST   | `/dsh-owui-chat2api/api/start`         | launch `chat2api.py`                     |
| POST   | `/dsh-owui-chat2api/api/stop`          | stop `chat2api.py`                       |
| POST   | `/dsh-owui-chat2api/api/login`         | one-time Open WebUI login                |
| GET    | `/dsh-owui-chat2api/api/usage?range=`  | same-origin proxy to `http://<host>:<port>/v1/usage` |

Usage stays same-origin (through `/api/usage`), so the dashboard also works over
HTTPS and when DSH is accessed remotely — no CORS needed on the proxy.

## Notes

- The panel is an overlay injected via `webServer.tapIndex` — it is *not* the
  Settings navigation slot (that slot only exists for dynamic plugins).
- If the DSH agent session routes through this proxy, stopping the proxy
  interrupts the current chat; the controls are guarded so this stays a
  deliberate action.

## Development (source vs packaged copy)

This repository is the **source of truth**. The copy DSH actually runs is the
installed bundle under `~/.dsh/plugins/dsh-owui-chat2api-<version>` (that is
also where the live `.chrome-profile` lives — which must never be committed).

- Edit code here, then pack the bundle:
  `powershell -ExecutionPolicy Bypass -File scripts\pack.ps1`
- Re-link the profile and restart DSH Desktop (the script prints the exact steps).
- `scripts/pack.ps1` excludes `.chrome-profile/`, `usage.db`, `.git` and build
  noise by construction, so the packaged copy stays clean.

## Release

Tag the version and push:

```bash
git tag v0.5.0 && git push origin v0.5.0
```

Then on GitHub: **Releases → Draft a new release** → pick the tag → title/notes →
attach an artifact. `npm pack` produces a clean `dsh-owui-chat2api-0.5.0.tgz`
(or zip the repo tree). The artifact carries no credentials by design —
`.npmignore` excludes `.chrome-profile/` and `usage.db`.

## License

- Plugin code (everything except `chat2api/`): **MIT** — see `LICENSE`.
- Bundled `chat2api/` proxy: **MIT** © 2026 openwebui-chat2api contributors — see
  `THIRD_PARTY_NOTICES.md` and
  [Sozbo-Tang/openwebui-chat2api](https://github.com/Sozbo-Tang/openwebui-chat2api).

## Security

`.chrome-profile/` holds your logged-in Open WebUI session (cookies, Local
State) — it is gitignored and npmignored **and must never be published**.
On a new machine: start the plugin, click **Login**, sign in once.
