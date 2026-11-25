import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool, type PoolClient } from 'pg';
import { env } from '../config/env';

type SqliteDatabase = typeof import('./sqlite-database').sqliteDatabase;

const postgresSchema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, website_url TEXT, github_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('draft', 'analyzing', 'completed', 'completed_with_warnings', 'failed')),
  input_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
ALTER TABLE projects ALTER COLUMN user_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS projects_user_updated_idx ON projects(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS project_source_analyses (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'completed_with_warnings', 'failed')),
  evidence_json TEXT NOT NULL DEFAULT '{}', field_analysis_json TEXT NOT NULL DEFAULT '{}',
  warnings_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS case_studies (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL, content_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS case_studies_project_created_idx ON case_studies(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS project_fields (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL, category TEXT NOT NULL, field_name TEXT NOT NULL, field_type TEXT NOT NULL,
  value_json TEXT NOT NULL, ai_value_json TEXT, source TEXT NOT NULL, confidence_score DOUBLE PRECISION,
  ai_source TEXT, ai_confidence_score DOUBLE PRECISION, ai_generated_by TEXT, ai_updated_at TEXT,
  editable INTEGER NOT NULL DEFAULT 1, required INTEGER NOT NULL DEFAULT 0, read_only INTEGER NOT NULL DEFAULT 0,
  default_value_json TEXT, description TEXT NOT NULL DEFAULT '', options_json TEXT NOT NULL DEFAULT '[]',
  display_order INTEGER NOT NULL DEFAULT 0, visibility TEXT NOT NULL DEFAULT 'visible', pinned INTEGER NOT NULL DEFAULT 0,
  is_suggested INTEGER NOT NULL DEFAULT 0, suggestion_status TEXT, manual_notes TEXT NOT NULL DEFAULT '',
  user_edited INTEGER NOT NULL DEFAULT 0, created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, field_key)
);
CREATE INDEX IF NOT EXISTS project_fields_project_order_idx ON project_fields(project_id, category, display_order, field_name);
CREATE TABLE IF NOT EXISTS project_knowledge_chunks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL, source_id TEXT NOT NULL, title TEXT NOT NULL, source_url TEXT,
  content TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', content_hash TEXT NOT NULL,
  embedding_json TEXT NOT NULL, embedding_model TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(project_id, source_type, source_id)
);
CREATE INDEX IF NOT EXISTS project_knowledge_project_source_idx ON project_knowledge_chunks(project_id, source_type);
CREATE TABLE IF NOT EXISTS project_chat_messages (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), content TEXT NOT NULL,
  citations_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS project_chat_project_created_idx ON project_chat_messages(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS app_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
INSERT INTO project_fields (
  id, project_id, field_key, category, field_name, field_type, value_json, source, confidence_score,
  editable, user_edited, created_by, created_at, updated_at
)
SELECT 'seed-project-name-' || id, id, 'project_name', 'general', 'Project Name', 'text',
  to_json(name)::text, 'User', 1, 1, 1, user_id, created_at, updated_at FROM projects
ON CONFLICT (project_id, field_key) DO NOTHING;
INSERT INTO project_fields (
  id, project_id, field_key, category, field_name, field_type, value_json, source, confidence_score,
  editable, user_edited, created_by, created_at, updated_at
)
SELECT 'seed-website-' || id, id, 'website', 'general', 'Website', 'url', to_json(website_url)::text,
  'User', 1, 1, 1, user_id, created_at, updated_at FROM projects WHERE website_url IS NOT NULL
ON CONFLICT (project_id, field_key) DO NOTHING;
INSERT INTO project_fields (
  id, project_id, field_key, category, field_name, field_type, value_json, source, confidence_score,
  editable, user_edited, created_by, created_at, updated_at
)
SELECT 'seed-github-' || id, id, 'github_repository', 'technical', 'GitHub Repository', 'url', to_json(github_url)::text,
  'User', 1, 1, 1, user_id, created_at, updated_at FROM projects WHERE github_url IS NOT NULL
ON CONFLICT (project_id, field_key) DO NOTHING;
`;

const legacyTables = [
  'projects', 'project_source_analyses', 'case_studies', 'project_fields',
  'project_knowledge_chunks', 'project_chat_messages',
] as const;

let pool: Pool | null = null;
let sqlite: SqliteDatabase | null = null;
let initialization: Promise<void> | null = null;
const transactionClient = new AsyncLocalStorage<PoolClient>();
const sqliteTransaction = new AsyncLocalStorage<boolean>();
let sqliteQueue: Promise<void> = Promise.resolve();

function convertSql(sql: string): string {
  let parameterIndex = 0;
  let converted = sql.replace(/\?/g, () => `$${++parameterIndex}`);
  const ignoreInsert = isIgnoreInsert(sql);
  converted = converted.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO');
  if (ignoreInsert) converted = `${converted.replace(/;\s*$/, '')} ON CONFLICT DO NOTHING`;
  return converted;
}

function isIgnoreInsert(sql: string): boolean {
  return /INSERT\s+OR\s+IGNORE\s+INTO/i.test(sql);
}

async function withSqliteLock<T>(operation: () => T): Promise<T> {
  if (sqliteTransaction.getStore()) return operation();
  const previous = sqliteQueue;
  let release!: () => void;
  sqliteQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return operation(); } finally { release(); }
}

export async function initializeDatabase(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    if (env.DATABASE_URL) {
      const sslCa = env.DATABASE_SSL_CA_BASE64
        ? Buffer.from(env.DATABASE_SSL_CA_BASE64, 'base64').toString('utf8').trim()
        : undefined;
      if (sslCa && !/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(sslCa)) {
        throw new Error('DATABASE_SSL_CA_BASE64 does not contain a PEM certificate');
      }
      pool = new Pool({
        connectionString: env.DATABASE_URL,
        max: 5,
        ssl: { rejectUnauthorized: true, ...(sslCa ? { ca: sslCa } : {}) },
        connectionTimeoutMillis: 10_000,
        query_timeout: 30_000,
      });
      await pool.query(postgresSchema);
      await migrateLegacySqlite(pool);
      return;
    }
    const local = await import('./sqlite-database.js');
    sqlite = local.sqliteDatabase;
  })();
  try { await initialization; } catch (error) { initialization = null; throw error; }
}

async function migrateLegacySqlite(targetPool: Pool): Promise<void> {
  if (!env.SQLITE_MIGRATION_PATH) return;
  const migrationId = 'sqlite-to-supabase-v1';
  const alreadyApplied = await targetPool.query('SELECT 1 FROM app_migrations WHERE id = $1', [migrationId]);
  if (alreadyApplied.rows.length > 0) return;

  const sourcePath = resolve(env.SQLITE_MIGRATION_PATH);
  if (!existsSync(sourcePath)) throw new Error(`SQLite migration file not found at ${sourcePath}`);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const client = await targetPool.connect();
  const copiedRows: Record<string, number> = {};
  try {
    const available = new Set((source.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(({ name }) => name));
    await client.query('BEGIN');
    for (const table of legacyTables) {
      if (!available.has(table)) continue;
      const sourceColumns = (source.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(({ name }) => name);
      const targetShape = await client.query(`SELECT * FROM "${table}" LIMIT 0`);
      const targetColumns = new Set(targetShape.fields.map(({ name }) => name));
      const columns = sourceColumns.filter((column) => targetColumns.has(column));
      if (columns.length === 0) continue;
      const rows = source.prepare(`SELECT * FROM "${table}"`).all() as Array<Record<string, unknown>>;
      const columnSql = columns.map((column) => `"${column}"`).join(', ');
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
      const insertSql = `INSERT INTO "${table}" (${columnSql}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
      for (const row of rows) {
        const values = columns.map((column) => {
          if (table === 'projects' && column === 'user_id') return null;
          if (table === 'project_fields' && column === 'created_by') return null;
          return row[column] ?? null;
        });
        const inserted = await client.query(insertSql, values);
        copiedRows[table] = (copiedRows[table] ?? 0) + (inserted.rowCount ?? 0);
      }
    }
    await client.query('INSERT INTO app_migrations (id, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [migrationId, new Date().toISOString()]);
    await client.query('COMMIT');
    console.info('[database] SQLite data imported into Supabase Postgres', { rowsByTable: copiedRows });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    source.close();
    client.release();
  }
}

