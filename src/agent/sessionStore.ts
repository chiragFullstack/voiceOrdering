/**
 * Call sessions.
 *
 * An in-memory store with a TTL and a hard capacity. Sessions are ephemeral by
 * nature — a phone call that goes quiet for half an hour is over — so there is
 * no database here, which is also what keeps this deployable as a single zip.
 *
 * The store is held on `globalThis` so Next.js's dev-time module reloading does
 * not silently drop live calls between edits.
 *
 * NOTE: state lives in one process. Running multiple instances behind a load
 * balancer requires sticky sessions, or swapping this implementation for Redis
 * behind the same interface.
 */

import { config } from '@/lib/config';
import { newSessionId } from '@/lib/ids';
import { logger } from '@/lib/logger';
import {
  CapacityExceededError,
  SessionExpiredError,
  SessionNotFoundError,
} from '@/domain/errors';
import type { AgentState } from './agent';

export interface TranscriptEntry {
  readonly role: 'customer' | 'agent';
  readonly text: string;
  readonly at: string;
}

export interface CallSession {
  readonly id: string;
  readonly agent: AgentState;
  readonly transcript: readonly TranscriptEntry[];
  readonly createdAt: string;
  readonly lastActivityAt: string;
}

interface StoreShape {
  readonly sessions: Map<string, CallSession>;
  sweepTimer: NodeJS.Timeout | null;
}

const GLOBAL_KEY = Symbol.for('smash-and-go.session-store');

function getStore(): StoreShape {
  const container = globalThis as typeof globalThis & { [GLOBAL_KEY]?: StoreShape };
  container[GLOBAL_KEY] ??= { sessions: new Map(), sweepTimer: null };
  const store = container[GLOBAL_KEY];

  // A low-frequency sweep bounds memory even if no requests touch a session
  // again. `unref` keeps it from holding the process open.
  if (!store.sweepTimer) {
    store.sweepTimer = setInterval(() => sweepExpired(store), 60_000);
    store.sweepTimer.unref?.();
  }
  return store;
}

function ttlMillis(): number {
  return config.sessionTtlMinutes * 60_000;
}

function isExpired(session: CallSession, now: number): boolean {
  return now - Date.parse(session.lastActivityAt) > ttlMillis();
}

function sweepExpired(store: StoreShape): number {
  const now = Date.now();
  let removed = 0;
  for (const [id, session] of store.sessions) {
    if (!isExpired(session, now)) continue;
    store.sessions.delete(id);
    removed += 1;
  }
  if (removed > 0) logger.info('swept expired sessions', { removed, remaining: store.sessions.size });
  return removed;
}

/* -------------------------------------------------------------------------- */
/* API                                                                         */
/* -------------------------------------------------------------------------- */

export function createSession(agent: AgentState, greeting: string): CallSession {
  const store = getStore();

  if (store.sessions.size >= config.maxSessions) {
    sweepExpired(store);
    // Still full: drop the least recently used rather than refusing outright,
    // but refuse if even that is not possible.
    if (store.sessions.size >= config.maxSessions) {
      const oldest = [...store.sessions.values()].sort((a, b) =>
        a.lastActivityAt.localeCompare(b.lastActivityAt),
      )[0];
      if (!oldest) throw new CapacityExceededError(config.maxSessions);
      store.sessions.delete(oldest.id);
      logger.warn('evicted least-recently-used session at capacity', {
        evicted: oldest.id,
        limit: config.maxSessions,
      });
    }
  }

  const timestamp = new Date().toISOString();
  const session: CallSession = {
    id: newSessionId(),
    agent,
    transcript: [{ role: 'agent', text: greeting, at: timestamp }],
    createdAt: timestamp,
    lastActivityAt: timestamp,
  };

  store.sessions.set(session.id, session);
  logger.info('session created', { sessionId: session.id, active: store.sessions.size });
  return session;
}

/** Throws rather than returning null: every caller needs the same 404/410. */
export function requireSession(sessionId: string): CallSession {
  const store = getStore();
  const session = store.sessions.get(sessionId);
  if (!session) throw new SessionNotFoundError(sessionId);
  if (isExpired(session, Date.now())) {
    store.sessions.delete(sessionId);
    throw new SessionExpiredError(sessionId);
  }
  return session;
}

export function saveSession(
  session: CallSession,
  agent: AgentState,
  newEntries: readonly TranscriptEntry[],
): CallSession {
  const store = getStore();
  const transcript = [...session.transcript, ...newEntries].slice(-config.maxTranscriptTurns);

  const updated: CallSession = {
    ...session,
    agent,
    transcript,
    lastActivityAt: new Date().toISOString(),
  };

  store.sessions.set(session.id, updated);
  return updated;
}

export function deleteSession(sessionId: string): void {
  getStore().sessions.delete(sessionId);
}

/** Operational snapshot, exposed by the health endpoint. */
export function storeStats(): { active: number; capacity: number; ttlMinutes: number } {
  return {
    active: getStore().sessions.size,
    capacity: config.maxSessions,
    ttlMinutes: config.sessionTtlMinutes,
  };
}
