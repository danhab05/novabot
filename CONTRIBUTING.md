# Contributing to Novabot

Thanks for helping! A few rules keep the project easy to run for everyone.

- **Setup**: `bun install`, copy `.env.example` to `~/.novabot/secrets.env`, `bun run dev`.
- **Tests**: `bun run test` (runs each package's tests separately) and `bun run typecheck` must pass.
  Tests never touch your real `~/.claude`, `~/.codex` or `~/.novabot`: they use temporary dirs via env vars.
- **No personal data in code**: hostnames, domains, emails, Discord ids, paths and project names belong in
  configuration (`secrets.env` / env vars, documented in `.env.example`) or in the database — never in source,
  fixtures or registry manifests. Use fictional values in tests (`Alice`, `acme`, `example.com`, `203.0.113.x`).
- **New env var?** Read it in `apps/daemon/src/core/config.ts` when possible and document it in `.env.example`.
- **Modules** are independent (`packages/*`): a missing or failing module must not stop the daemon.
- **Safety**: anything destructive, billing/DNS/secret-related, or sent on the owner's behalf must be a
  `reserved` tool that goes through `ask_owner`.
- Code comments may be in French or English; user-facing docs are in English.
- Small, focused PRs with a clear description and how you tested it.
