import { describe, expect, it } from 'vitest';

import { getMenuIndex } from '@/domain/menu';
import { addLine, createOrder, setLineQuantity, updateLineSelections } from '@/domain/order';
import { normaliseSelections, priceLine, priceOrder } from '@/domain/pricing';
import { addMinor, minor, multiplyMinor, percentageOfMinor } from '@/domain/money';

const index = getMenuIndex();

/** Deterministic ids and clock, so assertions do not chase timestamps. */
function testContext() {
  let sequence = 0;
  let tick = 0;
  return {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, (tick += 1))),
    newLineId: () => `ln_${(sequence += 1)}`,
    newOrderId: () => 'order_test',
  };
}

describe('money', () => {
  it('refuses non-integer minor units', () => {
    expect(() => minor(12.5)).toThrow(TypeError);
  });

  it('adds and multiplies without floating-point drift', () => {
    const a = minor(1010);
    const b = minor(2020);
    expect(addMinor(a, b)).toBe(3030);
    expect(multiplyMinor(a, 3)).toBe(3030);
  });

  it('rounds percentages half-up on the minor unit', () => {
    expect(percentageOfMinor(minor(1005), 5)).toBe(50); // 50.25 -> 50
    expect(percentageOfMinor(minor(1010), 5)).toBe(51); // 50.5  -> 51
    expect(percentageOfMinor(minor(1000), 0)).toBe(0);
  });
});

describe('selection normalisation', () => {
  const zinger = index.itemsById.get('spicy-zinger-burger')!;
  const fries = index.itemsById.get('fries')!;

  it('fills a required variant from its default', () => {
    const result = normaliseSelections(index, fries, []);
    expect(result.selections).toEqual([{ groupId: 'fries-size', choiceId: 'fries-regular' }]);
    expect(result.defaultedGroupIds).toEqual(['fries-size']);
  });

  it('keeps only the last choice in a variant group', () => {
    const result = normaliseSelections(index, fries, [
      { groupId: 'fries-size', choiceId: 'fries-large' },
      { groupId: 'fries-size', choiceId: 'fries-regular' },
    ]);
    expect(result.selections).toEqual([{ groupId: 'fries-size', choiceId: 'fries-regular' }]);
  });

  it('carries several modifiers on one line and de-duplicates them', () => {
    const result = normaliseSelections(index, zinger, [
      { groupId: 'burger-addons', choiceId: 'extra-cheese' },
      { groupId: 'burger-addons', choiceId: 'no-onions' },
      { groupId: 'burger-addons', choiceId: 'extra-cheese' },
      { groupId: 'burger-addons', choiceId: 'fried-egg' },
    ]);
    expect(result.selections.map((selection) => selection.choiceId)).toEqual([
      'extra-cheese',
      'no-onions',
      'fried-egg',
    ]);
  });

  it('rejects an option the item does not allow (strict) and drops it (lenient)', () => {
    const bad = [{ groupId: 'fries-size', choiceId: 'fries-large' }];
    expect(() => normaliseSelections(index, zinger, bad, 'strict')).toThrow();

    const lenient = normaliseSelections(index, zinger, bad, 'lenient');
    expect(lenient.selections).toEqual([]);
    expect(lenient.dropped[0]?.reason).toBe('group-not-allowed-for-item');
  });

  it('resolves an ambiguous option phrase to whichever group the item allows', () => {
    // "large" exists in both fries-size and soft-drink-size; only one applies.
    const both = [
      { groupId: 'fries-size', choiceId: 'fries-large' },
      { groupId: 'soft-drink-size', choiceId: 'soft-drink-large' },
    ];
    expect(normaliseSelections(index, fries, both, 'lenient').selections).toEqual([
      { groupId: 'fries-size', choiceId: 'fries-large' },
    ]);
  });
});

