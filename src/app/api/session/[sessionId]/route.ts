/**
 * GET    /api/session/:id — current state of a call (recovers after a reload).
 * DELETE /api/session/:id — hang up and forget the session.
 */

import { z } from 'zod';

import { endCall, getCall } from '@/agent/callService';
import { handleRoute, parseRouteParam } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Session ids are UUIDs. Anything else is rejected before it reaches the store. */
const sessionIdSchema = z.string().uuid();

interface RouteParams {
  readonly params: Promise<{ readonly sessionId: string }>;
}

export async function GET(request: Request, { params }: RouteParams) {
  const { sessionId } = await params;
  return handleRoute(request, () =>
    getCall(parseRouteParam(sessionId, sessionIdSchema, 'session id')),
  );
}

export async function DELETE(request: Request, { params }: RouteParams) {
  const { sessionId } = await params;
  return handleRoute(request, () =>
    endCall(parseRouteParam(sessionId, sessionIdSchema, 'session id')),
  );
}
