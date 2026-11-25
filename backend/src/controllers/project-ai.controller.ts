import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { answerProjectQuestion, CASE_STUDY_SECTIONS, editCaseStudySectionWithAi, rerankProjectKnowledgeWithGroq } from '../services/case-study.service';
import { getProjectChatHistory, retrieveProjectKnowledge } from '../services/project-knowledge.service';
import { database } from '../storage/database';
import { AppError } from '../utils/app-error';
import { successResponse } from '../utils/api-response';
import { ensureProjectExists } from '../utils/require-project';

function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export async function listProjectChat(req: Request, res: Response): Promise<void> {
  const projectId = param(req, 'id');
  await ensureProjectExists(projectId);
  res.status(200).json(successResponse({ messages: await getProjectChatHistory(projectId) }, 'Project chat history retrieved'));
}

export async function sendProjectChatMessage(req: Request, res: Response): Promise<void> {
  const projectId = param(req, 'id');
  await ensureProjectExists(projectId);
  const { question } = z.object({ question: z.string().trim().min(1).max(2_000) }).strict().parse(req.body);
  const conversationHistory = (await getProjectChatHistory(projectId)).slice(-8);
  const retrievalQuery = [
    ...conversationHistory.slice(-4).map((message) => `${message.role}: ${message.content.slice(0, 500)}`),
    `Current question: ${question}`,
  ].join('\n').slice(-3_000);
  const candidates = await retrieveProjectKnowledge(projectId, retrievalQuery, 12);
  const retrieved = await rerankProjectKnowledgeWithGroq(retrievalQuery, candidates, 6);
  const answer = (await answerProjectQuestion(question, retrieved, conversationHistory)).slice(0, 20_000);
  const citations = retrieved.map(({ id, sourceType, title, url }) => ({ id, sourceType, title, url }));
  const now = new Date().toISOString();
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();

  await database.transaction(async () => {
    await database.prepare(`
      INSERT INTO project_chat_messages (id, project_id, role, content, citations_json, created_at)
      VALUES (?, ?, 'user', ?, '[]', ?)
    `).run(userMessageId, projectId, question, now);
    await database.prepare(`
      INSERT INTO project_chat_messages (id, project_id, role, content, citations_json, created_at)
      VALUES (?, ?, 'assistant', ?, ?, ?)
    `).run(assistantMessageId, projectId, answer, JSON.stringify(citations), now);
  });

  res.status(200).json(successResponse({ answer, citations, userMessageId, assistantMessageId, createdAt: now }, 'Project answer generated from retrieved evidence'));
}

const sectionEditSchema = z.object({
  action: z.enum(['expand', 'rewrite', 'replace', 'add', 'remove']),
  sectionKey: z.string().trim().min(1).max(120).optional(),
  sectionTitle: z.string().trim().min(1).max(120).optional(),
  instruction: z.string().trim().max(1_000).optional().default(''),
  replacement: z.string().trim().min(1).max(30_000).optional(),
}).strict();

type CustomReportSection = { id: string; title: string; content: unknown };

function customSections(content: Record<string, unknown>): CustomReportSection[] {
  return Array.isArray(content.customSections)
    ? content.customSections.filter((item): item is CustomReportSection => Boolean(item) && typeof item === 'object' &&
      typeof (item as Record<string, unknown>).id === 'string' && typeof (item as Record<string, unknown>).title === 'string')
    : [];
}

function stringForEdit(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2) ?? ''; } catch { return String(value); }
}

export async function editCaseStudySection(req: Request, res: Response): Promise<void> {
  const projectId = param(req, 'id');
  const caseStudyId = param(req, 'caseStudyId');
  await ensureProjectExists(projectId);
  const input = sectionEditSchema.parse(req.body);
  const row = await database.prepare(`
    SELECT c.id, c.status, c.content_json
    FROM case_studies c
    WHERE c.project_id = ? AND c.id = ?
  `).get(projectId, caseStudyId) as { id: string; status: string; content_json: string } | undefined;
  if (!row) throw AppError.notFound('Case study');

  let content: Record<string, unknown>;
  try { content = JSON.parse(row.content_json) as Record<string, unknown>; }
  catch { throw new AppError('Saved case-study content is invalid', { statusCode: 500, code: 'INTERNAL_ERROR' }); }
  const nextContent = { ...content };
  let sectionTitle = input.sectionTitle ?? '';
  let currentValue: unknown;
  let customId: string | null = null;

  if (input.action === 'add') {
    if (!sectionTitle) throw new AppError('A title is required for a new section', { statusCode: 400, code: 'VALIDATION_ERROR' });
    if (!input.replacement && !input.instruction) throw new AppError('Describe what the new section should cover', { statusCode: 400, code: 'VALIDATION_ERROR' });
  } else {
    if (!input.sectionKey) throw new AppError('A report section is required', { statusCode: 400, code: 'VALIDATION_ERROR' });
    const definition = CASE_STUDY_SECTIONS.find((section) => section.key === input.sectionKey);
    if (definition) {
      if (!Object.hasOwn(content, definition.key)) throw AppError.notFound('Report section');
      sectionTitle = definition.title;
      currentValue = content[definition.key];
    } else {
      const match = /^custom:([0-9a-f-]{36})$/i.exec(input.sectionKey);
      const existingCustom = customSections(content);
      const section = match ? existingCustom.find((item) => item.id === match[1]) : undefined;
      if (!section) throw AppError.notFound('Report section');
      customId = section.id;
      sectionTitle = section.title;
      currentValue = section.content;
    }
  }

  if (input.action === 'remove') {
    if (customId) nextContent.customSections = customSections(content).filter((section) => section.id !== customId);
    else delete nextContent[input.sectionKey!];
  } else {
    let nextValue: string;
    if (input.action === 'replace') {
      if (!input.replacement) throw new AppError('Replacement text is required', { statusCode: 400, code: 'VALIDATION_ERROR' });
      nextValue = input.replacement;
    } else if (input.replacement && input.action === 'add') {
      nextValue = input.replacement;
    } else {
      const retrievalQuery = `${sectionTitle}\n${input.instruction}\n${stringForEdit(currentValue).slice(0, 1_000)}`;
      const candidates = await retrieveProjectKnowledge(projectId, retrievalQuery, 12);
      const context = await rerankProjectKnowledgeWithGroq(retrievalQuery, candidates, 6);
      nextValue = await editCaseStudySectionWithAi({
        action: input.action === 'expand' || input.action === 'rewrite' ? input.action : 'add',
        sectionTitle,
        ...(currentValue !== undefined ? { currentValue: stringForEdit(currentValue) } : {}),
        instruction: input.instruction || `Create a concise ${sectionTitle} section grounded in the available project evidence.`,
        context,
      });
    }

    if (input.action === 'add') {
      const sections = customSections(content);
      const id = randomUUID();
      nextContent.customSections = [...sections, { id, title: sectionTitle, content: nextValue }];
    } else if (customId) {
      nextContent.customSections = customSections(content).map((section) => section.id === customId ? { ...section, content: nextValue } : section);
    } else {
      nextContent[input.sectionKey!] = nextValue;
    }
  }

  const now = new Date().toISOString();
  const nextId = randomUUID();
  await database.prepare(`
    INSERT INTO case_studies (id, project_id, status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(nextId, projectId, row.status, JSON.stringify(nextContent), now, now);
  res.status(201).json(successResponse({ caseStudyId: nextId, status: row.status, content: nextContent, createdAt: now, updatedAt: now }, 'Report section saved as a new case-study version'));
}
