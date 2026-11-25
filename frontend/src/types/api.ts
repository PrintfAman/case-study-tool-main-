/**
 * THE API CONTRACT, MIRRORED ON THE CLIENT
 * ----------------------------------------
 * These types describe exactly what backend/src/utils/api-response.ts sends.
 * They are declared again here rather than imported from the backend package
 * because the two apps deploy separately and the browser build must not depend
 * on server source files.
 *
 * In a larger project this shared contract would live in a `shared/` package
 * imported by both sides. For a two-folder project, a deliberate, documented
 * duplicate is simpler than build tooling.
 */

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'INTERNAL_ERROR';

/**
 * Extra codes that exist only on the client: things that can go wrong before or
 * after a real HTTP response ever arrives.
 */
export type ClientErrorCode = ApiErrorCode | 'NETWORK_ERROR' | 'INVALID_RESPONSE';

export interface ApiErrorDetail {
  field?: string;
  message: string;
}

export interface ApiErrorBody {
  code: ApiErrorCode;
  details: ApiErrorDetail[];
}

export interface ApiSuccessResponse<TData> {
  success: true;
  message: string;
  data: TData;
  error: null;
}

export interface ApiErrorResponse {
  success: false;
  message: string;
  data: null;
  error: ApiErrorBody;
}

export type ApiResponse<TData> = ApiSuccessResponse<TData> | ApiErrorResponse;
