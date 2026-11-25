import type { Request, Response } from 'express';
import { buildHealthReport } from '../services/health.service';
import { errorResponse, successResponse } from '../utils/api-response';

/**
 * HEALTH CONTROLLER
 * -----------------
 * Controllers are thin on purpose: translate an HTTP request into a service
 * call, then translate the result into the standard response envelope. All the
 * thinking lives in the service.
 *
 * Status code choice:
 *   200 - every dependency is fine, monitoring is happy.
 *   503 - a configured dependency is down. We use 503 (Service Unavailable)
 *         rather than 200 so load balancers and uptime monitors react without
 *         having to parse the body.
 */
export async function getHealth(_req: Request, res: Response): Promise<void> {
  const report = await buildHealthReport();

  if (report.status === 'degraded') {
    const failingChecks = report.checks
      .filter((check) => check.status === 'down')
      .map((check) => ({
        field: check.name,
        message: check.detail ?? `${check.name} is unavailable`,
      }));

    res
      .status(503)
      .json(errorResponse('INTERNAL_ERROR', 'Service is degraded', failingChecks));
    return;
  }

  res.status(200).json(successResponse(report, 'Service is healthy'));
}
