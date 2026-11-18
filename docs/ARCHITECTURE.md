# Novabot — architecture

Novabot is a single always-on daemon (Bun + SQLite) plus a PWA. It keeps a conversational
"brain" online, delegates heavy work to coding agents running in [Herdr](https://herdr.dev)
terminals, and talks to you through Discord and the PWA.

```
 Discord ──┐                  ┌─ Brain (direct model calls) ── Codex OAuth (ChatGPT subscription)
 PWA ──────┤                  │                            └─ Claude CLI  (`claude -p`, Claude subscription)
 Crons ────┼──> novabotd ─────┤
 Health ───┘   (Bun, SQLite)  ├─ Herdr orchestrator ──> claude / codex panes (one worktree + branch per task)
               │              │        └─ MCP "novabot" injected into every agent (tasks, memory, ask_owner…)
               │              └─ Live browser: shared Chrome (CDP) → screencast → PWA, take-over
               └─ HTTP + SSE + WebSocket ──> PWA (behind HTTPS reverse proxy)
```

## Repository layout

| Path | Role |
|---|---|
| `apps/daemon` | Hono HTTP server, SQLite schema, auth, event bus, tool registry, module loader, OpenBot importer |
| `apps/pwa` | Vite + React + Tailwind PWA (projects, threads, tasks, live browser, terminals, cockpit) |
| `packages/shared` | Shared types (`Project`, `Task`, `Message`, `NovaEvent`, `ToolDef`…) and helpers |
| `packages/brain` | Model providers (Codex OAuth, Claude CLI), router, tool loop, memory + journal, skills proposals, voice |
| `packages/herdr` | Task orchestrator (agent/model choice, worktrees, verification loop, watchdog) and per-project Herdr sessions |
| `packages/mcp` | stdio MCP server exposing the daemon's tools to Claude Code / Codex |
| `packages/discord` | Discord bot (one channel per project, one thread per task), OAuth login, Web Push |
| `packages/browser` | CDP screencast hub, input forwarding, take-over state |
| `packages/proactive` | Scheduler (cron + one-shot), morning brief, health monitoring + auto-fix, quotas, ideas |
| `packages/catalog` | Catalog of MCP connectors, skills and agent templates; Google/Yahoo/WhatsApp/Coolify/GitHub integrations; public catalog page |

Every package exports a `Module` (`init`, `routes`, `publicRoutes`, `start`, `stop`). A module that
is missing, disabled (`NOVABOT_DISABLE`) or failing never prevents the daemon from starting.

## Brain

Used for everything that must be fast and does not touch code: answering, routing (which project,
which agent, which model), splitting a request, **verifying** that a task is done, summarising,
extracting memories, writing the brief, triaging mail, voice.

- Providers: **OpenAI through Codex OAuth** (device login from the PWA, or `~/.codex/auth.json`) and
  **Claude through the `claude` CLI** (`claude -p`, stream-json).
- Router: three tiers (`fast`, `reason`, `critical`) mapped to each family's models, with automatic
  fallback to the other family when a quota window passes 85 % (5 h) / 90 % or a call fails.
- Native tool loop over the shared tool registry (memory, tasks, crons, notifications, catalog,
  browser, integrations). Tools flagged `reserved` can only run after the owner's explicit approval.

## Herdr orchestrator

- Each heavy task = one Herdr agent in a per-project workspace, with a dedicated git worktree and branch.
  Claude runs with `--dangerously-skip-permissions` (+ `IS_SANDBOX=1`), Codex with `--yolo`.
- Agent/model choice: Claude for open-ended work, Codex for bounded tasks and reviews, escalation after
  two failures, cross-family review.
- **Autonomy loop**: when the agent calls `task_done` with evidence, the brain verifies (git state,
  output, evidence). If not done it sends a precise fix prompt (up to 3 times, then escalation).
  A decision reserved to the owner → `ask_owner` (one question + a recommendation), task goes `waiting`.
- Watchdog: stuck agent → read + nudge; quota limit → automatic resume after reset.
- Adaptive parallelism: a new agent starts only if available RAM, swap and load are within limits
  (`NOVABOT_HERDR_LIMITS`), otherwise it waits in a priority queue (broken prod > owner request > background).

## Project autonomy

Each project has an autonomy level:

| Level | Agents may… |
|---|---|
| `full` | commit, merge into the deployed branch, push (= deploy) and verify in production |
| `pr` | push a branch and open a PR, never merge or deploy |
| `readonly` | read and report only |

Whatever the level, destructive deletions, DNS, billing, secrets and anything sent on the owner's
behalf go through `ask_owner`.

## Memory, skills, proactivity

- After each exchange the brain extracts durable facts, decisions, preferences and pitfalls (global or
  per project). Every write is recorded in the **journal** (PWA): edit, delete, pin. Search: SQLite FTS5.
- Injected context: `SOUL.md` (personality, in the data dir) + optional global rules file
  (`NOVABOT_GLOBAL_RULES_FILE`) + global and project memory + the project handoff (`handoffs/<id>.md`).
- Skills: after a new procedure works, the brain proposes a skill; the owner accepts it in one tap and it
  is installed for both Claude Code (`~/.claude/skills`) and Codex (`~/.codex/skills`).
- Proactivity: morning brief (07:00 in `NOVABOT_TZ`) on Discord + push; relaunch of stalled tasks;
  health monitoring (Coolify apps and deployments if configured, `NOVABOT_HEALTH_URLS`, `url:` and
  `services:` lines in project notes) with automatic diagnosis/fix tasks; an "Ideas" box that is never
  applied automatically.

## Channels

- **Discord**: one channel per project (grouped by folder category), one thread per task, owner mention
  when done or blocked. Voice messages are transcribed.
- **PWA**: folders → projects on the left, the project thread in the middle, a right panel with
  Tasks | Live browser | Terminals, and a Cockpit (agents, queue, quotas, health, memory journal, ideas).
  Web Push, dictation and TTS. Same thread as Discord.

## Security

- The daemon listens on `NOVABOT_HOST` (default 127.0.0.1) and is exposed through an HTTPS reverse proxy.
- Login is Discord OAuth only. The admin is the account whose id is `NOVABOT_ADMIN_DISCORD_ID`.
  Any other Discord account is refused unless it was explicitly invited to a project, and then only
  sees that project (no global threads, no terminals, no shared browser).
- Secrets live in `secrets.env` (mode 600): never in SQLite, logs or the catalog. Integration OAuth
  tokens are stored encrypted (AES-256-GCM, key derived from `NOVABOT_INTERNAL_TOKEN`).
- Web pages and e-mails are untrusted data: never executed as instructions.
- Publishing to the public catalog is refused if the secret scanner finds anything.

## Migration from Hermes Agent / OpenBot (optional)

On first start, if the configured paths exist, Novabot imports read-only and exactly once (a flag
in the `settings` table prevents re-imports; existing rows are never modified):
- Hermes Agent (`NOVABOT_IMPORT_HERMES_DIR`): `SOUL.md`, `memories/`, `project-memory/`, skills (as
  catalog entries) and `cron/jobs.json` (imported disabled, for review).
- OpenBot (`NOVABOT_IMPORT_OPENBOT_SETUP`, `NOVABOT_IMPORT_OPENBOT_HANDOFFS`, `NOVABOT_IMPORT_OPENBOT_SKILLS`):
  project sheets, handoffs and skills.
- Optionally your crontab (`NOVABOT_IMPORT_CRONTAB=1`), imported disabled.

See `docs/API.md` for the HTTP contract.
