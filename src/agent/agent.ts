/**
 * The order-taking agent.
 *
 * A small, explicit state machine over a pure order reducer:
 *
 *      greeting -> ordering <-> clarifying -> confirming -> completed
 *                     ^                           |
 *                     +---------- deny -----------+
 *
 * One turn = one utterance. The parser turns the utterance into intents, each
 * intent is applied to a working copy of the order, and the events produced are
 * stitched into a single spoken reply. An intent that fails is caught, reported
 * conversationally, and the remaining intents still run — a misheard modifier
 * must never lose the rest of the sentence.
 */

import { findItem } from '@/domain/menu';
import { describeUnknownError, isAppError } from '@/domain/errors';
import {
  addLine,
  clearLines,
  defaultOrderContext,
  findLine,
  linesForItem,
  mostRecentlyTouchedLine,
  removeLine,
  setLineQuantity,
  setStatus,
  updateLineSelections,
  type OrderContext,
} from '@/domain/order';
import { priceLine, priceOrder, selectionSignature } from '@/domain/pricing';
import type {
  MenuIndex,
  OptionGroup,
  Order,
  OrderLine,
  PricedOrder,
  SelectionRef,
} from '@/domain/types';
import type { Intent, LineTarget, ParseResult } from '@/nlu/intents';
import { parseUtterance } from '@/nlu/parse';
import { logger } from '@/lib/logger';
import {
  categoryScript,
  confirmationScript,
  describeLine,
  joinList,
  menuOverviewScript,
  optionQuestionScript,
  recapScript,
  runningTotalSentence,
  spokenTotal,
} from './speech';

/* -------------------------------------------------------------------------- */
/* State                                                                       */
/* -------------------------------------------------------------------------- */

export type ConversationState =
  | 'greeting'
  | 'ordering'
  | 'clarifying'
  | 'confirming'
  | 'completed'
  | 'cancelled';

/**
 * An open question the agent is waiting on an answer to.
 *
 * `which-item`   — the caller named something that matches more than one item.
 * `which-option` — the caller named an item but not a variant the catalogue
 *                  marks `askWhenUnspecified` (drink size, say). The default is
 *                  already on the line, so an unanswered question costs nothing.
 */
export type PendingQuestion =
  | {
      readonly kind: 'which-item';
      readonly candidateItemIds: readonly string[];
      /** Carried over so "the crispy one" keeps the quantity and options asked for. */
      readonly quantity: number;
      readonly selections: readonly SelectionRef[];
      readonly question: string;
    }
  | {
      readonly kind: 'which-option';
      readonly lineId: string;
      readonly groupId: string;
      readonly question: string;
    };

export type TurnEventType =
  | 'added'
  | 'updated'
  | 'removed'
  | 'cleared'
  | 'off_menu'
  | 'question'
  | 'info'
  | 'warning'
  | 'confirmed';

export interface TurnEvent {
  readonly type: TurnEventType;
  readonly message: string;
  readonly lineId?: string;
  readonly itemId?: string;
}

export interface AgentState {
  readonly state: ConversationState;
  readonly order: Order;
  readonly pending: PendingQuestion | null;
  readonly lastTouchedLineId: string | null;
  readonly turnCount: number;
}

export interface TurnResult {
  readonly state: AgentState;
  /** What the agent says. Rendered to the transcript and spoken aloud. */
  readonly reply: string;
  readonly events: readonly TurnEvent[];
  readonly order: PricedOrder;
  /** Parser output, surfaced in the inspector panel for demos and debugging. */
  readonly parse: ParseResult;
}

/** True once the call is over and the session should stop accepting turns. */
export function isTerminal(state: ConversationState): boolean {
  return state === 'completed' || state === 'cancelled';
}

/* -------------------------------------------------------------------------- */
/* Opening                                                                     */
/* -------------------------------------------------------------------------- */

export function startConversation(
  index: MenuIndex,
  order: Order,
): { state: AgentState; greeting: string } {
  return {
    state: { state: 'ordering', order, pending: null, lastTouchedLineId: null, turnCount: 0 },
    greeting: index.menu.restaurant.greeting,
  };
}

