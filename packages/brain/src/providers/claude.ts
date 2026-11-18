// Fournisseur Claude via l'abonnement, UNIQUEMENT par la CLI officielle `claude -p` (jamais l'OAuth en direct).
// Les outils Novabot passent par le serveur MCP novabot (packages/mcp) → daemon → registre d'outils.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, NOVA_DIR } from "../util.ts";
import type { Provider, Tier, CompleteReq, AgentTurnReq, AgentTurnRes, QuotaSink } from "./types.ts";
import { ProviderError } from "./types.ts";

const MODELS: Record<Tier, string> = { fast: "haiku", reason: "sonnet", critical: "opus" };
const MCP_ENTRY = new URL("../../../mcp/src/index.ts", import.meta.url).pathname;

export interface ClaudeOpts { daemonUrl: string; internalToken: string; quota?: QuotaSink; withBrowser?: boolean }

interface RunRes { text: string; toolCalls: AgentTurnRes["toolCalls"]; isError: boolean; error?: string }

export class ClaudeProvider implements Provider {
  id = "claude" as const;
  constructor(private o: ClaudeOpts) {}
  model(tier: Tier) { return MODELS[tier]; }

  async available() {
    const p = Bun.spawnSync(["claude", "--version"], { stdout: "pipe", stderr: "pipe" });
    return p.exitCode === 0 ? { ok: true } : { ok: false, reason: "CLI claude introuvable" };
  }

  private mcpConfig(env: Record<string, string>): string {
    const dir = join(NOVA_DIR, "tmp"); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const servers: Record<string, unknown> = {
      novabot: { type: "stdio", command: "bun", args: [MCP_ENTRY], env: { NOVABOT_URL: this.o.daemonUrl, NOVABOT_INTERNAL_TOKEN: this.o.internalToken, ...env } },
    };
    if (this.o.withBrowser !== false) servers.browser = { type: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest", "--cdp-endpoint", process.env.NOVABOT_CDP_URL ?? "http://127.0.0.1:9222", "--output-dir", process.env.NOVABOT_PLAYWRIGHT_OUTPUT_DIR ?? join(HOME, ".playwright-mcp")] };
    const f = join(dir, `mcp-${crypto.randomUUID()}.json`);
    writeFileSync(f, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
    return f;
  }

  private async run(args: string[], userContent: unknown[], onDelta?: (t: string) => void, onTool?: (n: string, i: unknown) => void, timeoutMs = 300_000): Promise<RunRes> {
    const p = Bun.spawn(["claude", "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages",
      "--no-session-persistence", "--setting-sources", "", ...args], {
      cwd: NOVA_DIR, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { ...process.env, IS_SANDBOX: "1" },
    });
    p.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: userContent } }) + "\n");
    p.stdin.end();
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const res: RunRes = { text: "", toolCalls: [], isError: false };
    let streamed = "";
    const reader = p.stdout.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let d: any; try { d = JSON.parse(line); } catch { continue; }
        if (d.type === "stream_event") {
          const ev = d.event;
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") { streamed += ev.delta.text; onDelta?.(ev.delta.text); }
          else if (ev?.type === "message_start" && streamed && !streamed.endsWith("\n\n")) { streamed += "\n\n"; onDelta?.("\n\n"); }
        } else if (d.type === "assistant") {
          for (const b of d.message?.content ?? []) if (b.type === "tool_use") { const n = String(b.name).replace(/^mcp__novabot__/, ""); res.toolCalls.push({ name: n, input: b.input, ok: true }); onTool?.(n, b.input); }
        } else if (d.type === "rate_limit_event") {
          const w = d.rate_limit_info?.unifiedWindows ?? {};
          if (w.five_hour) this.o.quota?.("claude", "5h", Math.round(w.five_hour.utilization * 100), (w.five_hour.resetsAt ?? 0) * 1000 || null);
          if (w.seven_day) this.o.quota?.("claude", "7d", Math.round(w.seven_day.utilization * 100), (w.seven_day.resetsAt ?? 0) * 1000 || null);
        } else if (d.type === "result") {
          res.isError = !!d.is_error; res.text = typeof d.result === "string" ? d.result : streamed;
          if (d.is_error) res.error = String(d.result ?? d.subtype);
        }
      }
      if (done) break;
    }
    clearTimeout(timer);
    const code = await p.exited;
    if (!res.text && streamed) res.text = streamed;
    if (code !== 0 && !res.text) {
      const err = await new Response(p.stderr).text();
      throw new ProviderError(`claude -p a échoué (code ${code}) : ${err.slice(0, 300)}`, "claude", true);
    }
    if (res.isError) {
      const limited = /limit|quota|rate/i.test(res.error ?? "");
      throw new ProviderError(`Claude : ${res.error?.slice(0, 300)}`, "claude", limited || true);
    }
    return res;
  }

  async complete(req: CompleteReq) {
    const tier = req.tier ?? "fast";
    const sys = (req.system ?? "Tu es un assistant précis.") + (req.json ? "\nRéponds UNIQUEMENT avec un objet JSON valide, sans texte autour." : "");
    const r = await this.run(["--model", MODELS[tier], "--tools", "", "--strict-mcp-config", "--system-prompt", sys], [{ type: "text", text: req.prompt }], undefined, undefined, 180_000);
    return { text: r.text.trim(), model: MODELS[tier] };
  }

  async agentTurn(req: AgentTurnReq): Promise<AgentTurnRes> {
    const model = MODELS[req.tier];
    const tc = req.toolCtx;
    const cfg = this.mcpConfig({ ...(tc.projectId ? { NOVA_PROJECT_ID: tc.projectId } : {}), ...(tc.threadId ? { NOVA_THREAD_ID: tc.threadId } : {}) });
    // Historique (hors dernier message) aplati dans le prompt : la CLI est sans état ici.
    const prev = req.history.slice(0, -1).map((m) => `${m.role === "user" ? "Utilisateur" : "Novabot"} : ${m.text}`).join("\n\n");
    const last = req.history[req.history.length - 1];
    const content: unknown[] = [
      { type: "text", text: (prev ? `<historique>\n${prev}\n</historique>\n\n` : "") + (last?.text ?? "") },
      ...(last?.images ?? []).map((i) => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.dataBase64 } })),
    ];
    const allowed = ["mcp__novabot__*", ...(this.o.withBrowser !== false ? ["mcp__browser__*"] : [])];
    const r = await this.run(["--model", model, "--tools", "", "--mcp-config", cfg, "--strict-mcp-config", "--allowedTools", ...allowed,
      "--permission-mode", "bypassPermissions", "--system-prompt", req.system, "--max-turns", String(req.maxSteps ?? 12)], content, req.onDelta, req.onToolCall);
    return { text: r.text.trim(), model, provider: "claude", toolCalls: r.toolCalls };
  }
}
