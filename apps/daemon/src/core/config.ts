import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Configuration : variables d'environnement, complétées par le fichier de secrets
// (défaut ~/.novabot/secrets.env, mode 600). Les secrets ne vont jamais en base ni dans les logs.
// Liste complète et documentée : .env.example à la racine du dépôt.
const HOME = process.env.HOME || homedir();
const DATA_DIR = process.env.NOVABOT_DATA ?? join(HOME, ".novabot");
export const SECRETS_FILE = process.env.NOVABOT_SECRETS ?? join(DATA_DIR, "secrets.env");

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnvFile(SECRETS_FILE);

const env = (k: string, d = "") => process.env[k] ?? d;
const dataDir = env("NOVABOT_DATA", DATA_DIR);
const port = Number(env("NOVABOT_PORT", "8790"));

export const config = {
  host: env("NOVABOT_HOST", "127.0.0.1"),
  port,
  publicUrl: env("NOVABOT_PUBLIC_URL", `http://localhost:${port}`).replace(/\/+$/, ""),
  dataDir,
  dbPath: env("NOVABOT_DB", join(dataDir, "novabot.db")),
  secretsFile: SECRETS_FILE,
  pwaDist: env("NOVABOT_PWA_DIST", new URL("../../../pwa/dist", import.meta.url).pathname),
  /** Jeton interne : MCP novabot -> daemon, et tests. */
  internalToken: env("NOVABOT_INTERNAL_TOKEN"),
  /** Prénom du propriétaire (admin), utilisé dans les prompts et messages. */
  ownerName: env("NOVABOT_OWNER_NAME", "Owner"),
  /** Discord id du propriétaire (admin). */
  adminDiscordId: env("NOVABOT_ADMIN_DISCORD_ID"),
  discord: { token: env("DISCORD_BOT_TOKEN"), clientId: env("DISCORD_CLIENT_ID"), clientSecret: env("DISCORD_CLIENT_SECRET"), guildId: env("DISCORD_GUILD_ID") },
  google: { clientId: env("GOOGLE_CLIENT_ID"), clientSecret: env("GOOGLE_CLIENT_SECRET") },
  vapid: { publicKey: env("VAPID_PUBLIC_KEY"), privateKey: env("VAPID_PRIVATE_KEY"), subject: env("VAPID_SUBJECT", "mailto:admin@example.com") },
  /** Coolify (optionnel) : URL de l'instance (ex. https://coolify.example.com) + jeton API. Vide = désactivé. */
  coolify: {
    url: env("COOLIFY_URL").replace(/\/+$/, ""),
    token: env("COOLIFY_TOKEN"),
    tokenFile: env("COOLIFY_TOKEN_FILE", join(HOME, ".coolify-api-token")),
    /** Domaines de test à ignorer pour le check HTTP (suffixe, ex. ".app.example.com"). */
    ignoreDomainSuffix: env("COOLIFY_IGNORE_DOMAIN_SUFFIX"),
    /** Correspondance app Coolify -> projet Novabot quand les noms diffèrent : "app1=projet1,app2=projet2". */
    appProjectMap: parseMap(env("NOVABOT_COOLIFY_APP_MAP")),
  },
  /** URL supplémentaires à surveiller (séparées par virgules). */
  healthUrls: env("NOVABOT_HEALTH_URLS").split(",").map((s) => s.trim()).filter(Boolean),
  /** Fichier de règles globales injecté dans le contexte du cerveau (optionnel). */
  globalRulesFile: env("NOVABOT_GLOBAL_RULES_FILE", join(HOME, "AGENTS.md")),
  /** Script de lecture des quotas Claude/Codex (optionnel, format "<tool> <window> <used%> <resets_at> <age_s>"). */
  quotaScript: env("NOVABOT_QUOTA_SCRIPT", join(HOME, ".claude/skills/chef-orchestre/limits.sh")),
  /** Migration optionnelle depuis Hermes Agent / OpenBot (ignorée si les chemins n'existent pas). */
  import: {
    hermesDir: env("NOVABOT_IMPORT_HERMES_DIR", env("NOVABOT_HERMES_DIR", join(HOME, ".hermes"))),
    openbotSetup: env("NOVABOT_IMPORT_OPENBOT_SETUP").split(",").map((s) => s.trim()).filter(Boolean),
    openbotHandoffs: env("NOVABOT_IMPORT_OPENBOT_HANDOFFS").split(",").map((s) => s.trim()).filter(Boolean),
    crontab: env("NOVABOT_IMPORT_CRONTAB") === "1",
  },
  tz: env("NOVABOT_TZ", "Europe/Paris"),
  dev: env("NOVABOT_DEV") === "1",
  /** Modules désactivés (liste séparée par virgules). */
  disabled: new Set(env("NOVABOT_DISABLE").split(",").filter(Boolean)),
};
export type Config = typeof config;

function parseMap(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of s.split(",")) { const [k, v] = pair.split("=").map((x) => x?.trim()); if (k && v) out[k] = v; }
  return out;
}

/** Jeton API Coolify : COOLIFY_TOKEN, sinon contenu de COOLIFY_TOKEN_FILE. null si non configuré. */
export function coolifyToken(c: Config["coolify"] = config.coolify): string | null {
  if (c.token) return c.token;
  try { return c.tokenFile && existsSync(c.tokenFile) ? readFileSync(c.tokenFile, "utf8").trim() || null : null; } catch { return null; }
}
