import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, lstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateManifest } from "../src/manifest.ts";
import { scanSecrets } from "../src/secrets-scan.ts";
import { encryptJson, decryptJson } from "../src/crypto.ts";
import { defaultPaths, type Runner } from "../src/paths.ts";
import { installSkill, uninstallSkill, installMcp, uninstallMcp, appendSecrets } from "../src/install.ts";
import { scanSources, findSkillDirs } from "../src/sources.ts";
import { textFromMime, dayBounds, runGhReadOnly } from "../src/integrations.ts";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "nbcat-")); });
afterEach(() => rmSync(home, { recursive: true, force: true }));
const P = () => defaultPaths({ home, secretsFile: join(home, ".novabot/secrets.env"), openbotSkills: join(home, "openbot-skills") });

const skill = (over: any = {}) => validateManifest({ id: "skill-demo", type: "skill", name: "demo", version: "1.0.0", description: "d", skill: { files: { "SKILL.md": "---\nname: demo\n---\nx", "scripts/a.sh": "echo a" } }, ...over });

// ---------------- manifeste ----------------
test("manifeste valide : skill, mcp, agent", () => {
  expect(skill().id).toBe("skill-demo");
  expect(validateManifest({ id: "mcp-x", type: "mcp", name: "X", version: "1.2.3", description: "d", mcp: { command: "npx", args: ["-y", "x"] } }).mcp!.args).toEqual(["-y", "x"]);
  expect(validateManifest({ id: "agent-x", type: "agent", name: "X", version: "1.0.0", description: "d", agent: { instructions: "fais", defaultAgent: "codex" } }).agent!.defaultAgent).toBe("codex");
});
test("manifeste invalide : chemins, types, champs inconnus ignorés", () => {
  expect(() => skill({ skill: { files: { "SKILL.md": "x", "../evil": "y" } } })).toThrow(/chemin interdit/);
  expect(() => skill({ skill: { files: { "a.md": "x" } } })).toThrow(/SKILL.md requis/);
  expect(() => validateManifest({ id: "Bad Id", type: "zzz", name: "", version: "1", description: "" })).toThrow(/id[\s\S]*type[\s\S]*version/);
  expect(() => validateManifest({ id: "mcp-x", type: "mcp", name: "X", version: "1.0.0", description: "d", mcp: { command: "rm -rf /" } })).toThrow(/commande simple/);
  expect(() => validateManifest({ id: "mcp-x", type: "mcp", name: "X", version: "1.0.0", description: "d", mcp: { url: "http://x" } })).toThrow(/https/);
  const m: any = validateManifest({ id: "agent-x", type: "agent", name: "X", version: "1.0.0", description: "d", agent: { instructions: "i" }, evil: "<script>" });
  expect(m.evil).toBeUndefined();
});

// ---------------- secrets ----------------
test("scan de secrets : détecte clés, jetons, mots de passe, emails, chemins", () => {
  const f = scanSecrets({
    a: "clé sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ", b: "stripe sk_live_51Habcdefghijkl", c: "ghp_abcdefghijklmnopqrstuvwxyz0123",
    d: "password: hunter2hunter", e: "écris à alice.perso@gmail.com", f: "voir /home/alice/.secrets/mots-de-passe.txt", g: "-----BEGIN OPENSSH PRIVATE KEY-----",
    h: "ssh root@203.0.113.7",
  });
  const kinds = new Set(f.map((x) => x.kind));
  for (const k of ["clé OpenAI/Anthropic", "clé Stripe", "jeton GitHub", "mot de passe en clair", "adresse e-mail", "chemin de secrets", "clé privée", "adresse IP publique"]) expect(kinds.has(k)).toBe(true);
  expect(f.every((x) => !x.excerpt.includes("hunter2hunter"))).toBe(true); // l'extrait ne recopie pas le secret
});
test("scan de secrets : manifeste propre = aucune trouvaille", () => {
  expect(scanSecrets(skill())).toEqual([]);
  expect(scanSecrets({ x: "contact@example.com, réseau 192.168.1.10, 127.0.0.1" })).toEqual([]);
});

// ---------------- chiffrement ----------------
test("chiffrement AES-GCM : aller-retour, IV aléatoire, mauvaise clé refusée", async () => {
  const data = { access_token: "ya29.secret", refresh_token: "1//r" };
  const a = await encryptJson("k1", data), b = await encryptJson("k1", data);
  expect(a).not.toBe(b);
  expect(a.includes("ya29")).toBe(false);
  expect(await decryptJson("k1", a)).toEqual(data);
  await expect(decryptJson("k2", a)).rejects.toThrow();
  await expect(encryptJson("", data)).rejects.toThrow(/NOVABOT_INTERNAL_TOKEN/);
});

