import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { Badge } from './components/Badge';
import { Panel } from './components/Panel';
import { ProjectInformationPanel } from './components/ProjectInformationPanel';
import { ProjectChatPanel } from './components/ProjectChatPanel';
import { getOrCreateWorkspaceUser } from './services/auth-api';
import { API_BASE_URL } from './services/api-client';
import { createProject, deleteProject, discoverProjectFields, editProjectCaseStudySection, generateProjectReport, getProjectCaseStudyVersion, listProjectCaseStudies, listProjects, runProjectAnalysis, type CaseStudySectionEditInput } from './services/project-api';
import type { AuthUser } from './types/auth';
import type { CaseStudySummary, Project } from './types/projects';

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsBusy, setProjectsBusy] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectDeleteConfirmationId, setProjectDeleteConfirmationId] = useState<string | null>(null);
  const [projectDeletingId, setProjectDeletingId] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projectChatOpen, setProjectChatOpen] = useState(false);
  const projectChatDialogRef = useRef<HTMLDialogElement>(null);
  const [activeCaseStudyId, setActiveCaseStudyId] = useState<string | null>(null);
  const [caseStudyHistory, setCaseStudyHistory] = useState<CaseStudySummary[]>([]);
  const [historyBusyId, setHistoryBusyId] = useState<string | null>(null);
  const [caseStudy, setCaseStudy] = useState<Record<string, unknown> | null>(null);
  const [analysisBusyId, setAnalysisBusyId] = useState<string | null>(null);
  const [reportBusyId, setReportBusyId] = useState<string | null>(null);
  const [projectCreatingBusy, setProjectCreatingBusy] = useState(false);
  const [fieldDiscoveryBusyIds, setFieldDiscoveryBusyIds] = useState<Set<string>>(new Set());
  const [fieldDiscoveryErrors, setFieldDiscoveryErrors] = useState<Record<string, string>>({});
  const [informationRefreshToken, setInformationRefreshToken] = useState(0);
  const [reportEditBusy, setReportEditBusy] = useState(false);
  const [reportEditError, setReportEditError] = useState<string | null>(null);

  useEffect(() => {
    setProjectChatOpen(false);
  }, [activeProjectId]);

  useEffect(() => {
    const dialog = projectChatDialogRef.current;
    if (!dialog) return;
    if (projectChatOpen && !dialog.open) dialog.showModal();
    else if (!projectChatOpen && dialog.open) dialog.close();
  }, [projectChatOpen]);

  useEffect(() => {
    let active = true;
    void getOrCreateWorkspaceUser()
      .then((currentUser) => { if (active) setUser(currentUser); })
      .catch((error: unknown) => { if (active) setWorkspaceError(error instanceof Error ? error.message : 'Unable to open workspace'); })
      .finally(() => { if (active) setWorkspaceLoading(false); });
    return () => { active = false; };
  }, []);

  function retryWorkspace() {
    setWorkspaceLoading(true);
    setWorkspaceError(null);
    void getOrCreateWorkspaceUser()
      .then(setUser)
      .catch((error: unknown) => setWorkspaceError(error instanceof Error ? error.message : 'Unable to open workspace'))
      .finally(() => setWorkspaceLoading(false));
  }

  async function refreshProjects() {
    setProjectsBusy(true);
    setProjectError(null);
    try {
      const result = await listProjects();
      setProjects(result.projects);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : 'Unable to load projects');
    } finally {
      setProjectsBusy(false);
    }
  }

  useEffect(() => {
    if (!user) {
      setProjects([]);
      return;
    }
    void refreshProjects();
  }, [user?.id]);

  async function handleCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProjectError(null);
    const form = new FormData(event.currentTarget);
    const formElement = event.currentTarget;
    const name = String(form.get('name') ?? '').trim();
    const websiteUrl = String(form.get('websiteUrl') ?? '').trim() || null;
    const githubUrl = String(form.get('githubUrl') ?? '').trim() || null;

    setProjectCreatingBusy(true);
    try {
      const project = await createProject({ name, websiteUrl, githubUrl });
      formElement.reset();
      setProjects((current) => [project, ...current]);
      setActiveProjectId(project.id);
      setActiveCaseStudyId(null);
      setCaseStudy(null);
      setCaseStudyHistory([]);
      setFieldDiscoveryErrors((current) => { const next = { ...current }; delete next[project.id]; return next; });
      void handleDiscoverFields(project.id);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : 'Unable to create project');
    } finally {
      setProjectCreatingBusy(false);
    }
  }

  async function handleDiscoverFields(id: string, refresh = false) {
    setFieldDiscoveryBusyIds((current) => new Set(current).add(id));
    setFieldDiscoveryErrors((current) => { const next = { ...current }; delete next[id]; return next; });
    try {
      const result = await discoverProjectFields(id, refresh);
      setProjects((current) => current.map((project) => project.id === id
        ? { ...project, fieldDiscoveryStatus: result.status }
        : project));
      setInformationRefreshToken((current) => current + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to collect project information';
      setFieldDiscoveryErrors((current) => ({ ...current, [id]: message }));
      setProjects((current) => current.map((project) => project.id === id
        ? { ...project, fieldDiscoveryStatus: 'failed' }
        : project));
    } finally {
      setFieldDiscoveryBusyIds((current) => { const next = new Set(current); next.delete(id); return next; });
    }
  }

  function handleSelectProjectInformation(project: Project) {
    setFieldDiscoveryErrors((current) => { const next = { ...current }; delete next[project.id]; return next; });
    if (activeProjectId !== project.id) {
      setCaseStudy(null);
      setActiveCaseStudyId(null);
      setCaseStudyHistory([]);
    }
    setActiveProjectId(project.id);
    if ((project.fieldDiscoveryStatus === 'not_started' || project.fieldDiscoveryStatus === 'failed') && !fieldDiscoveryBusyIds.has(project.id)) {
      void handleDiscoverFields(project.id);
    }
    void refreshCaseStudyHistory(project.id);
  }

  async function handleDeleteProject(id: string) {
    setProjectDeletingId(id);
    try {
      await deleteProject(id);
      setProjects((current) => current.filter((project) => project.id !== id));
      setProjectDeleteConfirmationId(null);
      if (activeProjectId === id) {
        setActiveProjectId(null);
        setActiveCaseStudyId(null);
        setCaseStudy(null);
        setCaseStudyHistory([]);
      }
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : 'Unable to delete project');
    } finally {
      setProjectDeletingId(null);
    }
  }

  async function handleAnalysis(id: string) {
    setAnalysisBusyId(id);
    setProjectError(null);
    setActiveProjectId(id);
    setCaseStudy(null);
    setActiveCaseStudyId(null);
    setCaseStudyHistory([]);
    try {
      const result = await runProjectAnalysis(id);
      setCaseStudy(result.content);
      setActiveCaseStudyId(result.caseStudyId);
      await refreshProjects();
      await refreshCaseStudyHistory(id);
      document.querySelector('#report-preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : 'Analysis failed');
    } finally {
      setAnalysisBusyId(null);
    }
  }

  async function refreshCaseStudyHistory(id: string) {
    setActiveProjectId(id);
    setHistoryBusyId(id);
    try {
      const result = await listProjectCaseStudies(id);
      setCaseStudyHistory(result.caseStudies);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : 'Unable to load analysis history');
    } finally {
      setHistoryBusyId((current) => current === id ? null : current);
    }
  }

  async function handleSelectHistory(projectId: string, caseStudyId: string) {
    setActiveProjectId(projectId);
    setProjectError(null);
    try {
      const result = await getProjectCaseStudyVersion(projectId, caseStudyId);
      setCaseStudy(result.content);
      setActiveCaseStudyId(result.id);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : 'Unable to load saved analysis');
    }
  }

  async function handleReport(id: string, caseStudyId?: string) {
    setReportBusyId(id);
    setProjectError(null);
    try {
      const report = await generateProjectReport(id, caseStudyId);
      const origin = API_BASE_URL.replace(/\/api\/v1$/, '');
      const response = await fetch(`${origin}${report.downloadUrl}`, { credentials: 'include' });
      if (!response.ok) throw new Error('Unable to download PDF report');
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = report.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : 'Unable to generate report');
    } finally {
      setReportBusyId(null);
    }
  }

  async function handleEditReportSection(input: CaseStudySectionEditInput): Promise<boolean> {
    if (!activeProjectId || !activeCaseStudyId) return false;
    setReportEditBusy(true);
    setReportEditError(null);
    try {
      const result = await editProjectCaseStudySection(activeProjectId, activeCaseStudyId, input);
      setCaseStudy(result.content);
      setActiveCaseStudyId(result.caseStudyId);
      await refreshCaseStudyHistory(activeProjectId);
      return true;
    } catch (error) {
      setReportEditError(error instanceof Error ? error.message : 'Unable to update this report section');
      return false;
    } finally {
      setReportEditBusy(false);
    }
  }

  if (workspaceLoading) {
    return <div className="app-shell app-shell--loading"><main className="loading-card" aria-live="polite"><Panel label="private workspace" title="Opening your dashboard"><p className="muted">Preparing your private workspace...</p></Panel></main></div>;
  }

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <a className="brand-lockup" href="/" aria-label="Case Study Tool home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
          <span className="brand-lockup__text"><strong>Case Study</strong><small>Project intelligence</small></span>
        </a>

        <div className="sidebar-workspace">
          <span className="sidebar-workspace__label">Workspace</span>
          <div className="sidebar-workspace__current"><span className="workspace-avatar">{user?.name?.trim().charAt(0).toUpperCase() || 'W'}</span><span>{user?.name || 'Private workspace'}</span><span className="workspace-chevron" aria-hidden="true" /></div>
        </div>

        <nav className="sidebar-nav" aria-label="Primary navigation">
          <span className="sidebar-nav__label">Workspace</span>
          <a className="sidebar-nav__link sidebar-nav__link--active" href="#projects" aria-current="page"><span className="sidebar-nav__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7.5h6l2 2h8v9H4z" /><path d="M4 7.5V5h6l2 2h4" /></svg></span>Projects<span className="sidebar-nav__count">{projects.length}</span></a>
          <a className="sidebar-nav__link" href="#analysis-history"><span className="sidebar-nav__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4 9.5" /><path d="M4 5v4.5h4.5M12 8v4l2.5 1.5" /></svg></span>Analysis history</a>
          <a className="sidebar-nav__link" href="#report-preview"><span className="sidebar-nav__icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 3.75h8l4 4v12.5H6z" /><path d="M14 3.75v4h4M9 12h6M9 15.5h6" /></svg></span>Reports</a>
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-tip"><span className="sidebar-tip__spark" aria-hidden="true" /><div><strong>Start with evidence</strong><p>Add a website or repository to build your project profile.</p></div></div>
          <div className="sidebar-profile"><span className="sidebar-profile__avatar">{user?.name?.trim().charAt(0).toUpperCase() || 'W'}</span><span className="sidebar-profile__text"><strong>{user?.name || 'Workspace'}</strong><small>Private workspace</small></span><span className="sidebar-profile__status" aria-hidden="true" /></div>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar__breadcrumb"><span>Workspace</span><span className="topbar__slash">/</span><strong>Projects</strong></div>
          <div className="topbar__actions"><span className="workspace-pill"><span className="workspace-pill__dot" />Private workspace</span></div>
        </header>

        <main id="console" className="dashboard-main">
          {workspaceError ? <Panel label="workspace connection" title="Unable to open dashboard"><p className="form-error" role="alert">{workspaceError}</p><button className="btn" type="button" onClick={retryWorkspace}>Retry connection</button></Panel> : null}
          <header className="page-heading">
            <div className="page-heading__copy"><p className="page-eyebrow"><span />Project intelligence <span className="page-eyebrow__slash">/</span> Dashboard</p><h1 className="display hero-title">Your project workspace</h1><p>Bring your product story into focus with evidence from your website and repository.</p></div>
            <a className="btn btn--primary page-heading__action" href="#create-project"><span aria-hidden="true">+</span>New project</a>
          </header>

          <div className="bento">
            <Panel id="create-project" label="Start a project" title="Collect analysis sources" variant="hero" className="bento__wide">
              <form className="project-form" onSubmit={(event) => void handleCreateProject(event)}>
                <label>Project name<input name="name" required minLength={2} maxLength={120} placeholder="Example product analysis" /></label>
                <label>Website URL <span>(optional with GitHub)</span><input name="websiteUrl" type="url" placeholder="https://example.com" /></label>
                <label>GitHub repository <span>(optional with website)</span><input name="githubUrl" type="url" placeholder="https://github.com/owner/repository" /></label>
                {projectError ? <p className="form-error" role="alert">{projectError}</p> : null}
                <button className="btn btn--invert" type="submit" disabled={projectCreatingBusy}>{projectCreatingBusy ? 'Creating project...' : 'Create project'}</button>
              </form>
            </Panel>

            <Panel id="projects" label="workspace" title="Your projects" actions={projectsBusy ? <Badge tone="muted">Loading</Badge> : <Badge tone="outline">{projects.length} projects</Badge>} className="bento__wide">
              {projects.length === 0 && !projectsBusy ? <p className="muted">No projects yet. Create one above to collect its project fields.</p> : null}
              {projectsBusy ? <p className="muted">Loading projects...</p> : null}
              <div className="project-list">
                {projects.map((project) => (
                  <article className="project-row" key={project.id}>
                    <div className="project-row__main"><span className="micro-label">{project.fieldDiscoveryStatus === 'completed' || project.fieldDiscoveryStatus === 'completed_with_warnings' ? 'Fields ready' : project.fieldDiscoveryStatus === 'running' || fieldDiscoveryBusyIds.has(project.id) ? 'Collecting fields' : project.fieldDiscoveryStatus === 'failed' ? 'Field collection failed' : project.status}</span><h3 className="display text-[16px]">{project.name}</h3>{project.websiteUrl ? <a href={project.websiteUrl} target="_blank" rel="noreferrer">{project.websiteUrl}</a> : null}{project.githubUrl ? <a href={project.githubUrl} target="_blank" rel="noreferrer">{project.githubUrl}</a> : null}</div>
                    <div className="project-row__actions"><button className="btn" type="button" onClick={() => handleSelectProjectInformation(project)}>Information</button><button className="btn" type="button" disabled={historyBusyId === project.id} onClick={() => { if (activeProjectId !== project.id) { setCaseStudy(null); setActiveCaseStudyId(null); } void refreshCaseStudyHistory(project.id); }}>{historyBusyId === project.id ? 'Loading...' : 'History'}</button><button className="btn btn--danger" type="button" disabled={projectDeletingId === project.id} onClick={() => setProjectDeleteConfirmationId((current) => current === project.id ? null : project.id)}>Delete</button></div>
                    {projectDeleteConfirmationId === project.id ? <div className="inline-delete-confirm" role="group" aria-label={`Confirm deleting ${project.name}`}>
                      <p>Delete <strong>{project.name}</strong>? This removes its project information, reports, and chat history.</p>
                      <div className="field-actions"><button className="btn btn--small" type="button" disabled={projectDeletingId === project.id} onClick={() => setProjectDeleteConfirmationId(null)}>Cancel</button><button className="btn btn--danger btn--small" type="button" disabled={projectDeletingId === project.id} onClick={() => void handleDeleteProject(project.id)}>{projectDeletingId === project.id ? 'Deleting...' : 'Delete project'}</button></div>
                    </div> : null}
                  </article>
                ))}
              </div>
            </Panel>

            {activeProjectId ? <ProjectInformationPanel
              key={activeProjectId}
              projectId={activeProjectId}
              refreshToken={informationRefreshToken}
              discoveryStatus={projects.find((project) => project.id === activeProjectId)?.fieldDiscoveryStatus ?? 'not_started'}
              discoveryBusy={fieldDiscoveryBusyIds.has(activeProjectId)}
              discoveryError={fieldDiscoveryBusyIds.has(activeProjectId) ? null : fieldDiscoveryErrors[activeProjectId] ?? null}
              onRetryDiscovery={() => void handleDiscoverFields(activeProjectId, true)}
              onViewCaseStudy={() => void handleAnalysis(activeProjectId)}
              creatingCaseStudy={analysisBusyId === activeProjectId}
            /> : null}

            {activeProjectId ? <>
              <button className="project-chat-launcher__button" type="button" aria-haspopup="dialog" aria-expanded={projectChatOpen} aria-controls="project-ai-chat-dialog" onClick={() => setProjectChatOpen(true)}>
                <span className="project-chat-launcher__icon" aria-hidden="true">AI</span>
                <span>Ask AI</span>
              </button>
              <dialog ref={projectChatDialogRef} id="project-ai-chat-dialog" className="project-chat-dialog" aria-labelledby="project-ai-chat-title" onClose={() => setProjectChatOpen(false)}>
                <header className="project-chat-dialog__header">
                  <div><p className="micro-label">Project assistant</p><h2 id="project-ai-chat-title">Ask AI about {projects.find((project) => project.id === activeProjectId)?.name ?? 'this project'}</h2></div>
                  <button className="project-chat-dialog__close" type="button" aria-label="Close project assistant" onClick={() => setProjectChatOpen(false)}>Close</button>
                </header>
                <div className="project-chat-dialog__body"><ProjectChatPanel key={activeProjectId} projectId={activeProjectId} /></div>
              </dialog>
            </> : null}

            {activeProjectId ? <Panel id="analysis-history" label="saved analyses" title="Analysis history" actions={historyBusyId === activeProjectId ? <Badge tone="muted">Loading</Badge> : <Badge tone="outline">{caseStudyHistory.length} versions</Badge>} className="bento__wide">
              {historyBusyId === activeProjectId ? <p className="muted">Loading saved analyses...</p> : null}
              {historyBusyId !== activeProjectId && caseStudyHistory.length === 0 ? <p className="muted">No saved analyses for this project yet.</p> : null}
              <div className="history-list">{caseStudyHistory.map((item) => <article className={`history-row ${item.id === activeCaseStudyId ? 'history-row--active' : ''}`} key={item.id}>
                <div><span className="micro-label">{item.status}</span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></div>
                <div className="project-row__actions"><button className="btn" type="button" onClick={() => void handleSelectHistory(activeProjectId, item.id)}>{item.id === activeCaseStudyId ? 'Viewing' : 'View'}</button><button className="btn" type="button" disabled={reportBusyId === activeProjectId} onClick={() => void handleReport(activeProjectId, item.id)}>{reportBusyId === activeProjectId ? 'Building...' : 'PDF'}</button></div>
              </article>)}</div>
            </Panel> : null}

            <Panel id="report-preview" label="case study" title="Report preview" actions={activeCaseStudyId && activeProjectId ? <><Badge tone="outline">Saved case study</Badge><button className="btn btn--small" type="button" disabled={reportBusyId === activeProjectId} onClick={() => void handleReport(activeProjectId, activeCaseStudyId)}>{reportBusyId === activeProjectId ? 'Preparing PDF...' : 'Download PDF'}</button></> : <Badge tone="muted">No selection</Badge>} className="bento__wide">
              {reportEditError ? <p className="form-error" role="alert">{reportEditError}</p> : null}
              {!caseStudy ? <p className="muted">Review and finalize the Project Information fields, then select View Case Study to create the report.</p> : <CaseStudyPreview content={caseStudy} onEdit={handleEditReportSection} busy={reportEditBusy} />}
            </Panel>

          </div>
        </main>
        <footer className="workspace-footer"><span>Case Study Tool</span><span>Private project workspace</span></footer>
      </div>
    </div>
  );
}

