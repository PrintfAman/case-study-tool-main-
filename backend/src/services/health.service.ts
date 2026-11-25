import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../config/env';
import { databaseHealth } from '../storage/database';

/**
 * HEALTH SERVICE
 * --------------
 * Collects the facts a health endpoint reports. It is a *service* (not a
 * controller) because building this data is business logic, and the controller's
 * only job is to turn it into an HTTP response. Keeping them apart means Phase 9
 * can call `buildHealthReport()` directly in a test, with no HTTP involved.
 */

/** Where a dependency currently stands. */
export type DependencyStatus = 'up' | 'down' | 'configured' | 'not_configured';

export interface DependencyCheck {
  name: string;
  status: DependencyStatus;
  /** Human-readable note, e.g. why it is not configured. */
  detail?: string;
}

export interface HealthReport {
  /** 'ok' when every configured dependency is up, 'degraded' otherwise. */
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

const SERVICE_NAME = 'case-study-tool-backend';

/**
 * Reads `version` out of backend/package.json once, then caches it.
 * `__dirname` is <backend>/src/services while running through tsx and
 * <backend>/dist/services after a build, so `../../package.json` resolves to
 * the same file either way.
 */
let cachedVersion: string | null = null;

function readAppVersion(): string {
  if (cachedVersion !== null) return cachedVersion;

  try {
    const raw = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedVersion = typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    // A missing or malformed package.json must not break the health check.
    cachedVersion = 'unknown';
  }

  return cachedVersion;
}

/**
 * Credential configuration is reported separately from provider reachability.
 * An API key being present does not prove that a third-party service is online.
 */
function buildDependencyChecks(): DependencyCheck[] {
  const database = databaseHealth();
  return [
    {
      name: 'database',
      status: database.up ? 'up' : 'down',
      detail: database.detail,
    },
    {
      name: 'groq_synthesis',
      status: env.GROQ_API_KEY ? 'configured' : 'not_configured',
      detail: env.GROQ_API_KEY ? 'Credential is set; provider reachability is checked during analysis.' : 'No GROQ_API_KEY; evidence-based fallback reports remain available.',
    },
    {
      name: 'tavily_competitor_research',
      status: env.TAVILY_API_KEY ? 'configured' : 'not_configured',
      detail: env.TAVILY_API_KEY
        ? 'Credential is set; provider reachability is checked during analysis.'
        : 'No TAVILY_API_KEY; independent competitor research is unavailable.',
    },
  ];
}

/** Assembles the full health report. Pure read of current process state. */
export function buildHealthReport(): HealthReport {
  const memory = process.memoryUsage();
  const checks = buildDependencyChecks();

  // Only a check that is actively configured and failing makes us degraded.
  const hasFailure = checks.some((check) => check.status === 'down');

  return {
    status: hasFailure ? 'degraded' : 'ok',
    service: SERVICE_NAME,
    version: readAppVersion(),
    environment: env.NODE_ENV,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    nodeVersion: process.version,
    memory: {
      rssMb: Math.round((memory.rss / 1024 / 1024) * 10) / 10,
      heapUsedMb: Math.round((memory.heapUsed / 1024 / 1024) * 10) / 10,
    },
    checks,
  };
}