describe('price derivation', () => {
  it('derives unit price as base plus the sum of modifier deltas', () => {
    const context = testContext();
    const order = addLine(
      index,
      createOrder(context),
      {
        itemId: 'spicy-zinger-burger',
        quantity: 2,
        selections: [
          { groupId: 'burger-addons', choiceId: 'extra-cheese' },
          { groupId: 'burger-addons', choiceId: 'no-onions' },
        ],
      },
      context,
    ).order;

    const priced = priceLine(index, order.lines[0]!);
    expect(priced.unitBasePrice).toBe(3000);
    expect(priced.unitModifierTotal).toBe(400); // cheese +4, no onions +0
    expect(priced.unitPrice).toBe(3400);
    expect(priced.lineTotal).toBe(6800);
    expect(priced.label).toBe('2x Spicy Zinger Burger (Extra Cheese, No Onions)');
  });

  it('re-derives the total after a quantity change rather than reusing a stored one', () => {
    const context = testContext();
    let order = addLine(
      index,
      createOrder(context),
      { itemId: 'fries', quantity: 1, selections: [{ groupId: 'fries-size', choiceId: 'fries-large' }] },
      context,
    ).order;

    expect(priceOrder(index, order).totals.total).toBe(1500);

    order = setLineQuantity(order, order.lines[0]!.id, 3, context).order;
    expect(priceOrder(index, order).totals.total).toBe(4500);
  });

  it('re-derives after a modifier is added to an existing line', () => {
    const context = testContext();
    let order = addLine(
      index,
      createOrder(context),
      { itemId: 'double-chicken-smash', quantity: 1, selections: [] },
      context,
    ).order;
    expect(priceOrder(index, order).totals.total).toBe(3800);

    order = updateLineSelections(
      index,
      order,
      order.lines[0]!.id,
      { add: [{ groupId: 'burger-addons', choiceId: 'extra-patty' }] },
      context,
    ).order;
    expect(priceOrder(index, order).totals.total).toBe(4800);
  });

  it('stores no price on a line — only ids, quantity and selections', () => {
    const context = testContext();
    const order = addLine(
      index,
      createOrder(context),
      { itemId: 'milkshake', quantity: 1, selections: [] },
      context,
    ).order;

    expect(Object.keys(order.lines[0]!).sort()).toEqual([
      'createdAt',
      'id',
      'itemId',
      'quantity',
      'selections',
      'updatedAt',
    ]);
  });

  it('sums a mixed order exactly', () => {
    const context = testContext();
    let order = createOrder(context);

    // Zinger + extra cheese  = 34
    order = addLine(
      index,
      order,
      {
        itemId: 'spicy-zinger-burger',
        quantity: 1,
        selections: [{ groupId: 'burger-addons', choiceId: 'extra-cheese' }],
      },
      context,
    ).order;
    // 2 x Large Fries        = 30
    order = addLine(
      index,
      order,
      { itemId: 'fries', quantity: 2, selections: [{ groupId: 'fries-size', choiceId: 'fries-large' }] },
      context,
    ).order;
    // Medium Coke            = 8
    order = addLine(index, order, { itemId: 'soft-drink', quantity: 1, selections: [] }, context).order;

    const priced = priceOrder(index, order);
    expect(priced.totals.subtotal).toBe(3400 + 3000 + 800);
    expect(priced.totals.total).toBe(7200);
    expect(priced.totals.itemCount).toBe(4);
    expect(priced.totals.lineCount).toBe(3);
  });

  it('merges an identical repeat order into one line', () => {
    const context = testContext();
    let order = createOrder(context);
    order = addLine(index, order, { itemId: 'coleslaw', quantity: 1, selections: [] }, context).order;
    const second = addLine(index, order, { itemId: 'coleslaw', quantity: 1, selections: [] }, context);

    expect(second.mergedIntoExistingLine).toBe(true);
    expect(second.order.lines).toHaveLength(1);
    expect(second.order.lines[0]?.quantity).toBe(2);
  });

  it('keeps differently-configured lines of the same item apart', () => {
    const context = testContext();
    let order = createOrder(context);
    order = addLine(
      index,
      order,
      { itemId: 'fries', quantity: 1, selections: [{ groupId: 'fries-size', choiceId: 'fries-large' }] },
      context,
    ).order;
    order = addLine(index, order, { itemId: 'fries', quantity: 1, selections: [] }, context).order;

    expect(order.lines).toHaveLength(2);
    expect(priceOrder(index, order).totals.total).toBe(2500);
  });
});
