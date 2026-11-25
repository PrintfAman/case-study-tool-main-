import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { BackendStatusPanel } from './components/BackendStatusPanel';
import { Badge } from './components/Badge';
import { DependenciesPanel } from './components/DependenciesPanel';
import { LiveStatusChip } from './components/LiveStatusChip';
import { Panel } from './components/Panel';
import { ProjectInformationPanel } from './components/ProjectInformationPanel';
import { useApiHealth } from './hooks/useApiHealth';
import { getOrCreateWorkspaceUser } from './services/auth-api';
import { API_BASE_URL } from './services/api-client';
import { createProject, deleteProject, generateProjectReport, getProjectCaseStudy, getProjectCaseStudyVersion, listProjectCaseStudies, listProjects, runProjectAnalysis } from './services/project-api';
import type { AuthUser } from './types/auth';
import type { CaseStudySummary, Project } from './types/projects';

export default function App() {
  const health = useApiHealth();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsBusy, setProjectsBusy] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeCaseStudyId, setActiveCaseStudyId] = useState<string | null>(null);
  const [caseStudyHistory, setCaseStudyHistory] = useState<CaseStudySummary[]>([]);
  const [historyBusyId, setHistoryBusyId] = useState<string | null>(null);
  const [caseStudy, setCaseStudy] = useState<Record<string, unknown> | null>(null);
  const [analysisBusyId, setAnalysisBusyId] = useState<string | null>(null);
  const [reportBusyId, setReportBusyId] = useState<string | null>(null);
  const [informationRefreshToken, setInformationRefreshToken] = useState(0);

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

    try {
      const project = await createProject({ name, websiteUrl, githubUrl });
      formElement.reset();
      setProjects((current) => [project, ...current]);
      setActiveProjectId(project.id);
      setActiveCaseStudyId(null);
      setCaseStudy(null);
      setCaseStudyHistory([]);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : 'Unable to create project');
    }
  }

  async function handleDeleteProject(id: string) {
    if (!window.confirm('Delete this project and its case study?')) return;
    try {
      await deleteProject(id);
      setProjects((current) => current.filter((project) => project.id !== id));
      if (activeProjectId === id) {
        setActiveProjectId(null);
        setActiveCaseStudyId(null);
        setCaseStudy(null);
        setCaseStudyHistory([]);
      }
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : 'Unable to delete project');
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
      setInformationRefreshToken((current) => current + 1);
      await refreshProjects();
      await refreshCaseStudyHistory(id);
      await handleReport(id, result.caseStudyId);
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : 'Analysis failed');
    } finally {
      setAnalysisBusyId(null);
    }
  }

  async function handlePreview(id: string) {
    setActiveProjectId(id);
    setProjectError(null);
    setCaseStudy(null);
    setActiveCaseStudyId(null);
    setCaseStudyHistory([]);
    try {
      const result = await getProjectCaseStudy(id);
      setCaseStudy(result.content);
      setActiveCaseStudyId(result.id);
      void refreshCaseStudyHistory(id);
    } catch (error) {
      setCaseStudy(null);
      setProjectError(error instanceof Error ? error.message : 'Case study not available yet');
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

  if (workspaceLoading) {
    return <div className="tp-web-stage min-h-screen"><main className="relative z-10 mx-auto w-full max-w-[720px] px-4 py-8" aria-live="polite"><Panel label="private workspace" title="Opening your dashboard"><p className="muted">Preparing your private workspace...</p></Panel></main></div>;
  }

  return (
    <div className="tp-web-stage min-h-screen">
      <div className="tp-fx" aria-hidden="true" />
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-[1180px] flex-col px-4 py-4 sm:px-6 sm:py-6">
        <nav className="pill-nav" aria-label="Primary navigation">
          <a className="pill-nav__brand" href="/">Case Study Tool</a>
          <a className="nav-link nav-link--active" href="#console">Console</a>
          <a className="nav-link" href="#projects">Projects</a>
          <a className="nav-link" href="#analysis-history">History</a>
          <a className="nav-link" href="#report-preview">Reports</a>
          <span className="nav-link">Private workspace</span>
          <LiveStatusChip status={health.status} />
        </nav>

        <main id="console" className="flex flex-1 flex-col py-6 sm:py-8">
          {workspaceError ? <Panel label="workspace connection" title="Unable to open dashboard"><p className="form-error" role="alert">{workspaceError}</p><button className="btn" type="button" onClick={retryWorkspace}>Retry connection</button></Panel> : null}
          <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div><p className="micro-label mb-2">Project analysis console</p><h1 className="display hero-title">Case study workspace</h1></div>
            <Badge tone="outline">Evidence workspace</Badge>
          </header>

          <div className="bento">
            <Panel label="new project" title="Collect analysis sources" variant="hero" className="bento__wide">
              <form className="project-form" onSubmit={(event) => void handleCreateProject(event)}>
                <label>Project name<input name="name" required minLength={2} maxLength={120} placeholder="Example product analysis" /></label>
                <label>Website URL <span>(optional with GitHub)</span><input name="websiteUrl" type="url" placeholder="https://example.com" /></label>
                <label>GitHub repository <span>(optional with website)</span><input name="githubUrl" type="url" placeholder="https://github.com/owner/repository" /></label>
              {projectError ? <p className="form-error" role="alert">{projectError}</p> : null}
                <button className="btn btn--invert" type="submit">Create project</button>
              </form>
            </Panel>

            <Panel id="projects" label="workspace" title="Your projects" actions={projectsBusy ? <Badge tone="muted">Loading</Badge> : <Badge tone="outline">{projects.length} projects</Badge>} className="bento__wide">
              {projects.length === 0 && !projectsBusy ? <p className="muted">No projects yet. Create one above to begin analysis.</p> : null}
              {projectsBusy ? <p className="muted">Loading projects...</p> : null}
              <div className="project-list">
                {projects.map((project) => (
                  <article className="project-row" key={project.id}>
                    <div className="project-row__main"><span className="micro-label">{project.status}</span><h3 className="display text-[16px]">{project.name}</h3>{project.websiteUrl ? <a href={project.websiteUrl} target="_blank" rel="noreferrer">{project.websiteUrl}</a> : null}{project.githubUrl ? <a href={project.githubUrl} target="_blank" rel="noreferrer">{project.githubUrl}</a> : null}</div>
                    <div className="project-row__actions"><button className="btn" type="button" onClick={() => setActiveProjectId(project.id)}>Information</button><button className="btn" type="button" disabled={analysisBusyId === project.id || reportBusyId === project.id} onClick={() => void handleAnalysis(project.id)}>{reportBusyId === project.id ? 'Preparing PDF...' : analysisBusyId === project.id ? 'Analyzing...' : 'Analyze & Download PDF'}</button><button className="btn" type="button" onClick={() => void handlePreview(project.id)}>Preview</button><button className="btn" type="button" disabled={historyBusyId === project.id} onClick={() => { if (activeProjectId !== project.id) { setCaseStudy(null); setActiveCaseStudyId(null); } void refreshCaseStudyHistory(project.id); }}>{historyBusyId === project.id ? 'Loading...' : 'History'}</button><button className="btn" type="button" disabled={reportBusyId === project.id} onClick={() => void handleReport(project.id)}>{reportBusyId === project.id ? 'Building...' : 'PDF'}</button><button className="btn btn--danger" type="button" onClick={() => void handleDeleteProject(project.id)}>Delete</button></div>
                  </article>
                ))}
              </div>
            </Panel>

            {activeProjectId ? <ProjectInformationPanel key={activeProjectId} projectId={activeProjectId} refreshToken={informationRefreshToken} /> : null}

            {activeProjectId ? <Panel id="analysis-history" label="saved analyses" title="Analysis history" actions={historyBusyId === activeProjectId ? <Badge tone="muted">Loading</Badge> : <Badge tone="outline">{caseStudyHistory.length} versions</Badge>} className="bento__wide">
              {historyBusyId === activeProjectId ? <p className="muted">Loading saved analyses...</p> : null}
              {historyBusyId !== activeProjectId && caseStudyHistory.length === 0 ? <p className="muted">No saved analyses for this project yet.</p> : null}
              <div className="history-list">{caseStudyHistory.map((item) => <article className={`history-row ${item.id === activeCaseStudyId ? 'history-row--active' : ''}`} key={item.id}>
                <div><span className="micro-label">{item.status}</span><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></div>
                <div className="project-row__actions"><button className="btn" type="button" onClick={() => void handleSelectHistory(activeProjectId, item.id)}>{item.id === activeCaseStudyId ? 'Viewing' : 'View'}</button><button className="btn" type="button" disabled={reportBusyId === activeProjectId} onClick={() => void handleReport(activeProjectId, item.id)}>{reportBusyId === activeProjectId ? 'Building...' : 'PDF'}</button></div>
              </article>)}</div>
            </Panel> : null}

            <Panel id="report-preview" label="case study" title="Report preview" actions={activeCaseStudyId ? <Badge tone="outline">Saved analysis</Badge> : <Badge tone="muted">No selection</Badge>} className="bento__wide">
              {!caseStudy ? <p className="muted">Run an analysis or select Preview from a project to view the case study.</p> : <CaseStudyPreview content={caseStudy} />}
            </Panel>

            <BackendStatusPanel health={health} className="bento__wide" />
            <DependenciesPanel health={health} className="bento__half" />
          </div>
        </main>
        <footer className="footer-line"><span>Case Study Tool</span><span>Frontend / React</span><span>API / Express</span></footer>
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

function CaseStudyPreview({ content }: { content: Record<string, unknown> }) {
  const sections = ['executiveSummary','projectOverview','businessBackground','problemStatement','objectives','websiteAnalysis','technicalArchitecture','technologyStack','repositoryAnalysis','businessModel','targetAudience','marketAnalysis','competitorAnalysis','competitorComparison','businessScope','marketOpportunities','revenueModel','profitabilityAnalysis','risksAndLimitations','swotAnalysis','recommendations','growthStrategy','implementationRoadmap','conclusion'];
  return <div className="report-preview">{sections.map((key) => <section key={key}><h3>{fieldLabel(key)}</h3><div className="report-preview__content"><ReportValue value={content[key]} /></div></section>)}</div>;
}
