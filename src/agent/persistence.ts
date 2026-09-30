/**
 * Optional capture of confirmed orders.
 *
 * Enabled only when `ORDER_LOG_DIR` is set. Each confirmed order is appended as
 * one JSON Lines record — enough for a kitchen display or a nightly export,
 * without pulling a database into a single-zip deployment.
 *
 * Failure here is never allowed to fail a call: the customer has already been
 * told their order is in, so a write error is logged and swallowed.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { config } from '@/lib/config';
import { logger } from '@/lib/logger';
import type { PricedOrder } from '@/domain/types';

export interface ConfirmedOrderRecord {
  readonly orderId: string;
  readonly sessionId: string;
  readonly confirmedAt: string;
  readonly currency: string;
  readonly lines: ReadonlyArray<{
    readonly itemId: string;
    readonly quantity: number;
    readonly selections: ReadonlyArray<{ groupId: string; choiceId: string }>;
    readonly unitPrice: number;
    readonly lineTotal: number;
  }>;
  readonly subtotal: number;
  readonly vat: number;
  readonly total: number;
}

export function toRecord(sessionId: string, order: PricedOrder): ConfirmedOrderRecord {
  return {
    orderId: order.orderId,
    sessionId,
    confirmedAt: order.confirmedAt ?? new Date().toISOString(),
    currency: order.currency.code,
    lines: order.lines.map((line) => ({
      itemId: line.itemId,
      quantity: line.quantity,
      selections: line.selections.map((selection) => ({
        groupId: selection.groupId,
        choiceId: selection.choiceId,
      })),
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
    })),
    subtotal: order.totals.subtotal,
    vat: order.totals.vat,
    total: order.totals.total,
  };
}

/** One file per day keeps records easy to rotate and to hand to the kitchen. */
function fileNameFor(date: Date): string {
  return `orders-${date.toISOString().slice(0, 10)}.jsonl`;
}

/**
 * Resolves `ORDER_LOG_DIR` to a directory inside the project.
 *
 * Environment variables are trusted less than they usually are here: a value
 * like `../../etc` would otherwise have the server writing outside its own
 * deployment. Anything that escapes the working directory is refused.
 */
function resolveLogDirectory(configured: string): string | null {
  const base = process.cwd();
  // turbopackIgnore: the path is deliberately dynamic and is contained below.
  const candidate = resolve(/* turbopackIgnore: true */ base, configured);
  const inside = relative(base, candidate);

  if (inside.length === 0) return null; // the project root itself
  if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) return null;

  return candidate;
}

export async function recordConfirmedOrder(
  sessionId: string,
  order: PricedOrder,
): Promise<void> {
  const directory = config.orderLogDir;
  if (!directory) return;

  const absolute = resolveLogDirectory(directory);
  if (!absolute) {
    logger.warn('ORDER_LOG_DIR points outside the project; order capture is disabled', {
      configured: directory,
    });
    return;
  }

  try {
    await mkdir(/* turbopackIgnore: true */ absolute, { recursive: true });
    const line = `${JSON.stringify(toRecord(sessionId, order))}\n`;
    await appendFile(join(absolute, fileNameFor(new Date())), line, 'utf8');
    logger.info('order recorded', { orderId: order.orderId, sessionId });
  } catch (error) {
    // Read-only filesystems (most serverless hosts) land here by design.
    logger.warn('could not record order; continuing', {
      orderId: order.orderId,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
