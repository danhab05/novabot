#!/usr/bin/env bun
// Login Codex PROPRE à Novabot (device code) → ~/.novabot/codex-auth.json. Usage : bun packages/brain/src/providers/codex-login.ts
import { startDeviceLogin, OWN_FILE } from "./codex-auth.ts";
const l = await startDeviceLogin();
console.log(`1. Ouvre ${l.url}\n2. Saisis le code : ${l.userCode}\n(en attente, 15 min max…)`);
await l.done;
console.log(l.status() === "ok" ? `OK → ${OWN_FILE}` : `Échec : ${l.error()}`);
process.exit(l.status() === "ok" ? 0 : 1);
