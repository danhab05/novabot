// Fournisseur OpenAI via l'abonnement ChatGPT (OAuth Codex) : appels directs à l'API Responses
// de chatgpt.com/backend-api/codex, en streaming SSE, avec boucle d'outils native.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDef } from "@novabot/shared";
import { HOME, parseSSE, clip } from "../util.ts";
import { getCodexCreds, onUnauthorized } from "./codex-auth.ts";
import type { Provider, Tier, CompleteReq, AgentTurnReq, AgentTurnRes, LlmMessage, QuotaSink } from "./types.ts";
import { ProviderError } from "./types.ts";

const BASE = "https://chatgpt.com/backend-api/codex";
const VERSION = "0.1.0";

/** Choisit le modèle le plus récent de chaque famille dans ~/.codex/models_cache.json. */
export function codexModels(cachePath = join(HOME, ".codex", "models_cache.json")): Record<Tier, string> {
  const fallback = { fast: "gpt-6-luna", reason: "gpt-6.1-sol", critical: "gpt-6-astra" };
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8"));
    const slugs: string[] = (Array.isArray(raw) ? raw : raw.models ?? []).map((m: any) => m.slug ?? m.id).filter(Boolean);
    const best = (family: string) => slugs
      .map((s) => ({ s, m: s.match(new RegExp(`^gpt-(\\d+)(?:\\.(\\d+))?-${family}$`)) }))
      .filter((x) => x.m)
      .sort((a, b) => Number(b.m![1]) - Number(a.m![1]) || Number(b.m![2] ?? 0) - Number(a.m![2] ?? 0))[0]?.s;
    return { fast: best("luna") ?? fallback.fast, reason: best("sol") ?? fallback.reason, critical: best("astra") ?? fallback.critical };
  } catch { return fallback; }
}

const EFFORT: Record<Tier, string> = { fast: "low", reason: "low", critical: "high" };

function toInput(history: LlmMessage[]): any[] {
  return history.map((m) => m.role === "user"
    ? { type: "message", role: "user", content: [
        ...(m.text ? [{ type: "input_text", text: m.text }] : []),
        ...(m.images ?? []).map((i) => ({ type: "input_image", image_url: `data:${i.mime};base64,${i.dataBase64}` })),
      ] }
    : { type: "message", role: "assistant", content: [{ type: "output_text", text: m.text }] });
}

/** Les schémas d'outils doivent être des objets JSON Schema valides. */
function toTools(tools: ToolDef[]) {
  return tools.map((t) => ({ type: "function", name: t.name, description: t.description, strict: false, parameters: t.inputSchema && (t.inputSchema as any).type ? t.inputSchema : { type: "object", properties: {} } }));
}

export class CodexProvider implements Provider {
  id = "codex" as const;
  private models = codexModels();
  constructor(private quota?: QuotaSink) {}
  model(tier: Tier) { return this.models[tier]; }

  async available() {
    try { await getCodexCreds(); return { ok: true }; } catch (e: any) { return { ok: false, reason: e.message }; }
  }

