import { homedir } from "node:os";
// Exécution de commandes externes (herdr, git, bash). Injectable pour les tests.
export interface ExecResult { code: number; stdout: string; stderr: string }
export interface ExecOpts { cwd?: string; timeoutMs?: number; env?: Record<string, string>; input?: string }
export type Exec = (cmd: string, args: string[], opts?: ExecOpts) => Promise<ExecResult>;

export const realExec: Exec = async (cmd, args, opts = {}) => {
  const p = Bun.spawn([cmd, ...args], {
    cwd: opts.cwd, stdout: "pipe", stderr: "pipe", stdin: opts.input ? "pipe" : "ignore",
    env: { ...process.env, PATH: `${process.env.HOME || homedir()}/.local/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ""}`, ...(opts.env ?? {}) },
  });
  if (opts.input && p.stdin) { (p.stdin as any).write(opts.input); (p.stdin as any).end(); }
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (opts.timeoutMs) timer = setTimeout(() => { try { p.kill(); } catch {} }, opts.timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (timer) clearTimeout(timer);
  return { code, stdout, stderr };
};

/** Extrait le premier objet JSON d'une sortie (herdr imprime du JSON ; erreurs JSON sur stderr). */
export function parseJson<T = any>(s: string): T | null {
  const t = s.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch {}
  const i = t.indexOf("{"); const j = t.lastIndexOf("}");
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch {} }
  return null;
}
