// Choix agent/modèle (tables du skill chef-orchestre), quotas et garde-fou ressources.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentKind, Task } from "@novabot/shared";
import type { Exec } from "./exec.ts";

// ---------------- Ressources ----------------
export interface Resources { memAvailMb: number; swapPct: number; load1: number }
export interface Limits { memMb: number; swapPct: number; load: number; maxParallel: number }
export const DEFAULT_LIMITS: Limits = { memMb: 3072, swapPct: 75, load: 6, maxParallel: 4 };

export function readResources(): Resources {
  const mi = readFileSync("/proc/meminfo", "utf8");
  const kb = (k: string) => Number(mi.match(new RegExp(`^${k}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
  const swapTotal = kb("SwapTotal");
  const swapPct = swapTotal ? Math.round(((swapTotal - kb("SwapFree")) / swapTotal) * 100) : 0;
  const load1 = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
  return { memAvailMb: Math.round(kb("MemAvailable") / 1024), swapPct, load1 };
}

/** null = OK pour lancer ; sinon la raison du refus. La priorité 0 (prod cassée) ignore la charge CPU. */
export function resourceBlock(r: Resources, l: Limits, priority: number, running: number): string | null {
  if (running >= l.maxParallel) return `déjà ${running} agents actifs (max ${l.maxParallel})`;
  if (r.memAvailMb < l.memMb) return `RAM disponible ${r.memAvailMb} Mo < ${l.memMb} Mo`;
  if (r.swapPct >= l.swapPct) return `swap ${r.swapPct} % ≥ ${l.swapPct} %`;
  if (priority > 0 && r.load1 >= l.load) return `charge ${r.load1} ≥ ${l.load}`;
  return null;
}

// ---------------- Quotas ----------------
export interface QuotaState { claude5h: number | null; claude7d: number | null; claudeReset: number | null; codex: number | null; codexReset: number | null }

/** Lit le script de quotas (NOVABOT_QUOTA_SCRIPT, optionnel : absent = quotas inconnus). Lignes : "<tool> <window> <used%> <resets_at> <age_s>". */
export async function readQuotas(exec: Exec, script = process.env.NOVABOT_QUOTA_SCRIPT || join(process.env.HOME || homedir(), ".claude/skills/chef-orchestre/limits.sh")): Promise<QuotaState> {
  const q: QuotaState = { claude5h: null, claude7d: null, claudeReset: null, codex: null, codexReset: null };
  try {
    const r = await exec("bash", [script], { timeoutMs: 20_000 });
    for (const line of r.stdout.split("\n")) {
      const [tool, win, pct, reset] = line.trim().split(/\s+/);
      const p = Number(pct), rs = Number(reset) * 1000 || null;
      if (tool === "claude" && win === "five_hour") { q.claude5h = p; q.claudeReset = rs; }
      else if (tool === "claude" && win === "seven_day") q.claude7d = p;
      else if (tool === "codex" && Number.isFinite(p)) { q.codex = Math.max(q.codex ?? 0, p); q.codexReset = rs; }
    }
  } catch { /* quotas inconnus : on ne bloque pas */ }
  return q;
}

// ---------------- Modèles ----------------
export type Level = 1 | 2 | 3 | 4; // 1 mécanique, 2 cadré, 3 lourd, 4 le plus dur
export const CLAUDE: Record<Level, { model: string; effort: string }> = {
  1: { model: "haiku", effort: "medium" }, 2: { model: "sonnet", effort: "high" }, 3: { model: "opus", effort: "high" }, 4: { model: "fable", effort: "high" },
};
export const CODEX: Record<Level, { model: string; effort: string }> = {
  1: { model: "gpt-6-luna", effort: "medium" }, 2: { model: "gpt-6.1-sol", effort: "high" }, 3: { model: "gpt-6-astra", effort: "high" }, 4: { model: "gpt-6-astra", effort: "max" },
};
const LEVEL_OF: Record<string, Level> = { haiku: 1, sonnet: 2, opus: 3, fable: 4, "gpt-6-luna": 1, "gpt-6.1-sol": 2, "gpt-6-astra": 3 };

export function levelOf(model: string | null, effort?: string | null): Level {
  if (!model) return 2;
  const l = LEVEL_OF[model] ?? 2;
  return model === "gpt-6-astra" && effort === "max" ? 4 : l;
}
export const isCritical = (t: Pick<Task, "model" | "effort" | "priority">) => levelOf(t.model, t.effort) >= 3 || t.effort === "xhigh" || t.effort === "max";

/** Heuristique de niveau quand rien n'est imposé (le cerveau peut fixer model/effort lui-même). */
export function guessLevel(t: Pick<Task, "title" | "goal" | "priority">): Level {
  const s = `${t.title} ${t.goal}`.toLowerCase();
  if (/s[ée]curit|architect|refonte|conception|d[ée]bog|cause inconnue|production|prod cass|migration/.test(s)) return 3;
  if (/renomm|typo|libell[ée]|texte|doc\b|readme|relance.*test|r[ée]g[ée]n[ée]r/.test(s) && s.length < 400) return 1;
  return 2;
}
/** Claude par défaut (flou, UI, multi-fichiers) ; Codex pour borné/algo/tests/relecture. */
export function guessKind(t: Pick<Task, "title" | "goal">): AgentKind {
  const s = `${t.title} ${t.goal}`.toLowerCase();
  return /\b(test|tests|scraper|script|parsing|parse|algorithm|algo|backend pur|relecture|revue|review|ci)\b/.test(s) ? "codex" : "claude";
}

export const familyOf = (model: string): AgentKind => (/^(claude|haiku|sonnet|opus|fable)/.test(model) ? "claude" : "codex");

export interface Choice { kind: AgentKind; model: string; effort: string; reason: string }

export function choose(t: Pick<Task, "title" | "goal" | "priority" | "agentKind" | "model" | "effort">, q: QuotaState, failures = 0): Choice {
  let kind: AgentKind = t.agentKind ?? guessKind(t);
  let level: Level = t.model ? levelOf(t.model, t.effort) : guessLevel(t);
  const reasons: string[] = [];
  const claudeHot = (q.claude5h ?? 0) >= 85 || (q.claude7d ?? 0) >= 75;
  const codexHot = (q.codex ?? 0) >= 85;
  if (!t.agentKind) {
    if (kind === "claude" && claudeHot && !codexHot) { kind = "codex"; reasons.push("quota Claude haut → Codex"); }
    else if (kind === "codex" && codexHot && !claudeHot) { kind = "claude"; reasons.push("quota Codex haut → Claude"); }
  }
  // escalade : après 2 échecs, niveau au-dessus (ou changement de famille au sommet)
  if (failures >= 2) {
    if (level < 4) { level = (level + 1) as Level; reasons.push("escalade après 2 échecs"); }
    else { kind = kind === "claude" ? "codex" : "claude"; reasons.push("changement de famille après 2 échecs"); }
  }
  const table = kind === "claude" ? CLAUDE : CODEX;
  // modèle imposé, même famille, sans escalade → on le garde
  if (t.model && failures < 2 && familyOf(t.model) === kind)
    return { kind, model: t.model, effort: t.effort ?? table[level].effort, reason: reasons.join(", ") || "imposé" };
  return { kind, model: table[level].model, effort: t.effort && failures < 2 ? t.effort : table[level].effort, reason: reasons.join(", ") || `niveau ${level}` };
}

/** Détection d'un message de limite de quota dans la sortie d'un agent. */
export const LIMIT_RE = /usage limit|limit reached|rate limit|hit your limit|resets? (at|in) |you've reached|quota exceeded/i;
