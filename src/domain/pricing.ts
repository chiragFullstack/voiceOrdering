/**
 * Price derivation.
 *
 * This is the only place in the system that produces a number with a currency
 * attached. Nothing here reads a stored total, because no total is ever stored:
 *
 *     unitPrice  = item.basePrice + SUM(selected choice.priceDelta)
 *     lineTotal  = unitPrice x quantity
 *     subtotal   = SUM(lineTotal)
 *     vat        = round(subtotal x vatRate)
 *     total      = subtotal + vat
 *
 * Change a price in `data/menu.json` and every open order re-prices itself on
 * the next read. There is no cache to invalidate and no guess to go stale.
 */

import { findChoice, findItem, groupsForItem } from './menu';
import {
  ItemNotFoundError,
  OptionNotAllowedError,
} from './errors';
import { addMinor, minor, multiplyMinor, percentageOfMinor, ZERO, type Minor } from './money';
import type {
  MenuIndex,
  MenuItem,
  OptionGroup,
  Order,
  OrderLine,
  OrderTotals,
  PricedLine,
  PricedOrder,
  PricedSelection,
  SelectionRef,
} from './types';

/* -------------------------------------------------------------------------- */
/* Selection normalisation                                                     */
/* -------------------------------------------------------------------------- */

export interface NormalisedSelections {
  /** Canonical, validated, catalogue-ordered selections for a line. */
  readonly selections: readonly SelectionRef[];
  /** Selections that came from a group default rather than from the caller. */
  readonly defaultedGroupIds: readonly string[];
  /** Requested selections that were dropped, with the reason. For diagnostics. */
  readonly dropped: readonly { selection: SelectionRef; reason: string }[];
}

/**
 * Turns whatever the caller asked for into a canonical selection set:
 *
 *  - unknown groups/choices are rejected (`strict`) or dropped (`lenient`);
 *  - a `variant` group keeps only the last requested choice (so "large,
 *    actually make it regular" resolves correctly);
 *  - a `modifier` group de-duplicates and respects `maxSelect`;
 *  - required groups fall back to `defaultChoiceId`, so a line is always
 *    priceable and the read-back can always name the size.
 *
 * `lenient` mode is used on the voice path, where a misheard modifier should
 * degrade gracefully instead of failing the whole turn. `strict` is used by the
 * HTTP API, where a bad id is a bug in the caller.
 */
export function normaliseSelections(
  index: MenuIndex,
  item: MenuItem,
  requested: readonly SelectionRef[],
  mode: 'strict' | 'lenient' = 'strict',
): NormalisedSelections {
  const allowedGroups = groupsForItem(index, item);
  const allowedGroupIds = new Set(allowedGroups.map((group) => group.id));
  const dropped: { selection: SelectionRef; reason: string }[] = [];

  /** groupId -> ordered choice ids that survived validation */
  const chosen = new Map<string, string[]>();

  for (const selection of requested) {
    if (!allowedGroupIds.has(selection.groupId)) {
      if (mode === 'strict') {
        throw new OptionNotAllowedError(item.id, selection.groupId, selection.choiceId);
      }
      dropped.push({ selection, reason: 'group-not-allowed-for-item' });
      continue;
    }
    if (!findChoice(index, selection.groupId, selection.choiceId)) {
      if (mode === 'strict') {
        throw new OptionNotAllowedError(item.id, selection.groupId, selection.choiceId);
      }
      dropped.push({ selection, reason: 'unknown-choice' });
      continue;
    }

    const group = index.groupsById.get(selection.groupId) as OptionGroup;
    const current = chosen.get(group.id) ?? [];

    if (group.kind === 'variant') {
      // Exactly one: a later choice supersedes an earlier one.
      chosen.set(group.id, [selection.choiceId]);
      continue;
    }

    if (current.includes(selection.choiceId)) continue; // idempotent
    if (current.length >= group.maxSelect) {
      if (mode === 'strict') {
        throw new OptionNotAllowedError(item.id, selection.groupId, selection.choiceId);
      }
      dropped.push({ selection, reason: 'max-selections-reached' });
      continue;
    }
    chosen.set(group.id, [...current, selection.choiceId]);
  }

  // Fill required groups from their declared default.
  const defaultedGroupIds: string[] = [];
  for (const group of allowedGroups) {
    const current = chosen.get(group.id) ?? [];
    if (current.length >= group.minSelect) continue;
    if (!group.defaultChoiceId) continue; // schema guarantees this cannot happen
    chosen.set(group.id, [group.defaultChoiceId]);
    defaultedGroupIds.push(group.id);
  }

  // Emit in catalogue order so two equivalent lines always compare equal.
  const selections: SelectionRef[] = [];
  for (const group of allowedGroups) {
    for (const choiceId of chosen.get(group.id) ?? []) {
      selections.push({ groupId: group.id, choiceId });
    }
  }

  return { selections, defaultedGroupIds, dropped };
}

