/**
 * POST /api/session — start a call.
 *
 * Returns an opaque session id plus the agent's opening line and an empty,
 * fully-priced order, so the browser has everything it needs to render the
 * first frame without a second round trip.
 */

import { startCall } from '@/agent/callService';
import { handleRoute } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleRoute(request, () => startCall());
}
