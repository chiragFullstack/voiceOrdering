/**
 * Turning order state into something worth listening to.
 *
 * A read-back has to sound like a person repeating an order, not like a
 * database dump: "two Large Fries and a Medium Coke", never "Fries x2 (Large),
 * Soft Drink x1 (Medium, Coke)". Everything here is presentation only — no
 * price is calculated in this module, it only reads what `pricing.ts` derived.
 */

import { speakMoney } from '@/domain/money';
import type { MenuIndex, PricedLine, PricedOrder } from '@/domain/types';
import { spokenNumber } from '@/nlu/normalize';

/* -------------------------------------------------------------------------- */
/* Lists and plurals                                                           */
/* -------------------------------------------------------------------------- */

/** "a, b and c" — the Oxford comma is omitted because it is not spoken. */
export function joinList(parts: readonly string[], conjunction = 'and'): string {
  const items = parts.filter((part) => part.trim().length > 0);
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] as string;
  if (items.length === 2) return `${items[0]} ${conjunction} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} ${conjunction} ${items.at(-1)}`;
}

/** Good-enough English pluralisation for menu nouns. */
function pluralise(name: string): string {
  if (/(s|x|z|ch|sh)$/i.test(name)) return name; // Fries, Onion Rings, Sticks
  if (/([^aeiou])y$/i.test(name)) return name.replace(/y$/i, 'ies');
  return `${name}s`;
}

function indefiniteArticle(phrase: string): string {
  return /^[aeiou]/i.test(phrase) ? 'an' : 'a';
}

/* -------------------------------------------------------------------------- */
/* Naming a line                                                               */
/* -------------------------------------------------------------------------- */

const NO_GROUPS: ReadonlySet<string> = new Set();

/**
 * The noun for a line, without a quantity.
 *
 * Variant choices normally read as adjectives in front of the name ("Large
 * Fries", "Chocolate Milkshake"). An item may nominate one group to *become*
 * the name via `speechNameGroupId`, which turns "Soft Drink (Medium, Coke)"
 * into "Medium Coke". Combos keep their own name and push every choice into the
 * trailing clause, because "Coke Classic Combo" is not how anyone speaks.
 */
export function spokenItemName(
  index: MenuIndex,
  line: PricedLine,
  omitGroupIds: ReadonlySet<string> = NO_GROUPS,
): string {
  const item = index.itemsById.get(line.itemId);
  if (!item) return line.itemName;
  if (item.components) return item.name;

  const nameGroupId = item.speechNameGroupId;
  let base = item.name;
  const prefixes: string[] = [];

  for (const selection of line.selections) {
    if (selection.groupKind !== 'variant') continue;
    if (omitGroupIds.has(selection.groupId)) continue;
    if (nameGroupId && selection.groupId === nameGroupId) {
      base = selection.choiceName;
      continue;
    }
    prefixes.push(selection.choiceName);
  }

  return [...prefixes, base].join(' ');
}

/** The "with ..." clause: modifiers, plus a combo's variant choices. */
function spokenExtras(
  index: MenuIndex,
  line: PricedLine,
  omitGroupIds: ReadonlySet<string> = NO_GROUPS,
): string[] {
  const item = index.itemsById.get(line.itemId);
  const isCombo = Boolean(item?.components);
  return line.selections
    .filter((selection) => !omitGroupIds.has(selection.groupId))
    .filter((selection) => (isCombo ? true : selection.groupKind === 'modifier'))
    .map((selection) => selection.choiceName.toLowerCase());
}

/**
 * A full spoken line: "two Spicy Zinger Burgers with extra cheese and no onions".
 *
 * `omitGroupIds` holds a group back from the description. It is used when the
 * agent is about to ask about that group — announcing "a Medium Coke" and then
 * asking "what size?" in the same breath would be absurd.
 */
export function describeLine(
  index: MenuIndex,
  line: PricedLine,
  omitGroupIds: ReadonlySet<string> = NO_GROUPS,
): string {
  const noun = spokenItemName(index, line, omitGroupIds);
  const head =
    line.quantity === 1
      ? `${indefiniteArticle(noun)} ${noun}`
      : `${spokenNumber(line.quantity)} ${pluralise(noun)}`;

  const extras = spokenExtras(index, line, omitGroupIds);
  return extras.length > 0 ? `${head} with ${joinList(extras)}` : head;
}

