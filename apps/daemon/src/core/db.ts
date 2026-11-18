import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Migrations append-only : ne jamais modifier une migration publiée, en ajouter une.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (id TEXT PRIMARY KEY, discord_id TEXT UNIQUE, name TEXT NOT NULL, avatar TEXT, role TEXT NOT NULL DEFAULT 'guest', created_at INTEGER NOT NULL);
  CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
  CREATE TABLE folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, folder_id TEXT REFERENCES folders(id), path TEXT, stack TEXT, notes TEXT,
    discord_channel_id TEXT, autonomy TEXT NOT NULL DEFAULT 'full', default_agent TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE project_members (project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY (project_id, user_id));
  CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), title TEXT NOT NULL, discord_thread_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE INDEX threads_project ON threads(project_id, updated_at);
  CREATE TABLE messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), role TEXT NOT NULL, author_id TEXT, content TEXT NOT NULL, meta TEXT, created_at INTEGER NOT NULL);
  CREATE INDEX messages_thread ON messages(thread_id, created_at);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), thread_id TEXT, title TEXT NOT NULL, goal TEXT NOT NULL, done_criteria TEXT,
    status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 1, agent_kind TEXT, model TEXT, effort TEXT, herdr_agent TEXT, herdr_pane TEXT, branch TEXT, worktree TEXT,
    attempts INTEGER NOT NULL DEFAULT 0, evidence TEXT, summary TEXT, question TEXT, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER);
  CREATE INDEX tasks_status ON tasks(status, priority, created_at);
  CREATE TABLE task_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, type TEXT NOT NULL, data TEXT, created_at INTEGER NOT NULL);
  CREATE INDEX task_events_task ON task_events(task_id, created_at);
  CREATE TABLE memories (id TEXT PRIMARY KEY, scope TEXT NOT NULL, project_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL, source_message_id TEXT,
    pinned INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content); END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content); END;
  CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content); INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content); END;
  CREATE TABLE memory_journal (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, action TEXT NOT NULL, before TEXT, after TEXT, actor TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE crons (id TEXT PRIMARY KEY, name TEXT NOT NULL, schedule TEXT, once_at INTEGER, prompt TEXT NOT NULL, project_id TEXT, enabled INTEGER NOT NULL DEFAULT 1, last_run INTEGER, next_run INTEGER);
  CREATE TABLE health_checks (id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL UNIQUE, status TEXT NOT NULL, detail TEXT, checked_at INTEGER NOT NULL);
  CREATE TABLE ideas (id TEXT PRIMARY KEY, project_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL);
  CREATE TABLE skill_proposals (id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', task_id TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE catalog_items (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, installed INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL, keys TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE quotas (provider TEXT NOT NULL, window TEXT NOT NULL, used_pct REAL NOT NULL, resets_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (provider, window));
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

export type DB = Database;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY)");
  const done = new Set((db.query("SELECT n FROM _migrations").all() as { n: number }[]).map((r) => r.n));
  MIGRATIONS.forEach((sql, n) => {
    if (done.has(n)) return;
    db.transaction(() => {
      db.exec(sql);
      db.query("INSERT INTO _migrations (n) VALUES (?)").run(n);
    })();
  });
  return db;
}

/** Permet aux modules d'ajouter leurs propres tables (préfixées par le nom du module). */
export function ensureModuleSchema(db: DB, module: string, version: number, sql: string) {
  db.exec("CREATE TABLE IF NOT EXISTS _module_schema (module TEXT PRIMARY KEY, version INTEGER NOT NULL)");
  const row = db.query("SELECT version FROM _module_schema WHERE module = ?").get(module) as { version: number } | null;
  if (row && row.version >= version) return;
  db.transaction(() => {
    db.exec(sql);
    db.query("INSERT INTO _module_schema (module, version) VALUES (?, ?) ON CONFLICT(module) DO UPDATE SET version = excluded.version").run(module, version);
  })();
}

// ---- conversions ligne SQL (snake_case) <-> objets (camelCase) ----
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
const JSON_COLS = new Set(["meta", "data", "manifest", "keys"]);
const BOOL_COLS = new Set(["pinned", "enabled", "installed", "published", "deleted"]);

export function fromRow<T>(row: any): T {
  if (!row) return row;
  const o: any = {};
  for (const [k, v] of Object.entries(row)) {
    if (JSON_COLS.has(k)) o[camel(k)] = v == null ? null : JSON.parse(v as string);
    else if (BOOL_COLS.has(k)) o[camel(k)] = !!v;
    else o[camel(k)] = v;
  }
  return o as T;
}

export function toRow(obj: Record<string, unknown>): Record<string, any> {
  const r: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const sk = snake(k);
    if (JSON_COLS.has(sk)) r[sk] = v == null ? null : JSON.stringify(v);
    else if (typeof v === "boolean") r[sk] = v ? 1 : 0;
    else r[sk] = v;
  }
  return r;
}

export function insert(db: DB, table: string, obj: Record<string, unknown>) {
  const r = toRow(obj);
  const cols = Object.keys(r);
  db.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map((c) => "$" + c).join(",")})`).run(r);
}

export function update(db: DB, table: string, idCol: string, idVal: string, patch: Record<string, unknown>) {
  const r = toRow(patch);
  const cols = Object.keys(r);
  if (!cols.length) return;
  db.query(`UPDATE ${table} SET ${cols.map((c) => `${c} = $${c}`).join(",")} WHERE ${idCol} = $__id`).run({ ...r, __id: idVal } as any);
}
