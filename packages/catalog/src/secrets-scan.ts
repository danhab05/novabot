// Détection de secrets avant publication publique. Volontairement large : mieux vaut refuser à tort.
export interface Finding { kind: string; excerpt: string; where: string }

const RULES: [string, RegExp][] = [
  ["clé privée", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["clé OpenAI/Anthropic", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g],
  ["clé Stripe", /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g],
  ["jeton GitHub", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g],
  ["jeton Slack", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["clé AWS", /\bAKIA[0-9A-Z]{16}\b/g],
  ["clé Google", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["jeton Discord", /\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/g],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["mot de passe en clair", /\b(?:password|passwd|pwd|mot[ _-]de[ _-]passe|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"',;]{6,}/gi],
  ["chemin de secrets", /(?:\/root|\/home\/[\w.-]+|~)\/\.(?:secrets|novabot\/secrets|coolify-api-token|ssh)|mots-de-passe\.txt|\.env\b(?!\.example)/g],
  ["adresse e-mail", /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g],
  ["adresse IP publique", /\b(?!(?:10|127|0)\.)(?!192\.168\.)(?!172\.(?:1[6-9]|2\d|3[01])\.)(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ["URL avec identifiants", /\b[a-z]+:\/\/[^\s/:@]+:[^\s/@]+@/gi],
];

/** Scanne un objet (manifeste) et retourne les trouvailles, avec le champ concerné. */
export function scanSecrets(obj: unknown): Finding[] {
  const out: Finding[] = [];
  const walk = (v: unknown, where: string) => {
    if (typeof v === "string") {
      for (const [kind, re] of RULES) {
        re.lastIndex = 0;
        for (const m of v.matchAll(re)) {
          const s = m[0];
          out.push({ kind, where, excerpt: s.length > 12 ? s.slice(0, 6) + "…" + s.slice(-2) : s.slice(0, 3) + "…" });
          if (out.length > 200) return;
        }
      }
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { walk(k, `${where}.${k}(clé)`); walk(x, where ? `${where}.${k}` : k); }
  };
  walk(obj, "");
  return out;
}
