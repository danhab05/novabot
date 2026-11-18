// Module « sessions » : les sessions Claude Code / Codex ouvertes dans Herdr, rattachées à un projet
// par leur dossier de travail. La PWA les affiche en terminal live (xterm.js) et peut y écrire.
// Lecture seule par défaut : on n'envoie à une session que ce que le propriétaire tape lui-même. Admin uniquement.
import type { Module, Ctx } from "@novabot/daemon/core";
import { fromRow } from "@novabot/daemon/core";
import type { Project } from "@novabot/shared";
import { realExec, type Exec, parseJson } from "./exec.ts";

export interface SessionInfo {
  paneId: string; workspaceId: string; kind: string; name: string | null; status: string; cwd: string;
  title: string; novabot: boolean; sessionId: string | null; revision: number;
}

/** Le projet dont le chemin est le plus long préfixe du cwd. Un projet à la racine (/root) ne capte que le cwd exact. */
export function projectForCwd(projects: Pick<Project, "id" | "path">[], cwd: string): string | null {
  let best: { id: string; len: number } | null = null;
  for (const p of projects) {
    if (!p.path) continue;
    const base = p.path.replace(/\/+$/, "");
    const shallow = base.split("/").filter(Boolean).length <= 1; // /root, /opt…
    const hit = shallow ? cwd === base : cwd === base || cwd.startsWith(base + "/");
    if (hit && (!best || base.length > best.len)) best = { id: p.id, len: base.length };
  }
  return best?.id ?? null;
}

const KEY_RE = /^(enter|esc|tab|backspace|up|down|left|right|space|ctrl\+[a-z]|shift\+tab|pageup|pagedown|home|end)$/;

