export const FIELD_CATEGORIES = ['general', 'technical', 'business', 'product', 'market', 'financial', 'ai_insights', 'custom_fields'] as const;
export const FIELD_TYPES = ['text', 'long_text', 'number', 'currency', 'percentage', 'url', 'email', 'phone', 'date', 'date_time', 'boolean', 'dropdown', 'multi_select', 'tags', 'rich_text', 'json', 'file_attachment'] as const;

export type FieldCategory = typeof FIELD_CATEGORIES[number];
export type FieldType = typeof FIELD_TYPES[number];
export type FieldSource = 'AI' | 'Website' | 'GitHub' | 'User' | 'External API';

export interface ProjectField {
  id: string;
  projectId: string;
  key: string;
  category: FieldCategory;
  fieldName: string;
  fieldType: FieldType;
  value: unknown;
  aiValue: unknown;
  source: FieldSource;
  confidenceScore: number | null;
  aiSource: FieldSource | null;
  aiConfidenceScore: number | null;
  generatedBy: string | null;
  aiUpdatedAt: string | null;
  editable: boolean;
  required: boolean;
  readOnly: boolean;
  defaultValue: unknown;
  description: string;
  options: string[];
  displayOrder: number;
  visibility: 'visible' | 'hidden' | 'deleted';
  pinned: boolean;
  suggested: boolean;
  suggestionStatus: 'pending' | 'accepted' | 'rejected' | 'deleted' | null;
  manualNotes: string;
  userEdited: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectFieldInput {
  fieldName: string;
  fieldType: FieldType;
  value?: unknown;
  description?: string;
  required?: boolean;
  readOnly?: boolean;
  editable?: boolean;
  defaultValue?: unknown;
  category?: FieldCategory;
  displayOrder?: number;
  visibility?: 'visible' | 'hidden';
  pinned?: boolean;
  manualNotes?: string;
  options?: string[];
}

export type UpdateProjectFieldInput = Partial<Omit<CreateProjectFieldInput, 'value'>> & { value?: unknown };
