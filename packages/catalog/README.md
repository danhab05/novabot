# @novabot/catalog

Catalogue Novabot (connecteurs MCP, skills, modèles d'agents), installation symétrique,
publication publique et intégrations (Google, Yahoo, WhatsApp, Coolify, GitHub).

- Sources : `~/.claude/skills` (local, installés), dossiers de `NOVABOT_SKILL_DIRS`, et en option `NOVABOT_IMPORT_HERMES_DIR/skills/**` (hermes) et `NOVABOT_IMPORT_OPENBOT_SKILLS` (openbot) ; `registry/*.json` (MCP) et `registry/agents/*.json` (agents).
- Installation : skill → `~/.claude/skills/<nom>` + lien `~/.codex/skills/<nom>` ; MCP → `claude mcp add --scope user` + bloc balisé `# novabot:begin/end <nom>` dans `~/.codex/config.toml` (sauvegarde `.bak-novabot-*`) ; secrets → ajoutés à `~/.novabot/secrets.env` (jamais écrasés, jamais en argument : lancés via `bin/with-secrets.sh`).
- Désinstallation : uniquement ce que Novabot a installé (table `catalog_installs`). Les secrets ajoutés restent.
- Intégrations « builtin » : outils dans `ctx.tools` (exposés au cerveau et aux agents via le MCP novabot). Envois (`gmail_send`, `whatsapp_send`) marqués `reserved`.
- Publication : `POST /api/catalog/:id/publish` refuse si `scanSecrets` trouve quoi que ce soit (422 + liste). Page publique `/pub/catalogue`, manifeste `/pub/catalogue/<id>.json`, installation par lien `/catalog/install?src=<url>`.
- Jetons OAuth : AES-256-GCM, clé HKDF de `NOVABOT_INTERNAL_TOKEN`, table `catalog_integrations`.

## Client OAuth Google (à faire une fois)
1. https://console.cloud.google.com/projectcreate → projet « Novabot » (sans facturation).
2. API et services → Bibliothèque : activer Gmail API, Google Calendar API, Google Drive API.
3. Écran de consentement OAuth : Externe, mode Test, ajouter ton adresse Gmail en utilisateur test.
4. Identifiants → ID client OAuth → Application Web, URI de redirection `<NOVABOT_PUBLIC_URL>/auth/google/callback`.
5. `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` dans `~/.novabot/secrets.env`, redémarrer Novabot, puis ouvrir `/auth/google?scope=gmail,calendar,drive`.

Tests : `bun test` (HOME temporaire via `NOVABOT_CATALOG_HOME`, rien n'est écrit dans le vrai `~/.claude`).
