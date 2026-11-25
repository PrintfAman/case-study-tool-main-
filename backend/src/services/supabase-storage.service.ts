import { env } from '../config/env';
import { AppError } from '../utils/app-error';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

function localPath(objectPath: string): string {
  const parts = objectPath.split('/');
  const fileName = basename(objectPath);
  const directory = parts.at(-2) === 'reports' ? env.REPORT_STORAGE_DIR : env.UPLOAD_STORAGE_DIR;
  return resolve(directory, fileName);
}

function storageConfigured(): boolean {
  return Boolean(env.SUPABASE_URL && (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY) && env.SUPABASE_STORAGE_BUCKET);
}

function configuration(): { baseUrl: string; bucket: string; key: string } {
  const key = env.SUPABASE_SECRET_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_URL || !key || !env.SUPABASE_STORAGE_BUCKET) {
    throw new AppError('Supabase Storage is not configured', { statusCode: 503, code: 'INTERNAL_ERROR' });
  }
  return {
    baseUrl: `${env.SUPABASE_URL.replace(/\/+$/, '')}/storage/v1/object`,
    bucket: env.SUPABASE_STORAGE_BUCKET,
    key,
  };
}

function objectUrl(baseUrl: string, bucket: string, objectPath: string, authenticated = false): string {
  const bucketPath = encodeURIComponent(bucket);
  const filePath = objectPath.split('/').map(encodeURIComponent).join('/');
  return `${baseUrl}/${authenticated ? 'authenticated/' : ''}${bucketPath}/${filePath}`;
}

function authHeaders(key: string): Record<string, string> {
  const headers = { apikey: key };
  // Legacy service_role keys are JWTs and need Authorization. New sb_secret
  // keys are opaque API keys and must only be sent in the apikey header.
  return /^eyJ/.test(key) ? { ...headers, Authorization: `Bearer ${key}` } : headers;
}

export async function verifyStorageBucket(): Promise<void> {
  if (!storageConfigured() && !env.isProduction) return;
  const { baseUrl, bucket, key } = configuration();
  const response = await fetch(`${baseUrl.replace(/\/object$/, '')}/bucket/${encodeURIComponent(bucket)}`, {
    headers: authHeaders(key),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Supabase Storage bucket "${bucket}" is unavailable (HTTP ${response.status})`);
  const details = await response.json() as { public?: unknown };
  if (details.public !== false) throw new Error(`Supabase Storage bucket "${bucket}" must be private`);
}

async function checkResponse(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  const detail = response.status === 404 ? 'bucket or object not found' : `HTTP ${response.status}`;
  throw new AppError(`Supabase Storage ${action} failed (${detail})`, { statusCode: 502, code: 'INTERNAL_ERROR' });
}

export async function uploadStoredObject(objectPath: string, bytes: Buffer | Uint8Array, contentType: string, overwrite = false): Promise<void> {
  if (!storageConfigured() && !env.isProduction) {
    const path = localPath(objectPath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' });
    return;
  }
  const { baseUrl, bucket, key } = configuration();
  const response = await fetch(objectUrl(baseUrl, bucket, objectPath), {
    method: 'POST',
    headers: { ...authHeaders(key), 'Content-Type': contentType, 'x-upsert': String(overwrite) },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(30_000),
  });
  await checkResponse(response, 'upload');
}

export async function downloadStoredObject(objectPath: string): Promise<Buffer | null> {
  if (!storageConfigured() && !env.isProduction) {
    try { return await readFile(localPath(objectPath)); } catch { return null; }
  }
  const { baseUrl, bucket, key } = configuration();
  const response = await fetch(objectUrl(baseUrl, bucket, objectPath, true), { headers: authHeaders(key), signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) return null;
  await checkResponse(response, 'download');
  return Buffer.from(await response.arrayBuffer());
}

export async function deleteStoredObject(objectPath: string): Promise<void> {
  if (!storageConfigured() && !env.isProduction) {
    await rm(localPath(objectPath), { force: true });
    return;
  }
  const { baseUrl, bucket, key } = configuration();
  const response = await fetch(`${baseUrl}/${encodeURIComponent(bucket)}`, {
    method: 'DELETE',
    headers: { ...authHeaders(key), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefixes: [objectPath] }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return;
  await checkResponse(response, 'delete');
}

/** One-time, non-destructive copy of old Render disk objects into the private bucket. */
export async function migrateLegacyStorage(): Promise<void> {
  if (!storageConfigured() || !env.DATABASE_URL) return;
  const { database } = await import('../storage/database.js');
  const migrationId = 'legacy-storage-to-supabase-v1';
  if (await database.prepare('SELECT 1 FROM app_migrations WHERE id = ?').get(migrationId)) return;

  let reportCount = 0;
  let attachmentCount = 0;
  try {
    const reports = await readdir(resolve(env.REPORT_STORAGE_DIR), { withFileTypes: true });
    for (const entry of reports) {
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.pdf') continue;
      const match = /^([0-9a-f-]{36})-.+\.pdf$/i.exec(entry.name);
      if (!match) continue;
      const projectId = match[1]!;
      await uploadStoredObject(`${projectId}/reports/${entry.name}`, await readFile(join(resolve(env.REPORT_STORAGE_DIR), entry.name)), 'application/pdf', true);
      reportCount += 1;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const rows = await database.prepare("SELECT project_id, value_json FROM project_fields WHERE field_type = 'file_attachment'").all() as Array<{ project_id: string; value_json: string }>;
  for (const row of rows) {
    let value: unknown;
    try { value = JSON.parse(row.value_json) as unknown; } catch { continue; }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const attachment = value as { attachmentId?: unknown; extension?: unknown; contentType?: unknown };
    if (typeof attachment.attachmentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(attachment.attachmentId)) continue;
    if (typeof attachment.extension !== 'string' || !/^\.[a-z0-9]{1,10}$/i.test(attachment.extension)) continue;
    const fileName = `${attachment.attachmentId}${attachment.extension}`;
    try {
      const bytes = await readFile(join(resolve(env.UPLOAD_STORAGE_DIR), fileName));
      const contentType = typeof attachment.contentType === 'string' ? attachment.contentType : 'application/octet-stream';
      await uploadStoredObject(`${row.project_id}/attachments/${fileName}`, bytes, contentType, true);
      attachmentCount += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  await database.prepare('INSERT INTO app_migrations (id, applied_at) VALUES (?, ?) ON CONFLICT DO NOTHING')
    .run(migrationId, new Date().toISOString());
  console.info('[storage] Legacy files copied into Supabase Storage', { reports: reportCount, attachments: attachmentCount });
}
