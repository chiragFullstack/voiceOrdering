import { describe, expect, it } from 'vitest';

import { getMenuIndex } from '@/domain/menu';
import { createOrder, type OrderContext } from '@/domain/order';
import { handleTurn, startConversation, type AgentState, type TurnResult } from '@/agent/agent';

const index = getMenuIndex();

function context(): OrderContext {
  let sequence = 0;
  let tick = 0;
  return {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, (tick += 1))),
    newLineId: () => `ln_${(sequence += 1)}`,
    newOrderId: () => 'order_test',
  };
}

/** Drives a scripted call and returns the final turn plus every reply. */
function runCall(utterances: readonly string[]): {
  last: TurnResult;
  replies: string[];
  state: AgentState;
} {
  const orderContext = context();
  let state = startConversation(index, createOrder(orderContext)).state;
  const replies: string[] = [];
  let last: TurnResult | null = null;

  for (const utterance of utterances) {
    last = handleTurn(index, state, utterance, orderContext);
    state = last.state;
    replies.push(last.reply);
  }

  if (!last) throw new Error('a call must have at least one turn');
  return { last, replies, state };
}

describe('taking an order', () => {
  it('adds an item with several modifiers and reads the running total', () => {
    const { last } = runCall(['a spicy zinger with extra cheese and no onions']);

    expect(last.order.lines).toHaveLength(1);
    expect(last.order.lines[0]?.itemId).toBe('spicy-zinger-burger');
    expect(last.order.lines[0]?.selections.map((selection) => selection.choiceId)).toEqual(
      expect.arrayContaining(['extra-cheese', 'no-onions']),
    );
    expect(last.order.totals.total).toBe(3400);
    expect(last.reply).toMatch(/34 dirhams/);
  });

  it('builds a multi-item order and keeps the total correct throughout', () => {
    const { last } = runCall([
      'a spicy zinger with extra cheese',
      'two large fries',
      'and a medium coke',
    ]);

    expect(last.order.lines).toHaveLength(3);
    // 34 + 30 + 8
    expect(last.order.totals.total).toBe(7200);
  });

  it('puts a combo drink choice inside the combo, not on a separate line', () => {
    const { last } = runCall(['a classic combo with sprite']);

    expect(last.order.lines).toHaveLength(1);
    expect(last.order.lines[0]?.itemId).toBe('classic-combo');
    expect(last.order.lines[0]?.selections).toContainEqual(
      expect.objectContaining({ choiceId: 'combo-sprite' }),
    );
    expect(last.order.totals.total).toBe(4200);
    expect(last.reply).toMatch(/with sprite/i);
  });

  it('still treats two things joined by "and" as two lines', () => {
    const { last } = runCall(['a classic combo and a sprite']);

    expect(last.order.lines).toHaveLength(2);
    expect(last.order.totals.total).toBe(4200 + 800);
  });

  it('applies burger add-ons to a combo', () => {
    const { last } = runCall(['a zinger combo with extra cheese and no onions']);

    expect(last.order.lines).toHaveLength(1);
    expect(last.order.totals.total).toBe(4800 + 400);
  });

  it('names the size it defaulted to, so nothing is a surprise', () => {
    const { last } = runCall(['a coke', 'medium']);
    expect(last.reply).toMatch(/Medium Coke/i);
    expect(last.order.totals.total).toBe(800);
  });
});

