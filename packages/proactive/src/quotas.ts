// Lecture des quotas d'abonnement, même méthode que ~/.claude/skills/chef-orchestre/limits.sh :
// - Claude : ~/.claude/state/rate-limits.json (alimenté par la statusline)
// - Codex  : dernière ligne "rate_limits" des sessions récentes ~/.codex/sessions/AAAA/MM/JJ/*.jsonl
import { existsSync, readFileSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Quota } from "@novabot/shared";

const sec = (v: unknown) => (typeof v === "number" && v > 0 ? (v < 1e12 ? v * 1000 : v) : null);

export function readClaudeQuotas(path = join(homedir(), ".claude/state/rate-limits.json")): Quota[] {
  if (!existsSync(path)) return [];
  try {
    const d = JSON.parse(readFileSync(path, "utf8"));
    const updatedAt = sec(d.saved_at) ?? statSync(path).mtimeMs;
    const out: Quota[] = [];
    for (const [k, window] of [["five_hour", "5h"], ["seven_day", "7d"]] as const) {
      const w = d.rate_limits?.[k];
      if (w) out.push({ provider: "claude", window, usedPct: Math.round(Number(w.used_percentage ?? 0)), resetsAt: sec(w.resets_at), updatedAt });
    }
    return out;
  } catch { return []; }
}

function findRateLimits(o: any): any {
  if (!o || typeof o !== "object") return null;
  if (o.rate_limits && typeof o.rate_limits === "object") return o.rate_limits;
  for (const v of Object.values(o)) { const r = findRateLimits(v); if (r) return r; }
  return null;
}

function tail(path: string, bytes = 512 * 1024): string {
  const size = statSync(path).size;
  const fd = openSync(path, "r");
  try {
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally { closeSync(fd); }
}

function recentSessionFiles(dir: string, limit = 5): string[] {
  if (!existsSync(dir)) return [];
  const files: { f: string; m: number }[] = [];
  // ne parcourt que les jours les plus récents (AAAA/MM/JJ triés)
  const sortedDesc = (p: string) => { try { return readdirSync(p).sort().reverse(); } catch { return []; } };
  outer: for (const y of sortedDesc(dir)) for (const mo of sortedDesc(join(dir, y))) for (const d of sortedDesc(join(dir, y, mo))) {
    for (const f of readdirSync(join(dir, y, mo, d))) if (f.endsWith(".jsonl")) { const p = join(dir, y, mo, d, f); files.push({ f: p, m: statSync(p).mtimeMs }); }
    if (files.length >= limit * 4) break outer;
  }
  return files.sort((a, b) => b.m - a.m).slice(0, limit).map((x) => x.f);
}

export function readCodexQuotas(dir = join(homedir(), ".codex/sessions")): Quota[] {
  for (const f of recentSessionFiles(dir)) {
    const lines = tail(f).split("\n").filter((l) => l.includes('"rate_limits"'));
    const last = lines[lines.length - 1];
    if (!last) continue;
    try {
      const rl = findRateLimits(JSON.parse(last));
      if (!rl) continue;
      const updatedAt = statSync(f).mtimeMs;
      const out: Quota[] = [];
      for (const k of ["primary", "secondary"]) {
        const w = rl[k];
        if (!w) continue;
        const mins = Number(w.window_minutes ?? 0);
        const window: Quota["window"] = mins && mins <= 24 * 60 ? "5h" : "7d";
        out.push({ provider: "codex", window, usedPct: Math.round(Number(w.used_percent ?? 0)), resetsAt: sec(w.resets_at), updatedAt });
      }
      if (out.length) return out;
    } catch { /* ligne tronquée : session suivante */ }
  }
  return [];
}

/** Quota effectif : si resetsAt est passé, la fenêtre est remise à zéro. */
export function effective(q: Quota, now = Date.now()): Quota {
  return q.resetsAt && q.resetsAt <= now ? { ...q, usedPct: 0 } : q;
}
