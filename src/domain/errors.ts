/**
 * Typed application errors.
 *
 * Every error thrown deliberately by this application extends `AppError`, so
 * the API layer can map it to an HTTP status and a *safe* public message
 * without ever leaking internals. Anything that is not an `AppError` is
 * treated as an unexpected fault: logged in full, reported as a generic 500.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'MENU_INVALID'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_EXPIRED'
  | 'SESSION_CLOSED'
  | 'CAPACITY_EXCEEDED'
  | 'LINE_NOT_FOUND'
  | 'ITEM_NOT_FOUND'
  | 'OPTION_NOT_ALLOWED'
  | 'INVALID_QUANTITY'
  | 'EMPTY_ORDER'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

interface AppErrorOptions {
  /** Machine-readable, stable across releases — safe for clients to switch on. */
  readonly code: ErrorCode;
  /** HTTP status to surface at the API boundary. */
  readonly status: number;
  /** Human-readable and safe to show to an end user. Never include internals. */
  readonly message: string;
  /** Structured, non-sensitive context. Included in the API response. */
  readonly details?: Readonly<Record<string, unknown>>;
  /** Original error, kept for logs only. Never serialised to a response. */
  readonly cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Readonly<Record<string, unknown>>;
  /** Marks errors that are the caller's fault (4xx) vs. ours (5xx). */
  readonly isOperational = true;

  constructor(options: AppErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.status = options.status;
    if (options.details) this.details = options.details;
    Error.captureStackTrace?.(this, new.target);
  }

  /** The shape returned to clients. Deliberately free of stack traces. */
  toPublicJSON(requestId: string): { error: PublicErrorBody } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
        requestId,
      },
    };
  }
}

export interface PublicErrorBody {
  code: ErrorCode;
  message: string;
  details?: Readonly<Record<string, unknown>>;
  requestId: string;
}

/* -------------------------------------------------------------------------- */
/* Concrete errors                                                             */
/* -------------------------------------------------------------------------- */

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: 'VALIDATION_ERROR', status: 400, message, ...(details ? { details } : {}) });
  }
}

/**
 * Thrown at startup when `data/menu.json` does not satisfy the schema or its
 * referential-integrity rules. Fatal by design: a kitchen with a broken
 * catalogue must not take orders.
 */
export class MenuInvalidError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ code: 'MENU_INVALID', status: 500, message, ...(details ? { details } : {}) });
  }
}

export class SessionNotFoundError extends AppError {
  constructor(sessionId: string) {
    super({
      code: 'SESSION_NOT_FOUND',
      status: 404,
      message: 'That call session no longer exists. Start a new call to order.',
      details: { sessionId },
    });
  }
}

export class SessionExpiredError extends AppError {
  constructor(sessionId: string) {
    super({
      code: 'SESSION_EXPIRED',
      status: 410,
      message: 'That call session timed out. Start a new call to order.',
      details: { sessionId },
    });
  }
}

export class SessionClosedError extends AppError {
  constructor(sessionId: string, status: string) {
    super({
      code: 'SESSION_CLOSED',
      status: 409,
      message: 'That order is already finished. Start a new call to order again.',
      details: { sessionId, status },
    });
  }
}

export class CapacityExceededError extends AppError {
  constructor(limit: number) {
    super({
      code: 'CAPACITY_EXCEEDED',
      status: 503,
      message: 'The kitchen line is busy right now. Please try again in a moment.',
      details: { limit },
    });
  }
}

export class LineNotFoundError extends AppError {
  constructor(lineId: string) {
    super({
      code: 'LINE_NOT_FOUND',
      status: 404,
      message: 'That item is not on the order any more.',
      details: { lineId },
    });
  }
}

export class ItemNotFoundError extends AppError {
  constructor(itemId: string) {
    super({
      code: 'ITEM_NOT_FOUND',
      status: 404,
      message: 'We do not have that item on the menu.',
      details: { itemId },
    });
  }
}

export class OptionNotAllowedError extends AppError {
  constructor(itemId: string, groupId: string, choiceId: string) {
    super({
      code: 'OPTION_NOT_ALLOWED',
      status: 422,
      message: 'That option is not available for this item.',
      details: { itemId, groupId, choiceId },
    });
  }
}

export class InvalidQuantityError extends AppError {
  constructor(quantity: number, max: number) {
    super({
      code: 'INVALID_QUANTITY',
      status: 422,
      message: `Quantity must be a whole number between 1 and ${max}.`,
      details: { quantity, max },
    });
  }
}

export class EmptyOrderError extends AppError {
  constructor() {
    super({
      code: 'EMPTY_ORDER',
      status: 409,
      message: 'There is nothing on the order yet.',
    });
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super({
      code: 'RATE_LIMITED',
      status: 429,
      message: 'Too many requests. Please slow down and try again shortly.',
      details: { retryAfterSeconds },
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Wraps an unknown thrown value into a safe, generic 500. */
export function toInternalError(cause: unknown): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    status: 500,
    message: 'Something went wrong on our side. Please try again.',
    cause,
  });
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Safely extract a message from an unknown thrown value, for logging. */
export function describeUnknownError(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