// ---------------- skills ----------------
test("install/uninstall d'un skill dans un HOME temporaire + lien Codex", () => {
  const p = P();
  mkdirSync(p.codexSkills, { recursive: true });
  const d = installSkill(p, skill());
  expect(readFileSync(join(home, ".claude/skills/demo/SKILL.md"), "utf8")).toContain("name: demo");
  expect(existsSync(join(home, ".claude/skills/demo/scripts/a.sh"))).toBe(true);
  expect(lstatSync(join(p.codexSkills, "demo")).isSymbolicLink()).toBe(true);
  expect(() => installSkill(p, skill())).toThrow(/existe déjà/);
  uninstallSkill(p, d);
  expect(existsSync(join(home, ".claude/skills/demo"))).toBe(false);
  expect(existsSync(join(p.codexSkills, "demo"))).toBe(false);
});
test("uninstall refuse un dossier hors de ~/.claude/skills", () => {
  expect(() => uninstallSkill(P(), { kind: "skill", dir: "/etc", codexLink: null })).toThrow(/refus/);
});
test("scan des sources : skills Claude + Hermes récursif (hors .archive) + registre", () => {
  const p = P();
  for (const [dir, name] of [[".claude/skills/a", "a"], [".hermes/skills/cat/b", "b"], [".hermes/skills/.archive/c", "c"]]) {
    mkdirSync(join(home, dir), { recursive: true });
    writeFileSync(join(home, dir, "SKILL.md"), `---\nname: ${name}\ndescription: skill ${name}\n---\n`);
  }
  expect(findSkillDirs(p.hermesSkills, true).map((d) => d.split("/").pop())).toEqual(["b"]);
  const items = scanSources(p, () => false);
  const ids = items.map((i) => i.manifest.id);
  expect(ids).toContain("skill-a");
  expect(ids).toContain("hermes-b");
  expect(ids).not.toContain("hermes-c");
  expect(ids).toContain("mcp-coolify");
  expect(ids).toContain("agent-seo");
  expect(items.find((i) => i.manifest.id === "skill-a")!.installed).toBe(true);
});

// ---------------- MCP + secrets ----------------
test("install/uninstall MCP : claude mcp add + bloc config.toml balisé, rien d'autre touché", async () => {
  const p = P();
  mkdirSync(join(home, ".codex"), { recursive: true });
  const original = '[mcp_servers.browser]\ncommand = "npx"\n\n[other]\nx = 1\n';
  writeFileSync(p.codexConfig, original);
  const calls: string[][] = [];
  const run: Runner = async (cmd) => { calls.push(cmd); return { code: 0, stdout: "", stderr: "" }; };
  const m = validateManifest({ id: "mcp-stripe", type: "mcp", name: "Stripe", version: "1.0.0", description: "d", secrets: [{ key: "STRIPE_SECRET_KEY", label: "k" }], mcp: { command: "npx", args: ["-y", "@stripe/mcp"] } });
  await expect(installMcp(p, run, m, {})).rejects.toThrow(/STRIPE_SECRET_KEY/);
  const d = await installMcp(p, run, m, { STRIPE_SECRET_KEY: "rk_test_abc" });
  expect(d.secretsAdded).toEqual(["STRIPE_SECRET_KEY"]);
  expect((statSync(p.secretsFile).mode & 0o777).toString(8)).toBe("600");
  expect(calls[0].slice(0, 5)).toEqual(["claude", "mcp", "add", "--scope", "user"]);
  expect(calls[0].join(" ")).not.toContain("rk_test_abc"); // le secret ne passe pas en argument
  const toml = readFileSync(p.codexConfig, "utf8");
  expect(toml).toContain("[mcp_servers.stripe]");
  expect(toml).toContain("with-secrets.sh");
  await uninstallMcp(p, run, d);
  expect(calls.at(-1)).toEqual(["claude", "mcp", "remove", "--scope", "user", "stripe"]);
  expect(readFileSync(p.codexConfig, "utf8").trim()).toBe(original.trim());
  expect(readFileSync(p.secretsFile, "utf8")).toContain("STRIPE_SECRET_KEY="); // secret conservé
});
test("MCP déjà présent dans la config Codex : pas de doublon", async () => {
  const p = P();
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(p.codexConfig, '[mcp_servers.browser]\ncommand = "npx"\n');
  const run: Runner = async () => ({ code: 0, stdout: "", stderr: "" });
  const m = validateManifest({ id: "mcp-browser", type: "mcp", name: "B", version: "1.0.0", description: "d", mcp: { command: "npx" } });
  const d = await installMcp(p, run, m);
  expect(d.codexAdded).toBe(false);
});
test("appendSecrets n'écrase jamais une clé existante", () => {
  const f = join(home, "s.env");
  writeFileSync(f, "A_KEY=old\n");
  expect(appendSecrets(f, { A_KEY: "new", B_KEY: "v w" })).toEqual(["B_KEY"]);
  const s = readFileSync(f, "utf8");
  expect(s).toContain("A_KEY=old");
  expect(s).toContain("B_KEY='v w'");
  expect(() => appendSecrets(f, { C: "x\ny" })).toThrow();
});

// ---------------- helpers d'intégration ----------------
test("MIME : extraction texte (quoted-printable)", () => {
  const src = 'Content-Type: multipart/alternative; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nBonjour =C3=A9t=C3=A9\r\n--b--';
  expect(textFromMime(src)).toContain("Bonjour été");
});
test("bornes du jour à Paris", () => {
  const { start, end } = dayBounds("Europe/Paris", new Date("2026-11-18T12:00:00Z"));
  expect(start).toBe("2026-11-17T23:00:00.000Z");
  expect(end).toBe("2026-11-18T23:00:00.000Z");
});
test("gh : lecture seule", async () => {
  const fake: any = { d: { run: async () => ({ code: 0, stdout: "ok", stderr: "" }) } };
  expect(await runGhReadOnly(fake, ["pr", "list"])).toBe("ok");
  await expect(runGhReadOnly(fake, ["pr", "merge", "1"])).rejects.toThrow(/non autorisé/);
  await expect(runGhReadOnly(fake, ["api", "-X", "DELETE", "repos/x"])).rejects.toThrow(/GET/);
  await expect(runGhReadOnly(fake, ["api", "repos/x", "-f", "a=b"])).rejects.toThrow(/GET/);
});
