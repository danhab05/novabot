# Novabot

**An always-on personal AI harness that runs on your own server.**

Novabot keeps a conversational brain online 24/7, using the AI subscriptions you already pay for,
and hands heavy coding work to Claude Code / Codex agents running in visible, resumable terminals.
You talk to it from Discord or from a fast PWA on your phone.

> [Version française courte](README.fr.md)

## What it does

- **Brain on your subscriptions**: direct calls to OpenAI models through your **ChatGPT subscription
  (Codex OAuth)** and to Claude through your **Claude subscription (`claude -p`)**. Requests are routed by
  tier (fast / reason / critical), with automatic fallback to the other family when a quota runs low.
- **Delegates the heavy lifting**: code, deploys, debugging and long research become *tasks*, run by
  Claude Code or Codex inside [Herdr](https://herdr.dev) panes, each in its own git worktree and branch.
  Novabot checks the evidence, sends fix prompts, and only reports "done" when it is verified.
- **Discord-native**: one channel per project, one thread per task, a mention when it is done or blocked.
- **Fast PWA**: projects, threads, task cards, a **live browser** (watch the agent's Chrome tab and take
  over with clicks and keys — captchas, 2FA) and **live terminals** on the agents' Herdr sessions.
  Push notifications, dictation and text-to-speech.
- **Memory with a journal**: durable facts, decisions, preferences and pitfalls are extracted after each
  exchange; every change is visible and editable. Per-project handoffs keep agents in context.
- **Skills proposals**: after a new procedure works, Novabot proposes a reusable skill; accept it in one tap
  and it is installed for both Claude Code and Codex.
- **Proactive**: crons and one-shot reminders, a morning brief, health monitoring (HTTP, Coolify
  deployments, systemd/docker services) with automatic fix tasks, relaunch of stalled tasks, an ideas box.
- **Catalog**: MCP connectors (Gmail, Google Calendar, Drive, Yahoo Mail, WhatsApp bridge, GitHub, Coolify,
  Stripe, Supabase…), skills and agent templates, installable in one click, plus a public catalog page.

The UI and the prompts are currently written in **French** (set `NOVABOT_LANGUAGE` to change the language
the assistant answers in).

## Architecture

```
 Discord ──┐                  ┌─ Brain ── Codex OAuth (ChatGPT subscription)
 PWA ──────┤                  │       └── Claude CLI  (claude -p, Claude subscription)
 Crons ────┼──> novabotd ─────┤
 Health ───┘   (Bun, SQLite)  ├─ Herdr orchestrator ──> Claude Code / Codex panes
               │              │        (worktree + branch per task, MCP "novabot" in every agent)
               │              └─ Live browser: shared Chrome via CDP → screencast → PWA
               └─ HTTP + SSE + WebSocket ──> PWA (behind your HTTPS reverse proxy)
```

One Bun process, one SQLite file, independent modules (`packages/*`). Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
HTTP contract: [docs/API.md](docs/API.md).

## Requirements

- A Linux server (systemd recommended), 2+ GB RAM for Novabot and its agents (more if you run several agents in parallel).
- [Bun](https://bun.sh) ≥ 1.3, git.
- A domain name and a reverse proxy with HTTPS (Caddy example included).
- A Discord server you administrate and a Discord application (see below).
- Optional but recommended:
  - [`claude`](https://docs.anthropic.com/en/docs/claude-code) CLI logged in to your Claude subscription;
  - [`codex`](https://github.com/openai/codex) CLI and/or a ChatGPT subscription (Codex OAuth login from the PWA);
  - [Herdr](https://herdr.dev), to run coding agents in terminals;
  - Chrome/Chromium with remote debugging on `127.0.0.1:9222` for the live browser;
  - `gh` CLI for the GitHub connector; Python 3 + venv for local voice (faster-whisper, edge-tts).

## Quick start

```bash
git clone https://github.com/<you>/novabot.git && cd novabot
./scripts/install.sh          # checks tools, bun install, builds the PWA, creates ~/.novabot/secrets.env
$EDITOR ~/.novabot/secrets.env  # fill in NOVABOT_PUBLIC_URL + the Discord values (see below)
bun run start                 # or install the systemd unit printed by install.sh
```

Then put it behind HTTPS (see [docs/deploy/Caddyfile.example](docs/deploy/Caddyfile.example) — keep
`flush_interval -1`, the PWA relies on streaming), open your `NOVABOT_PUBLIC_URL` and sign in with Discord.

Run as a service:

```bash
sudo cp scripts/novabot.service /etc/systemd/system/novabot.service   # rendered by install.sh from novabot.service.example
sudo systemctl daemon-reload && sudo systemctl enable --now novabot
tail -f ~/.novabot/novabot.log
curl -s http://127.0.0.1:8790/healthz
```

## Configuration

Everything is configured through environment variables, read from `~/.novabot/secrets.env` (mode 600)
by default. Every variable is documented in [`.env.example`](.env.example).

| | Variables |
|---|---|
| **Required** | `NOVABOT_PUBLIC_URL`, `NOVABOT_ADMIN_DISCORD_ID`, `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_GUILD_ID` |
| Generated | `NOVABOT_INTERNAL_TOKEN`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` |
| Core (optional) | `NOVABOT_HOST`, `NOVABOT_PORT`, `NOVABOT_OWNER_NAME`, `NOVABOT_OWNER_ABOUT`, `NOVABOT_LANGUAGE`, `NOVABOT_TZ`, `NOVABOT_DATA`, `NOVABOT_DISABLE` |
| Integrations (optional) | `GOOGLE_CLIENT_ID/SECRET`, `YAHOO_EMAIL`, `YAHOO_APP_PASSWORD`, `NOVABOT_WHATSAPP_CMD`, `COOLIFY_URL`, `COOLIFY_TOKEN(_FILE)` |
| Agents (optional) | `CODEX_HOME`, `NOVABOT_HERDR_LIMITS`, `NOVABOT_QUOTA_SCRIPT`, `NOVABOT_GLOBAL_RULES_FILE`, `NOVABOT_CDP_URL` |
| Monitoring (optional) | `NOVABOT_HEALTH_URLS`, `NOVABOT_COOLIFY_APP_MAP`, `COOLIFY_IGNORE_DOMAIN_SUFFIX` |
| Migration (optional) | `NOVABOT_IMPORT_HERMES_DIR`, `NOVABOT_IMPORT_OPENBOT_SETUP`, `NOVABOT_IMPORT_OPENBOT_HANDOFFS`, `NOVABOT_IMPORT_OPENBOT_SKILLS`, `NOVABOT_IMPORT_CRONTAB` |

Personality lives in `~/.novabot/SOUL.md` (created on first start; edit it freely). Projects, folders,
crons and health targets live in the database and are managed from the PWA or by talking to Novabot.

### Logging in to the models

- **Claude**: install the `claude` CLI and log in once (`claude`) as the user that runs Novabot.
- **ChatGPT / Codex**: either log in with the `codex` CLI (`codex login`, credentials in `~/.codex/auth.json`)
  or start Novabot's own device-code login: `curl -X POST -H "Authorization: Bearer $NOVABOT_INTERNAL_TOKEN" http://127.0.0.1:8790/api/brain/codex/login`
  and open the returned URL with the returned code.

## Discord application setup

1. Go to <https://discord.com/developers/applications> → **New Application** (e.g. "Novabot").
2. **Bot** tab → *Reset Token* → copy it into `DISCORD_BOT_TOKEN`.
   Under *Privileged Gateway Intents*, enable **Server Members Intent** and **Message Content Intent**.
3. **OAuth2** tab → copy the *Client ID* into `DISCORD_CLIENT_ID` and the *Client Secret* into
   `DISCORD_CLIENT_SECRET`. Add the redirect URI **`<NOVABOT_PUBLIC_URL>/auth/discord/callback`**
   (e.g. `https://novabot.example.com/auth/discord/callback`).
4. Invite the bot to your server: OAuth2 → URL Generator, scopes **`bot`** and **`applications.commands`**,
   permissions integer **`326686067792`** — or directly:
   `https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot+applications.commands&permissions=326686067792`
5. In Discord, enable *Settings → Advanced → Developer Mode*, then right-click your server → *Copy Server ID*
   → `DISCORD_GUILD_ID`, and right-click yourself → *Copy User ID* → `NOVABOT_ADMIN_DISCORD_ID`.
6. Restart Novabot. The log should show the bot connected and the project channels synchronised.

## Security model

- **Who can log in**: login is Discord OAuth only. The account whose id is `NOVABOT_ADMIN_DISCORD_ID` is the
  admin. Any other Discord account is refused unless the admin explicitly invited it to a project; a guest
  then only sees that project's threads and tasks — no global threads, terminals, shared browser or health.
- The daemon listens on `127.0.0.1` by default; expose it only through your HTTPS reverse proxy.
- Secrets stay in `secrets.env` (600): never in the database, logs or catalog. Integration OAuth tokens are
  encrypted at rest (AES-256-GCM, key derived from `NOVABOT_INTERNAL_TOKEN`).
- Web pages, e-mails and messages are treated as untrusted data, never as instructions.
- Publishing to the public catalog is blocked if the secret scanner finds a key, token, e-mail, public IP address or
  secret path.
- `/auth/dev?token=<NOVABOT_INTERNAL_TOKEN>` gives an emergency admin session: keep that token secret.

## Autonomy rules

Novabot is designed to **decide and act**, not to ask permission for every step:

- Reversible, local work is done without confirmation: code, tests, commits, branches, restarts, config edits.
- Per project autonomy level: **`full`** (agents may merge into the deployed branch, push = deploy, and verify
  in production), **`pr`** (branch + pull request only), **`readonly`** (report only).
- **Reserved actions** always require your explicit approval through `ask_owner` (one question + a
  recommendation, the task waits): destructive deletions, DNS, billing/payments, missing secrets, security
  changes, stopping production services, and anything sent on your behalf (e-mail, WhatsApp…).
- A task is never reported as done without evidence (tests, command output, verified URL, commit).

## Development

```bash
bun install
bun run dev          # daemon with --watch
cd apps/pwa && bun run dev
bun run test         # tests of every package
bun run typecheck
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Optional migration from Hermes Agent / OpenBot is described in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#migration-from-hermes-agent--openbot-optional).

## License

[MIT](LICENSE) © Novabot contributors