/* -------------------------------------------------------------------------- */
/* A turn                                                                      */
/* -------------------------------------------------------------------------- */

interface TurnScratch {
  order: Order;
  lastTouchedLineId: string | null;
  pending: PendingQuestion | null;
  conversation: ConversationState;
  orderChanged: boolean;
  readonly events: TurnEvent[];
}

export function handleTurn(
  index: MenuIndex,
  previous: AgentState,
  utterance: string,
  context: OrderContext = defaultOrderContext,
): TurnResult {
  const parse = parseUtterance(index, utterance);

  const scratch: TurnScratch = {
    order: previous.order,
    lastTouchedLineId: previous.lastTouchedLineId,
    pending: previous.pending,
    conversation: previous.state === 'greeting' ? 'ordering' : previous.state,
    orderChanged: false,
    events: [],
  };

  const intents = scratch.pending
    ? resolvePendingQuestion(index, scratch, parse)
    : [...parse.intents];

  for (const intent of intents) {
    try {
      applyIntent(index, scratch, intent, context);
    } catch (error) {
      // One bad clause must not sink the whole utterance.
      if (isAppError(error)) {
        scratch.events.push({ type: 'warning', message: error.message });
        logger.debug('intent rejected', { code: error.code, intent: intent.kind });
      } else {
        scratch.events.push({
          type: 'warning',
          message: "Sorry, I couldn't do that one — could you say it another way?",
        });
        logger.error('intent failed unexpectedly', {
          intent: intent.kind,
          error: describeUnknownError(error),
        });
      }
    }
  }

  const order = priceOrder(index, scratch.order);
  const reply = composeReply(index, previous, scratch, order);

  return {
    state: {
      state: scratch.conversation,
      order: scratch.order,
      pending: scratch.pending,
      lastTouchedLineId: scratch.lastTouchedLineId,
      turnCount: previous.turnCount + 1,
    },
    reply,
    events: scratch.events,
    order,
    parse,
  };
}

/* -------------------------------------------------------------------------- */
/* Pending questions                                                           */
/* -------------------------------------------------------------------------- */

const ORDINALS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(first|number one|the one|1st)\b/, 0],
  [/\b(second|number two|2nd)\b/, 1],
  [/\b(third|number three|3rd)\b/, 2],
  [/\b(fourth|number four|4th)\b/, 3],
  [/\b(fifth|number five|5th)\b/, 4],
];

/**
 * Interprets this turn as an answer to the open question when it plausibly is
 * one, and otherwise drops the question and lets the turn proceed normally —
 * a caller who changes the subject should not be re-asked forever.
 */
function resolvePendingQuestion(
  index: MenuIndex,
  scratch: TurnScratch,
  parse: ParseResult,
): Intent[] {
  const pending = scratch.pending;
  if (!pending) return [...parse.intents];
  scratch.pending = null;
  scratch.conversation = 'ordering';

  if (pending.kind === 'which-option') {
    return resolveOptionAnswer(scratch, pending, parse);
  }

  const candidates = new Set(pending.candidateItemIds);

  // "the crispy one" — the parser already resolved it to a menu item.
  const namedItem = parse.intents.find(
    (intent): intent is Extract<Intent, { kind: 'add_item' }> =>
      intent.kind === 'add_item' && candidates.has(intent.itemId),
  );
  if (namedItem) {
    return [
      {
        kind: 'add_item',
        itemId: namedItem.itemId,
        quantity: namedItem.quantity > 1 ? namedItem.quantity : pending.quantity,
        selections: mergeSelections(pending.selections, namedItem.selections),
        sourceText: namedItem.sourceText,
      },
      ...parse.intents.filter((intent) => intent !== namedItem),
    ];
  }

  // Still ambiguous, but narrowed — e.g. answering "chicken" to a burger question.
  const stillAmbiguous = parse.intents.find(
    (intent): intent is Extract<Intent, { kind: 'clarify_item' }> => intent.kind === 'clarify_item',
  );
  if (stillAmbiguous) {
    const narrowed = stillAmbiguous.candidateItemIds.filter((itemId) => candidates.has(itemId));
    if (narrowed.length === 1) {
      return [
        {
          kind: 'add_item',
          itemId: narrowed[0] as string,
          quantity: pending.quantity,
          selections: mergeSelections(pending.selections, stillAmbiguous.selections),
          sourceText: stillAmbiguous.sourceText,
        },
      ];
    }
  }

  // "the second one"
  for (const [pattern, position] of ORDINALS) {
    if (!pattern.test(parse.normalized)) continue;
    const itemId = pending.candidateItemIds[position];
    if (!itemId) break;
    return [
      {
        kind: 'add_item',
        itemId,
        quantity: pending.quantity,
        selections: pending.selections,
        sourceText: parse.original,
      },
    ];
  }

  // Not an answer. Let the utterance stand on its own.
  return [...parse.intents];
}

