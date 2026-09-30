/**
 * Order operations.
 *
 * Every function here is **pure**: it takes an order and returns a new one,
 * never mutating its input. That makes the whole ordering flow replayable and
 * trivially testable, and it means a failed turn can simply discard its result
 * instead of leaving the order half-changed.
 *
 * Nothing in this module computes or stores a price — see `pricing.ts`.
 */

import { findItem } from './menu';
import {
  InvalidQuantityError,
  ItemNotFoundError,
  LineNotFoundError,
  ValidationError,
} from './errors';
import { normaliseSelections, selectionSignature } from './pricing';
import type { MenuIndex, Order, OrderLine, OrderStatus, SelectionRef } from './types';
import { newLineId, newSessionId } from '@/lib/ids';

/** Hard caps. A phone order that exceeds these is a mistake, not a big order. */
export const MAX_QUANTITY_PER_LINE = 50;
export const MAX_LINES_PER_ORDER = 40;

/** Injectable clock + id source, so tests can be deterministic. */
export interface OrderContext {
  readonly now: () => Date;
  readonly newLineId: () => string;
  readonly newOrderId: () => string;
}

export const defaultOrderContext: OrderContext = {
  now: () => new Date(),
  newLineId,
  newOrderId: newSessionId,
};

/** The outcome of an operation: the new order plus what it touched. */
export interface OrderMutation {
  readonly order: Order;
  /** The line added, changed, or removed — `null` when nothing was touched. */
  readonly lineId: string | null;
  /** True when an add folded into an existing, identically-configured line. */
  readonly mergedIntoExistingLine: boolean;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                */
/* -------------------------------------------------------------------------- */

export function createOrder(context: OrderContext = defaultOrderContext): Order {
  const timestamp = context.now().toISOString();
  return {
    id: context.newOrderId(),
    lines: [],
    status: 'draft',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                   */
/* -------------------------------------------------------------------------- */

export interface AddLineInput {
  readonly itemId: string;
  readonly quantity: number;
  readonly selections: readonly SelectionRef[];
}

/**
 * Adds an item. If an identically-configured line already exists, its quantity
 * is increased instead of creating a duplicate — "a coke... and another coke"
 * should read back as "2x Medium Coke", not two separate lines.
 */
export function addLine(
  index: MenuIndex,
  order: Order,
  input: AddLineInput,
  context: OrderContext = defaultOrderContext,
): OrderMutation {
  const item = findItem(index, input.itemId);
  if (!item) throw new ItemNotFoundError(input.itemId);
  if (!item.available) {
    throw new ValidationError(`${item.name} is not available right now.`, { itemId: item.id });
  }
  assertQuantity(input.quantity);

  const { selections } = normaliseSelections(index, item, input.selections, 'lenient');
  const signature = selectionSignature(item.id, selections);
  const timestamp = context.now().toISOString();

  const existing = order.lines.find(
    (line) => selectionSignature(line.itemId, line.selections) === signature,
  );

  if (existing) {
    const quantity = clampQuantity(existing.quantity + input.quantity);
    return {
      order: touch(
        {
          ...order,
          lines: order.lines.map((line) =>
            line.id === existing.id ? { ...line, quantity, updatedAt: timestamp } : line,
          ),
        },
        timestamp,
      ),
      lineId: existing.id,
      mergedIntoExistingLine: true,
    };
  }

  if (order.lines.length >= MAX_LINES_PER_ORDER) {
    throw new ValidationError(
      `An order cannot have more than ${MAX_LINES_PER_ORDER} different items.`,
      { limit: MAX_LINES_PER_ORDER },
    );
  }

  const line: OrderLine = {
    id: context.newLineId(),
    itemId: item.id,
    quantity: input.quantity,
    selections,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  return {
    order: touch({ ...order, lines: [...order.lines, line] }, timestamp),
    lineId: line.id,
    mergedIntoExistingLine: false,
  };
}

/** Sets an absolute quantity. A quantity of zero removes the line. */
export function setLineQuantity(
  order: Order,
  lineId: string,
  quantity: number,
  context: OrderContext = defaultOrderContext,
): OrderMutation {
  const existing = requireLine(order, lineId);
  if (quantity === 0) return removeLine(order, lineId, context);
  assertQuantity(quantity);

  const timestamp = context.now().toISOString();
  return {
    order: touch(
      {
        ...order,
        lines: order.lines.map((line) =>
          line.id === existing.id ? { ...line, quantity, updatedAt: timestamp } : line,
        ),
      },
      timestamp,
    ),
    lineId: existing.id,
    mergedIntoExistingLine: false,
  };
}

export function removeLine(
  order: Order,
  lineId: string,
  context: OrderContext = defaultOrderContext,
): OrderMutation {
  requireLine(order, lineId);
  const timestamp = context.now().toISOString();
  return {
    order: touch({ ...order, lines: order.lines.filter((line) => line.id !== lineId) }, timestamp),
    lineId,
    mergedIntoExistingLine: false,
  };
}

/**
 * Applies modifier changes to an existing line.
 *
 * Adding a `variant` choice replaces the current one for that group (Regular ->
 * Large); adding a `modifier` choice appends to the set. Removals are matched
 * on the exact `{ groupId, choiceId }` pair.
 *
 * If the edit makes the line identical to another line, the two are merged —
 * the same rule as `addLine`, so the ticket never shows two identical rows.
 */
export function updateLineSelections(
  index: MenuIndex,
  order: Order,
  lineId: string,
  changes: { readonly add?: readonly SelectionRef[]; readonly remove?: readonly SelectionRef[] },
  context: OrderContext = defaultOrderContext,
): OrderMutation {
  const existing = requireLine(order, lineId);
  const item = findItem(index, existing.itemId);
  if (!item) throw new ItemNotFoundError(existing.itemId);

  const removals = new Set(
    (changes.remove ?? []).map((ref) => `${ref.groupId}:${ref.choiceId}`),
  );
  const kept = existing.selections.filter(
    (ref) => !removals.has(`${ref.groupId}:${ref.choiceId}`),
  );

  // normaliseSelections gives variant groups last-wins semantics, so appending
  // the additions is all that is needed to make "make it large" replace the size.
  const { selections } = normaliseSelections(
    index,
    item,
    [...kept, ...(changes.add ?? [])],
    'lenient',
  );

  const timestamp = context.now().toISOString();
  const signature = selectionSignature(item.id, selections);
  const twin = order.lines.find(
    (line) => line.id !== lineId && selectionSignature(line.itemId, line.selections) === signature,
  );

  if (twin) {
    const quantity = clampQuantity(twin.quantity + existing.quantity);
    return {
      order: touch(
        {
          ...order,
          lines: order.lines
            .filter((line) => line.id !== lineId)
            .map((line) => (line.id === twin.id ? { ...line, quantity, updatedAt: timestamp } : line)),
        },
        timestamp,
      ),
      lineId: twin.id,
      mergedIntoExistingLine: true,
    };
  }

  return {
    order: touch(
      {
        ...order,
        lines: order.lines.map((line) =>
          line.id === lineId ? { ...line, selections, updatedAt: timestamp } : line,
        ),
      },
      timestamp,
    ),
    lineId,
    mergedIntoExistingLine: false,
  };
}

export function clearLines(
  order: Order,
  context: OrderContext = defaultOrderContext,
): OrderMutation {
  const timestamp = context.now().toISOString();
  return {
    order: touch({ ...order, lines: [] }, timestamp),
    lineId: null,
    mergedIntoExistingLine: false,
  };
}

export function setStatus(
  order: Order,
  status: OrderStatus,
  context: OrderContext = defaultOrderContext,
): Order {
  const timestamp = context.now().toISOString();
  return touch(
    {
      ...order,
      status,
      ...(status === 'confirmed' ? { confirmedAt: timestamp } : {}),
    },
    timestamp,
  );
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

export function findLine(order: Order, lineId: string): OrderLine | undefined {
  return order.lines.find((line) => line.id === lineId);
}

/** Most recently added or edited line — the referent of "that" and "it". */
export function mostRecentlyTouchedLine(order: Order): OrderLine | undefined {
  if (order.lines.length === 0) return undefined;
  return [...order.lines].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1);
}

/** All lines for an item, newest first. Used to resolve "cancel the fries". */
export function linesForItem(order: Order, itemId: string): OrderLine[] {
  return order.lines
    .filter((line) => line.itemId === itemId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function isEmpty(order: Order): boolean {
  return order.lines.length === 0;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

function touch(order: Order, timestamp: string): Order {
  return { ...order, updatedAt: timestamp };
}

function requireLine(order: Order, lineId: string): OrderLine {
  const line = findLine(order, lineId);
  if (!line) throw new LineNotFoundError(lineId);
  return line;
}

function assertQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_LINE) {
    throw new InvalidQuantityError(quantity, MAX_QUANTITY_PER_LINE);
  }
}

function clampQuantity(quantity: number): number {
  return Math.min(Math.max(1, quantity), MAX_QUANTITY_PER_LINE);
}
