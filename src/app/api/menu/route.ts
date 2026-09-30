/**
 * GET /api/menu — the catalogue the browser renders and reasons about.
 *
 * Returned whole, exactly as the server sees it, so the on-screen menu and the
 * agent's understanding can never disagree. Read-only and identical for every
 * caller, so it is cacheable and exempt from rate limiting.
 */

import { getMenuIndex } from '@/domain/menu';
import { handleRoute } from '@/lib/api';

export const dynamic = 'force-static';
export const revalidate = 3600;

export async function GET(request: Request) {
  return handleRoute(
    request,
    () => {
      const { menu } = getMenuIndex();
      return { menu };
    },
    { rateLimit: false },
  );
}
