// Chiffrement AES-256-GCM des jetons d'intégration. Clé dérivée (HKDF-SHA256) de NOVABOT_INTERNAL_TOKEN.
const enc = new TextEncoder();
const dec = new TextDecoder();

async function key(secret: string) {
  if (!secret) throw new Error("NOVABOT_INTERNAL_TOKEN absent : chiffrement impossible");
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("novabot.catalog.v1"), info: enc.encode("integration-tokens") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptJson(secret: string, data: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), enc.encode(JSON.stringify(data))));
  return "v1." + Buffer.from(iv).toString("base64url") + "." + Buffer.from(ct).toString("base64url");
}

export async function decryptJson<T = unknown>(secret: string, blob: string): Promise<T> {
  const [v, ivB, ctB] = blob.split(".");
  if (v !== "v1" || !ivB || !ctB) throw new Error("format chiffré inconnu");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(ivB, "base64url") }, await key(secret), Buffer.from(ctB, "base64url"));
  return JSON.parse(dec.decode(pt)) as T;
}
