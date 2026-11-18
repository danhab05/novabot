#!/usr/bin/env bash
# Lance une commande MCP avec les secrets de Novabot en variables d'environnement,
# sans jamais écrire les secrets dans ~/.claude.json ou ~/.codex/config.toml.
set -euo pipefail
SECRETS="${NOVABOT_SECRETS:-${NOVABOT_DATA:-$HOME/.novabot}/secrets.env}"
if [ -r "$SECRETS" ]; then set -a; . "$SECRETS"; set +a; fi
exec "$@"
