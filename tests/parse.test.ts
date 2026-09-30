import { describe, expect, it } from 'vitest';

import { getMenuIndex } from '@/domain/menu';
import type { Intent } from '@/nlu/intents';
import { parseUtterance } from '@/nlu/parse';

const index = getMenuIndex();

function intentsOf(utterance: string): Intent[] {
  return [...parseUtterance(index, utterance).intents];
}

function firstOfKind<K extends Intent['kind']>(
  utterance: string,
  kind: K,
): Extract<Intent, { kind: K }> {
  const found = intentsOf(utterance).find((intent) => intent.kind === kind);
  if (!found) {
    throw new Error(
      `No "${kind}" intent in "${utterance}". Got: ${intentsOf(utterance)
        .map((intent) => intent.kind)
        .join(', ')}`,
    );
  }
  return found as Extract<Intent, { kind: K }>;
}

describe('item recognition', () => {
  it('matches an exact item name', () => {
    expect(firstOfKind('I would like a Spicy Zinger Burger', 'add_item').itemId).toBe(
      'spicy-zinger-burger',
    );
  });

  it('matches informal aliases', () => {
    expect(firstOfKind('can i get a zinger', 'add_item').itemId).toBe('spicy-zinger-burger');
    expect(firstOfKind('give me some chips', 'add_item').itemId).toBe('fries');
    expect(firstOfKind('a veggie please', 'add_item').itemId).toBe('veggie-burger');
  });

  it('tolerates speech-to-text misspellings', () => {
    expect(firstOfKind('mozarella sticks', 'add_item').itemId).toBe('mozzarella-sticks');
    expect(firstOfKind('one coleslaw', 'add_item').itemId).toBe('coleslaw');
  });

  it('prefers the longest matching phrase', () => {
    // "smash" alone also matches; the three-token alias must win.
    expect(firstOfKind('a double chicken smash', 'add_item').itemId).toBe('double-chicken-smash');
    // "cheese" is an add-on, but "loaded cheese fries" is an item.
    expect(firstOfKind('loaded cheese fries', 'add_item').itemId).toBe('loaded-cheese-fries');
  });

  it('asks rather than guesses when an alias fits two items', () => {
    const clarify = firstOfKind('a chicken burger', 'clarify_item');
    expect(clarify.candidateItemIds).toEqual(
      expect.arrayContaining(['grilled-chicken-burger', 'crispy-chicken-burger']),
    );
  });

  it('treats a bare category as a question, not an order', () => {
    expect(firstOfKind('can i get a burger', 'clarify_category').categoryId).toBe('burgers');
  });
});

describe('quantities', () => {
  it('reads spelled-out and numeric quantities', () => {
    expect(firstOfKind('two veggie burgers', 'add_item').quantity).toBe(2);
    expect(firstOfKind('3 onion rings', 'add_item').quantity).toBe(3);
    expect(firstOfKind('a couple of milkshakes', 'add_item').quantity).toBe(2);
  });

  it('defaults to one', () => {
    expect(firstOfKind('a bottled water', 'add_item').quantity).toBe(1);
  });

  it('handles a mid-order correction with no item named', () => {
    const intent = firstOfKind('actually make it two', 'set_quantity');
    expect(intent.quantity).toBe(2);
    expect(intent.target).toEqual({ by: 'last' });
  });

  it('handles a mid-order correction naming the item', () => {
    const intent = firstOfKind('actually make that three fries', 'set_quantity');
    expect(intent.quantity).toBe(3);
    expect(intent.target).toMatchObject({ by: 'item', itemId: 'fries' });
  });
});