function previewText(value: unknown, depth = 0): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => previewText(item, depth + 1)).join('\n');
  if (value && typeof value === 'object') {
    if (depth >= 5) return 'Further nested details are available in the PDF report.';
    return Object.entries(value as Record<string, unknown>).slice(0, 30)
      .map(([key, child]) => `${fieldLabel(key)}: ${previewText(child, depth + 1)}`)
      .join('\n');
  }
  if (value == null) return 'Not available';
  return String(value);
}

function fieldLabel(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function ReportValue({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (value == null) return <p className="muted">Not available</p>;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return <p>{String(value)}</p>;
  if (depth >= 5) return <p>{previewText(value)}</p>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <p className="muted">No data collected.</p>;
    const records = value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
    if (records.length === value.length) {
      const columns = [...new Set(records.flatMap((record) => Object.keys(record)))].slice(0, 6);
      return <div className="report-preview__table-wrap"><table className="report-preview__table"><thead><tr>{columns.map((column) => <th scope="col" key={column}>{fieldLabel(column)}</th>)}</tr></thead><tbody>{records.slice(0, 40).map((record, rowIndex) => <tr key={rowIndex}>{columns.map((column) => <td key={column}>{previewText(record[column])}</td>)}</tr>)}</tbody></table></div>;
    }
    return <ul className="report-preview__list">{value.slice(0, 40).map((item, index) => <li key={index}><ReportValue value={item} depth={depth + 1} /></li>)}</ul>;
  }

  const entries = Object.entries(value as Record<string, unknown>).slice(0, 30);
  return entries.length === 0
    ? <p className="muted">No data collected.</p>
    : <dl className="report-preview__fields">{entries.map(([key, child]) => <div className="report-preview__field" key={key}><dt>{fieldLabel(key)}</dt><dd><ReportValue value={child} depth={depth + 1} /></dd></div>)}</dl>;
}

function CaseStudyPreview({ content, onEdit, busy }: {
  content: Record<string, unknown>;
  onEdit: (input: CaseStudySectionEditInput) => Promise<boolean>;
  busy: boolean;
}) {
  const sections = ['executiveSummary','projectOverview','businessBackground','problemStatement','objectives','websiteAnalysis','technicalArchitecture','technologyStack','repositoryAnalysis','businessModel','targetAudience','marketAnalysis','competitorAnalysis','competitorComparison','businessScope','marketOpportunities','revenueModel','profitabilityAnalysis','risksAndLimitations','swotAnalysis','recommendations','growthStrategy','implementationRoadmap','conclusion'];
  const [editing, setEditing] = useState<{ key: string; title: string; action: 'expand' | 'rewrite' | 'replace' } | null>(null);
  const [editText, setEditText] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newInstruction, setNewInstruction] = useState('');
  const customSections = Array.isArray(content.customSections)
    ? content.customSections.filter((item): item is { id: string; title: string; content: unknown } => Boolean(item) && typeof item === 'object' &&
      typeof (item as Record<string, unknown>).id === 'string' && typeof (item as Record<string, unknown>).title === 'string')
    : [];
  const availableSections = sections.filter((key) => Object.hasOwn(content, key)).map((key) => ({ key, title: fieldLabel(key), value: content[key] }));
  const reportSections = [
    ...availableSections,
    ...customSections.map((section) => ({ key: `custom:${section.id}`, title: section.title, value: section.content })),
  ];

  async function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const saved = await onEdit({
      action: editing.action,
      sectionKey: editing.key,
      ...(editing.action === 'replace' ? { replacement: editText } : { instruction: editText }),
    });
    if (saved) { setEditing(null); setEditText(''); }
  }

  async function addSection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await onEdit({ action: 'add', sectionTitle: newTitle.trim(), instruction: newInstruction.trim() });
    if (saved) { setNewTitle(''); setNewInstruction(''); }
  }

  function openEditor(key: string, title: string, action: 'expand' | 'rewrite' | 'replace', value: unknown) {
    setEditing({ key, title, action });
    setEditText(action === 'replace' ? previewText(value) : '');
  }

  return <div className="report-preview">
    <form className="report-editor__add" onSubmit={(event) => void addSection(event)}>
      <div><strong>Add a report section</strong><p className="muted">Generate one section from retrieved project evidence. Existing sections remain unchanged.</p></div>
      <label>Section title<input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} maxLength={120} required /></label>
      <label>What should it cover?<textarea value={newInstruction} onChange={(event) => setNewInstruction(event.target.value)} maxLength={1000} rows={2} required /></label>
      <button className="btn btn--primary" type="submit" disabled={busy}>{busy ? 'Saving section...' : 'Add with AI'}</button>
    </form>
    {reportSections.map(({ key, title, value }) => <section className="report-preview__section" key={key}>
      <div className="report-preview__section-heading"><h3>{title}</h3><div className="report-editor__actions">
        <button className="btn btn--small" type="button" disabled={busy} onClick={() => openEditor(key, title, 'expand', value)}>Expand</button>
        <button className="btn btn--small" type="button" disabled={busy} onClick={() => openEditor(key, title, 'rewrite', value)}>Rewrite</button>
        <button className="btn btn--small" type="button" disabled={busy} onClick={() => openEditor(key, title, 'replace', value)}>Replace</button>
        <button className="btn btn--small btn--danger" type="button" disabled={busy} onClick={() => void onEdit({ action: 'remove', sectionKey: key })}>Remove</button>
      </div></div>
      <div className="report-preview__content"><ReportValue value={value} /></div>
      {editing?.key === key ? <form className="report-editor__form" onSubmit={(event) => void submitEdit(event)}>
        <label>{editing.action === 'replace' ? `Replacement text for ${editing.title}` : `Instructions to ${editing.action} ${editing.title}`}<textarea value={editText} onChange={(event) => setEditText(event.target.value)} rows={5} maxLength={editing.action === 'replace' ? 30000 : 1000} required={editing.action === 'replace'} placeholder={editing.action === 'replace' ? 'Enter the complete section text' : 'Optional guidance for the AI edit'} /></label>
        <div className="report-editor__actions"><button className="btn btn--primary" type="submit" disabled={busy}>{busy ? 'Saving version...' : 'Save new version'}</button><button className="btn" type="button" onClick={() => setEditing(null)}>Cancel</button></div>
      </form> : null}
    </section>)}
  </div>;
}
