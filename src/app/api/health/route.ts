/**
 * GET /api/health — liveness plus a little operational context.
 *
 * Touching the menu index here means a catalogue that fails validation shows up
 * as an unhealthy deployment rather than as a broken first phone call.
 */

import { getMenuIndex } from '@/domain/menu';
import { storeStats } from '@/agent/sessionStore';
import { handleRoute } from '@/lib/api';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return handleRoute(
    request,
    () => {
      const index = getMenuIndex();
      return {
        status: 'ok' as const,
        menu: {
          schemaVersion: index.menu.schemaVersion,
          itemCount: index.menu.items.length,
          categoryCount: index.menu.categories.length,
          optionGroupCount: index.menu.optionGroups.length,
        },
        sessions: storeStats(),
        time: new Date().toISOString(),
      };
    },
    { rateLimit: false },
  );
}
