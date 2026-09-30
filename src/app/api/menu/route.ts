/**
 * GET /api/menu — the catalogue the browser renders and reasons about.
 *
 * Returned whole, exactly as the server sees it, so the on-screen menu and the
 * agent's understanding can never disagree.
 *
 * Served dynamically rather than prerendered. A statically exported route
 * handler is executed at build time with a stand-in `Request`, which couples a
 * successful build to request-handling code that has no business running then —
 * and the catalogue is a few kilobytes read from an in-process cache, so there
 * is nothing to gain. Caching is handled where it belongs, at the CDN, via
 * `Cache-Control` below.
 */

import { getMenuIndex } from '@/domain/menu';
import { handleRoute } from '@/lib/api';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Cached at the edge for an hour; served stale for a day while revalidating. */
const CACHE_CONTROL = 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400';

export async function GET(request: Request) {
  return handleRoute(
    request,
    () => {
      const { menu } = getMenuIndex();
      return { menu };
    },
    { rateLimit: false, cacheControl: CACHE_CONTROL },
  );
}
