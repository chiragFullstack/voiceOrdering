'use client';

/**
 * Browser-side API client.
 *
 * Every call goes through one function so that timeouts, aborts and error
 * shapes are handled identically. Server errors arrive as a typed body, and
 * `ApiError` preserves the code and request id — the id is shown to the user on
 * an unexpected failure, which makes a bug report traceable to a log line.
 */

import type { CallSnapshot, TurnResponse } from '@/agent/callService';
import type { PublicErrorBody } from '@/domain/errors';
import type { Menu } from '@/domain/types';

const DEFAULT_TIMEOUT_MS = 15_000;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | null;

  constructor(message: string, status: number, code: string, requestId: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }

  /** True when the session is gone and the UI should offer a fresh call. */
  get isSessionGone(): boolean {
    return (
      this.code === 'SESSION_NOT_FOUND' ||
      this.code === 'SESSION_EXPIRED' ||
      this.code === 'SESSION_CLOSED'
    );
  }
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'DELETE';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  // Fold an externally-supplied signal into ours so either can cancel.
  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort);

  try {
    const response = await fetch(path, {
      method: options.method ?? 'GET',
      headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
      cache: 'no-store',
    });

    const payload: unknown = await response.json().catch(() => null);

    if (!response.ok) {
      const error = (payload as { error?: PublicErrorBody } | null)?.error;
      throw new ApiError(
        error?.message ?? `Request failed (${response.status}).`,
        response.status,
        error?.code ?? 'UNKNOWN',
        error?.requestId ?? response.headers.get('x-request-id'),
      );
    }

    return payload as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('That took too long. Please try again.', 408, 'TIMEOUT', null);
    }
    throw new ApiError(
      'Could not reach the kitchen. Check your connection and try again.',
      0,
      'NETWORK_ERROR',
      null,
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                   */
/* -------------------------------------------------------------------------- */

export function fetchMenu(signal?: AbortSignal): Promise<{ menu: Menu }> {
  return request('/api/menu', signal ? { signal } : {});
}

export function startCall(signal?: AbortSignal): Promise<CallSnapshot & { greeting: string }> {
  return request('/api/session', { method: 'POST', ...(signal ? { signal } : {}) });
}

export function sendTurn(
  sessionId: string,
  utterance: string,
  signal?: AbortSignal,
): Promise<TurnResponse> {
  return request(`/api/session/${encodeURIComponent(sessionId)}/turn`, {
    method: 'POST',
    body: { utterance },
    ...(signal ? { signal } : {}),
  });
}

export function endCall(sessionId: string): Promise<{ ended: true }> {
  return request(`/api/session/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
}