describe('asking about an unstated size', () => {
  it('asks which size when the caller does not say', () => {
    const { last } = runCall(['a soft drink']);

    expect(last.reply).toMatch(/What size would you like — small, medium or large\?/i);
    // The drink is not announced as a Medium before the size has been asked
    // about ("medium" still appears, as one of the choices offered).
    expect(last.reply).not.toMatch(/Medium Coke/i);
    expect(last.reply).toMatch(/Got it — a Coke\./);
    expect(last.state.state).toBe('clarifying');
    // The default is still applied, so the line is priceable from the start.
    expect(last.order.totals.total).toBe(800);
  });

  it('applies the size the caller answers with', () => {
    const { last } = runCall(['a soft drink', 'large']);

    expect(last.order.lines).toHaveLength(1);
    expect(last.order.lines[0]?.selections).toContainEqual(
      expect.objectContaining({ choiceId: 'soft-drink-large' }),
    );
    expect(last.order.totals.total).toBe(1000);
    expect(last.state.state).toBe('ordering');
  });

  it('handles the smallest size too', () => {
    const { last } = runCall(['a coke', 'small']);
    expect(last.order.totals.total).toBe(600);
  });

  it('does not ask when the caller already stated a size', () => {
    const { last } = runCall(['a large coke']);

    expect(last.reply).not.toMatch(/What size/i);
    expect(last.state.state).toBe('ordering');
    expect(last.order.totals.total).toBe(1000);
  });

  it('keeps the medium default when the caller ignores the question', () => {
    const { last } = runCall(['a soft drink', 'and large fries']);

    expect(last.order.lines).toHaveLength(2);
    expect(last.order.lines[0]?.selections).toContainEqual(
      expect.objectContaining({ choiceId: 'soft-drink-medium' }),
    );
    expect(last.order.totals.total).toBe(800 + 1500);
    expect(last.state.state).toBe('ordering');
  });

  it('keeps the default when the caller declines to choose', () => {
    const { last } = runCall(['a soft drink', 'no']);

    expect(last.order.lines).toHaveLength(1);
    expect(last.order.totals.total).toBe(800);
  });

  it('carries the quantity through the question', () => {
    const { last } = runCall(['two soft drinks', 'large']);

    expect(last.order.lines).toHaveLength(1);
    expect(last.order.lines[0]?.quantity).toBe(2);
    expect(last.order.totals.total).toBe(2000);
  });

  // Regression: answering with the drink's own name ("sprite", "large coke")
  // parses as add_item, because those phrases are menu items in their own
  // right. Taken literally that rang up a *second* drink.
  it.each([
    ['sprite', 'soft-drink-medium', 'sprite', 800],
    ['small sprite', 'soft-drink-small', 'sprite', 600],
    ['a small sprite', 'soft-drink-small', 'sprite', 600],
    ['large coke', 'soft-drink-large', 'coke', 1000],
    ['large sprite please', 'soft-drink-large', 'sprite', 1000],
    ['fanta', 'soft-drink-medium', 'fanta', 800],
  ])('answering "%s" configures the drink instead of adding another', (
    answer,
    sizeChoiceId,
    flavourChoiceId,
    total,
  ) => {
    const { last } = runCall(['a soft drink', answer]);

    expect(last.order.lines).toHaveLength(1);
    expect(last.order.lines[0]?.selections).toContainEqual(
      expect.objectContaining({ choiceId: sizeChoiceId }),
    );
    expect(last.order.lines[0]?.selections).toContainEqual(
      expect.objectContaining({ choiceId: flavourChoiceId }),
    );
    expect(last.order.totals.total).toBe(total);
  });

  it('reads a count stated alongside the size', () => {
    const { last } = runCall(['a soft drink', 'two large cokes']);

    expect(last.order.lines).toHaveLength(1);
    expect(last.order.lines[0]?.quantity).toBe(2);
    expect(last.order.totals.total).toBe(2000);
  });

  it('still orders a genuinely different item named in the answer', () => {
    const { last } = runCall(['a soft drink', 'and large fries']);

    expect(last.order.lines).toHaveLength(2);
    expect(last.order.lines.map((line) => line.itemId)).toEqual(['soft-drink', 'fries']);
  });

  it('does not ask again when an identical drink is added', () => {
    const { replies } = runCall(['a large coke', 'another large coke']);
    expect(replies[1]).not.toMatch(/What size/i);
  });

  it('leaves items whose groups are not flagged alone', () => {
    // Only `soft-drink-size` sets askWhenUnspecified in the catalogue.
    expect(runCall(['fries']).last.reply).not.toMatch(/What size/i);
    expect(runCall(['a classic combo']).last.reply).not.toMatch(/What size/i);
    expect(runCall(['a milkshake']).last.reply).not.toMatch(/What flavour/i);
  });

  it('still closes the order cleanly after the question', () => {
    const { last } = runCall(['a soft drink', 'large', "that's everything", 'yes']);

    expect(last.state.state).toBe('completed');
    expect(last.order.status).toBe('confirmed');
    expect(last.order.totals.total).toBe(1000);
  });
});