/** Stable fingerprint of a line's configuration, used to merge identical lines. */
export function selectionSignature(
  itemId: string,
  selections: readonly SelectionRef[],
): string {
  const parts = selections
    .map((selection) => `${selection.groupId}:${selection.choiceId}`)
    .sort();
  return `${itemId}|${parts.join(',')}`;
}

/* -------------------------------------------------------------------------- */
/* Line and order pricing                                                      */
/* -------------------------------------------------------------------------- */

export function priceLine(index: MenuIndex, line: OrderLine): PricedLine {
  const item = findItem(index, line.itemId);
  if (!item) throw new ItemNotFoundError(line.itemId);

  const normalised = normaliseSelections(index, item, line.selections, 'lenient');
  const defaulted = new Set(normalised.defaultedGroupIds);

  const selections: PricedSelection[] = [];
  for (const ref of normalised.selections) {
    const found = findChoice(index, ref.groupId, ref.choiceId);
    if (!found) continue; // normaliseSelections already filtered these out
    selections.push({
      groupId: found.group.id,
      groupName: found.group.name,
      groupKind: found.group.kind,
      choiceId: found.choice.id,
      choiceName: found.choice.name,
      priceDelta: found.choice.priceDelta,
      isDefault: defaulted.has(found.group.id),
    });
  }

  const unitModifierTotal = addMinor(...selections.map((selection) => selection.priceDelta));
  const unitPrice = addMinor(item.basePrice, unitModifierTotal);
  const lineTotal = multiplyMinor(unitPrice, line.quantity);

  return {
    lineId: line.id,
    itemId: item.id,
    itemName: item.name,
    categoryId: item.categoryId,
    quantity: line.quantity,
    unitBasePrice: item.basePrice,
    unitModifierTotal,
    unitPrice,
    lineTotal,
    selections,
    label: buildLineLabel(item.name, line.quantity, selections),
  };
}

export function priceOrder(index: MenuIndex, order: Order): PricedOrder {
  const lines = order.lines.map((line) => priceLine(index, line));
  return {
    orderId: order.id,
    status: order.status,
    currency: index.menu.currency,
    lines,
    totals: computeTotals(index, lines),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    ...(order.confirmedAt ? { confirmedAt: order.confirmedAt } : {}),
  };
}

export function computeTotals(index: MenuIndex, lines: readonly PricedLine[]): OrderTotals {
  const subtotal = addMinor(...lines.map((line) => line.lineTotal));
  const vatRatePercent = index.menu.pricing.vatRatePercent;
  const vat = vatRatePercent > 0 ? percentageOfMinor(subtotal, vatRatePercent) : ZERO;
  return {
    subtotal,
    vatRatePercent,
    vat,
    total: addMinor(subtotal, vat),
    itemCount: lines.reduce((count, line) => count + line.quantity, 0),
    lineCount: lines.length,
  };
}

/** Price a hypothetical line without adding it to an order (used for previews). */
export function quoteUnitPrice(
  index: MenuIndex,
  item: MenuItem,
  selections: readonly SelectionRef[],
): Minor {
  const normalised = normaliseSelections(index, item, selections, 'lenient');
  const deltas = normalised.selections.map(
    (ref) => findChoice(index, ref.groupId, ref.choiceId)?.choice.priceDelta ?? ZERO,
  );
  return minor(item.basePrice + deltas.reduce<number>((sum, delta) => sum + delta, 0));
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * "2x Fries (Large)" / "1x Spicy Zinger Burger (Extra Cheese, No Onions)".
 *
 * Defaulted variants are still named: a caller who said only "a coke" should
 * hear "Medium Coke" in the read-back, so the size they are being charged for
 * is never a surprise.
 */
function buildLineLabel(
  itemName: string,
  quantity: number,
  selections: readonly PricedSelection[],
): string {
  const variants = selections.filter((selection) => selection.groupKind === 'variant');
  const modifiers = selections.filter((selection) => selection.groupKind === 'modifier');
  const parts = [...variants, ...modifiers].map((selection) => selection.choiceName);
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `${quantity}x ${itemName}${suffix}`;
}
