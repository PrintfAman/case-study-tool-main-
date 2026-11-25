import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from './Badge';
import { Panel } from './Panel';
import {
  bulkUpdateProjectFields,
  createProjectField,
  decideProjectFieldSuggestion,
  deleteProjectField,
  downloadProjectFieldAttachment,
  listProjectFields,
  reorderProjectFields,
  restoreAiProjectField,
  updateProjectField,
  uploadProjectFieldAttachment,
} from '../services/project-api';
import { FIELD_CATEGORIES, FIELD_TYPES, type FieldCategory, type FieldType, type ProjectField } from '../types/project-fields';

const categoryNames: Record<FieldCategory, string> = {
  general: 'General', technical: 'Technical', business: 'Business', product: 'Product',
  market: 'Market', financial: 'Financial', ai_insights: 'AI Insights', custom_fields: 'Custom Fields',
};

const typeNames: Record<FieldType, string> = {
  text: 'Text', long_text: 'Long Text', number: 'Number', currency: 'Currency', percentage: 'Percentage',
  url: 'URL', email: 'Email', phone: 'Phone', date: 'Date', date_time: 'Date & Time', boolean: 'Boolean',
  dropdown: 'Dropdown', multi_select: 'Multi Select', tags: 'Tags', rich_text: 'Rich Text', json: 'JSON', file_attachment: 'File Attachment',
};

function valueDraft(value: unknown): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

function parseDraft(type: FieldType, value: unknown): unknown {
  if (type === 'boolean') return value == null || value === '' ? null : value === true || value === 'true';
  if (value == null || value === '') return null;
  if (type === 'number' || type === 'currency' || type === 'percentage') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error('Enter a valid number.');
    return number;
  }
  if (type === 'multi_select' || type === 'tags') return String(value).split(',').map((item) => item.trim()).filter(Boolean);
  if (type === 'json') {
    try { return JSON.parse(String(value)) as unknown; } catch { throw new Error('Enter valid JSON.'); }
  }
  if (type === 'file_attachment') return value;
  return String(value);
}

function displayValue(field: ProjectField): string {
  const value = field.value;
  if (value == null || value === '') return 'Not set';
  if (field.fieldType === 'boolean') return value ? 'Yes' : 'No';
  if (field.fieldType === 'file_attachment' && typeof value === 'object') return String((value as { fileName?: string }).fileName ?? 'Attached file');
  if (Array.isArray(value)) return value.map(String).join(' · ');
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  if (field.fieldType === 'currency' && typeof value === 'number') return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
  if (field.fieldType === 'percentage') return `${String(value)}%`;
  return String(value);
}

function FieldInput({ field, value, onChange, disabled = false }: { field: Pick<ProjectField, 'fieldType' | 'options' | 'fieldName'>; value: unknown; onChange: (value: unknown) => void; disabled?: boolean }) {
  const type = field.fieldType;
  if (type === 'boolean') {
    return <select className="field-control" disabled={disabled} value={value === true ? 'true' : value === false ? 'false' : ''} onChange={(event) => onChange(event.target.value === '' ? null : event.target.value === 'true')}><option value="">Choose</option><option value="true">Yes</option><option value="false">No</option></select>;
  }
  if (type === 'dropdown' && field.options.length > 0) {
    return <select className="field-control" disabled={disabled} value={typeof value === 'string' ? value : ''} onChange={(event) => onChange(event.target.value)}><option value="">Choose</option>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}</select>;
  }
  if (type === 'multi_select' && field.options.length > 0) {
    const selected = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    return <select className="field-control field-control--multi" multiple disabled={disabled} value={selected} onChange={(event) => onChange([...event.currentTarget.selectedOptions].map((option) => option.value))}>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}</select>;
  }
  if (type === 'rich_text') return <RichTextEditor value={valueDraft(value)} onChange={onChange} disabled={disabled} />;
  if (type === 'long_text' || type === 'json') {
    return <textarea className="field-control field-control--textarea" disabled={disabled} value={valueDraft(value)} onChange={(event) => onChange(event.target.value)} aria-label={field.fieldName} />;
  }
  if (type === 'file_attachment') return <p className="muted">Choose a file below to attach it.</p>;
  if (type === 'dropdown') return <input className="field-control" disabled={disabled} value={valueDraft(value)} placeholder="Enter an option" onChange={(event) => onChange(event.target.value)} />;
  if (type === 'multi_select' || type === 'tags') return <input className="field-control" disabled={disabled} value={valueDraft(value)} placeholder="Separate values with commas" onChange={(event) => onChange(event.target.value)} />;
  const inputType = type === 'number' || type === 'currency' || type === 'percentage' ? 'number'
    : type === 'date' ? 'date' : type === 'date_time' ? 'datetime-local'
      : type === 'url' || type === 'email' ? type : type === 'phone' ? 'tel' : 'text';
  return <input className="field-control" disabled={disabled} type={inputType} step={inputType === 'number' ? 'any' : undefined} value={valueDraft(value)} onChange={(event) => onChange(inputType === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value)} aria-label={field.fieldName} />;
}

