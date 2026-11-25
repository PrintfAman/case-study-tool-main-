import type { CaseStudySummary, CaseStudyVersion, CreateProjectInput, Project, ProjectFieldDiscoveryResult } from '../types/projects';
import type { CreateProjectFieldInput, ProjectField, UpdateProjectFieldInput } from '../types/project-fields';
import { API_BASE_URL, apiRequest } from './api-client';

export function createProject(input: CreateProjectInput): Promise<Project> {
  return apiRequest<Project>('/projects/', { method: 'POST', body: input });
}

export function discoverProjectFields(id: string, refresh = false): Promise<ProjectFieldDiscoveryResult> {
  return apiRequest<ProjectFieldDiscoveryResult>(`/projects/${encodeURIComponent(id)}/discover-fields`, {
    method: 'POST',
    body: refresh ? { refresh: true } : {},
  });
}

export function listProjects(): Promise<{ projects: Project[] }> {
  return apiRequest<{ projects: Project[] }>('/projects/');
}

export function getProject(id: string): Promise<Project> {
  return apiRequest<Project>(`/projects/${encodeURIComponent(id)}`);
}

export function deleteProject(id: string): Promise<null> {
  return apiRequest<null>(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function runProjectAnalysis(id: string): Promise<{ projectId: string; caseStudyId: string; status: string; content: Record<string, unknown> }> {
  return apiRequest<{ projectId: string; caseStudyId: string; status: string; content: Record<string, unknown> }>(`/analysis/projects/${encodeURIComponent(id)}/analyze`, { method: 'POST' });
}

export function getProjectCaseStudy(id: string): Promise<CaseStudyVersion> {
  return apiRequest<CaseStudyVersion>(`/analysis/projects/${encodeURIComponent(id)}/case-study`);
}

export function listProjectCaseStudies(id: string): Promise<{ caseStudies: CaseStudySummary[] }> {
  return apiRequest<{ caseStudies: CaseStudySummary[] }>(`/analysis/projects/${encodeURIComponent(id)}/case-studies`);
}

export function getProjectCaseStudyVersion(id: string, caseStudyId: string): Promise<CaseStudyVersion> {
  return apiRequest<CaseStudyVersion>(`/analysis/projects/${encodeURIComponent(id)}/case-studies/${encodeURIComponent(caseStudyId)}`);
}

export interface ProjectChatCitation {
  id: string;
  sourceType: string;
  title: string;
  url: string | null;
}

export interface ProjectChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: ProjectChatCitation[];
  createdAt: string;
}

export function getProjectChat(id: string): Promise<{ messages: ProjectChatMessage[] }> {
  return apiRequest<{ messages: ProjectChatMessage[] }>(`/analysis/projects/${encodeURIComponent(id)}/chat`);
}

export function askProjectChat(id: string, question: string): Promise<{ answer: string; citations: ProjectChatCitation[]; userMessageId: string; assistantMessageId: string; createdAt: string }> {
  return apiRequest<{ answer: string; citations: ProjectChatCitation[]; userMessageId: string; assistantMessageId: string; createdAt: string }>(`/analysis/projects/${encodeURIComponent(id)}/chat`, {
    method: 'POST', body: { question },
  });
}

export type CaseStudySectionAction = 'expand' | 'rewrite' | 'replace' | 'add' | 'remove';
export interface CaseStudySectionEditInput {
  action: CaseStudySectionAction;
  sectionKey?: string;
  sectionTitle?: string;
  instruction?: string;
  replacement?: string;
}

export function editProjectCaseStudySection(id: string, caseStudyId: string, input: CaseStudySectionEditInput): Promise<{ caseStudyId: string; status: string; content: Record<string, unknown>; createdAt: string; updatedAt: string }> {
  return apiRequest<{ caseStudyId: string; status: string; content: Record<string, unknown>; createdAt: string; updatedAt: string }>(
    `/analysis/projects/${encodeURIComponent(id)}/case-studies/${encodeURIComponent(caseStudyId)}/sections`,
    { method: 'POST', body: input },
  );
}

export function generateProjectReport(id: string, caseStudyId?: string): Promise<{ fileName: string; downloadUrl: string }> {
  return apiRequest<{ fileName: string; downloadUrl: string }>(`/reports/projects/${encodeURIComponent(id)}/report`, {
    method: 'POST',
    ...(caseStudyId ? { body: { caseStudyId } } : {}),
  });
}

export function listProjectFields(id: string): Promise<{ fields: ProjectField[] }> {
  return apiRequest<{ fields: ProjectField[] }>(`/projects/${encodeURIComponent(id)}/fields`);
}

export function createProjectField(id: string, input: CreateProjectFieldInput): Promise<{ field: ProjectField }> {
  return apiRequest<{ field: ProjectField }>(`/projects/${encodeURIComponent(id)}/fields`, { method: 'POST', body: input });
}

export function updateProjectField(id: string, fieldId: string, input: UpdateProjectFieldInput): Promise<{ field: ProjectField }> {
  return apiRequest<{ field: ProjectField }>(`/projects/${encodeURIComponent(id)}/fields/${encodeURIComponent(fieldId)}`, { method: 'PATCH', body: input });
}

export function deleteProjectField(id: string, fieldId: string): Promise<null> {
  return apiRequest<null>(`/projects/${encodeURIComponent(id)}/fields/${encodeURIComponent(fieldId)}`, { method: 'DELETE' });
}

export function restoreAiProjectField(id: string, fieldId: string): Promise<{ field: ProjectField }> {
  return apiRequest<{ field: ProjectField }>(`/projects/${encodeURIComponent(id)}/fields/${encodeURIComponent(fieldId)}/restore-ai`, { method: 'POST' });
}

export function decideProjectFieldSuggestion(id: string, fieldId: string, action: 'accept' | 'reject'): Promise<{ field: ProjectField }> {
  return apiRequest<{ field: ProjectField }>(`/projects/${encodeURIComponent(id)}/fields/${encodeURIComponent(fieldId)}/suggestion`, { method: 'POST', body: { action } });
}

export function reorderProjectFields(id: string, fieldIds: string[]): Promise<null> {
  return apiRequest<null>(`/projects/${encodeURIComponent(id)}/fields/reorder`, { method: 'POST', body: { fieldIds } });
}

export function bulkUpdateProjectFields(id: string, updates: Array<{ fieldId: string; value: unknown }>): Promise<{ fields: ProjectField[] }> {
  return apiRequest<{ fields: ProjectField[] }>(`/projects/${encodeURIComponent(id)}/fields/bulk`, { method: 'PATCH', body: { updates } });
}

export async function uploadProjectFieldAttachment(id: string, fieldId: string, file: File): Promise<{ field: ProjectField }> {
  const response = await fetch(`${API_BASE_URL}/projects/${encodeURIComponent(id)}/fields/${encodeURIComponent(fieldId)}/attachment`, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    body: file,
  });
  const payload = await response.json().catch(() => null) as { message?: string; data?: { field: ProjectField } } | null;
  if (!response.ok || !payload?.data?.field) throw new Error(payload?.message ?? 'Unable to attach file');
  return payload.data;
}

export async function downloadProjectFieldAttachment(id: string, fieldId: string, attachmentId: string): Promise<Blob> {
  const response = await fetch(`${API_BASE_URL}/projects/${encodeURIComponent(id)}/fields/${encodeURIComponent(fieldId)}/attachment/${encodeURIComponent(attachmentId)}`, { credentials: 'omit' });
  if (!response.ok) throw new Error('Unable to download attachment');
  return response.blob();
}