describe('changing an order mid-call', () => {
  it('handles "actually make it two"', () => {
    const { last } = runCall(['a veggie burger', 'actually make it two']);

    expect(last.order.lines).toHaveLength(1);
    expect(last.order.lines[0]?.quantity).toBe(2);
    expect(last.order.totals.total).toBe(4800);
  });

  it('handles "cancel the fries" without touching the rest', () => {
    const { last } = runCall(['a crispy chicken burger', 'and large fries', 'cancel the fries']);

    expect(last.order.lines).toHaveLength(1);
    expect(last.order.lines[0]?.itemId).toBe('crispy-chicken-burger');
    expect(last.order.totals.total).toBe(2600);
  });

  it('handles a quantity stated after the item: "make the fries three"', () => {
    const { last } = runCall(['large fries', 'actually make the fries three']);

    expect(last.order.lines).toHaveLength(1);
    expect(last.order.lines[0]?.quantity).toBe(3);
    expect(last.order.totals.total).toBe(4500);
  });

  it('changes the quantity of a combo without duplicating the line', () => {
    const { last } = runCall(['a classic combo with sprite', 'actually make the classic combo two']);

    expect(last.order.lines).toHaveLength(1);
    expect(last.order.lines[0]?.quantity).toBe(2);
    expect(last.order.lines[0]?.selections).toContainEqual(
      expect.objectContaining({ choiceId: 'combo-sprite' }),
    );
    expect(last.order.totals.total).toBe(8400);
  });

  it('upgrades a size on an existing line', () => {
    const { last } = runCall(['fries', 'actually make the fries large']);

    expect(last.order.lines).toHaveLength(1);
    expect(last.order.lines[0]?.selections).toContainEqual(
      expect.objectContaining({ choiceId: 'fries-large' }),
    );
    expect(last.order.totals.total).toBe(1500);
  });

  it('adds a modifier to the item just ordered', () => {
    const { last } = runCall(['a double chicken smash', 'add an extra patty to that']);
    expect(last.order.totals.total).toBe(4800);
  });

  it('removes a modifier again', () => {
    const { last } = runCall([
      'a grilled chicken burger with extra cheese',
      'actually no cheese',
    ]);
    expect(last.order.totals.total).toBe(2800);
  });

  it('says so when asked to cancel something that is not on the order', () => {
    const { last } = runCall(['a veggie burger', 'cancel the onion rings']);
    expect(last.reply).toMatch(/don't have Onion Rings/i);
    expect(last.order.lines).toHaveLength(1);
  });

  it('clears everything on "start over"', () => {
    const { last } = runCall(['two zingers', 'large fries', 'actually lets start over']);
    expect(last.order.lines).toHaveLength(0);
    expect(last.order.totals.total).toBe(0);
  });
});

describe('clarification', () => {
  it('asks which chicken burger, then honours the answer with the original quantity', () => {
    const { last, replies } = runCall(['two chicken burgers', 'the crispy one']);

    expect(replies[0]).toMatch(/Grilled Chicken Burger or the Crispy Chicken Burger/i);
    expect(last.order.lines).toHaveLength(1);
    expect(last.order.lines[0]?.itemId).toBe('crispy-chicken-burger');
    expect(last.order.lines[0]?.quantity).toBe(2);
    expect(last.order.totals.total).toBe(5200);
  });

  it('accepts an ordinal answer', () => {
    const { last } = runCall(['a chicken burger', 'the first one']);
    expect(last.order.lines[0]?.itemId).toBe('grilled-chicken-burger');
  });

  it('lists the options when only a category was named', () => {
    const { replies } = runCall(['can i get a burger']);
    expect(replies[0]).toMatch(/Spicy Zinger Burger/);
  });

  it('drops the question if the caller changes the subject', () => {
    const { last } = runCall(['a chicken burger', 'actually just a coke']);
    expect(last.order.lines).toHaveLength(1);
    expect(last.order.lines[0]?.itemId).toBe('soft-drink');
  });
});

describe('the curveball', () => {
  it('declines an off-menu item and offers something real', () => {
    const { last } = runCall(['do you have pizza']);

    expect(last.reply).toMatch(/don't do pizza/i);
    expect(last.reply).toMatch(/Double Chicken Smash|Classic Combo/);
    expect(last.order.lines).toHaveLength(0);
  });

  it('stays graceful for something it has no rule for', () => {
    const { last } = runCall(['can i get a lobster thermidor']);
    expect(last.reply).toMatch(/Sorry/i);
    expect(last.reply).toMatch(/Burger|burgers/);
  });

  it('keeps the order intact and carries on afterwards', () => {
    const { last } = runCall(['a zinger', 'do you have sushi', 'ok just add large fries']);

    expect(last.order.lines).toHaveLength(2);
    expect(last.order.totals.total).toBe(4500);
  });
});

describe('confirming and closing', () => {
  it('reads the whole order back before ending the call', () => {
    const { replies, last } = runCall([
      'a spicy zinger with extra cheese and no onions',
      'two large fries',
      "that's everything",
    ]);

    const readBack = replies.at(-1) ?? '';
    expect(readBack).toMatch(/read that back/i);
    expect(readBack).toMatch(/Spicy Zinger Burger/);
    expect(readBack).toMatch(/extra cheese/i);
    expect(readBack).toMatch(/no onions/i);
    expect(readBack).toMatch(/two Large Fries/i);
    expect(readBack).toMatch(/64 dirhams/);
    expect(readBack).toMatch(/Shall I send that to the kitchen/i);
    expect(last.state.state).toBe('confirming');
  });

  it('confirms only after the caller says yes', () => {
    const { last } = runCall(['a veggie burger', "that's it", 'yes please']);

    expect(last.state.state).toBe('completed');
    expect(last.order.status).toBe('confirmed');
    expect(last.order.confirmedAt).toBeTruthy();
    expect(last.reply).toMatch(/24 dirhams/);
  });

  it('reopens the order when the caller says no at confirmation', () => {
    const { last, replies } = runCall([
      'a veggie burger',
      "that's it",
      'no',
      'add large fries',
    ]);

    expect(replies[2]).toMatch(/tell me what to change/i);
    expect(last.state.state).toBe('ordering');
    expect(last.order.lines).toHaveLength(2);
    expect(last.order.totals.total).toBe(3900);
  });

  it('will not confirm an empty order', () => {
    const { last } = runCall(["that's everything"]);
    expect(last.state.state).toBe('ordering');
    expect(last.reply).toMatch(/don't have anything on the order/i);
  });

  it('lets a caller add one more thing after the read-back', () => {
    const { last } = runCall(['a veggie burger', "that's it", 'oh and a coleslaw']);

    expect(last.state.state).toBe('ordering');
    expect(last.order.lines).toHaveLength(2);
  });
});

describe('answering questions', () => {
  it('reads the running total on request', () => {
    const { last } = runCall(['two large fries', "what's my total"]);
    expect(last.reply).toMatch(/30 dirhams/);
  });

  it('recaps the order on request', () => {
    const { last } = runCall(['a zinger', 'a coke', 'can you read that back']);
    expect(last.reply).toMatch(/Spicy Zinger Burger/);
    expect(last.reply).toMatch(/Medium Coke/);
  });

  it('describes a category when asked', () => {
    const { last } = runCall(['what drinks do you have']);
    expect(last.reply).toMatch(/Milkshake/);
  });
});

describe('robustness', () => {
  it('never throws, whatever it is given', () => {
    const inputs = [
      '',
      '        ',
      '!!!???',
      'a'.repeat(400),
      'cancel cancel cancel',
      'two two two burgers',
      '<script>alert(1)</script>',
      'zinger '.repeat(30),
    ];

    for (const input of inputs) {
      const orderContext = context();
      const state = startConversation(index, createOrder(orderContext)).state;
      expect(() => handleTurn(index, state, input, orderContext)).not.toThrow();
    }
  });

  it('always produces a reply', () => {
    const { replies } = runCall(['glorp', 'mmm', 'uh']);
    for (const reply of replies) expect(reply.trim().length).toBeGreaterThan(0);
  });

  it('reports a quantity that is out of range without losing the turn', () => {
    const { last } = runCall(['999 burgers']);
    expect(last.reply.trim().length).toBeGreaterThan(0);
    expect(last.order.lines.length).toBeLessThanOrEqual(1);
  });

  it('treats the order as immutable between turns', () => {
    const orderContext = context();
    const initial = startConversation(index, createOrder(orderContext)).state;
    const after = handleTurn(index, initial, 'a coke', orderContext);

    expect(initial.order.lines).toHaveLength(0);
    expect(after.state.order.lines).toHaveLength(1);
  });
});
