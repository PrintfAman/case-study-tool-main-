import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { env } from '../config/env';

/**
 * Local-first SQLite store. The database file lives under the backend working
 * directory by default (`backend/storage`) and is excluded from Git.
 * Schema creation is idempotent so existing local data survives restarts.
 */
const databasePath = resolve(process.cwd(), env.DATABASE_PATH);
mkdirSync(dirname(databasePath), { recursive: true });

export const sqliteDatabase = new DatabaseSync(databasePath);
sqliteDatabase.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
sqliteDatabase.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    name TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    website_url TEXT,
    github_url TEXT,
    status TEXT NOT NULL CHECK (status IN ('draft', 'analyzing', 'completed', 'completed_with_warnings', 'failed')),
    input_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS projects_user_updated_idx ON projects(user_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS project_source_analyses (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'completed_with_warnings', 'failed')),
    evidence_json TEXT NOT NULL DEFAULT '{}',
    field_analysis_json TEXT NOT NULL DEFAULT '{}',
    warnings_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS case_studies (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_fields (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    field_key TEXT NOT NULL,
    category TEXT NOT NULL,
    field_name TEXT NOT NULL,
    field_type TEXT NOT NULL,
    value_json TEXT NOT NULL,
    ai_value_json TEXT,
    source TEXT NOT NULL,
    confidence_score REAL,
    ai_source TEXT,
    ai_confidence_score REAL,
    ai_generated_by TEXT,
    ai_updated_at TEXT,
    editable INTEGER NOT NULL DEFAULT 1,
    required INTEGER NOT NULL DEFAULT 0,
    read_only INTEGER NOT NULL DEFAULT 0,
    default_value_json TEXT,
    description TEXT NOT NULL DEFAULT '',
    options_json TEXT NOT NULL DEFAULT '[]',
    display_order INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'visible',
    pinned INTEGER NOT NULL DEFAULT 0,
    is_suggested INTEGER NOT NULL DEFAULT 0,
    suggestion_status TEXT,
    manual_notes TEXT NOT NULL DEFAULT '',
    user_edited INTEGER NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, field_key)
  );
  CREATE INDEX IF NOT EXISTS project_fields_project_order_idx
    ON project_fields(project_id, category, display_order, field_name);

  -- Project-scoped vector records share the existing SQLite durability boundary.
  -- The project_id foreign key ensures knowledge cannot outlive or cross projects.
  CREATE TABLE IF NOT EXISTS project_knowledge_chunks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    title TEXT NOT NULL,
    source_url TEXT,
    content TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    content_hash TEXT NOT NULL,
    embedding_json TEXT NOT NULL,
    embedding_model TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, source_type, source_id)
  );
  CREATE INDEX IF NOT EXISTS project_knowledge_project_source_idx
    ON project_knowledge_chunks(project_id, source_type);

  CREATE TABLE IF NOT EXISTS project_chat_messages (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    citations_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS project_chat_project_created_idx
    ON project_chat_messages(project_id, created_at DESC);
`);

// Older project databases required an authenticated user for every record.
// Rebuild only that table so anonymous project inserts can leave user_id NULL;
// existing project IDs and all dependent project data remain intact.
const projectsSchema = sqliteDatabase.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get() as { sql: string } | undefined;
if (projectsSchema?.sql && /user_id\s+TEXT\s+NOT\s+NULL/i.test(projectsSchema.sql)) {
  sqliteDatabase.exec('PRAGMA foreign_keys = OFF');
  sqliteDatabase.exec('BEGIN IMMEDIATE');
  try {
    sqliteDatabase.exec(`
      CREATE TABLE projects_anonymous (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        website_url TEXT,
        github_url TEXT,
        status TEXT NOT NULL CHECK (status IN ('draft', 'analyzing', 'completed', 'completed_with_warnings', 'failed')),
        input_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO projects_anonymous (id, user_id, name, website_url, github_url, status, input_json, created_at, updated_at)
        SELECT id, user_id, name, website_url, github_url, status, input_json, created_at, updated_at FROM projects;
      DROP TABLE projects;
      ALTER TABLE projects_anonymous RENAME TO projects;
      CREATE INDEX projects_user_updated_idx ON projects(user_id, updated_at DESC);
    `);
    sqliteDatabase.exec('COMMIT');
  } catch (error) {
    sqliteDatabase.exec('ROLLBACK');
    throw error;
  } finally {
    sqliteDatabase.exec('PRAGMA foreign_keys = ON');
  }
}

// Backfill the core fields for projects created before dynamic fields existed.
sqliteDatabase.exec(`
  INSERT OR IGNORE INTO project_fields (
    id, project_id, field_key, category, field_name, field_type, value_json, source,
    confidence_score, editable, user_edited, created_by, created_at, updated_at
  )
  SELECT 'seed-project-name-' || id, id, 'project_name', 'general', 'Project Name', 'text',
    json_quote(name), 'User', 1, 1, 1, user_id, created_at, updated_at FROM projects;

  INSERT OR IGNORE INTO project_fields (
    id, project_id, field_key, category, field_name, field_type, value_json, source,
    confidence_score, editable, user_edited, created_by, created_at, updated_at
  )
  SELECT 'seed-website-' || id, id, 'website', 'general', 'Website', 'url',
    json_quote(website_url), 'User', 1, 1, 1, user_id, created_at, updated_at
  FROM projects WHERE website_url IS NOT NULL;

  INSERT OR IGNORE INTO project_fields (
    id, project_id, field_key, category, field_name, field_type, value_json, source,
    confidence_score, editable, user_edited, created_by, created_at, updated_at
  )
  SELECT 'seed-github-' || id, id, 'github_repository', 'technical', 'GitHub Repository', 'url',
    json_quote(github_url), 'User', 1, 1, 1, user_id, created_at, updated_at
  FROM projects WHERE github_url IS NOT NULL;
`);

// Earlier local prototypes stored only one report per project. Preserve those
// rows while removing the project_id uniqueness constraint for analysis history.
const caseStudiesSchema = sqliteDatabase.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'case_studies'").get() as { sql: string } | undefined;
if (caseStudiesSchema?.sql && /project_id\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(caseStudiesSchema.sql)) {
  sqliteDatabase.exec('BEGIN IMMEDIATE');
  try {
    sqliteDatabase.exec(`
      ALTER TABLE case_studies RENAME TO case_studies_previous;
      CREATE TABLE case_studies (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO case_studies (id, project_id, status, content_json, created_at, updated_at)
        SELECT id, project_id, status, content_json, created_at, updated_at FROM case_studies_previous;
      DROP TABLE case_studies_previous;
    `);
    sqliteDatabase.exec('COMMIT');
  } catch (error) {
    sqliteDatabase.exec('ROLLBACK');
    throw error;
  }
}
sqliteDatabase.exec('CREATE INDEX IF NOT EXISTS case_studies_project_created_idx ON case_studies(project_id, created_at DESC)');

export function sqliteDatabaseHealth(): { up: boolean; detail?: string } {
  try {
    sqliteDatabase.prepare('SELECT 1 AS healthy').get();
    return { up: true };
  } catch {
    return { up: false, detail: 'SQLite database query failed' };
  }
}

export function closeSqliteDatabase(): void {
  sqliteDatabase.close();
}
