/**
 * Application service for a call.
 *
 * Routes stay thin: they validate input and delegate here. This is the only
 * layer that knows about sessions *and* the agent, so the ordering rules stay
 * testable without an HTTP server.
 */

import { SessionClosedError } from '@/domain/errors';
import { getMenuIndex } from '@/domain/menu';
import { createOrder } from '@/domain/order';
import { priceOrder } from '@/domain/pricing';
import type { PricedOrder } from '@/domain/types';
import type { ParseResult } from '@/nlu/intents';
import { logger } from '@/lib/logger';
import {
  handleTurn,
  isTerminal,
  startConversation,
  type ConversationState,
  type TurnEvent,
} from './agent';
import { recordConfirmedOrder } from './persistence';
import {
  createSession,
  deleteSession,
  requireSession,
  saveSession,
  type TranscriptEntry,
} from './sessionStore';

/* -------------------------------------------------------------------------- */
/* Wire types — shared with the browser                                        */
/* -------------------------------------------------------------------------- */

export interface CallSnapshot {
  readonly sessionId: string;
  readonly state: ConversationState;
  readonly order: PricedOrder;
  readonly transcript: readonly TranscriptEntry[];
  /** The question the agent is waiting on, if any. */
  readonly pendingQuestion: string | null;
}

export interface TurnResponse extends CallSnapshot {
  readonly reply: string;
  readonly events: readonly TurnEvent[];
  /** Parser trace, shown in the inspector panel. Safe: derived from the menu. */
  readonly parse: ParseResult;
}

/* -------------------------------------------------------------------------- */
/* Operations                                                                  */
/* -------------------------------------------------------------------------- */

export function startCall(): CallSnapshot & { greeting: string } {
  const index = getMenuIndex();
  const { state, greeting } = startConversation(index, createOrder());
  const session = createSession(state, greeting);

  return {
    sessionId: session.id,
    state: state.state,
    order: priceOrder(index, state.order),
    transcript: session.transcript,
    pendingQuestion: null,
    greeting,
  };
}

export function getCall(sessionId: string): CallSnapshot {
  const index = getMenuIndex();
  const session = requireSession(sessionId);
  return {
    sessionId: session.id,
    state: session.agent.state,
    order: priceOrder(index, session.agent.order),
    transcript: session.transcript,
    pendingQuestion: session.agent.pending?.question ?? null,
  };
}

export async function takeTurn(sessionId: string, utterance: string): Promise<TurnResponse> {
  const index = getMenuIndex();
  const session = requireSession(sessionId);

  if (isTerminal(session.agent.state)) {
    throw new SessionClosedError(sessionId, session.agent.state);
  }

  const result = handleTurn(index, session.agent, utterance);
  const at = new Date().toISOString();
  const entries: TranscriptEntry[] = [
    { role: 'customer', text: utterance, at },
    { role: 'agent', text: result.reply, at },
  ];

  const saved = saveSession(session, result.state, entries);

  // Capture happens after the session is saved, so a persistence failure can
  // never roll back an order the customer has already been told is confirmed.
  if (result.state.state === 'completed') {
    await recordConfirmedOrder(sessionId, result.order);
    logger.info('order confirmed', {
      sessionId,
      orderId: result.order.orderId,
      lineCount: result.order.totals.lineCount,
      itemCount: result.order.totals.itemCount,
      total: result.order.totals.total,
    });
  }

  return {
    sessionId,
    state: result.state.state,
    order: result.order,
    transcript: saved.transcript,
    pendingQuestion: result.state.pending?.question ?? null,
    reply: result.reply,
    events: result.events,
    parse: result.parse,
  };
}

export function endCall(sessionId: string): { ended: true } {
  // Tolerant on purpose: hanging up twice is not an error.
  deleteSession(sessionId);
  logger.info('session ended', { sessionId });
  return { ended: true };
}
