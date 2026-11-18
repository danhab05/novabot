// Choix du fournisseur pour les appels directs du cerveau.
//
// Défaut : Codex (OAuth ChatGPT direct) en premier. Raisons : appel HTTP direct (pas de processus
// à lancer : ~1 s au lieu de ~4 s pour `claude -p`), boucle d'outils native et streaming fin, et il
// préserve le quota Claude, déjà consommé par les agents Herdr (Claude par défaut pour le code).
// Claude (CLI) prend le relais si Codex est saturé, indisponible ou en erreur.
//
// Règles quotas (table quotas, alimentée par les en-têtes x-codex-* et rate_limit_event de Claude) :
//  - fenêtre 5 h ≥ 85 % → l'autre famille d'abord
//  - fenêtre 7 j ≥ 90 % → l'autre famille d'abord
//  - les deux saturés → le moins chargé.
import type { DB } from "@novabot/daemon/core";
import type { Provider, ProviderId } from "./providers/types.ts";

export interface QuotaRow { provider: string; window: string; usedPct: number; resetsAt: number | null }

export function loadQuotas(db: DB): QuotaRow[] {
  return (db.query("SELECT provider, window, used_pct AS usedPct, resets_at AS resetsAt FROM quotas").all() as QuotaRow[]);
}

export function saturation(quotas: QuotaRow[], p: ProviderId, now = Date.now()): number {
  // renvoie un score : >1 = saturé ; quotas dont le reset est passé ignorés
  let score = 0;
  for (const q of quotas) {
    if (q.provider !== p) continue;
    if (q.resetsAt && q.resetsAt < now) continue;
    const limit = q.window === "5h" ? 85 : 90;
    score = Math.max(score, q.usedPct / limit);
  }
  return score;
}

export function orderProviders(quotas: QuotaRow[], prefer: ProviderId[] = ["codex", "claude"], now = Date.now()): ProviderId[] {
  const sat = (p: ProviderId) => saturation(quotas, p, now);
  const ok = prefer.filter((p) => sat(p) < 1);
  const full = prefer.filter((p) => sat(p) >= 1).sort((a, b) => sat(a) - sat(b));
  return [...ok, ...full];
}

export class Router {
  constructor(private db: DB, private providers: Record<ProviderId, Provider>, private prefer: () => ProviderId[] = () => ["codex", "claude"]) {}

  order(forced?: ProviderId): Provider[] {
    const ids = forced ? [forced, ...this.prefer().filter((p) => p !== forced)] : orderProviders(loadQuotas(this.db), this.prefer());
    return ids.map((i) => this.providers[i]).filter(Boolean);
  }

  /** Exécute fn sur le premier fournisseur qui réussit (bascule sur erreur retryable). */
  async run<T>(fn: (p: Provider) => Promise<T>, forced?: ProviderId): Promise<T> {
    let last: unknown;
    for (const p of this.order(forced)) {
      try { return await fn(p); }
      catch (e: any) { last = e; if (e?.retryable === false) throw e; console.warn(`[brain] ${p.id} a échoué, bascule :`, String(e?.message ?? e).slice(0, 200)); }
    }
    throw last ?? new Error("aucun fournisseur disponible");
  }
}
