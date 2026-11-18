// Chemins injectables (tests : HOME temporaire, jamais le vrai ~/.claude).
import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  home: string;
  claudeSkills: string;
  codexSkills: string;
  codexConfig: string;
  /** Sources de skills importables (optionnelles, ignorées si absentes). */
  hermesSkills: string;
  openbotSkills: string;
  /** Dossiers de skills supplémentaires (NOVABOT_SKILL_DIRS, séparés par « : »). */
  extraSkills: string[];
  secretsFile: string;
  registryDir: string;
}

export function defaultPaths(over: Partial<Paths> = {}): Paths {
  const testHome = process.env.NOVABOT_CATALOG_HOME;
  const home = over.home ?? testHome ?? process.env.HOME ?? homedir();
  const e = (k: string) => (testHome ? undefined : process.env[k]);
  return {
    home,
    claudeSkills: e("NOVABOT_CLAUDE_SKILLS_DIR") ?? join(home, ".claude/skills"),
    codexSkills: e("NOVABOT_CODEX_SKILLS_DIR") ?? join(home, ".codex/skills"),
    codexConfig: join(home, ".codex/config.toml"),
    hermesSkills: e("NOVABOT_IMPORT_HERMES_SKILLS") ?? join(e("NOVABOT_IMPORT_HERMES_DIR") ?? join(home, ".hermes"), "skills"),
    openbotSkills: testHome ? join(home, "openbot-skills") : process.env.NOVABOT_IMPORT_OPENBOT_SKILLS ?? "",
    extraSkills: (e("NOVABOT_SKILL_DIRS") ?? "").split(":").filter(Boolean),
    secretsFile: process.env.NOVABOT_SECRETS ?? join(process.env.NOVABOT_DATA ?? join(home, ".novabot"), "secrets.env"),
    registryDir: new URL("../registry", import.meta.url).pathname,
    ...over,
  };
}

/** Exécuteur de commandes injectable (tests : faux exécuteur). */
export type Runner = (cmd: string[], opts?: { env?: Record<string, string> }) => Promise<{ code: number; stdout: string; stderr: string }>;
export const realRunner: Runner = async (cmd, opts = {}) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...(opts.env ?? {}) } });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
};
