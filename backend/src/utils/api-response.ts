/**
 * ONE RESPONSE SHAPE FOR THE ENTIRE API
 * -------------------------------------
 * The frontend should never have to guess what a response looks like. Every
 * endpoint - success or failure - returns this exact envelope:
 *
 *   { "success": true,  "message": "...", "data": {...}, "error": null }
 *   { "success": false, "message": "...", "data": null,  "error": {...} }
 *
 * Why an envelope instead of returning the data directly?
 * 1. The client checks one boolean (`success`) instead of guessing at shapes.
 * 2. Error codes are machine-readable ("VALIDATION_ERROR"), so the UI can react
 *    specifically instead of parsing English messages.
 * 3. It leaves room for pagination metadata later without breaking clients.
 *
 * These are plain functions with no Express types in them, so they are trivial
 * to unit test in Phase 9.
 */

/** Machine-readable error identifiers. Add new ones as modules grow. */
export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'INTERNAL_ERROR';

/** A single explanation of what was wrong with a request. */
export interface ApiErrorDetail {
  /** Optional dotted path to the offending input, e.g. "githubUrl". */
  field?: string;
  message: string;
}

export interface ApiErrorBody {
  code: ApiErrorCode;
  details: ApiErrorDetail[];
}

/** The envelope every successful response uses. */
export interface ApiSuccessResponse<TData> {
  success: true;
  message: string;
  data: TData;
  error: null;
}

/** The envelope every failed response uses. */
export interface ApiErrorResponse {
  success: false;
  message: string;
  data: null;
  error: ApiErrorBody;
}

/** Union of both shapes - handy for typing the frontend API client. */
export type ApiResponse<TData> = ApiSuccessResponse<TData> | ApiErrorResponse;

/** Builds a success envelope. Does not touch Express. */
export function successResponse<TData>(
  data: TData,
  message = 'Operation completed successfully',
): ApiSuccessResponse<TData> {
  return { success: true, message, data, error: null };
}

/** Builds an error envelope. Does not touch Express. */
export function errorResponse(
  code: ApiErrorCode,
  message: string,
  details: ApiErrorDetail[] = [],
): ApiErrorResponse {
  return { success: false, message, data: null, error: { code, details } };
}