describe('modifiers', () => {
  it('reads several modifiers from one phrase', () => {
    const intent = firstOfKind(
      'a spicy zinger with extra cheese and no onions',
      'add_item',
    );
    expect(intent.itemId).toBe('spicy-zinger-burger');
    // "and no onions" becomes its own clause targeting the line just created.
    const modify = intentsOf('a spicy zinger with extra cheese and no onions').find(
      (candidate) => candidate.kind === 'modify_line',
    );
    const applied = [
      ...intent.selections.map((selection) => selection.choiceId),
      ...(modify?.kind === 'modify_line' ? modify.add.map((ref) => ref.choiceId) : []),
    ];
    expect(applied).toEqual(expect.arrayContaining(['extra-cheese', 'no-onions']));
  });

  it('reads a size as a variant choice', () => {
    const intent = firstOfKind('large fries', 'add_item');
    expect(intent.selections).toContainEqual({ groupId: 'fries-size', choiceId: 'fries-large' });
  });

  it('expands a drink shortcut into item plus flavour', () => {
    const intent = firstOfKind('a large coke', 'add_item');
    expect(intent.itemId).toBe('soft-drink');
    expect(intent.selections).toContainEqual({ groupId: 'soft-drink-flavour', choiceId: 'coke' });
    expect(intent.selections).toContainEqual({
      groupId: 'soft-drink-size',
      choiceId: 'soft-drink-large',
    });
  });

  it('reads a count stated beside a bare option', () => {
    const intent = firstOfKind('two large', 'set_quantity');
    expect(intent.quantity).toBe(2);
    expect(intent.target).toEqual({ by: 'last' });
    // The option edit is still emitted alongside the count.
    expect(intentsOf('two large').map((candidate) => candidate.kind)).toContain('modify_line');
  });

  it('does not invent a count where there is no number', () => {
    expect(intentsOf('no onions').map((intent) => intent.kind)).not.toContain('set_quantity');
    expect(intentsOf('extra cheese').map((intent) => intent.kind)).not.toContain('set_quantity');
  });

  it('distinguishes "no onions" (an option) from "no cheese" (a removal)', () => {
    const keepAsOption = firstOfKind('no onions', 'modify_line');
    expect(keepAsOption.add).toContainEqual({ groupId: 'burger-addons', choiceId: 'no-onions' });

    const removal = firstOfKind('no cheese', 'modify_line');
    expect(removal.remove).toContainEqual({ groupId: 'burger-addons', choiceId: 'extra-cheese' });
  });
});

describe('removals', () => {
  it('cancels a named item', () => {
    const intent = firstOfKind('cancel the fries', 'remove_item');
    expect(intent.target).toMatchObject({ by: 'item', itemId: 'fries' });
  });

  it('accepts other phrasings', () => {
    expect(firstOfKind('take the coleslaw off', 'remove_item').target).toMatchObject({
      itemId: 'coleslaw',
    });
    expect(firstOfKind('drop the onion rings', 'remove_item').target).toMatchObject({
      itemId: 'onion-rings',
    });
  });

  it('cancels by category', () => {
    expect(firstOfKind('remove the drink', 'remove_item').target).toEqual({
      by: 'category',
      categoryId: 'drinks',
    });
  });

  it('clears the whole order on "start over"', () => {
    expect(intentsOf('actually can we start over')[0]?.kind).toBe('cancel_order');
  });
});

describe('conversational intents', () => {
  it.each([
    ["what's my total", 'read_total'],
    ['how much is that', 'read_total'],
    ['can you read that back', 'repeat_order'],
    ["that's everything", 'finish'],
    ["that's it thanks", 'finish'],
    ['yes please', 'confirm'],
    ['no', 'deny'],
    ['what do you have', 'list_menu'],
  ] as const)('reads "%s" as %s', (utterance, kind) => {
    expect(intentsOf(utterance).map((intent) => intent.kind)).toContain(kind);
  });
});

describe('the curveball', () => {
  it.each([
    'do you have pizza',
    'can i get some sushi',
    'a beef burger please',
    'do you do chicken nuggets',
    'i want an ice cream',
  ])('answers "%s" as off-menu', (utterance) => {
    expect(firstOfKind(utterance, 'off_menu')).toBeDefined();
  });

  it('treats an unrecognised request as off-menu rather than a shrug', () => {
    const intent = firstOfKind('can i get a lobster thermidor', 'off_menu');
    expect(intent.ruleIndex).toBeNull();
  });
});

describe('multi-clause utterances', () => {
  it('splits an order into separate adds', () => {
    const intents = intentsOf('two crispy chicken burgers and a large coke');
    const adds = intents.filter((intent) => intent.kind === 'add_item');
    expect(adds).toHaveLength(2);
    expect(adds.map((intent) => (intent.kind === 'add_item' ? intent.itemId : ''))).toEqual([
      'crispy-chicken-burger',
      'soft-drink',
    ]);
  });

  it('never returns an empty intent list', () => {
    for (const utterance of ['', '   ', '...', 'mmm']) {
      expect(parseUtterance(index, utterance).intents.length).toBeGreaterThan(0);
    }
  });
});