/**
 * Reads this turn as the answer to "what size would you like?".
 *
 * Two shapes arrive, and both mean the same thing:
 *
 *   "large"        -> modify_line against the last line
 *   "large sprite" -> add_item, because "sprite" is a menu item in its own
 *                     right. Taken literally that would ring up a *second*
 *                     drink, which is never what a caller answering a question
 *                     about their drink means.
 *
 * So an add of the very item we just asked about is folded into an edit of that
 * line. A genuinely different item ("and large fries") is left alone and is
 * ordered as normal, which is how a caller ignores the question.
 */
function resolveOptionAnswer(
  scratch: TurnScratch,
  pending: Extract<PendingQuestion, { kind: 'which-option' }>,
  parse: ParseResult,
): Intent[] {
  const target: LineTarget = { by: 'line', lineId: pending.lineId };
  const askedAboutItemId = findLine(scratch.order, pending.lineId)?.itemId;

  const resolved: Intent[] = [];
  let foldedAnAdd = false;

  for (const intent of parse.intents) {
    // A bare option word, or a count beside it: point both at the exact line we
    // asked about rather than at whatever happens to be last.
    if (intent.kind === 'modify_line' && intent.target.by === 'last') {
      resolved.push({ ...intent, target });
      continue;
    }
    if (intent.kind === 'set_quantity' && intent.target.by === 'last') {
      resolved.push({ ...intent, target });
      continue;
    }

    const restatesTheSameDrink =
      !foldedAnAdd &&
      intent.kind === 'add_item' &&
      askedAboutItemId !== undefined &&
      intent.itemId === askedAboutItemId;

    if (restatesTheSameDrink && intent.kind === 'add_item') {
      foldedAnAdd = true;
      resolved.push({
        kind: 'modify_line',
        target,
        add: intent.selections,
        remove: [],
        sourceText: intent.sourceText,
      });
      // "make it two large cokes" answers the size and changes the count.
      if (intent.quantity > 1) {
        resolved.push({
          kind: 'set_quantity',
          target,
          quantity: intent.quantity,
          sourceText: intent.sourceText,
        });
      }
      continue;
    }

    resolved.push(intent);
  }

  return resolved;
}