export function createSessionsModule(exec: Exec = realExec, bin = "herdr"): Module {
  const run = async (args: string[], timeoutMs = 20_000) => {
    const r = await exec(bin, args, { timeoutMs });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(0, 300) || `herdr exit ${r.code}`);
    return r.stdout;
  };

  async function listAll(ctx: Ctx): Promise<(SessionInfo & { projectId: string | null })[]> {
    const j = parseJson<any>(await run(["pane", "list"]));
    const panes: any[] = j?.result?.panes ?? [];
    // le nom de l'agent n'est donné que par `agent list`
    const names = new Map<string, string>();
    for (const a of parseJson<any>(await run(["agent", "list"]).catch(() => ""))?.result?.agents ?? []) if (a.name) names.set(a.pane_id, a.name);
    for (const p of panes) if (!p.name && names.has(p.pane_id)) p.name = names.get(p.pane_id);
    const projects = (ctx.db.query("SELECT id, path FROM projects").all() as any[]).map((r) => fromRow<Project>(r));
    return panes
      .filter((p) => p.agent) // seulement les panneaux qui hébergent un agent
      .map((p) => {
        const cwd = p.foreground_cwd || p.cwd || "";
        return {
          paneId: p.pane_id, workspaceId: p.workspace_id, kind: p.agent, name: p.name ?? null, status: p.agent_status ?? "unknown",
          cwd, title: p.terminal_title_stripped ?? "", novabot: /^nb-|^nbs-/.test(p.name ?? ""), sessionId: p.agent_session?.value ?? null,
          revision: p.revision ?? 0, projectId: projectForCwd(projects, cwd),
        };
      });
  }

  return {
    name: "sessions",
    init() {},
    routes(app, ctx) {
      const admin = (c: any) => c.get("user").role === "admin";

      app.get("/api/sessions", async (c) => {
        if (!admin(c)) return c.json({ error: "forbidden" }, 403);
        return c.json(await listAll(ctx));
      });

      app.get("/api/projects/:id/sessions", async (c) => {
        if (!admin(c)) return c.json({ error: "forbidden" }, 403);
        const kind = c.req.query("kind");
        const all = await listAll(ctx);
        return c.json(all.filter((s) => s.projectId === c.req.param("id") && (!kind || s.kind === kind)));
      });

      // Écran du panneau en ANSI (rendu par xterm.js côté PWA). source=visible : l'écran courant ; recent : historique.
      app.get("/api/sessions/:pane/screen", async (c) => {
        if (!admin(c)) return c.json({ error: "forbidden" }, 403);
        const pane = c.req.param("pane");
        const source = c.req.query("source") === "recent" ? "recent" : "visible";
        const lines = Math.min(Number(c.req.query("lines") ?? 200), 2000);
        try {
          const ansi = await run(["pane", "read", pane, "--source", source, "--lines", String(lines), "--format", "ansi"]);
          const meta = parseJson<any>(await run(["pane", "get", pane]))?.result?.pane ?? {};
          return c.json({ ansi, status: meta.agent_status ?? "unknown", title: meta.terminal_title_stripped ?? "", revision: meta.revision ?? 0, rows: meta.scroll?.viewport_rows ?? null });
        } catch (e: any) {
          return c.json({ error: String(e.message) }, 404);
        }
      });

      // Saisie : texte (sans Entrée) puis touches. submit=true ajoute Entrée.
      app.post("/api/sessions/:pane/input", async (c) => {
        if (!admin(c)) return c.json({ error: "forbidden" }, 403);
        const pane = c.req.param("pane");
        const b = await c.req.json<{ text?: string; keys?: string[]; submit?: boolean }>();
        const keys = [...(b.keys ?? []), ...(b.submit ? ["enter"] : [])].map((k) => k.toLowerCase());
        const bad = keys.find((k) => !KEY_RE.test(k));
        if (bad) return c.json({ error: `touche non autorisée: ${bad}` }, 400);
        try {
          if (b.text) await run(["pane", "send-text", pane, b.text]);
          if (keys.length) await run(["pane", "send-keys", pane, ...keys]);
          return c.json({ ok: true });
        } catch (e: any) {
          return c.json({ error: String(e.message) }, 400);
        }
      });

      // Nouvelle session interactive Claude Code / Codex sur le projet (skip-permissions / --yolo).
      app.post("/api/projects/:id/sessions", async (c) => {
        if (!admin(c)) return c.json({ error: "forbidden" }, 403);
        const p = fromRow<Project>(ctx.db.query("SELECT * FROM projects WHERE id = ?").get(c.req.param("id")));
        if (!p?.path) return c.json({ error: "projet sans dossier" }, 400);
        const b = await c.req.json<{ kind: "claude" | "codex" }>().catch(() => ({ kind: "claude" as const }));
        const kind = b.kind === "codex" ? "codex" : "claude";
        const name = `nbs-${p.id}-${kind}-${Date.now().toString(36).slice(-4)}`.slice(0, 32);
        try {
          const ws = parseJson<any>(await run(["workspace", "create", "--cwd", p.path, "--label", `nbs-${p.id}`, "--env", "IS_SANDBOX=1", "--no-focus"]))?.result;
          const paneId = ws?.root_pane?.pane_id;
          if (!paneId) throw new Error("workspace sans panneau");
          // attendre que le shell soit prêt (évite agent_pane_busy)
          for (let i = 0; i < 20; i++) {
            const pi = parseJson<any>(await run(["pane", "process-info", "--pane", paneId]).catch(() => ""))?.result?.process_info;
            if (pi?.shell_pid && (pi.foreground_process_group_id === pi.shell_pid || (pi.foreground_processes ?? []).every((x: any) => x.pid === pi.shell_pid))) break;
            await Bun.sleep(300);
          }
          const args = kind === "claude" ? ["--dangerously-skip-permissions"] : ["--yolo"];
          await run(["agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", "60000", "--", ...args], 90_000);
          return c.json({ paneId, name, kind });
        } catch (e: any) {
          return c.json({ error: String(e.message) }, 500);
        }
      });
    },
  };
}

export default createSessionsModule();
