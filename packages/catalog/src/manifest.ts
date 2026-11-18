import type { CatalogManifest } from "@novabot/shared";

const ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const VERSION = /^\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/;
const SECRET_KEY = /^[A-Z][A-Z0-9_]{1,63}$/;
const MAX_FILES = 50;
const MAX_TOTAL = 512 * 1024;

/** Validation stricte d'un manifeste (local ou distant). Lève une Error listant tous les problèmes. Ne retourne que les champs connus. */
export function validateManifest(input: unknown): CatalogManifest {
  const errs: string[] = [];
  const m = input as any;
  if (!m || typeof m !== "object" || Array.isArray(m)) throw new Error("manifeste : objet attendu");
  const str = (k: string, max = 200, req = true) => {
    if (m[k] === undefined && !req) return;
    if (typeof m[k] !== "string" || !m[k].trim() || m[k].length > max) errs.push(`${k} : texte requis (≤ ${max} car.)`);
  };
  if (typeof m.id !== "string" || !ID.test(m.id)) errs.push("id : [a-z0-9._-], 2 à 64 car.");
  if (!["mcp", "skill", "agent"].includes(m.type)) errs.push("type : mcp | skill | agent");
  str("name", 100); str("description", 2000);
  if (typeof m.version !== "string" || !VERSION.test(m.version)) errs.push("version : semver (ex. 1.0.0)");
  str("author", 100, false);
  if (m.permissions !== undefined && (!Array.isArray(m.permissions) || m.permissions.some((p: any) => typeof p !== "string" || p.length > 100))) errs.push("permissions : liste de textes");
  if (m.secrets !== undefined) {
    if (!Array.isArray(m.secrets) || m.secrets.some((s: any) => !s || typeof s.key !== "string" || !SECRET_KEY.test(s.key) || typeof s.label !== "string")) errs.push("secrets : [{ key: MAJUSCULES_, label }]");
  }
  const out: CatalogManifest = { id: m.id, type: m.type, name: m.name, version: m.version, description: m.description };
  if (m.author) out.author = m.author;
  if (m.permissions) out.permissions = [...m.permissions];
  if (m.secrets) out.secrets = m.secrets.map((s: any) => ({ key: s.key, label: s.label }));

  if (m.type === "mcp") {
    const x = m.mcp;
    if (!x || typeof x !== "object") errs.push("mcp : objet requis");
    else {
      if (x.url !== undefined) { try { const u = new URL(x.url); if (u.protocol !== "https:") errs.push("mcp.url : https requis"); } catch { errs.push("mcp.url invalide"); } }
      if (x.command !== undefined && (typeof x.command !== "string" || !/^[A-Za-z0-9._\/-]+$/.test(x.command))) errs.push("mcp.command : nom de commande simple");
      if (!x.command && !x.url && !x.builtin) errs.push("mcp : command, url ou builtin requis");
      if (x.builtin !== undefined && (typeof x.builtin !== "string" || !ID.test(x.builtin))) errs.push("mcp.builtin : id");
      if (x.args !== undefined && (!Array.isArray(x.args) || x.args.some((a: any) => typeof a !== "string" || a.length > 500))) errs.push("mcp.args : liste de textes");
      if (x.env !== undefined && (typeof x.env !== "object" || Object.entries(x.env).some(([k, v]) => !SECRET_KEY.test(k) || typeof v !== "string"))) errs.push("mcp.env : { CLE: valeur }");
      out.mcp = { command: x.command ?? "", ...(x.args ? { args: [...x.args] } : {}), ...(x.env ? { env: { ...x.env } } : {}), ...(x.url ? { url: x.url } : {}) };
      if ((x as any).builtin) (out.mcp as any).builtin = String((x as any).builtin);
    }
  }
  if (m.type === "skill") {
    const f = m.skill?.files;
    if (!f || typeof f !== "object") errs.push("skill.files : objet requis");
    else {
      const entries = Object.entries(f);
      let total = 0;
      if (!entries.length || entries.length > MAX_FILES) errs.push(`skill.files : 1 à ${MAX_FILES} fichiers`);
      if (!("SKILL.md" in f)) errs.push("skill.files : SKILL.md requis");
      for (const [p, c] of entries) {
        if (typeof c !== "string") { errs.push(`skill.files[${p}] : texte requis`); continue; }
        total += c.length;
        if (p.startsWith("/") || p.split("/").some((s) => s === ".." || s === "" || s.startsWith(".")) || !/^[A-Za-z0-9._\/-]+$/.test(p)) errs.push(`skill.files : chemin interdit ${p}`);
      }
      if (total > MAX_TOTAL) errs.push("skill.files : 512 Ko max");
      out.skill = { files: { ...f } };
    }
  }
  if (m.type === "agent") {
    const a = m.agent;
    if (!a || typeof a.instructions !== "string" || !a.instructions.trim() || a.instructions.length > 20000) errs.push("agent.instructions : texte requis (≤ 20000)");
    else {
      if (a.defaultAgent !== undefined && !["claude", "codex"].includes(a.defaultAgent)) errs.push("agent.defaultAgent : claude | codex");
      for (const k of ["skills", "mcp"]) if (a[k] !== undefined && (!Array.isArray(a[k]) || a[k].some((s: any) => typeof s !== "string" || !ID.test(s)))) errs.push(`agent.${k} : liste d'ids`);
      out.agent = { instructions: a.instructions, ...(a.defaultAgent ? { defaultAgent: a.defaultAgent } : {}), ...(a.skills ? { skills: [...a.skills] } : {}), ...(a.mcp ? { mcp: [...a.mcp] } : {}) };
    }
  }
  if (errs.length) throw new Error("manifeste invalide :\n- " + errs.join("\n- "));
  return out;
}
