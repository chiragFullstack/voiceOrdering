/**
 * The HTTP boundary.
 *
 * Every route is wrapped by `handleRoute`, which gives all of them the same
 * behaviour for free:
 *
 *  - a request id, echoed in logs and in every error body;
 *  - rate limiting;
 *  - a body-size and content-type guard before any parsing happens;
 *  - `AppError` -> its declared status and safe message;
 *  - anything else -> a generic 500, with the real cause logged, never sent.
 */

import { NextResponse } from 'next/server';
import { ZodError, type ZodSchema } from 'zod';

import {
  AppError,
  describeUnknownError,
  isAppError,
  RateLimitError,
  toInternalError,
  ValidationError,
} from '@/domain/errors';
import { newRequestId } from './ids';
import { logger } from './logger';
import { checkRateLimit, clientKeyFromRequest } from './rateLimit';

/** Requests larger than this are refused before being read into memory. */
const MAX_BODY_BYTES = 16 * 1024;

export interface RouteContext {
  readonly requestId: string;
  readonly request: Request;
}

type RouteHandler<T> = (context: RouteContext) => Promise<T> | T;

interface RouteOptions {
  /** Skip throttling for cheap, cacheable reads such as the menu. */
  readonly rateLimit?: boolean;
}

export async function handleRoute<T>(
  request: Request,
  handler: RouteHandler<T>,
  options: RouteOptions = {},
): Promise<NextResponse> {
  const requestId = newRequestId();
  const startedAt = Date.now();
  const route = new URL(request.url).pathname;

  try {
    if (options.rateLimit !== false) {
      const verdict = checkRateLimit(clientKeyFromRequest(request));
      if (!verdict.allowed) throw new RateLimitError(verdict.retryAfterSeconds);
    }

    const payload = await handler({ requestId, request });

    logger.info('request ok', {
      requestId,
      route,
      method: request.method,
      durationMs: Date.now() - startedAt,
    });

    return NextResponse.json(payload, {
      status: 200,
      headers: { 'x-request-id': requestId },
    });
  } catch (error) {
    return errorResponse(error, requestId, route, request.method, startedAt);
  }
}

function errorResponse(
  error: unknown,
  requestId: string,
  route: string,
  method: string,
  startedAt: number,
): NextResponse {
  const appError: AppError = isAppError(error)
    ? error
    : error instanceof ZodError
      ? zodToValidationError(error)
      : toInternalError(error);

  const level = appError.status >= 500 ? 'error' : 'warn';
  logger[level]('request failed', {
    requestId,
    route,
    method,
    status: appError.status,
    code: appError.code,
    durationMs: Date.now() - startedAt,
    // The underlying message is logged, never returned.
    detail: describeUnknownError(error),
  });

  const headers: Record<string, string> = { 'x-request-id': requestId };
  if (appError instanceof RateLimitError) {
    headers['retry-after'] = String(appError.retryAfterSeconds);
  }

  return NextResponse.json(appError.toPublicJSON(requestId), {
    status: appError.status,
    headers,
  });
}

function zodToValidationError(error: ZodError): ValidationError {
  const first = error.issues[0];
  const field = first?.path.join('.') ?? 'body';
  return new ValidationError(`Invalid request: ${field} ${first?.message ?? 'is invalid'}.`, {
    issues: error.issues.slice(0, 5).map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
}

/* -------------------------------------------------------------------------- */
/* Body parsing                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Reads and validates a JSON body.
 *
 * The content-length check happens before `request.json()` so an oversized
 * payload is rejected without being buffered, and the parsed value is validated
 * against the schema rather than being trusted.
 */
export async function readJsonBody<T>(request: Request, schema: ZodSchema<T>): Promise<T> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ValidationError('Request body must be application/json.');
  }

  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new ValidationError('Request body is too large.', { maxBytes: MAX_BODY_BYTES });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError('Request body is not valid JSON.');
  }

  return schema.parse(raw);
}

/** Validates a dynamic route segment such as a session id. */
export function parseRouteParam<T>(value: unknown, schema: ZodSchema<T>, name: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`Invalid ${name}.`);
  }
  return result.data;
}
