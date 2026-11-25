import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import { database } from '../storage/database';
import { AppError } from '../utils/app-error';
import { successResponse } from '../utils/api-response';
import {
  FIELD_CATEGORIES,
  FIELD_TYPES,
  serializeProjectField,
  type ProjectFieldRow,
} from '../services/project-fields.service';

const idParam = (value: string | string[] | undefined): string => Array.isArray(value) ? value[0] ?? '' : value ?? '';
const projectIdFor = (req: Request) => idParam(req.params.projectId);
const fieldIdFor = (req: Request) => idParam(req.params.fieldId);

function ensureProjectOwner(projectId: string, userId: string): void {
  if (!database.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId)) {
    throw AppError.notFound('Project');
  }
}

function getField(projectId: string, fieldId: string): ProjectFieldRow {
  const row = database.prepare("SELECT * FROM project_fields WHERE project_id = ? AND id = ? AND visibility <> 'deleted'").get(projectId, fieldId) as ProjectFieldRow | undefined;
  if (!row) throw AppError.notFound('Project field');
  return row;
}

function requiredValueMissing(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

function validateFieldValue(type: string, value: unknown, options: string[], required: boolean): unknown {
  if (required && requiredValueMissing(value)) {
    throw new AppError('A value is required for this field', { statusCode: 400, code: 'VALIDATION_ERROR' });
  }
  if (requiredValueMissing(value)) return null;

  const invalid = (): never => { throw new AppError(`Invalid value for ${type} field`, { statusCode: 400, code: 'VALIDATION_ERROR' }); };
  switch (type) {
    case 'text': case 'long_text': case 'phone': case 'rich_text':
      if (typeof value !== 'string') invalid();
      return value;
    case 'number': case 'currency': case 'percentage':
      if (typeof value !== 'number' || !Number.isFinite(value)) invalid();
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') invalid();
      return value;
    case 'url':
      if (typeof value !== 'string') return invalid();
      try { if (!['http:', 'https:'].includes(new URL(value).protocol)) return invalid(); } catch { return invalid(); }
      return value;
    case 'email':
      if (typeof value !== 'string' || !z.string().email().safeParse(value).success) invalid();
      return value;
    case 'date':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) invalid();
      return value;
    case 'date_time':
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) invalid();
      return value;
    case 'dropdown':
      if (typeof value !== 'string' || (options.length > 0 && !options.includes(value))) invalid();
      return value;
    case 'multi_select': case 'tags':
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || (options.length > 0 && !options.includes(item)))) invalid();
      return [...new Set(value as string[])];
    case 'json':
      return value;
    case 'file_attachment':
      if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid();
      if (typeof (value as Record<string, unknown>).attachmentId !== 'string' || typeof (value as Record<string, unknown>).fileName !== 'string') invalid();
      return value;
    default:
      invalid();
  }
}

const createSchema = z.object({
  fieldName: z.string().trim().min(1).max(120),
  fieldType: z.enum(FIELD_TYPES),
  value: z.unknown().optional(),
  description: z.string().trim().max(1000).optional().default(''),
  required: z.boolean().optional().default(false),
  readOnly: z.boolean().optional().default(false),
  editable: z.boolean().optional().default(true),
  defaultValue: z.unknown().optional(),
  category: z.enum(FIELD_CATEGORIES).optional().default('custom_fields'),
  displayOrder: z.number().int().min(0).max(1_000_000).optional().default(0),
  visibility: z.enum(['visible', 'hidden']).optional().default('visible'),
  pinned: z.boolean().optional().default(false),
  manualNotes: z.string().max(5000).optional().default(''),
  options: z.array(z.string().trim().min(1).max(100)).max(100).optional().default([]),
});

export function listProjectFields(req: Request, res: Response): void {
  const userId = (req as AuthenticatedRequest).user.id;
  const projectId = projectIdFor(req);
  ensureProjectOwner(projectId, userId);
  const rows = database.prepare(`
    SELECT * FROM project_fields
    WHERE project_id = ? AND visibility <> 'deleted'
    ORDER BY pinned DESC, category, display_order, field_name
  `).all(projectId) as unknown as ProjectFieldRow[];
  res.status(200).json(successResponse({ fields: rows.map(serializeProjectField) }, 'Project fields retrieved'));
}

