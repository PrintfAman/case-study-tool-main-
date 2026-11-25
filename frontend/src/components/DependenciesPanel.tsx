import type { ApiHealthState } from '../hooks/useApiHealth';
import type { DependencyStatus } from '../types/health';
import { Badge } from './Badge';
import { ErrorNotice } from './ErrorNotice';
import { Panel } from './Panel';
import { SkeletonLines } from './SkeletonLines';

/**
 * DEPENDENCIES PANEL
 * ------------------
 * Renders the `checks` array from the health report. The server decides what
 * the dependencies are and whether they are up; this component only decides how
 * a status looks.
 *
 * This is why the health endpoint returns a list rather than a boolean: in Phase
 * 2 the list gains `database`, in Phase 4 it can gain `groq`, and the UI needs
 * no change - it already renders whatever the server reports.
 *
 * `not_configured` is a first-class state, not an error. It means "this phase is
 * not built yet", and the panel says so in words instead of pretending.
 */

const STATUS_LABEL: Record<DependencyStatus, string> = {
  up: 'up',
  down: 'down',
  configured: 'configured',
  not_configured: 'not configured',
};

function StatusBadge({ status }: { status: DependencyStatus }) {
  if (status === 'up') return <Badge tone="solid">{STATUS_LABEL.up}</Badge>;
  if (status === 'down') return <Badge tone="accent">{STATUS_LABEL.down}</Badge>;
  return <Badge tone="muted">{STATUS_LABEL[status]}</Badge>;
}

export interface DependenciesPanelProps {
  health: ApiHealthState;
  className?: string;
}

export function DependenciesPanel({ health, className }: DependenciesPanelProps) {
  const { status, snapshot, errorMessage, errorCode, refetch } = health;

  return (
    <Panel
      label="dependencies"
      title="Service checks"
      actions={<Badge tone="muted">Live checks</Badge>}
      className={className}
    >
      {status === 'loading' ? <SkeletonLines rows={2} rowHeight="h-8" /> : null}

      {status === 'error' ? (
        <ErrorNotice
          title="No dependency report"
          message={errorMessage ?? 'The API did not answer.'}
          code={errorCode}
          onRetry={refetch}
          retryLabel="Run again"
        />
      ) : null}

      {status === 'success' && snapshot ? (
        snapshot.report.checks.length === 0 ? (
          <p className="text-[14px] muted">
            The server reported no dependencies to check.
          </p>
        ) : (
          <ul className="plain-list">
            {snapshot.report.checks.map((check) => (
              <li key={check.name} className="flex flex-col gap-1 border-b pb-3 last:border-b-0" style={{ borderColor: 'var(--tp-surf-2)' }}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="mono text-[13px] uppercase tracking-[0.08em]">{check.name}</span>
                  <StatusBadge status={check.status} />
                </div>
                {check.detail ? <p className="text-[13px] muted">{check.detail}</p> : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </Panel>
  );
}
