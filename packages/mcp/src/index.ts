#!/usr/bin/env bun
// Serveur MCP stdio « novabot » : expose les outils du daemon aux agents Claude Code / Codex lancés dans Herdr.
// Config (env) : NOVABOT_URL, NOVABOT_INTERNAL_TOKEN, NOVA_PROJECT_ID, NOVA_THREAD_ID, NOVA_TASK_ID.
// Sans dépendance : JSON-RPC 2.0 ligne par ligne (transport stdio MCP).

const URL_ = process.env.NOVABOT_URL ?? "http://127.0.0.1:8790";
const TOKEN = process.env.NOVABOT_INTERNAL_TOKEN ?? "";
const headers = () => ({
  "content-type": "application/json",
  authorization: `Bearer ${TOKEN}`,
  ...(process.env.NOVA_PROJECT_ID ? { "x-nova-project": process.env.NOVA_PROJECT_ID } : {}),
  ...(process.env.NOVA_THREAD_ID ? { "x-nova-thread": process.env.NOVA_THREAD_ID } : {}),
  ...(process.env.NOVA_TASK_ID ? { "x-nova-task": process.env.NOVA_TASK_ID } : {}),
});

// Outils jamais exposés aux agents (réservés au cerveau).
const HIDDEN = new Set((process.env.NOVA_MCP_HIDE ?? "").split(",").filter(Boolean));

function send(msg: unknown) { process.stdout.write(JSON.stringify(msg) + "\n"); }

async function handle(req: any) {
  const { id, method, params } = req;
  try {
    if (method === "initialize") {
      return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "novabot", version: "0.1.0" } } });
    }
    if (method === "notifications/initialized" || method?.startsWith("notifications/")) return;
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") {
      const r = await fetch(`${URL_}/internal/tools`, { headers: headers() });
      const list = (await r.json()) as any[];
      return send({ jsonrpc: "2.0", id, result: { tools: list.filter((t) => !HIDDEN.has(t.name)).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) } });
    }
    if (method === "tools/call") {
      const r = await fetch(`${URL_}/internal/tools/${encodeURIComponent(params.name)}`, { method: "POST", headers: headers(), body: JSON.stringify(params.arguments ?? {}) });
      const j = (await r.json()) as any;
      const text = j.ok ? (typeof j.result === "string" ? j.result : JSON.stringify(j.result, null, 2)) : `Erreur : ${j.error}`;
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: !j.ok } });
    }
    if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `méthode inconnue: ${method}` } });
  } catch (e: any) {
    if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32000, message: String(e?.message ?? e) } });
  }
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (line) { try { handle(JSON.parse(line)); } catch { /* ligne invalide ignorée */ } }
  }
});
