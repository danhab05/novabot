// Fausse CLI herdr (état en mémoire) pour tester la machine à états sans lancer de vrais agents.
import type { Exec, ExecResult } from "../src/exec.ts";
import { realExec } from "../src/exec.ts";

export interface FakeAgent { name: string; kind: string; pane: string; ws: string; status: string; output: string; args: string[]; cwd: string; session: string; prompts: string[] }
export type Behavior = (a: FakeAgent, prompt: string, fake: FakeHerdr) => void | Promise<void>;

export class FakeHerdr {
  workspaces: { workspace_id: string; label: string; env: Record<string, string>; cwd: string }[] = [];
  panes = new Map<string, { ws: string; cwd: string; env: Record<string, string> }>();
  agents = new Map<string, FakeAgent>();
  calls: string[][] = [];
  mcpConfigs: any[] = [];
  serverUp = true;
  quotaLines = "claude five_hour 10 0 1\nclaude seven_day 10 0 1\ncodex primary_300min 10 0 1\n";
  private n = 0;
  constructor(public behavior: Behavior) {}

  exec: Exec = async (cmd, args, opts) => {
    if (cmd === "herdr") { this.calls.push(args); return this.handle(args); }
    if (cmd === "bash" && args[0]?.includes("limits.sh")) return ok(this.quotaLines);
    if (cmd === "bash" && args[1]?.includes("herdr server")) { this.serverUp = true; return ok(""); }
    return realExec(cmd, args, opts);
  };

  private flag(args: string[], f: string) { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; }
  private envs(args: string[]) { const e: Record<string, string> = {}; args.forEach((a, i) => { if (a === "--env") { const [k, ...v] = args[i + 1].split("="); e[k] = v.join("="); } }); return e; }
  private agentJson(a: FakeAgent) {
    return { agent: a.kind, name: a.name, agent_status: a.status, pane_id: a.pane, workspace_id: a.ws, tab_id: a.pane + ":t", cwd: a.cwd, agent_session: { value: a.session } };
  }
  find(target: string) { return this.agents.get(target) ?? [...this.agents.values()].find((a) => a.pane === target); }

  private async handle(args: string[]): Promise<ExecResult> {
    const [g, c, ...rest] = args;
    const key = `${g} ${c}`;
    if (g === "status") return this.serverUp ? ok("status: running\n") : { code: 1, stdout: "", stderr: "server not running" };
    switch (key) {
      case "workspace list": return json({ workspaces: this.workspaces.map((w) => ({ workspace_id: w.workspace_id, label: w.label, pane_count: [...this.panes.values()].filter((p) => p.ws === w.workspace_id).length })) });
      case "workspace create": {
        const id = `w${++this.n}`, pane = `${id}:p1`;
        const env = this.envs(rest);
        this.workspaces.push({ workspace_id: id, label: this.flag(rest, "--label")!, env, cwd: this.flag(rest, "--cwd")! });
        this.panes.set(pane, { ws: id, cwd: this.flag(rest, "--cwd")!, env });
        return json({ workspace: { workspace_id: id }, tab: { tab_id: `${id}:t1` }, root_pane: { pane_id: pane } });
      }
      case "workspace close": {
        const id = rest[0]; this.workspaces = this.workspaces.filter((w) => w.workspace_id !== id);
        for (const [k, p] of this.panes) if (p.ws === id) this.panes.delete(k);
        return json({});
      }
      case "tab create": {
        const ws = this.flag(rest, "--workspace")!; const pane = `${ws}:p${++this.n}`;
        this.panes.set(pane, { ws, cwd: this.flag(rest, "--cwd")!, env: this.envs(rest) });
        return json({ tab: { tab_id: pane + ":t" }, root_pane: { pane_id: pane } });
      }
      case "pane close": {
        const p = rest[0]; this.panes.delete(p);
        for (const [n, a] of this.agents) if (a.pane === p) this.agents.delete(n);
        return json({});
      }
      case "pane process-info": return json({ process_info: { shell_pid: 1, foreground_process_group_id: 1, foreground_processes: [{ pid: 1, name: "bash" }] } });
      case "pane list": return json({ panes: [...this.panes.entries()].map(([pane_id, p]) => ({ pane_id, workspace_id: p.ws })) });
      case "agent list": return json({ agents: [...this.agents.values()].map((a) => this.agentJson(a)) });
      case "agent get": { const a = this.find(rest[0]); return a ? json({ agent: this.agentJson(a) }) : err("not_found"); }
      case "agent start": {
        const name = rest[0]; const pane = this.flag(rest, "--pane")!; const p = this.panes.get(pane);
        if (!p) return err("pane_not_found");
        const dd = rest.indexOf("--");
        const resumeIdx = rest.indexOf("--resume");
        const a: FakeAgent = { name, kind: this.flag(rest, "--kind")!, pane, ws: p.ws, status: "idle", output: "", args: rest.slice(dd + 1), cwd: p.cwd, session: resumeIdx >= 0 ? rest[resumeIdx + 1] : `sess-${name}`, prompts: [] };
        const mi = a.args.indexOf("--mcp-config");
        if (mi >= 0) this.mcpConfigs.push(JSON.parse(await Bun.file(a.args[mi + 1]).text()));
        this.agents.set(name, a);
        return json({ agent: this.agentJson(a) });
      }
      case "agent send-keys": return json({});
      case "agent read": { const a = this.find(rest[0]); return a ? ok(a.output) : err("not_found"); }
      case "agent prompt": {
        const a = this.find(rest[0]); if (!a) return err("not_found");
        a.prompts.push(rest[1]); a.status = "working";
        await this.behavior(a, rest[1], this);
        return json({});
      }
      case "agent wait": {
        const a = this.find(rest[0]); if (!a) return err("not_found");
        if (rest.includes("--until")) return json({ agent: this.agentJson(a) });
        for (let i = 0; i < 50 && a.status === "working"; i++) await Bun.sleep(5);
        return json({ agent: this.agentJson(a) });
      }
    }
    return { code: 2, stdout: "", stderr: `fake: commande non gérée ${args.join(" ")}` };
  }
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "" });
const json = (result: unknown): ExecResult => ok(JSON.stringify({ id: "fake", result }));
const err = (code: string): ExecResult => ({ code: 1, stdout: "", stderr: JSON.stringify({ error: { code, message: code } }) });
