import type { ApiResponse, ApiErrorDetail, ClientErrorCode } from '../types/api';

/**
 * THE ONLY PLACE THAT KNOWS HOW TO TALK TO THE BACKEND
 * ---------------------------------------------------
 * Every feature (projects, analysis, reports in later phases) calls
 * `apiRequest<T>(...)` instead of using fetch directly. One place means:
 *
 *   - the base URL is defined once,
 *   - the response envelope is unwrapped once,
 *   - error handling behaves the same everywhere,
 *   - shared request behavior stays in one place.
 *
 * The generic <TData> is the type of `data` inside the envelope, so the caller
 * gets a fully typed result and never touches `.data` or `.success` itself.
 */

/**
 * Vite injects VITE_API_BASE_URL at build time. The fallback keeps `npm run
 * dev` working even if someone forgets to create frontend/.env.
 */
export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL?.trim() || 'http://localhost:5000/api/v1';

/** An error the UI can display: always has a message and a code. */
export class ApiRequestError extends Error {
  public readonly code: ClientErrorCode;
  public readonly status: number;
  public readonly details: ApiErrorDetail[];

  constructor(
    message: string,
    options: { code: ClientErrorCode; status: number; details?: ApiErrorDetail[] },
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.code = options.code;
    this.status = options.status;
    this.details = options.details ?? [];
  }
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Plain object - it is serialised to JSON for you. */
  body?: unknown;
  /** Lets a caller cancel the request (used on unmount and on re-check). */
  signal?: AbortSignal;
}

/** Narrows unknown JSON into our envelope without trusting it. */
function isApiEnvelope(value: unknown): value is ApiResponse<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { success?: unknown }).success === 'boolean'
  );
}

/**
 * Performs one API call and returns the unwrapped `data` field.
 *
 * @throws {ApiRequestError} on network failure, invalid payload, or a
 *         `success: false` envelope from the server.
 */
export async function apiRequest<TData>(
  endpoint: string,
  options: ApiRequestOptions = {},
): Promise<TData> {
  const { method = 'GET', body, signal } = options;
  const url = `${API_BASE_URL}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;

  let response: Response;

  try {
    response = await fetch(url, {
      method,
      signal,
      credentials: 'omit',
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    // fetch() rejects for DNS failures, refused connections and CORS blocks.
    // The browser hides which one it was for security reasons, so the message
    // has to be about what the user can act on.
    throw new ApiRequestError(
      `Cannot reach the API at ${API_BASE_URL}. Is the backend running on port 5000?`,
      { code: 'NETWORK_ERROR', status: 0 },
    );
  }

  const rawBody = await response.text();

  let payload: unknown;
  try {
    payload = rawBody.length > 0 ? JSON.parse(rawBody) : null;
  } catch {
    // e.g. an HTML error page from a proxy, or a crash before our handler ran.
    throw new ApiRequestError(
      `The API returned an unreadable response (HTTP ${response.status}).`,
      { code: 'INVALID_RESPONSE', status: response.status },
    );
  }

  if (!isApiEnvelope(payload)) {
    throw new ApiRequestError('The API response did not match the expected envelope.', {
      code: 'INVALID_RESPONSE',
      status: response.status,
    });
  }

  if (!payload.success) {
    throw new ApiRequestError(payload.message, {
      code: payload.error.code,
      status: response.status,
      details: payload.error.details,
    });
  }

  return payload.data as TData;
}