export function createProjectField(req: Request, res: Response): void {
  const userId = (req as AuthenticatedRequest).user.id;
  const projectId = projectIdFor(req);
  ensureProjectOwner(projectId, userId);
  const input = createSchema.parse(req.body);
  const effectiveValue = Object.hasOwn(req.body as object, 'value') ? input.value : input.defaultValue ?? null;
  const effectiveEditable = input.readOnly ? false : input.editable;
  const value = validateFieldValue(input.fieldType, effectiveValue, input.options, false);
  const defaultValue = input.defaultValue === undefined ? null : validateFieldValue(input.fieldType, input.defaultValue, input.options, false);
  const now = new Date().toISOString();
  const id = randomUUID();
  database.prepare(`
    INSERT INTO project_fields (
      id, project_id, field_key, category, field_name, field_type, value_json, source,
      editable, required, read_only, default_value_json, description, options_json,
      display_order, visibility, pinned, manual_notes, user_edited, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'User', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    id, projectId, `custom:${id}`, input.category, input.fieldName, input.fieldType, JSON.stringify(value),
    effectiveEditable ? 1 : 0, input.required ? 1 : 0, input.readOnly ? 1 : 0,
    defaultValue === null ? null : JSON.stringify(defaultValue), input.description, JSON.stringify(input.options),
    input.displayOrder, input.visibility, input.pinned ? 1 : 0, input.manualNotes, userId, now, now,
  );
  const row = database.prepare('SELECT * FROM project_fields WHERE id = ?').get(id) as unknown as ProjectFieldRow;
  res.status(201).json(successResponse({ field: serializeProjectField(row) }, 'Custom field created'));
}

export function updateProjectField(req: Request, res: Response): void {
  const userId = (req as AuthenticatedRequest).user.id;
  const projectId = projectIdFor(req);
  ensureProjectOwner(projectId, userId);
  const row = getField(projectId, fieldIdFor(req));
  const schema = z.object({
    fieldName: z.string().trim().min(1).max(120).optional(),
    fieldType: z.enum(FIELD_TYPES).optional(),
    value: z.unknown().optional(),
    description: z.string().trim().max(1000).optional(),
    required: z.boolean().optional(),
    readOnly: z.boolean().optional(),
    editable: z.boolean().optional(),
    defaultValue: z.unknown().nullable().optional(),
    category: z.enum(FIELD_CATEGORIES).optional(),
    displayOrder: z.number().int().min(0).max(1_000_000).optional(),
    visibility: z.enum(['visible', 'hidden']).optional(),
    pinned: z.boolean().optional(),
    manualNotes: z.string().max(5000).optional(),
    options: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  }).parse(req.body);
  const isCustom = row.field_key.startsWith('custom:');
  if (schema.fieldName !== undefined && !isCustom) throw new AppError('AI field names cannot be changed; add a custom field instead', { statusCode: 400, code: 'BAD_REQUEST' });
  if ((schema.value !== undefined || Object.hasOwn(req.body as object, 'value')) && (!row.editable || row.read_only)) {
    throw new AppError('This field is read only', { statusCode: 403, code: 'FORBIDDEN' });
  }

  const fieldType = schema.fieldType ?? row.field_type;
  const required = schema.required ?? Boolean(row.required);
  const readOnly = schema.readOnly ?? Boolean(row.read_only);
  const editable = readOnly ? false : schema.editable ?? (schema.readOnly === false && Boolean(row.read_only) ? true : Boolean(row.editable));
  const optionsValue = schema.options ?? (JSON.parse(row.options_json) as string[]);
  const hasValue = Object.hasOwn(req.body as object, 'value');
  const proposedValue = hasValue ? schema.value : parseJsonForController(row.value_json);
  const value = validateFieldValue(fieldType, proposedValue, optionsValue, required && hasValue);
  const defaultValue = Object.hasOwn(req.body as object, 'defaultValue')
    ? schema.defaultValue === null ? null : validateFieldValue(fieldType, schema.defaultValue, optionsValue, false)
    : parseJsonForController(row.default_value_json);
  const userEdited = hasValue ? true : Boolean(row.user_edited);
  const source = hasValue ? 'User' : row.source;
  const confidence = hasValue ? null : row.confidence_score;
  database.prepare(`
    UPDATE project_fields SET
      field_name = ?, field_type = ?, value_json = ?, source = ?, confidence_score = ?,
      editable = ?, required = ?, read_only = ?, default_value_json = ?, description = ?,
      options_json = ?, category = ?, display_order = ?, visibility = ?, pinned = ?,
      manual_notes = ?, user_edited = ?, updated_at = ?
    WHERE id = ? AND project_id = ?
  `).run(
    schema.fieldName ?? row.field_name, fieldType, JSON.stringify(value), source, confidence,
    editable ? 1 : 0, required ? 1 : 0, readOnly ? 1 : 0,
    defaultValue === null ? null : JSON.stringify(defaultValue), schema.description ?? row.description,
    JSON.stringify(optionsValue), schema.category ?? row.category, schema.displayOrder ?? row.display_order,
    schema.visibility ?? row.visibility, (schema.pinned ?? Boolean(row.pinned)) ? 1 : 0,
    schema.manualNotes ?? row.manual_notes, userEdited ? 1 : 0, new Date().toISOString(), row.id, projectId,
  );
  const updated = database.prepare('SELECT * FROM project_fields WHERE id = ?').get(row.id) as unknown as ProjectFieldRow;
  res.status(200).json(successResponse({ field: serializeProjectField(updated) }, 'Project field updated'));
}

function parseJsonForController(value: string | null): unknown {
  if (value === null) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

export async function deleteProjectField(req: Request, res: Response): Promise<void> {
  const userId = (req as AuthenticatedRequest).user.id;
  const projectId = projectIdFor(req);
  ensureProjectOwner(projectId, userId);
  const row = getField(projectId, fieldIdFor(req));
  if (row.field_key.startsWith('custom:')) {
    database.prepare('DELETE FROM project_fields WHERE id = ? AND project_id = ?').run(row.id, projectId);
    await removeAttachmentFile(parseJsonForController(row.value_json));
  } else {
    database.prepare(`UPDATE project_fields SET visibility = 'deleted', is_suggested = 0, suggestion_status = 'deleted', user_edited = 1, updated_at = ? WHERE id = ? AND project_id = ?`).run(new Date().toISOString(), row.id, projectId);
  }
  res.status(200).json(successResponse(null, 'Project field removed'));
}

export function restoreAiProjectField(req: Request, res: Response): void {
  const userId = (req as AuthenticatedRequest).user.id;
  const projectId = projectIdFor(req);
  ensureProjectOwner(projectId, userId);
  const row = getField(projectId, fieldIdFor(req));
  if (!row.ai_value_json || !row.ai_source) throw new AppError('This field has no saved AI value to restore', { statusCode: 409, code: 'CONFLICT' });
  database.prepare(`
    UPDATE project_fields SET value_json = ai_value_json, source = ai_source,
      confidence_score = ai_confidence_score, user_edited = 0, updated_at = ?
    WHERE id = ? AND project_id = ?
  `).run(new Date().toISOString(), row.id, projectId);
  const updated = database.prepare('SELECT * FROM project_fields WHERE id = ?').get(row.id) as unknown as ProjectFieldRow;
  res.status(200).json(successResponse({ field: serializeProjectField(updated) }, 'AI value restored'));
}

export function updateFieldSuggestion(req: Request, res: Response): void {
  const userId = (req as AuthenticatedRequest).user.id;
  const projectId = projectIdFor(req);
  ensureProjectOwner(projectId, userId);
  const row = getField(projectId, fieldIdFor(req));
  if (!row.is_suggested || row.suggestion_status !== 'pending') throw new AppError('Suggestion is no longer pending', { statusCode: 409, code: 'CONFLICT' });
  const { action } = z.object({ action: z.enum(['accept', 'reject']) }).parse(req.body);
  database.prepare(`
    UPDATE project_fields SET is_suggested = 0, suggestion_status = ?, visibility = ?, updated_at = ?
    WHERE id = ? AND project_id = ?
  `).run(action === 'accept' ? 'accepted' : 'rejected', action === 'accept' ? 'visible' : 'hidden', new Date().toISOString(), row.id, projectId);
  const updated = database.prepare('SELECT * FROM project_fields WHERE id = ?').get(row.id) as unknown as ProjectFieldRow;
  res.status(200).json(successResponse({ field: serializeProjectField(updated) }, `Suggestion ${action}ed`));
}

export function reorderProjectFields(req: Request, res: Response): void {
  const userId = (req as AuthenticatedRequest).user.id;
  const projectId = projectIdFor(req);
  ensureProjectOwner(projectId, userId);
  const { fieldIds } = z.object({ fieldIds: z.array(z.string().uuid()).max(1000) }).parse(req.body);
  const update = database.prepare('UPDATE project_fields SET display_order = ?, updated_at = ? WHERE id = ? AND project_id = ? AND visibility <> \'deleted\'');
  const ids = database.prepare('SELECT id FROM project_fields WHERE project_id = ? AND visibility <> \'deleted\'').all(projectId) as Array<{ id: string }>;
  const allowed = new Set(ids.map((item) => item.id));
  if (fieldIds.some((id) => !allowed.has(id)) || new Set(fieldIds).size !== fieldIds.length) {
    throw new AppError('Field order contains invalid or duplicate field IDs', { statusCode: 400, code: 'VALIDATION_ERROR' });
  }
  database.exec('BEGIN IMMEDIATE');
  try {
    fieldIds.forEach((id, index) => update.run(index, new Date().toISOString(), id, projectId));
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  res.status(200).json(successResponse(null, 'Project fields reordered'));
}

export function bulkUpdateProjectFields(req: Request, res: Response): void {
  const userId = (req as AuthenticatedRequest).user.id;
  const projectId = projectIdFor(req);
  ensureProjectOwner(projectId, userId);
  const { updates } = z.object({
    updates: z.array(z.object({ fieldId: z.string().uuid(), value: z.unknown() })).min(1).max(100),
  }).parse(req.body);
  if (new Set(updates.map((update) => update.fieldId)).size !== updates.length) throw new AppError('Each field may only appear once in a bulk update', { statusCode: 400, code: 'VALIDATION_ERROR' });
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const update of updates) {
      const row = getField(projectId, update.fieldId);
      if (!row.editable || row.read_only) throw new AppError(`${row.field_name} is read only`, { statusCode: 403, code: 'FORBIDDEN' });
      const value = validateFieldValue(row.field_type, update.value, JSON.parse(row.options_json) as string[], Boolean(row.required));
      database.prepare(`
        UPDATE project_fields SET value_json = ?, source = 'User', confidence_score = NULL,
          user_edited = 1, updated_at = ? WHERE id = ? AND project_id = ?
      `).run(JSON.stringify(value), new Date().toISOString(), row.id, projectId);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  const rows = database.prepare("SELECT * FROM project_fields WHERE project_id = ? AND visibility <> 'deleted' ORDER BY pinned DESC, category, display_order, field_name").all(projectId) as unknown as ProjectFieldRow[];
  res.status(200).json(successResponse({ fields: rows.map(serializeProjectField) }, 'Project fields updated'));
}

interface AttachmentValue {
  attachmentId: string;
  fileName: string;
  extension: string;
  contentType: string;
  size: number;
}

function parseAttachment(value: unknown): AttachmentValue | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Partial<AttachmentValue>;
  if (typeof candidate.attachmentId !== 'string' || !z.string().uuid().safeParse(candidate.attachmentId).success) return null;
  if (typeof candidate.fileName !== 'string' || typeof candidate.extension !== 'string' || !/^\.[a-z0-9]{1,10}$/.test(candidate.extension)) return null;
  if (typeof candidate.contentType !== 'string' || typeof candidate.size !== 'number') return null;
  return candidate as AttachmentValue;
}

async function removeAttachmentFile(value: unknown): Promise<void> {
  const attachment = parseAttachment(value);
  if (!attachment) return;
  await rm(join(resolve(env.UPLOAD_STORAGE_DIR), `${attachment.attachmentId}${attachment.extension}`), { force: true });
}

export async function uploadProjectFieldAttachment(req: Request, res: Response): Promise<void> {
  const userId = (req as AuthenticatedRequest).user.id;
  const projectId = projectIdFor(req);
  ensureProjectOwner(projectId, userId);
  const row = getField(projectId, fieldIdFor(req));
  if (row.field_type !== 'file_attachment' || !row.editable || row.read_only) {
    throw new AppError('This field does not accept file uploads', { statusCode: 403, code: 'FORBIDDEN' });
  }
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.byteLength === 0 || body.byteLength > 10 * 1024 * 1024) {
    throw new AppError('Upload a non-empty file smaller than 10 MB', { statusCode: 400, code: 'VALIDATION_ERROR' });
  }
  let requestedName = req.get('x-file-name') ?? 'attachment';
  try { requestedName = decodeURIComponent(requestedName); } catch { /* Keep a safe fallback below. */ }
  const originalName = basename(requestedName).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160) || 'attachment';
  const extension = extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 11);
  const attachmentId = randomUUID();
  const storagePath = join(resolve(env.UPLOAD_STORAGE_DIR), `${attachmentId}${extension}`);
  const contentTypeHeader = req.get('content-type') ?? 'application/octet-stream';
  const contentType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(contentTypeHeader) ? contentTypeHeader.toLowerCase() : 'application/octet-stream';
  const value: AttachmentValue = { attachmentId, fileName: originalName, extension, contentType, size: body.byteLength };
  await mkdir(resolve(env.UPLOAD_STORAGE_DIR), { recursive: true });
  await writeFile(storagePath, body, { flag: 'wx' });
  try {
    database.prepare(`
      UPDATE project_fields SET value_json = ?, source = 'User', confidence_score = NULL,
        user_edited = 1, updated_at = ? WHERE id = ? AND project_id = ?
    `).run(JSON.stringify(value), new Date().toISOString(), row.id, projectId);
  } catch (error) {
    await rm(storagePath, { force: true });
    throw error;
  }
  await removeAttachmentFile(parseJsonForController(row.value_json));
  const updated = database.prepare('SELECT * FROM project_fields WHERE id = ?').get(row.id) as unknown as ProjectFieldRow;
  res.status(201).json(successResponse({ field: serializeProjectField(updated) }, 'File attached'));
}

export async function downloadProjectFieldAttachment(req: Request, res: Response): Promise<void> {
  const userId = (req as AuthenticatedRequest).user.id;
  const projectId = projectIdFor(req);
  ensureProjectOwner(projectId, userId);
  const row = getField(projectId, fieldIdFor(req));
  const attachment = parseAttachment(parseJsonForController(row.value_json));
  const attachmentId = idParam(req.params.attachmentId);
  if (row.field_type !== 'file_attachment' || !attachment || attachment.attachmentId !== attachmentId) throw AppError.notFound('Attachment');
  const filePath = join(resolve(env.UPLOAD_STORAGE_DIR), `${attachment.attachmentId}${attachment.extension}`);
  let bytes: Buffer;
  try { bytes = await readFile(filePath); } catch { throw AppError.notFound('Attachment'); }
  const safeName = attachment.fileName.replace(/["\\\r\n]/g, '_');
  res.status(200);
  res.setHeader('Content-Type', attachment.contentType);
  res.setHeader('Content-Length', String(bytes.byteLength));
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(bytes);
}
