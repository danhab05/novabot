// Worktrees et état git des tâches. Jamais de travail sur main/master : chaque tâche a sa branche nb/<slug>.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, relative, join } from "node:path";
import type { Exec } from "./exec.ts";

export interface RepoInfo { top: string; branch: string; head: string }

export async function repoInfo(exec: Exec, path: string): Promise<RepoInfo | null> {
  if (!path || !existsSync(path)) return null;
  const top = await exec("git", ["-C", path, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return null;
  const t = top.stdout.trim();
  if (t === "/root" || t === "/") return null; // jamais de worktree sur le home entier
  const br = await exec("git", ["-C", t, "rev-parse", "--abbrev-ref", "HEAD"]);
  const head = await exec("git", ["-C", t, "rev-parse", "HEAD"]);
  if (head.code !== 0) return null; // dépôt sans commit
  return { top: t, branch: br.stdout.trim(), head: head.stdout.trim() };
}

export const slugify = (s: string, max = 40) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "") || "tache";

/** Crée (ou réutilise) le worktree de la tâche. Retourne le cwd équivalent au dossier projet dans le worktree. */
export async function ensureWorktree(exec: Exec, o: { repo: RepoInfo; projectPath: string; wtPath: string; branch: string }): Promise<{ cwd: string; created: boolean }> {
  const rel = relative(o.repo.top, o.projectPath);
  const cwd = rel ? join(o.wtPath, rel) : o.wtPath;
  if (existsSync(o.wtPath)) return { cwd, created: false };
  mkdirSync(dirname(o.wtPath), { recursive: true });
  const exists = (await exec("git", ["-C", o.repo.top, "rev-parse", "--verify", "--quiet", `refs/heads/${o.branch}`])).code === 0;
  const args = exists ? ["-C", o.repo.top, "worktree", "add", o.wtPath, o.branch] : ["-C", o.repo.top, "worktree", "add", "-b", o.branch, o.wtPath, o.repo.head];
  const r = await exec("git", args);
  if (r.code !== 0) throw new Error(`git worktree add : ${r.stderr.trim().slice(0, 300)}`);
  return { cwd, created: true };
}

export async function gitSummary(exec: Exec, wt: string, base: string): Promise<string> {
  const [log, stat, st] = await Promise.all([
    exec("git", ["-C", wt, "log", "--oneline", `${base}..HEAD`]),
    exec("git", ["-C", wt, "diff", "--stat", `${base}...HEAD`]),
    exec("git", ["-C", wt, "status", "--porcelain"]),
  ]);
  return [`commits depuis la base :\n${log.stdout.trim() || "(aucun)"}`, `diff --stat :\n${stat.stdout.trim() || "(vide)"}`, `non commité :\n${st.stdout.trim() || "(rien)"}`].join("\n");
}

/** La branche de la tâche est-elle intégrée dans la branche de base ? */
export async function isMerged(exec: Exec, top: string, branch: string, baseBranch: string): Promise<boolean> {
  if (!baseBranch || baseBranch === "HEAD") return false;
  const head = await exec("git", ["-C", top, "rev-parse", branch]);
  const base = await exec("git", ["-C", top, "rev-parse", baseBranch]);
  if (head.code || base.code) return false;
  // une branche sans commit propre (head == base de départ) n'est pas « mergée » : rien à intégrer
  return (await exec("git", ["-C", top, "merge-base", "--is-ancestor", branch, baseBranch])).code === 0;
}

/** Supprime le worktree s'il est propre (jamais --force). */
export async function removeWorktree(exec: Exec, top: string, wtPath: string): Promise<boolean> {
  if (!existsSync(wtPath)) return true;
  return (await exec("git", ["-C", top, "worktree", "remove", wtPath])).code === 0;
}
