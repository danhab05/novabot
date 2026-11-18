# Novabot

**Un harness IA personnel, toujours allumé, sur ton propre serveur.**

Novabot garde un cerveau conversationnel en ligne 24 h/24 en utilisant tes abonnements existants
(ChatGPT via l'OAuth Codex, Claude via `claude -p`) et confie le travail lourd (code, déploiement,
débogage) à des agents Claude Code / Codex qui tournent dans des terminals [Herdr](https://herdr.dev),
chacun sur sa branche. Tu lui parles depuis Discord (un salon par projet, un fil par tâche) ou depuis une
PWA rapide avec navigateur et terminaux en direct, mémoire avec journal, propositions de skills,
crons, brief du matin, surveillance et catalogue de connecteurs MCP.

## Démarrage rapide

```bash
git clone https://github.com/<toi>/novabot.git && cd novabot
./scripts/install.sh            # vérifie les outils, installe, construit la PWA, crée ~/.novabot/secrets.env
$EDITOR ~/.novabot/secrets.env  # NOVABOT_PUBLIC_URL + valeurs Discord
bun run start
```

Mets-le derrière HTTPS (exemple Caddy : `docs/deploy/Caddyfile.example`, garder `flush_interval -1`),
puis connecte-toi avec Discord. Seul le compte `NOVABOT_ADMIN_DISCORD_ID` est admin ; les autres comptes
n'entrent que s'ils ont été invités sur un projet.

Toute la documentation (configuration, création de l'application Discord, sécurité, règles d'autonomie)
est dans le [README anglais](README.md) ; toutes les variables sont décrites dans `.env.example`.

Licence MIT.