  /** Un appel /responses en streaming. Retourne le texte et les items de sortie (function_call, reasoning…). */
  async respond(body: Record<string, unknown>, onDelta?: (t: string) => void): Promise<{ text: string; items: any[] }> {
    let creds = await getCodexCreds();
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch(`${BASE}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${creds.accessToken}`,
          ...(creds.accountId ? { "ChatGPT-Account-ID": creds.accountId } : {}),
          originator: "novabot", "User-Agent": `Novabot/${VERSION}`,
          "content-type": "application/json", accept: "text/event-stream",
        },
        body: JSON.stringify({ store: false, stream: true, ...body }),
        signal: AbortSignal.timeout(240_000),
      });
      this.recordQuota(r.headers);
      if (r.status === 401 && attempt === 0) { await onUnauthorized(creds); creds = await getCodexCreds(); continue; }
      if (!r.ok || !r.body) {
        const t = await r.text().catch(() => "");
        throw new ProviderError(`Codex HTTP ${r.status}: ${t.slice(0, 300)}`, "codex", r.status === 429 || r.status >= 500 || r.status === 401, r.status);
      }
      let text = ""; const items: any[] = [];
      for await (const ev of parseSSE(r.body)) {
        let d: any; try { d = JSON.parse(ev.data); } catch { continue; }
        const type = d.type ?? ev.event;
        if (type === "response.output_text.delta") { text += d.delta; onDelta?.(d.delta); }
        else if (type === "response.output_item.done") items.push(d.item);
        else if (type === "response.failed" || type === "error") throw new ProviderError(`Codex : ${JSON.stringify(d.response?.error ?? d.error ?? d).slice(0, 300)}`, "codex");
      }
      return { text, items };
    }
    throw new ProviderError("Codex : 401 persistant", "codex", true, 401);
  }

  private recordQuota(h: Headers) {
    if (!this.quota) return;
    const win = (prefix: string) => {
      const used = h.get(`x-codex-${prefix}-used-percent`); const minutes = Number(h.get(`x-codex-${prefix}-window-minutes`) ?? 0);
      if (used == null || !minutes) return;
      const resetAt = Number(h.get(`x-codex-${prefix}-reset-at`) ?? 0) * 1000 || null;
      const window = minutes <= 300 ? "5h" : "7d";
      this.quota!("codex", window, Number(used), resetAt);
    };
    win("primary"); win("secondary");
  }

  async complete(req: CompleteReq) {
    const tier = req.tier ?? "fast";
    const sys = (req.system ?? "Tu es un assistant précis.") + (req.json ? "\nRéponds UNIQUEMENT avec un objet JSON valide, sans texte autour." : "");
    const { text } = await this.respond({
      model: this.model(tier), instructions: sys, reasoning: { effort: EFFORT[tier] },
      input: toInput([{ role: "user", text: req.prompt }]),
    });
    return { text: text.trim(), model: this.model(tier) };
  }

  async agentTurn(req: AgentTurnReq): Promise<AgentTurnRes> {
    const model = this.model(req.tier);
    const input: any[] = toInput(req.history);
    const tools = toTools(req.tools);
    const calls: AgentTurnRes["toolCalls"] = [];
    let finalText = "";
    for (let step = 0; step < (req.maxSteps ?? 12); step++) {
      const { text, items } = await this.respond({
        model, instructions: req.system, input, reasoning: { effort: EFFORT[req.tier] },
        include: ["reasoning.encrypted_content"], ...(tools.length ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {}),
      }, req.onDelta);
      if (text) finalText += (finalText ? "\n\n" : "") + text;
      const fcs = items.filter((i) => i?.type === "function_call");
      if (!fcs.length) break;
      // rejouer les items de sortie (sans id : store=false) puis les résultats d'outils
      for (const it of items) {
        if (it.type === "reasoning") { if (it.encrypted_content) input.push({ type: "reasoning", summary: it.summary ?? [], encrypted_content: it.encrypted_content }); }
        else if (it.type === "function_call") input.push({ type: "function_call", call_id: it.call_id, name: it.name, arguments: it.arguments });
        else if (it.type === "message") input.push({ type: "message", role: "assistant", content: (it.content ?? []).map((c: any) => ({ type: "output_text", text: c.text ?? "" })) });
      }
      for (const fc of fcs) {
        let args: unknown = {}; try { args = JSON.parse(fc.arguments || "{}"); } catch { /* garde {} */ }
        req.onToolCall?.(fc.name, args);
        let out: string; let ok = true;
        try { const res = await req.runTool(fc.name, args); out = typeof res === "string" ? res : JSON.stringify(res); }
        catch (e: any) { ok = false; out = `Erreur : ${e?.message ?? e}`; }
        calls.push({ name: fc.name, input: args, ok });
        input.push({ type: "function_call_output", call_id: fc.call_id, output: clip(out, 20_000) });
      }
      if (step === (req.maxSteps ?? 12) - 1) finalText += "\n\n(J'ai atteint la limite d'étapes d'outils pour ce tour.)";
    }
    return { text: finalText.trim(), model, provider: "codex", toolCalls: calls };
  }
}