/** Compact written form for on-screen chips: "2 x Large Fries". */
export function writtenLine(index: MenuIndex, line: PricedLine): string {
  const noun = spokenItemName(index, line);
  const extras = spokenExtras(index, line);
  const suffix = extras.length > 0 ? ` (${extras.join(', ')})` : '';
  return `${line.quantity} x ${noun}${suffix}`;
}

/** "What size would you like — small, medium or large?" */
export function optionQuestionScript(group: {
  name: string;
  choices: readonly { name: string }[];
}): string {
  const names = group.choices.map((choice) => choice.name.toLowerCase());
  return `What ${group.name.toLowerCase()} would you like — ${joinList(names, 'or')}?`;
}

/* -------------------------------------------------------------------------- */
/* Money and totals                                                            */
/* -------------------------------------------------------------------------- */

export function spokenTotal(order: PricedOrder): string {
  return speakMoney(order.totals.total, order.currency);
}

/** "That brings you to 76 dirhams." — the running total after a change. */
export function runningTotalSentence(order: PricedOrder, variation = 0): string {
  const amount = spokenTotal(order);
  const phrasings = [
    `That brings you to ${amount}.`,
    `You're at ${amount} so far.`,
    `Running total is ${amount}.`,
    `That's ${amount} altogether.`,
  ];
  return phrasings[variation % phrasings.length] as string;
}

/* -------------------------------------------------------------------------- */
/* Whole-order read-back                                                       */
/* -------------------------------------------------------------------------- */

/** "a Spicy Zinger Burger with extra cheese, two Large Fries and a Medium Coke" */
export function describeOrderLines(index: MenuIndex, order: PricedOrder): string {
  const descriptions = order.lines.map((line) => describeLine(index, line));

  // With exactly two lines, a bare "X and Y" runs into the "and" inside a
  // modifier list ("...extra cheese and no onions and a Crispy Chicken Burger").
  // A comma before the final "and" gives the speech engine somewhere to breathe.
  if (descriptions.length === 2 && descriptions.some((text) => text.includes(' with '))) {
    return `${descriptions[0]}, and ${descriptions[1]}`;
  }

  return joinList(descriptions);
}

/**
 * The confirmation read-back. This is the last thing a caller hears before the
 * order is sent, so it states every line, every modifier and the exact total.
 */
export function confirmationScript(index: MenuIndex, order: PricedOrder): string {
  if (order.lines.length === 0) {
    return "There's nothing on the order yet. What can I get you?";
  }

  const lines = describeOrderLines(index, order);
  const total = spokenTotal(order);
  const vat =
    order.totals.vat > 0
      ? ` That includes ${speakMoney(order.totals.vat, order.currency)} of V A T.`
      : '';

  return `Let me read that back: ${lines}. Your total is ${total}.${vat} Shall I send that to the kitchen?`;
}

/** Spoken summary of what is currently on the ticket, without asking to close. */
export function recapScript(index: MenuIndex, order: PricedOrder): string {
  if (order.lines.length === 0) return "You haven't ordered anything yet.";
  return `So far you have ${describeOrderLines(index, order)}. That's ${spokenTotal(order)}.`;
}

/* -------------------------------------------------------------------------- */
/* Menu browsing                                                               */
/* -------------------------------------------------------------------------- */

export function categoryScript(index: MenuIndex, categoryId: string): string {
  const category = index.categoriesById.get(categoryId);
  const items = index.itemsByCategory.get(categoryId) ?? [];
  if (!category || items.length === 0) return 'I can tell you about our burgers, sides, drinks or combos.';

  const names = items.filter((item) => item.available).map((item) => item.name);
  return `On ${category.name.toLowerCase()} we have ${joinList(names, 'and')}. What sounds good?`;
}

export function menuOverviewScript(index: MenuIndex): string {
  const categories = index.menu.categories
    .filter((category) => (index.itemsByCategory.get(category.id) ?? []).length > 0)
    .map((category) => category.name.toLowerCase());
  return `We do ${joinList(categories)}. Which would you like to hear?`;
}