function mergeSelections(
  base: readonly SelectionRef[],
  extra: readonly SelectionRef[],
): SelectionRef[] {
  const seen = new Set(base.map((ref) => `${ref.groupId}:${ref.choiceId}`));
  const merged = [...base];
  for (const ref of extra) {
    const key = `${ref.groupId}:${ref.choiceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(ref);
  }
  return merged;
}

/* -------------------------------------------------------------------------- */
/* Intent application                                                          */
/* -------------------------------------------------------------------------- */

function applyIntent(
  index: MenuIndex,
  scratch: TurnScratch,
  intent: Intent,
  context: OrderContext,
): void {
  switch (intent.kind) {
    case 'add_item':
      return applyAdd(index, scratch, intent.itemId, intent.quantity, intent.selections, context);

    case 'set_quantity':
      return applySetQuantity(index, scratch, intent.target, intent.quantity, context);

    case 'bare_quantity':
      return applySetQuantity(index, scratch, { by: 'last' }, intent.quantity, context);

    case 'remove_item':
      return applyRemove(index, scratch, intent.target, context);

    case 'modify_line':
      return applyModify(index, scratch, intent.target, intent.add, intent.remove, context);

    case 'clarify_item':
      return askWhichItem(index, scratch, intent.candidateItemIds, intent.quantity, intent.selections);

    case 'clarify_category': {
      const items = (index.itemsByCategory.get(intent.categoryId) ?? []).filter(
        (item) => item.available,
      );
      if (items.length === 0) {
        scratch.events.push({ type: 'warning', message: "We don't have anything in that section." });
        return;
      }
      return askWhichItem(
        index,
        scratch,
        items.map((item) => item.id),
        intent.quantity,
        [],
      );
    }

    case 'off_menu':
      return applyOffMenu(index, scratch, intent.ruleIndex, intent.phrase);

    case 'read_total': {
      const priced = priceOrder(index, scratch.order);
      scratch.events.push({
        type: 'info',
        message:
          priced.lines.length === 0
            ? "There's nothing on the order yet."
            : `Your total is ${spokenTotal(priced)}.`,
      });
      return;
    }

    case 'repeat_order':
      scratch.events.push({ type: 'info', message: recapScript(index, priceOrder(index, scratch.order)) });
      return;

    case 'list_menu':
      scratch.events.push({
        type: 'info',
        message: intent.categoryId
          ? categoryScript(index, intent.categoryId)
          : menuOverviewScript(index),
      });
      return;

    case 'finish':
      return moveToConfirmation(index, scratch);

    case 'confirm':
      if (scratch.conversation === 'confirming') return finalise(index, scratch, context);
      scratch.events.push({ type: 'info', message: 'Great.' });
      return;

    case 'deny':
      if (scratch.conversation === 'confirming') {
        scratch.conversation = 'ordering';
        scratch.events.push({
          type: 'info',
          message: 'No problem — tell me what to change.',
        });
        return;
      }
      scratch.events.push({ type: 'info', message: 'No worries.' });
      return;

    case 'cancel_order': {
      if (scratch.order.lines.length === 0) {
        scratch.events.push({ type: 'info', message: "There's nothing to clear. What can I get you?" });
        return;
      }
      scratch.order = clearLines(scratch.order, context).order;
      scratch.lastTouchedLineId = null;
      scratch.conversation = 'ordering';
      scratch.orderChanged = true;
      scratch.events.push({
        type: 'cleared',
        message: "Okay, I've cleared the order. Let's start fresh — what can I get you?",
      });
      return;
    }

    case 'greeting':
      scratch.events.push({
        type: 'info',
        message:
          scratch.order.lines.length === 0
            ? index.menu.restaurant.greeting
            : 'What else can I get you?',
      });
      return;

    case 'unknown':
      scratch.events.push({
        type: 'warning',
        message: "Sorry, I didn't catch that. Could you say it again?",
      });
      return;

    default: {
      // Exhaustiveness guard: adding an intent without a handler is a type error.
      const unhandled: never = intent;
      throw new Error(`Unhandled intent: ${JSON.stringify(unhandled)}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Handlers                                                                    */
/* -------------------------------------------------------------------------- */

function applyAdd(
  index: MenuIndex,
  scratch: TurnScratch,
  itemId: string,
  quantity: number,
  selections: readonly SelectionRef[],
  context: OrderContext,
): void {
  const mutation = addLine(index, scratch.order, { itemId, quantity, selections }, context);
  scratch.order = mutation.order;
  scratch.lastTouchedLineId = mutation.lineId;
  scratch.orderChanged = true;
  if (scratch.conversation === 'confirming') scratch.conversation = 'ordering';

  // Ask about a variant the caller did not state, before naming it back to
  // them — "a Coke. What size?" rather than "a Medium Coke. What size?".
  const question = mutation.mergedIntoExistingLine
    ? null
    : groupToAskAbout(index, scratch, mutation.lineId, selections);

  scratch.events.push({
    type: 'added',
    message: `${pickAcknowledgement(scratch)} ${describeLineById(
      index,
      scratch.order,
      mutation.lineId,
      question ? new Set([question.group.id]) : undefined,
    )}.`,
    ...(mutation.lineId ? { lineId: mutation.lineId } : {}),
    itemId,
  });

  if (question && mutation.lineId) {
    scratch.pending = {
      kind: 'which-option',
      lineId: mutation.lineId,
      groupId: question.group.id,
      question: question.text,
    };
    scratch.conversation = 'clarifying';
    scratch.events.push({ type: 'question', message: question.text });
  }
}

/**
 * The first variant group on a new line that the catalogue says to ask about
 * and that the caller did not choose for themselves.
 *
 * Only one question per turn: a caller who says "a soft drink" should be asked
 * the size, not marched through every option the item has.
 */
function groupToAskAbout(
  index: MenuIndex,
  scratch: TurnScratch,
  lineId: string | null,
  requested: readonly SelectionRef[],
): { group: OptionGroup; text: string } | null {
  if (!lineId || scratch.pending || scratch.conversation === 'confirming') return null;

  const line = findLine(scratch.order, lineId);
  const item = line ? findItem(index, line.itemId) : undefined;
  if (!line || !item) return null;

  const statedGroupIds = new Set(requested.map((ref) => ref.groupId));

  for (const groupId of item.optionGroupIds) {
    const group = index.groupsById.get(groupId);
    if (!group?.askWhenUnspecified) continue;
    if (statedGroupIds.has(group.id)) continue; // the caller already said
    return { group, text: optionQuestionScript(group) };
  }

  return null;
}

function applySetQuantity(
  index: MenuIndex,
  scratch: TurnScratch,
  target: LineTarget,
  quantity: number,
  context: OrderContext,
): void {
  const line = resolveTarget(index, scratch, target);

  // "make it two zingers" when no zinger is on the ticket yet: just add them.
  if (!line) {
    if (target.by === 'item') {
      applyAdd(index, scratch, target.itemId, quantity, target.selections, context);
      return;
    }
    scratch.events.push({
      type: 'warning',
      message: "I'm not sure which item you mean — which one should I change?",
    });
    return;
  }

  if (quantity === 0) {
    applyRemoveLine(index, scratch, line, context);
    return;
  }

  const mutation = setLineQuantity(scratch.order, line.id, quantity, context);
  scratch.order = mutation.order;
  scratch.lastTouchedLineId = mutation.lineId;
  scratch.orderChanged = true;
  if (scratch.conversation === 'confirming') scratch.conversation = 'ordering';

  scratch.events.push({
    type: 'updated',
    message: `Done — ${describeLineById(index, scratch.order, mutation.lineId)}.`,
    ...(mutation.lineId ? { lineId: mutation.lineId } : {}),
    itemId: line.itemId,
  });
}

function applyRemove(
  index: MenuIndex,
  scratch: TurnScratch,
  target: LineTarget,
  context: OrderContext,
): void {
  const line = resolveTarget(index, scratch, target);
  if (!line) {
    scratch.events.push({ type: 'warning', message: describeMissingTarget(index, target) });
    return;
  }
  applyRemoveLine(index, scratch, line, context);
}

function applyRemoveLine(
  index: MenuIndex,
  scratch: TurnScratch,
  line: OrderLine,
  context: OrderContext,
): void {
  const description = describeLine(index, priceLine(index, line));
  const mutation = removeLine(scratch.order, line.id, context);
  scratch.order = mutation.order;
  scratch.lastTouchedLineId = null;
  scratch.orderChanged = true;
  if (scratch.conversation === 'confirming') scratch.conversation = 'ordering';

  scratch.events.push({
    type: 'removed',
    message: `Taken off — ${description}.`,
    itemId: line.itemId,
  });
}

function applyModify(
  index: MenuIndex,
  scratch: TurnScratch,
  target: LineTarget,
  add: readonly SelectionRef[],
  remove: readonly SelectionRef[],
  context: OrderContext,
): void {
  const line = resolveTarget(index, scratch, target);

  if (!line) {
    // "large fries" with nothing on the ticket yet is an order, not an edit.
    if (target.by === 'item') {
      applyAdd(index, scratch, target.itemId, 1, add, context);
      return;
    }
    scratch.events.push({
      type: 'warning',
      message: "I don't have anything to change yet — what would you like?",
    });
    return;
  }

  const mutation = updateLineSelections(index, scratch.order, line.id, { add, remove }, context);
  scratch.order = mutation.order;
  scratch.lastTouchedLineId = mutation.lineId;
  scratch.orderChanged = true;
  if (scratch.conversation === 'confirming') scratch.conversation = 'ordering';

  scratch.events.push({
    type: 'updated',
    message: `Updated — ${describeLineById(index, scratch.order, mutation.lineId)}.`,
    ...(mutation.lineId ? { lineId: mutation.lineId } : {}),
    itemId: line.itemId,
  });
}

function askWhichItem(
  index: MenuIndex,
  scratch: TurnScratch,
  candidateItemIds: readonly string[],
  quantity: number,
  selections: readonly SelectionRef[],
): void {
  const names = candidateItemIds
    .map((itemId) => findItem(index, itemId)?.name)
    .filter((name): name is string => Boolean(name));

  if (names.length === 0) {
    scratch.events.push({ type: 'warning', message: "Sorry, I didn't catch which one you wanted." });
    return;
  }

  // With two or three options, "the X or the Y" is how a person would ask.
  // Beyond that it becomes a mouthful, so the list is read plainly instead.
  const question =
    names.length === 1
      ? `Did you mean the ${names[0]}?`
      : names.length <= 3
        ? `Did you mean ${joinList(
            names.map((name) => `the ${name}`),
            'or',
          )}?`
        : `We've got ${joinList(names, 'or')} — which would you like?`;

  scratch.pending = { kind: 'which-item', candidateItemIds, quantity, selections, question };
  scratch.conversation = 'clarifying';
  scratch.events.push({ type: 'question', message: question });
}

/**
 * The curveball. The catalogue owns both the apology and the suggestions, so a
 * new "sorry, no sushi" answer is a data change, not a code change.
 */
function applyOffMenu(
  index: MenuIndex,
  scratch: TurnScratch,
  ruleIndex: number | null,
  phrase: string,
): void {
  const rule = ruleIndex === null ? undefined : index.menu.offMenu[ruleIndex];

  const apology = rule
    ? `Sorry — ${rule.reply}.`
    : `Sorry, we don't have that at ${index.menu.restaurant.name}.`;

  const suggestionIds = rule?.suggestItemIds ?? defaultSuggestions(index);
  const suggestions = suggestionIds
    .map((itemId) => findItem(index, itemId))
    .filter((item): item is NonNullable<typeof item> => Boolean(item) && item!.available)
    .map((item) => `the ${item.name}`);

  const offer =
    suggestions.length > 0
      ? ` What I can do is ${joinList(suggestions, 'or')} — any of those work?`
      : ' We do burgers, sides, drinks and combo meals — what sounds good?';

  scratch.events.push({ type: 'off_menu', message: `${apology}${offer}` });
  logger.debug('off-menu request', { phrase, matchedRule: ruleIndex });
}

function defaultSuggestions(index: MenuIndex): string[] {
  return (index.itemsByCategory.get('burgers') ?? []).slice(0, 2).map((item) => item.id);
}

function moveToConfirmation(index: MenuIndex, scratch: TurnScratch): void {
  if (scratch.order.lines.length === 0) {
    scratch.events.push({
      type: 'warning',
      message: "I don't have anything on the order yet. What can I get you?",
    });
    return;
  }
  scratch.order = setStatus(scratch.order, 'confirming');
  scratch.conversation = 'confirming';
  scratch.events.push({
    type: 'info',
    message: confirmationScript(index, priceOrder(index, scratch.order)),
  });
}

function finalise(index: MenuIndex, scratch: TurnScratch, context: OrderContext): void {
  if (scratch.order.lines.length === 0) {
    scratch.events.push({
      type: 'warning',
      message: "There's nothing on the order to send. What can I get you?",
    });
    scratch.conversation = 'ordering';
    return;
  }

  scratch.order = setStatus(scratch.order, 'confirmed', context);
  scratch.conversation = 'completed';
  scratch.orderChanged = true;

  const priced = priceOrder(index, scratch.order);
  scratch.events.push({
    type: 'confirmed',
    message: `Perfect — that's in with the kitchen. Your total is ${spokenTotal(priced)}. Thanks for calling ${index.menu.restaurant.name}!`,
  });
}

/* -------------------------------------------------------------------------- */
/* Target resolution                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Works out which line a caller meant.
 *
 * `by: 'item'` prefers a line whose options also match what they said, so
 * "cancel the large fries" leaves a separate regular fries line alone.
 */
function resolveTarget(
  index: MenuIndex,
  scratch: TurnScratch,
  target: LineTarget,
): OrderLine | undefined {
  switch (target.by) {
    case 'last': {
      const remembered = scratch.lastTouchedLineId
        ? findLine(scratch.order, scratch.lastTouchedLineId)
        : undefined;
      return remembered ?? mostRecentlyTouchedLine(scratch.order);
    }

    case 'line':
      return findLine(scratch.order, target.lineId);

    case 'item': {
      const candidates = linesForItem(scratch.order, target.itemId);
      if (candidates.length === 0) return undefined;
      if (target.selections.length === 0) return candidates[0];

      const wanted = selectionSignature(target.itemId, target.selections);
      return (
        candidates.find((line) => selectionSignature(line.itemId, line.selections) === wanted) ??
        candidates.find((line) =>
          target.selections.every((ref) =>
            line.selections.some(
              (existing) => existing.groupId === ref.groupId && existing.choiceId === ref.choiceId,
            ),
          ),
        ) ??
        candidates[0]
      );
    }

    case 'category': {
      const matching = scratch.order.lines.filter(
        (line) => findItem(index, line.itemId)?.categoryId === target.categoryId,
      );
      return [...matching].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    }

    default: {
      const unhandled: never = target;
      throw new Error(`Unhandled target: ${JSON.stringify(unhandled)}`);
    }
  }
}

function describeMissingTarget(index: MenuIndex, target: LineTarget): string {
  if (target.by === 'item') {
    const item = findItem(index, target.itemId);
    return item
      ? `I don't have ${item.name} on the order — was there something else to take off?`
      : "I don't have that on the order.";
  }
  if (target.by === 'category') {
    const category = index.categoriesById.get(target.categoryId);
    return category
      ? `There's nothing from ${category.name.toLowerCase()} on the order.`
      : "I don't have that on the order.";
  }
  if (target.by === 'line') return "That item is no longer on the order.";
  return "There's nothing on the order to take off.";
}

/* -------------------------------------------------------------------------- */
/* Reply composition                                                           */
/* -------------------------------------------------------------------------- */

const ACKNOWLEDGEMENTS = ['Got it —', 'Sure —', 'Okay —', 'Perfect —'] as const;

function pickAcknowledgement(scratch: TurnScratch): string {
  // Rotating by event count keeps a multi-item turn from repeating one word.
  return ACKNOWLEDGEMENTS[scratch.events.length % ACKNOWLEDGEMENTS.length] as string;
}

function describeLineById(
  index: MenuIndex,
  order: Order,
  lineId: string | null,
  omitGroupIds?: ReadonlySet<string>,
): string {
  if (!lineId) return 'that';
  const line = findLine(order, lineId);
  if (!line) return 'that';
  return describeLine(index, priceLine(index, line), omitGroupIds);
}

/**
 * Stitches the turn's events into one utterance, then appends the running total
 * and a light prompt — the two things a caller expects to hear after a change.
 */
function composeReply(
  index: MenuIndex,
  previous: AgentState,
  scratch: TurnScratch,
  order: PricedOrder,
): string {
  const parts = scratch.events.map((event) => event.message.trim()).filter((part) => part.length > 0);

  if (parts.length === 0) {
    parts.push("Sorry, I didn't catch that. Could you say it again?");
  }

  const isClosing = scratch.conversation === 'confirming' || scratch.conversation === 'completed';
  const awaitingAnswer = scratch.pending !== null;
  const alreadyStatedTotal = scratch.events.some(
    (event) => event.type === 'info' || event.type === 'confirmed',
  );

  if (scratch.orderChanged && !isClosing && !awaitingAnswer && !alreadyStatedTotal) {
    parts.push(runningTotalSentence(order, previous.turnCount));
    if (order.lines.length > 0) parts.push('Anything else?');
  }

  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