function RichTextEditor({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  function wrapSelection(before: string, after = before) {
    const element = input.current;
    if (!element) return;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    const selectedText = value.slice(start, end);
    const replacement = `${before}${selectedText || 'text'}${after}`;
    const next = `${value.slice(0, start)}${replacement}${value.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(start + before.length, start + before.length + (selectedText || 'text').length);
    });
  }
  function addBullet() {
    const element = input.current;
    if (!element) return;
    const start = element.selectionStart;
    const next = `${value.slice(0, start)}\n- ${value.slice(start)}`;
    onChange(next);
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(start + 3, start + 3); });
  }
  return <div className="rich-text-editor"><div className="rich-text-editor__toolbar" aria-label="Rich text formatting"><button type="button" disabled={disabled} onClick={() => wrapSelection('**')}>Bold</button><button type="button" disabled={disabled} onClick={() => wrapSelection('_')}>Italic</button><button type="button" disabled={disabled} onClick={addBullet}>List item</button><button type="button" disabled={disabled} onClick={() => wrapSelection('[', '](https://example.com)')}>Link</button></div><textarea ref={input} className="field-control field-control--textarea" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} aria-label="Rich text value; Markdown formatting is supported" /></div>;
}

function renderRichTextLine(value: string, keyPrefix: string): ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)]+\))/g;
  const parts = value.split(pattern).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={`${keyPrefix}-${index}`}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('_') && part.endsWith('_')) return <em key={`${keyPrefix}-${index}`}>{part.slice(1, -1)}</em>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={`${keyPrefix}-${index}`}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(part);
    if (link) return <a key={`${keyPrefix}-${index}`} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    return <span key={`${keyPrefix}-${index}`}>{part}</span>;
  });
}

function RichTextValue({ value }: { value: string }) {
  return <div className="rich-text-value">{value.split('\n').map((line, index) => line.startsWith('- ')
    ? <div className="rich-text-value__list-item" key={index}>{renderRichTextLine(line.slice(2), `line-${index}`)}</div>
    : <p key={index}>{renderRichTextLine(line, `line-${index}`)}</p>)}</div>;
}

export function ProjectInformationPanel({ projectId, refreshToken = 0 }: { projectId: string; refreshToken?: number }) {
  const [fields, setFields] = useState<ProjectField[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<'all' | FieldCategory>('all');
  const [showHidden, setShowHidden] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [newType, setNewType] = useState<FieldType>('text');
  const [newCategory, setNewCategory] = useState<FieldCategory>('custom_fields');
  const [newValue, setNewValue] = useState<unknown>('');
  const [newDefault, setNewDefault] = useState('');
  const [newOptions, setNewOptions] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkDrafts, setBulkDrafts] = useState<Record<string, unknown>>({});
  const [draggedId, setDraggedId] = useState<string | null>(null);

  async function loadFields() {
    setLoading(true);
    setError(null);
    try { setFields((await listProjectFields(projectId)).fields); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load project information'); }
    finally { setLoading(false); }
  }

  useEffect(() => { void loadFields(); }, [projectId, refreshToken]);

  const pendingSuggestions = fields.filter((field) => field.suggested && field.suggestionStatus === 'pending');
  const filteredFields = useMemo(() => fields.filter((field) => {
    if (field.suggested && field.suggestionStatus === 'pending') return false;
    if (!showHidden && field.visibility !== 'visible') return false;
    if (categoryFilter !== 'all' && field.category !== categoryFilter) return false;
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    return [field.fieldName, field.description, field.manualNotes, valueDraft(field.value)].join(' ').toLowerCase().includes(needle);
  }), [fields, categoryFilter, search, showHidden]);

  function replaceField(updated: ProjectField) {
    setFields((current) => current.map((field) => field.id === updated.id ? updated : field));
  }

  async function patchField(field: ProjectField, patch: Record<string, unknown>): Promise<boolean> {
    setSaving(true);
    setError(null);
    try { replaceField((await updateProjectField(projectId, field.id, patch)).field); return true; }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to update field'); return false; }
    finally { setSaving(false); }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setSaving(true);
    const fieldName = String(form.get('fieldName') ?? '').trim();
    const description = String(form.get('description') ?? '').trim();
    const required = form.get('required') === 'on';
    const readOnly = form.get('readOnly') === 'on';
      const pinned = form.get('pinned') === 'on';
    const visibility = String(form.get('visibility') ?? 'visible') as 'visible' | 'hidden';
    const orderText = String(form.get('displayOrder') ?? '0');
    const options = newOptions.split(',').map((option) => option.trim()).filter(Boolean);
    try {
      const value = parseDraft(newType, newValue);
      const defaultValue = newDefault === '' ? undefined : parseDraft(newType, newDefault);
      const created = await createProjectField(projectId, {
        fieldName, fieldType: newType, value, description, required, readOnly,
        defaultValue, category: newCategory, displayOrder: Number(orderText) || 0,
        visibility, options, pinned, manualNotes: String(form.get('manualNotes') ?? ''),
      });
      setFields((current) => [...current, created.field]);
      setCreateOpen(false);
      setNewValue('');
      setNewDefault('');
      setNewOptions('');
      setError(null);
      formElement.reset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to create custom field');
    } finally {
      setSaving(false);
    }
  }

  async function decideSuggestion(field: ProjectField, action: 'accept' | 'reject') {
    setSaving(true);
    setError(null);
    try { replaceField((await decideProjectFieldSuggestion(projectId, field.id, action)).field); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to update suggestion'); }
    finally { setSaving(false); }
  }

  async function removeField(field: ProjectField) {
    if (!window.confirm(`Remove “${field.fieldName}” from this project?`)) return;
    setSaving(true);
    try {
      await deleteProjectField(projectId, field.id);
      setFields((current) => current.filter((item) => item.id !== field.id));
      setSelected((current) => { const next = new Set(current); next.delete(field.id); return next; });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to remove field'); }
    finally { setSaving(false); }
  }

  async function restoreField(field: ProjectField) {
    setSaving(true);
    try { replaceField((await restoreAiProjectField(projectId, field.id)).field); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to restore AI value'); }
    finally { setSaving(false); }
  }

  async function uploadAttachment(field: ProjectField, file?: File) {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setError('Attachments must be smaller than 10 MB.'); return; }
    setSaving(true);
    setError(null);
    try { replaceField((await uploadProjectFieldAttachment(projectId, field.id, file)).field); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to attach file'); }
    finally { setSaving(false); }
  }

  async function downloadAttachment(field: ProjectField) {
    const value = field.value as { attachmentId?: string; fileName?: string } | null;
    if (!value?.attachmentId) return;
    setSaving(true);
    try {
      const blob = await downloadProjectFieldAttachment(projectId, field.id, value.attachmentId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = value.fileName ?? field.fieldName;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to download attachment'); }
    finally { setSaving(false); }
  }

  async function saveBulk(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const items = filteredFields.filter((field) => selected.has(field.id));
    try {
      const updates = items.map((field) => ({ fieldId: field.id, value: parseDraft(field.fieldType, bulkDrafts[field.id]) }));
      setSaving(true);
      const response = await bulkUpdateProjectFields(projectId, updates);
      setFields(response.fields);
      setSelected(new Set());
      setBulkOpen(false);
      setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to apply bulk changes'); }
    finally { setSaving(false); }
  }

  async function reorderWithinCategory(category: FieldCategory, sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    const siblings = fields.filter((field) => field.category === category && field.visibility !== 'deleted' && !(field.suggested && field.suggestionStatus === 'pending'));
    const from = siblings.findIndex((field) => field.id === sourceId);
    const to = siblings.findIndex((field) => field.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = siblings.splice(from, 1);
    if (!moved) return;
    siblings.splice(to, 0, moved);
    const orderedIds = siblings.map((field) => field.id);
    setFields((current) => current.map((field) => {
      const index = orderedIds.indexOf(field.id);
      return index < 0 ? field : { ...field, displayOrder: index };
    }));
    try { await reorderProjectFields(projectId, orderedIds); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to reorder fields'); void loadFields(); }
  }

  function toggleSelected(fieldId: string, checked: boolean) {
    setSelected((current) => { const next = new Set(current); checked ? next.add(fieldId) : next.delete(fieldId); return next; });
  }

  const selectedFields = filteredFields.filter((field) => selected.has(field.id));
  const groupedFields = FIELD_CATEGORIES
    .filter((category) => categoryFilter === 'all' || categoryFilter === category)
    .map((category) => ({ category, fields: filteredFields.filter((field) => field.category === category) }))
    .filter((group) => group.fields.length > 0);

  return (
    <Panel id="project-information" label="project workspace" title="Project Information" className="bento__wide" actions={<><Badge tone="outline">{fields.filter((field) => !field.suggested).length} fields</Badge><button className="btn btn--small" type="button" onClick={() => void loadFields()} disabled={loading}>Refresh</button></>}>
      <div className="field-toolbar">
        <input className="field-control" type="search" placeholder="Search fields and values" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search project fields" />
        <select className="field-control" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value as 'all' | FieldCategory)} aria-label="Filter fields by category"><option value="all">All categories</option>{FIELD_CATEGORIES.map((category) => <option value={category} key={category}>{categoryNames[category]}</option>)}</select>
        <label className="field-toggle"><input type="checkbox" checked={showHidden} onChange={(event) => setShowHidden(event.target.checked)} /> Show hidden</label>
        <button className="btn btn--primary" type="button" onClick={() => setCreateOpen((open) => !open)}>{createOpen ? 'Close form' : 'Add custom field'}</button>
      </div>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      {loading ? <p className="muted" aria-live="polite">Loading project information...</p> : null}

      {pendingSuggestions.length > 0 ? <section className="field-suggestions" aria-labelledby="field-suggestions-title">
        <div className="field-section-heading"><div><p className="micro-label">AI suggestions</p><h3 id="field-suggestions-title" className="display">Suggested fields</h3></div><Badge tone="accent">{pendingSuggestions.length} pending</Badge></div>
        <div className="field-suggestion-grid">{pendingSuggestions.map((field) => <article className="field-suggestion" key={field.id}>
          <div><strong>{field.fieldName}</strong><p>{field.description}</p><small>{categoryNames[field.category]} · {typeNames[field.fieldType]}</small></div>
          <div className="field-actions"><button className="btn btn--primary btn--small" disabled={saving} type="button" onClick={() => void decideSuggestion(field, 'accept')}>Accept</button><button className="btn btn--small" disabled={saving} type="button" onClick={() => void decideSuggestion(field, 'reject')}>Reject</button></div>
        </article>)}</div>
      </section> : null}

      {createOpen ? <form className="field-create-form" onSubmit={(event) => void handleCreate(event)}>
        <div className="field-section-heading"><div><p className="micro-label">User-defined</p><h3 className="display">Add a field</h3></div></div>
        <div className="field-form-grid">
          <label>Field Name<input className="field-control" name="fieldName" required maxLength={120} /></label>
          <label>Field Type<select className="field-control" value={newType} onChange={(event) => { setNewType(event.target.value as FieldType); setNewValue(''); setNewDefault(''); }}><option value="">Choose type</option>{FIELD_TYPES.map((type) => <option key={type} value={type}>{typeNames[type]}</option>)}</select></label>
          <label>Category<select className="field-control" value={newCategory} onChange={(event) => setNewCategory(event.target.value as FieldCategory)}>{FIELD_CATEGORIES.map((category) => <option key={category} value={category}>{categoryNames[category]}</option>)}</select></label>
          <label>Value<FieldInput field={{ fieldType: newType, options: newOptions.split(',').map((item) => item.trim()).filter(Boolean), fieldName: 'Value' }} value={newValue} onChange={setNewValue} /></label>
          <label>Default Value<input className="field-control" value={newDefault} onChange={(event) => setNewDefault(event.target.value)} placeholder="Optional" /></label>
          {(newType === 'dropdown' || newType === 'multi_select') ? <label>Options <span>(comma separated)</span><input className="field-control" value={newOptions} onChange={(event) => setNewOptions(event.target.value)} placeholder="Option A, Option B" /></label> : null}
          <label>Description<input className="field-control" name="description" maxLength={1000} /></label>
          <label>Display Order<input className="field-control" name="displayOrder" type="number" min="0" defaultValue="0" /></label>
          <label>Visibility<select className="field-control" name="visibility" defaultValue="visible"><option value="visible">Visible</option><option value="hidden">Hidden</option></select></label>
          <label className="field-checkbox"><input type="checkbox" name="required" /> Required</label>
          <label className="field-checkbox"><input type="checkbox" name="readOnly" /> Read only</label>
          <label className="field-checkbox"><input type="checkbox" name="pinned" /> Pin this field</label>
          <label className="field-span-all">Manual Notes<textarea className="field-control field-control--textarea" name="manualNotes" maxLength={5000} /></label>
        </div>
        <div className="field-actions"><button className="btn btn--primary" disabled={saving} type="submit">Create field</button></div>
      </form> : null}

      {selectedFields.length > 0 ? <section className="field-bulk-toolbar">
        <div className="field-section-heading"><strong>{selectedFields.length} fields selected</strong><div className="field-actions"><button className="btn btn--small" type="button" onClick={() => {
          setBulkDrafts(Object.fromEntries(selectedFields.map((field) => [field.id, valueDraft(field.value)])));
          setBulkOpen((open) => !open);
        }}>{bulkOpen ? 'Cancel bulk edit' : 'Bulk edit'}</button><button className="btn btn--small" type="button" onClick={() => setSelected(new Set())}>Clear</button></div></div>
        {bulkOpen ? <form className="field-bulk-editor" onSubmit={(event) => void saveBulk(event)}>{selectedFields.map((field) => <label key={field.id}>{field.fieldName}<FieldInput field={field} value={bulkDrafts[field.id]} onChange={(value) => setBulkDrafts((current) => ({ ...current, [field.id]: value }))} /></label>)}<button className="btn btn--primary" type="submit" disabled={saving}>Save selected fields</button></form> : null}
      </section> : null}

      {!loading && filteredFields.length === 0 ? <p className="muted">No matching fields. Run project analysis or add a custom field.</p> : null}
      <div className="field-category-list">{groupedFields.map(({ category, fields: categoryFields }) => {
        const isCollapsed = collapsed.has(category);
        return <section className="field-category" key={category}>
          <button className="field-category__toggle" type="button" aria-expanded={!isCollapsed} onClick={() => setCollapsed((current) => { const next = new Set(current); isCollapsed ? next.delete(category) : next.add(category); return next; })}>
            <span><span className="micro-label">{categoryNames[category]}</span><strong>{categoryFields.length} fields</strong></span><span aria-hidden="true">{isCollapsed ? '+' : '−'}</span>
          </button>
          {!isCollapsed ? <div className="field-grid">{categoryFields.map((field) => <article className={`project-field-card ${field.pinned ? 'project-field-card--pinned' : ''}`} key={field.id} draggable onDragStart={() => setDraggedId(field.id)} onDragEnd={() => setDraggedId(null)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (draggedId) void reorderWithinCategory(category, draggedId, field.id); setDraggedId(null); }}>
            <div className="project-field-card__heading">
              <label className="field-select"><input type="checkbox" checked={selected.has(field.id)} disabled={!field.editable || field.readOnly || field.fieldType === 'file_attachment'} onChange={(event) => toggleSelected(field.id, event.target.checked)} aria-label={`Select ${field.fieldName} for bulk editing`} /></label>
              <div className="project-field-card__title"><strong>{field.fieldName}</strong><span>{typeNames[field.fieldType]}</span></div>
              <button className="field-icon-button" type="button" title={field.pinned ? 'Unpin field' : 'Pin field'} aria-label={field.pinned ? 'Unpin field' : 'Pin field'} onClick={() => void patchField(field, { pinned: !field.pinned })}>{field.pinned ? '★' : '☆'}</button>
            </div>
            {field.description ? <p className="project-field-card__description">{field.description}</p> : null}
            {field.fieldType === 'file_attachment' ? <div className="field-file-control">
              {field.value ? <button className="field-link-button" type="button" onClick={() => void downloadAttachment(field)}>{displayValue(field)} · Download</button> : <span className="muted">No file attached</span>}
              {!field.readOnly && field.editable ? <input type="file" disabled={saving} aria-label={`Attach file to ${field.fieldName}`} onChange={(event) => { void uploadAttachment(field, event.target.files?.[0]); event.currentTarget.value = ''; }} /> : null}
            </div> : null}
            {field.fieldType === 'json' && !field.editable ? <pre className="project-field-card__value">{displayValue(field)}</pre> : null}
            {field.fieldType !== 'file_attachment' ? <FieldCardValue field={field} saving={saving} onSave={(value) => void patchField(field, { value })} /> : null}
            {field.key.startsWith('custom:') ? <details className="field-notes"><summary>Edit field settings</summary><FieldSettingsEditor field={field} disabled={saving} onSave={(patch) => patchField(field, patch)} /></details> : null}
            <div className="field-metadata"><span>Source: {field.source}{field.userEdited && field.aiSource ? ` · AI: ${field.aiSource}` : ''}</span>{(field.confidenceScore ?? field.aiConfidenceScore) != null ? <span>Confidence: {Math.round(((field.confidenceScore ?? field.aiConfidenceScore) ?? 0) * 100)}%</span> : <span>Confidence: user supplied / not scored</span>}<span>Updated: {new Date(field.updatedAt).toLocaleDateString()}</span><span>Generated by: {field.generatedBy ?? field.source}</span>{field.aiUpdatedAt ? <span>AI updated: {new Date(field.aiUpdatedAt).toLocaleDateString()}</span> : null}{field.required ? <span>Required</span> : null}{field.readOnly ? <span>Read only</span> : null}</div>
            <NotesEditor value={field.manualNotes} disabled={saving} onSave={(manualNotes) => void patchField(field, { manualNotes })} />
            <div className="field-actions field-actions--card">
              {field.userEdited && field.aiValue !== null ? <button className="btn btn--small" type="button" disabled={saving} onClick={() => void restoreField(field)}>Restore AI value</button> : null}
              <button className="btn btn--small" type="button" disabled={saving} onClick={() => void patchField(field, { visibility: field.visibility === 'visible' ? 'hidden' : 'visible' })}>{field.visibility === 'visible' ? 'Hide' : 'Show'}</button>
              <button className="btn btn--danger btn--small" type="button" disabled={saving} onClick={() => void removeField(field)}>Remove</button>
              <span className="field-drag-handle" title="Drag to reorder" aria-label="Drag to reorder">⋮⋮</span>
            </div>
          </article>)}</div> : null}
        </section>;
      })}</div>
    </Panel>
  );
}

function FieldCardValue({ field, saving, onSave }: { field: ProjectField; saving: boolean; onSave: (value: unknown) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<unknown>(field.value);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(field.value); }, [field.id, field.value]);
  if (editing) return <form className="field-value-editor" onSubmit={(event) => {
    event.preventDefault();
    try { onSave(parseDraft(field.fieldType, draft)); setEditing(false); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Invalid value'); }
  }}><FieldInput field={field} value={draft} onChange={setDraft} disabled={saving} />{error ? <span className="form-error">{error}</span> : null}<div className="field-actions"><button className="btn btn--primary btn--small" type="submit" disabled={saving}>Save</button><button className="btn btn--small" type="button" onClick={() => { setDraft(field.value); setEditing(false); setError(null); }}>Cancel</button></div></form>;

  return <div className="project-field-card__value-wrap"><div className={`project-field-card__value ${field.fieldType === 'json' ? 'project-field-card__value--json' : ''}`}>{field.fieldType === 'json' ? displayValue(field) : field.fieldType === 'rich_text' ? <RichTextValue value={typeof field.value === 'string' ? field.value : ''} /> : <p>{displayValue(field)}</p>}</div>{field.editable && !field.readOnly ? <button className="field-link-button" type="button" disabled={saving} onClick={() => { setDraft(field.value); setEditing(true); }}>Edit value</button> : null}</div>;
}

function NotesEditor({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return <details className="field-notes"><summary>{value ? 'Edit notes' : 'Add notes'}</summary><textarea className="field-control field-control--textarea" value={draft} maxLength={5000} onChange={(event) => setDraft(event.target.value)} aria-label="Manual notes" /><button className="btn btn--small" type="button" disabled={disabled || draft === value} onClick={() => onSave(draft)}>Save notes</button></details>;
}

function FieldSettingsEditor({ field, disabled, onSave }: { field: ProjectField; disabled: boolean; onSave: (patch: Record<string, unknown>) => Promise<boolean> }) {
  const [name, setName] = useState(field.fieldName);
  const [type, setType] = useState<FieldType>(field.fieldType);
  const [category, setCategory] = useState<FieldCategory>(field.category);
  const [description, setDescription] = useState(field.description);
  const [defaultDraft, setDefaultDraft] = useState(valueDraft(field.defaultValue));
  const [optionsDraft, setOptionsDraft] = useState(field.options.join(', '));
  const [required, setRequired] = useState(field.required);
  const [readOnly, setReadOnly] = useState(field.readOnly);
  const [visibility, setVisibility] = useState<'visible' | 'hidden'>(field.visibility === 'hidden' ? 'hidden' : 'visible');
  const [displayOrder, setDisplayOrder] = useState(String(field.displayOrder));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(field.fieldName);
    setType(field.fieldType);
    setCategory(field.category);
    setDescription(field.description);
    setDefaultDraft(valueDraft(field.defaultValue));
    setOptionsDraft(field.options.join(', '));
    setRequired(field.required);
    setReadOnly(field.readOnly);
    setVisibility(field.visibility === 'hidden' ? 'hidden' : 'visible');
    setDisplayOrder(String(field.displayOrder));
  }, [field]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const options = optionsDraft.split(',').map((item) => item.trim()).filter(Boolean);
      const defaultValue = defaultDraft === '' ? null : parseDraft(type, defaultDraft);
      const patch: Record<string, unknown> = {
        fieldName: name.trim(), fieldType: type, category, description, defaultValue,
        required, readOnly, editable: !readOnly, visibility,
        displayOrder: Math.max(0, Number(displayOrder) || 0), options,
      };
      if (type !== field.fieldType) patch.value = parseDraft(type, field.value);
      if (await onSave(patch)) setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Invalid field settings'); }
  }

  return <form className="field-settings-form" onSubmit={(event) => void submit(event)}>
    <label>Field Name<input className="field-control" value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} /></label>
    <label>Field Type<select className="field-control" value={type} disabled={disabled || field.readOnly} onChange={(event) => setType(event.target.value as FieldType)}>{FIELD_TYPES.map((item) => <option key={item} value={item}>{typeNames[item]}</option>)}</select></label>
    <label>Category<select className="field-control" value={category} onChange={(event) => setCategory(event.target.value as FieldCategory)}>{FIELD_CATEGORIES.map((item) => <option key={item} value={item}>{categoryNames[item]}</option>)}</select></label>
    <label>Description<input className="field-control" value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} /></label>
    <label>Default Value<input className="field-control" value={defaultDraft} onChange={(event) => setDefaultDraft(event.target.value)} /></label>
    {(type === 'dropdown' || type === 'multi_select') ? <label>Options<input className="field-control" value={optionsDraft} onChange={(event) => setOptionsDraft(event.target.value)} placeholder="Separate options with commas" /></label> : null}
    <label>Display Order<input className="field-control" type="number" min="0" value={displayOrder} onChange={(event) => setDisplayOrder(event.target.value)} /></label>
    <label>Visibility<select className="field-control" value={visibility} onChange={(event) => setVisibility(event.target.value as 'visible' | 'hidden')}><option value="visible">Visible</option><option value="hidden">Hidden</option></select></label>
    <label className="field-checkbox"><input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} /> Required</label>
    <label className="field-checkbox"><input type="checkbox" checked={readOnly} onChange={(event) => setReadOnly(event.target.checked)} /> Read only</label>
    {error ? <span className="form-error">{error}</span> : null}
    <button className="btn btn--small" type="submit" disabled={disabled}>Save field settings</button>
  </form>;
}
