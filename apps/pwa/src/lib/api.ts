// Client HTTP minimal. 401 -> déclenche l'écran de connexion ; 404 -> ApiError(404) (route pas encore livrée).
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (f: () => void) => { onUnauthorized = f; };

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("content-type", "application/json");
  const res = await fetch(path, { credentials: "same-origin", ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body });
  if (res.status === 401) { onUnauthorized?.(); throw new ApiError(401, "unauthorized"); }
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = j.error ?? msg; } catch {}
    throw new ApiError(res.status, msg);
  }
  const ct = res.headers.get("content-type") ?? "";
  return (ct.includes("application/json") ? res.json() : (res as any)) as T;
}

/** Variante qui renvoie null si la route n'existe pas (encore) : 404/405/501. */
export async function apiOptional<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T | null> {
  try { return await api<T>(path, init); }
  catch (e) { if (e instanceof ApiError && [404, 405, 501].includes(e.status)) return null; throw e; }
}

export const post = <T = any>(path: string, json?: unknown) => api<T>(path, { method: "POST", json: json ?? {} });
export const patch = <T = any>(path: string, json: unknown) => api<T>(path, { method: "PATCH", json });
export const del = <T = any>(path: string) => api<T>(path, { method: "DELETE" });