export const database = {
  prepare(sql: string) {
    return {
      async get(...parameters: unknown[]): Promise<unknown> {
        await initializeDatabase();
        if (pool) {
          const client = transactionClient.getStore();
          const result = await (client ?? pool).query(convertSql(sql), parameters);
          return result.rows[0];
        }
        return withSqliteLock(() => sqlite!.prepare(sql).get(...parameters as never[]));
      },
      async all(...parameters: unknown[]): Promise<unknown[]> {
        await initializeDatabase();
        if (pool) {
          const client = transactionClient.getStore();
          return (await (client ?? pool).query(convertSql(sql), parameters)).rows;
        }
        return withSqliteLock(() => sqlite!.prepare(sql).all(...parameters as never[]) as unknown[]);
      },
      async run(...parameters: unknown[]): Promise<{ changes: number }> {
        await initializeDatabase();
        if (pool) {
          const client = transactionClient.getStore();
          const result = await (client ?? pool).query(convertSql(sql), parameters);
          return { changes: result.rowCount ?? 0 };
        }
        return withSqliteLock(() => {
          const result = sqlite!.prepare(sql).run(...parameters as never[]);
          return { changes: Number(result.changes) };
        });
      },
    };
  },
  async exec(sql: string): Promise<void> {
    await initializeDatabase();
    if (pool) {
      const client = transactionClient.getStore();
      await (client ?? pool).query(sql);
      return;
    }
    await withSqliteLock(() => sqlite!.exec(sql));
  },
  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    await initializeDatabase();
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await transactionClient.run(client, operation);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    }
    return withSqliteLock(async () => {
      sqlite!.exec('BEGIN IMMEDIATE');
      try {
        const result = await sqliteTransaction.run(true, operation);
        sqlite!.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite!.exec('ROLLBACK');
        throw error;
      }
    });
  },
  close(): void {
    sqlite?.close();
    if (pool) void pool.end();
  },
};

export async function databaseHealth(): Promise<{ up: boolean; detail?: string }> {
  try {
    await database.prepare('SELECT 1 AS healthy').get();
    return { up: true };
  } catch {
    return { up: false, detail: env.DATABASE_URL ? 'Supabase Postgres query failed' : 'SQLite database query failed' };
  }
}

export function closeDatabase(): void { database.close(); }
