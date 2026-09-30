import { describe, expect, it } from 'vitest';

import { findChoice, getMenuIndex, groupsForItem, minimumPriceFor } from '@/domain/menu';

const index = getMenuIndex();

describe('menu catalogue', () => {
  it('loads and validates data/menu.json', () => {
    expect(index.menu.schemaVersion).toBe(1);
    expect(index.menu.items.length).toBeGreaterThanOrEqual(15);
    expect(index.menu.categories.map((category) => category.id)).toEqual([
      'burgers',
      'sides',
      'drinks',
      'combos',
    ]);
  });

  it('matches the printed menu prices', () => {
    const expected: Record<string, number> = {
      'grilled-chicken-burger': 2800,
      'crispy-chicken-burger': 2600,
      'veggie-burger': 2400,
      'double-chicken-smash': 3800,
      'spicy-zinger-burger': 3000,
      fries: 1000,
      'loaded-cheese-fries': 1800,
      'onion-rings': 1400,
      'mozzarella-sticks': 1600,
      coleslaw: 800,
      'fresh-lemon-mint': 1400,
      'iced-tea': 1200,
      milkshake: 1800,
      'bottled-water': 400,
      'classic-combo': 4200,
      'zinger-combo': 4800,
    };

    for (const [itemId, basePrice] of Object.entries(expected)) {
      expect(index.itemsById.get(itemId)?.basePrice, itemId).toBe(basePrice);
    }
  });

  it('prices size variants as the menu does', () => {
    const fries = index.itemsById.get('fries');
    expect(fries).toBeDefined();
    expect(findChoice(index, 'fries-size', 'fries-regular')?.choice.priceDelta).toBe(0);
    expect(findChoice(index, 'fries-size', 'fries-large')?.choice.priceDelta).toBe(500);
    // Regular 10, Large 15.
    expect((fries?.basePrice ?? 0) + 500).toBe(1500);

    // Soft drink: Small 6, Medium 8, Large 10.
    const drink = index.itemsById.get('soft-drink');
    expect(drink?.basePrice).toBe(600);
    expect(findChoice(index, 'soft-drink-size', 'soft-drink-medium')?.choice.priceDelta).toBe(200);
    expect(findChoice(index, 'soft-drink-size', 'soft-drink-large')?.choice.priceDelta).toBe(400);
  });

  it('carries the printed burger add-on deltas', () => {
    const deltas: Record<string, number> = {
      'extra-cheese': 400,
      'extra-patty': 1000,
      'fried-egg': 600,
      avocado: 500,
      'no-onions': 0,
      'no-pickles': 0,
    };
    for (const [choiceId, priceDelta] of Object.entries(deltas)) {
      expect(findChoice(index, 'burger-addons', choiceId)?.choice.priceDelta, choiceId).toBe(
        priceDelta,
      );
    }
  });

  it('shares one add-on group across every burger rather than duplicating it', () => {
    const burgers = index.itemsByCategory.get('burgers') ?? [];
    expect(burgers.length).toBe(5);
    for (const burger of burgers) {
      expect(burger.optionGroupIds).toContain('burger-addons');
    }
    expect(index.menu.optionGroups.filter((group) => group.id === 'burger-addons')).toHaveLength(1);
  });

  it('gives every required group a default so a line is always priceable', () => {
    for (const item of index.menu.items) {
      for (const group of groupsForItem(index, item)) {
        if (group.minSelect > 0) expect(group.defaultChoiceId, group.id).toBeTruthy();
      }
    }
  });

  it('flags drink size as a group the agent should ask about', () => {
    expect(index.groupsById.get('soft-drink-size')?.askWhenUnspecified).toBe(true);

    // Every flagged group must be a variant with a fallback, or the agent would
    // be asking a question it cannot resolve on its own.
    for (const group of index.menu.optionGroups) {
      if (!group.askWhenUnspecified) continue;
      expect(group.kind, group.id).toBe('variant');
      expect(group.defaultChoiceId, group.id).toBeTruthy();
    }
  });

  it('computes a minimum sale price for items with required variants', () => {
    expect(minimumPriceFor(index, index.itemsById.get('fries')!)).toBe(1000);
    expect(minimumPriceFor(index, index.itemsById.get('soft-drink')!)).toBe(600);
  });

  it('models combos as components referencing real items', () => {
    const combo = index.itemsById.get('classic-combo');
    expect(combo?.components?.map((component) => component.itemId)).toEqual([
      'grilled-chicken-burger',
      'fries',
      'soft-drink',
    ]);
    // The combo saves AED 4 against a la carte: 28 + 10 + 8 = 46, combo 42.
    expect(2800 + 1000 + 800 - (combo?.basePrice ?? 0)).toBe(400);
  });
});
