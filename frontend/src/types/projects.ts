export interface Project {
  id: string;
  name: string;
  websiteUrl: string | null;
  githubUrl: string | null;
  status: 'draft' | 'analyzing' | 'completed' | 'completed_with_warnings' | 'failed';
  fieldDiscoveryStatus: 'not_started' | 'running' | 'completed' | 'completed_with_warnings' | 'failed';
  input: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFieldDiscoveryResult {
  projectId: string;
  status: 'completed' | 'completed_with_warnings';
  warnings: string[];
  fieldCount: number;
  updatedAt: string;
}

export interface CreateProjectInput {
  name: string;
  websiteUrl?: string | null;
  githubUrl?: string | null;
}

export interface CaseStudySummary {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface CaseStudyVersion extends CaseStudySummary {
  content: Record<string, unknown>;
}
