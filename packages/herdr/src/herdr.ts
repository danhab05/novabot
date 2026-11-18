// Client minimal de la CLI herdr 0.8.0 (protocole 19). Formats vérifiés :
// list/get/create/start/wait → JSON {result:…} ; pane read / agent read → texte brut ;
// erreurs serveur → JSON sur stderr + exit 1 ; erreurs de syntaxe → exit 2.
import { type Exec, parseJson } from "./exec.ts";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";
export interface HerdrAgent {
  agent: string; agent_status: AgentStatus; pane_id: string; workspace_id: string; tab_id: string; cwd: string;
  name?: string; revision?: number; state_change_seq?: number; agent_session?: { value?: string } | null;
}
export interface HerdrWorkspace { workspace_id: string; label: string; pane_count: number; agent_status?: string }

export class HerdrError extends Error {
  constructor(msg: string, public code: number, public stderr: string) { super(msg); }
  get kind(): string { return (parseJson<any>(this.stderr)?.error?.code as string) ?? (this.stderr.match(/agent_prompt_stalled|not_found|timeout/)?.[0] ?? "error"); }
}

export class Herdr {
  constructor(private exec: Exec, private bin = "herdr") {}

  private async run(args: string[], timeoutMs = 60_000): Promise<string> {
    const r = await this.exec(this.bin, args, { timeoutMs });
    if (r.code !== 0) throw new HerdrError(`herdr ${args.slice(0, 2).join(" ")} → exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 400)}`, r.code, r.stderr || r.stdout);
    return r.stdout;
  }
  private async json(args: string[], timeoutMs?: number): Promise<any> {
    const out = await this.run(args, timeoutMs);
    const j = parseJson<any>(out);
    if (!j) throw new HerdrError(`herdr ${args.slice(0, 2).join(" ")} : sortie non JSON`, 0, out);
    return j.result ?? j;
  }

  async serverRunning(): Promise<boolean> {
    const r = await this.exec(this.bin, ["status", "server"], { timeoutMs: 15_000 });
    return r.code === 0 && !/not running|stopped/i.test(r.stdout);
  }
  async workspaces(): Promise<HerdrWorkspace[]> { return (await this.json(["workspace", "list"])).workspaces ?? []; }
  async workspaceCreate(o: { cwd: string; label: string; env?: Record<string, string> }): Promise<{ workspaceId: string; paneId: string }> {
    const r = await this.json(["workspace", "create", "--cwd", o.cwd, "--label", o.label, ...envArgs(o.env), "--no-focus"]);
    return { workspaceId: r.workspace?.workspace_id, paneId: r.root_pane?.pane_id };
  }
  async tabCreate(o: { workspaceId: string; cwd: string; label: string; env?: Record<string, string> }): Promise<{ paneId: string; tabId: string }> {
    const r = await this.json(["tab", "create", "--workspace", o.workspaceId, "--cwd", o.cwd, "--label", o.label, ...envArgs(o.env), "--no-focus"]);
    return { paneId: r.root_pane?.pane_id, tabId: r.tab?.tab_id };
  }
  async panes(workspaceId?: string): Promise<{ pane_id: string; workspace_id: string }[]> {
    return (await this.json(["pane", "list", ...(workspaceId ? ["--workspace", workspaceId] : [])])).panes ?? [];
  }
  /** Le shell du panneau est-il libre (aucun processus au premier plan autre que le shell) ? */
  async shellReady(paneId: string): Promise<boolean> {
    const r = await this.exec(this.bin, ["pane", "process-info", "--pane", paneId], { timeoutMs: 15_000 });
    if (r.code !== 0) return false;
    const pi = parseJson<any>(r.stdout)?.result?.process_info;
    if (!pi?.shell_pid) return false;
    const fg: any[] = pi.foreground_processes ?? [];
    return fg.every((p) => p.pid === pi.shell_pid) || pi.foreground_process_group_id === pi.shell_pid;
  }
  async workspaceClose(workspaceId: string) { await this.run(["workspace", "close", workspaceId]); }
  async paneClose(paneId: string) { await this.run(["pane", "close", paneId]); }
  async paneRead(paneId: string, lines = 120): Promise<string> { return this.run(["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)]); }

  async agents(): Promise<HerdrAgent[]> { return (await this.json(["agent", "list"])).agents ?? []; }
  async agentGet(target: string): Promise<HerdrAgent | null> {
    try { return (await this.json(["agent", "get", target])).agent ?? null; }
    catch (e) { if (e instanceof HerdrError) return null; throw e; }
  }
  async agentRead(target: string, lines = 120, source: "recent-unwrapped" | "visible" = "recent-unwrapped"): Promise<string> {
    return this.run(["agent", "read", target, "--source", source, "--lines", String(lines)]);
  }
  async agentStart(o: { name: string; kind: "claude" | "codex"; paneId: string; args: string[]; timeoutMs?: number }): Promise<HerdrAgent | null> {
    const t = o.timeoutMs ?? 90_000;
    const r = await this.json(["agent", "start", o.name, "--kind", o.kind, "--pane", o.paneId, "--timeout", String(t), "--", ...o.args], t + 15_000);
    return r.agent ?? null;
  }
  async agentSendKeys(target: string, keys: string[]) { await this.run(["agent", "send-keys", target, ...keys], 15_000); }
  /** Envoie un prompt (texte + Entrée). Pas de --wait : le suivi est fait par wait(). */
  async agentPrompt(target: string, text: string) { await this.run(["agent", "prompt", target, text], 30_000); }
  /** Attente bornée d'un état stable (idle/done/blocked), ou de `until`. Retourne l'agent ou null si timeout. */
  async agentWait(target: string, timeoutMs: number, until?: AgentStatus): Promise<HerdrAgent | null> {
    const r = await this.exec(this.bin, ["agent", "wait", target, ...(until ? ["--until", until] : []), "--timeout", String(timeoutMs)], { timeoutMs: timeoutMs + 30_000 });
    if (r.code !== 0) return null;
    const j = parseJson<any>(r.stdout);
    return j?.result?.agent ?? null;
  }
}

function envArgs(env?: Record<string, string>): string[] {
  return Object.entries(env ?? {}).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
}
