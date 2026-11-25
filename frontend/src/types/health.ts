/**
 * Shape of GET /health and GET /api/v1/health, as built by
 * backend/src/services/health.service.ts.
 */

/** Where a dependency currently stands. */
export type DependencyStatus = 'up' | 'down' | 'configured' | 'not_configured';

export interface DependencyCheck {
  name: string;
  status: DependencyStatus;
  detail?: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  service: string;
  version: string;
  environment: string;
  timestamp: string;
  uptimeSeconds: number;
  nodeVersion: string;
  memory: { rssMb: number; heapUsedMb: number };
  checks: DependencyCheck[];
}

/** The server's report plus what only the browser can measure. */
export interface HealthSnapshot {
  report: HealthReport;
  /** Round-trip time measured in the browser, in milliseconds. */
  latencyMs: number;
  /** When the browser received this response. */
  checkedAt: Date;
}
