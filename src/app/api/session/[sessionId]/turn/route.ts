/**
 * POST /api/session/:id/turn — one spoken (or typed) customer utterance.
 *
 * This is the only endpoint that changes an order, and it is deliberately the
 * *server* that does so: the browser sends words, never prices or line ids to
 * trust. Whatever the client does, the total comes from the catalogue.
 */

import { z } from 'zod';

import { takeTurn } from '@/agent/callService';
import { config } from '@/lib/config';
import { handleRoute, parseRouteParam, readJsonBody } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sessionIdSchema = z.string().uuid();

const turnBodySchema = z
  .object({
    /**
     * Raw transcript text. Bounded so a stuck recogniser cannot post an
     * unbounded string, and trimmed to reject whitespace-only turns.
     */
    utterance: z
      .string()
      .trim()
      .min(1, 'cannot be empty')
      .max(config.maxUtteranceLength, 'is too long'),
  })
  .strict();

interface RouteParams {
  readonly params: Promise<{ readonly sessionId: string }>;
}

export async function POST(request: Request, { params }: RouteParams) {
  const { sessionId } = await params;
  return handleRoute(request, async () => {
    const id = parseRouteParam(sessionId, sessionIdSchema, 'session id');
    const { utterance } = await readJsonBody(request, turnBodySchema);
    return takeTurn(id, utterance);
  });
}
