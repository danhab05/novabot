#!/usr/bin/env bash
# Novabot installer: checks requirements, installs dependencies, builds the PWA,
# creates ~/.novabot/secrets.env (from .env.example) and renders the systemd unit.
# Safe to re-run: never overwrites an existing secrets file or existing keys.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="${NOVABOT_DATA:-$HOME/.novabot}"
SECRETS="${NOVABOT_SECRETS:-$DATA/secrets.env}"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }

echo "Novabot installer — repo: $REPO"
echo
echo "1. Requirements"
command -v bun >/dev/null 2>&1 || die "bun not found. Install it: curl -fsSL https://bun.sh/install | bash"
ok "bun $(bun --version)"
command -v git >/dev/null 2>&1 && ok "git" || warn "git not found (needed for agent worktrees)"
if command -v herdr >/dev/null 2>&1; then ok "herdr (agents can run Claude Code / Codex in terminals)"; else warn "herdr not found: heavy tasks cannot be delegated to coding agents (optional)"; fi
if command -v claude >/dev/null 2>&1; then ok "claude CLI (log in once with: claude)"; else warn "claude CLI not found: no Claude brain/agents (optional, npm i -g @anthropic-ai/claude-code)"; fi
if command -v codex >/dev/null 2>&1; then ok "codex CLI (log in once with: codex login)"; else warn "codex CLI not found: Codex agents unavailable (the brain can still log in to ChatGPT from the PWA)"; fi
command -v gh >/dev/null 2>&1 && ok "gh CLI (GitHub connector)" || warn "gh CLI not found (optional, GitHub connector)"

echo
echo "2. Dependencies"
(cd "$REPO" && bun install)
ok "bun install"

echo
echo "3. PWA build"
(cd "$REPO/apps/pwa" && bun run build >/dev/null)
ok "apps/pwa/dist built"

echo
echo "4. Configuration ($SECRETS)"
mkdir -p "$DATA"; chmod 700 "$DATA"
if [ ! -f "$SECRETS" ]; then
  cp "$REPO/.env.example" "$SECRETS"
  ok "created from .env.example"
else
  ok "already exists (kept)"
fi
chmod 600 "$SECRETS"

# set_if_empty KEY VALUE : fills KEY only when missing or empty
set_if_empty() {
  local k="$1" v="$2"
  if grep -qE "^$k=.+" "$SECRETS"; then return 1; fi
  if grep -qE "^$k=" "$SECRETS"; then
    local tmp; tmp="$(mktemp)"
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k && !done {print k "=" v; done=1; next} {print}' "$SECRETS" > "$tmp"
    cat "$tmp" > "$SECRETS"; rm -f "$tmp"
  else
    printf '%s=%s\n' "$k" "$v" >> "$SECRETS"
  fi
  return 0
}

if set_if_empty NOVABOT_INTERNAL_TOKEN "$(bun -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"; then ok "NOVABOT_INTERNAL_TOKEN generated"; else ok "NOVABOT_INTERNAL_TOKEN already set"; fi
if ! grep -qE "^VAPID_PUBLIC_KEY=.+" "$SECRETS"; then
  KEYS="$(cd "$REPO/packages/discord" && bun -e 'const w=require("web-push");const k=w.generateVAPIDKeys();console.log(k.publicKey+" "+k.privateKey)')"
  set_if_empty VAPID_PUBLIC_KEY "${KEYS%% *}" >/dev/null || true
  set_if_empty VAPID_PRIVATE_KEY "${KEYS##* }" >/dev/null || true
  ok "VAPID keys generated"
else
  ok "VAPID keys already set"
fi

echo
echo "5. systemd unit"
UNIT="$REPO/scripts/novabot.service"
sed -e "s#__USER__#$(id -un)#g" -e "s#__HOME__#$HOME#g" -e "s#__REPO__#$REPO#g" -e "s#__BUN__#$(command -v bun)#g" \
  "$REPO/scripts/novabot.service.example" > "$UNIT"
ok "rendered $UNIT (not installed)"

missing=()
for k in NOVABOT_PUBLIC_URL NOVABOT_ADMIN_DISCORD_ID DISCORD_BOT_TOKEN DISCORD_CLIENT_ID DISCORD_CLIENT_SECRET DISCORD_GUILD_ID; do
  grep -qE "^$k=.+" "$SECRETS" || missing+=("$k")
done
if grep -qE "^NOVABOT_PUBLIC_URL=https://novabot.example.com$" "$SECRETS"; then missing+=("NOVABOT_PUBLIC_URL (still the example value)"); fi

echo
echo "Next steps"
if [ ${#missing[@]} -gt 0 ]; then
  echo "  - Edit $SECRETS and fill in:"; for k in "${missing[@]}"; do echo "      $k"; done
  echo "    (Discord app setup: see README.md → \"Discord application\")"
fi
cat <<EOF
  - Put Novabot behind HTTPS (example: docs/deploy/Caddyfile.example — keep flush_interval -1).
  - Try it:      cd $REPO && bun run start
  - Run as a service:
      sudo cp $UNIT /etc/systemd/system/novabot.service
      sudo systemctl daemon-reload && sudo systemctl enable --now novabot
      tail -f $DATA/novabot.log
  - Open your NOVABOT_PUBLIC_URL and sign in with Discord.
EOF
