/**
 * The parser.
 *
 * Pipeline, per utterance:
 *
 *   normalise -> split into segments -> per segment:
 *     1. match menu items (longest, strongest wins; ties become a clarification)
 *     2. match options in the tokens the items did not claim
 *     3. read a quantity from the tokens before the item
 *     4. pick an intent from the cue words present
 *   -> stitch orphan modifiers onto the preceding add
 *
 * The parser is stateless and pure. It never sees the order, so "make it two"
 * comes out as `set_quantity` against a `{ by: 'last' }` target and the agent
 * decides what "last" means.
 */

import type { MenuIndex, SelectionRef } from '@/domain/types';
import { getLexicon, type ChoicePhrase, type ItemPhrase } from './lexicon';
import {
  collectAmbiguity,
  findMatches,
  selectNonOverlapping,
  type PhraseMatch,
} from './match';
import type { Intent, LineTarget, ParseResult } from './intents';
import {
  contentTokens,
  normalizeText,
  parseNumberToken,
  segmentUtterance,
  tokenize,
} from './normalize';

/* -------------------------------------------------------------------------- */
/* Cue patterns                                                                */
/* -------------------------------------------------------------------------- */

const CUE = {
  cancelOrder:
    /\b(cancel (the |my |this )?(whole |entire )?order|start over|start again|scrap (the|my|it)|forget (the|my) order|clear (the|my) order|never mind the order)\b/,
  // The second branch catches split verb phrases: "take the coleslaw off".
  remove:
    /\b(cancel|remove|delete|drop|scratch|forget|get rid of|lose the|do not want|no longer want)\b|\btake\s+(?:the\s+|that\s+|my\s+|those\s+)?[\w\s]*\b(off|out|away)\b/,
  change: /\b(make (it|that|them|those)|make|change|instead|actually|switch|swap|update|rather)\b/,
  confirm:
    /^(yes|yeah|yep|yup|ye|sure|correct|right|exactly|perfect|confirm|confirmed|good|sounds good|that is right|that is correct|go ahead|place it|place the order|send it|submit)\b/,
  deny: /^(no|nope|nah|negative|not quite|not right|wrong|that is wrong|that is not right|incorrect)\b$/,
  total: /\b(total|how much|what do i owe|whats the damage|the damage|the price|the cost|add it up)\b/,
  repeat:
    /\b(repeat|read (it|that|them|the order)? ?back|read back|run (it|that) by|what did i order|what have i ordered|my order so far|go over (it|the order)|recap)\b/,
  menu: /\b(what do you have|what have you got|the menu|on the menu|what is on|my options|what options|what kind|what types|what flavours|what flavors|what sizes|recommend|suggestions|specials)\b/,
  finish:
    /\b(that is it|that is all|that is everything|that will be all|that will be it|nothing else|no thanks that is|i am done|we are done|all done|finished|complete the order|check out|checkout|place the order)\b/,
  greeting: /^(hi|hello|hey|yo|good (morning|afternoon|evening)|salaam|hola)\b/,
  negation: /^(no|not|without|hold|skip|remove|minus|less|zero)$/,
} as const;

/** A choice phrase that already means "leave it out" (e.g. "no onions"). */
const SELF_NEGATING_PHRASE = /^(no|without|hold|skip)\b/;

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export function parseUtterance(index: MenuIndex, utterance: string): ParseResult {
  const normalized = normalizeText(utterance);
  if (normalized.length === 0) {
    return { original: utterance, normalized, intents: [{ kind: 'unknown', sourceText: utterance }] };
  }

  const segments = segmentUtterance(normalized);
  const intents: Intent[] = [];

  for (const segment of segments) {
    intents.push(...parseSegment(index, segment, normalized));
  }

  // Punctuation-only input can yield nothing. Callers rely on there always
  // being at least one intent to act on, even if it is only "I didn't catch it".
  const resolved = dedupe(foldTrailingModifiers(intents));
  return {
    original: utterance,
    normalized,
    intents: resolved.length > 0 ? resolved : [{ kind: 'unknown', sourceText: utterance }],
  };
}

/* -------------------------------------------------------------------------- */
/* Segment parsing                                                             */
/* -------------------------------------------------------------------------- */

function parseSegment(index: MenuIndex, segment: string, fullUtterance: string): Intent[] {
  const lexicon = getLexicon(index);
  const rawTokens = tokenize(segment);
  const tokens = contentTokens(segment);

  if (tokens.length === 0) {
    // Pure filler, but the whole utterance may still be an acknowledgement.
    return CUE.confirm.test(segment) ? [{ kind: 'confirm' }] : [];
  }

  // Whole-order cancellation outranks everything else in the segment.
  if (CUE.cancelOrder.test(segment)) return [{ kind: 'cancel_order' }];

  /* --- 1. Items ---------------------------------------------------------- */

  const itemMatches = findMatches(tokens, lexicon.items);
  const allChoiceMatches = findMatches(tokens, lexicon.choices);
  const chosenItems = dropItemsThatModifyTheLead(
    index,
    selectNonOverlapping(itemMatches),
    allChoiceMatches,
    tokens,
  );

  /* --- 2. Options, from whatever the items did not claim ------------------ */

  const claimed = claimedIndices(chosenItems);
  const choiceMatches = allChoiceMatches.filter((match) => !overlapsClaimed(match, claimed));
  const chosenChoices = selectNonOverlapping(choiceMatches);
  const { additions, removals } = splitByNegation(tokens, chosenChoices);

  /* --- 3. Cues ----------------------------------------------------------- */

  const hasRemoveCue = CUE.remove.test(segment);
  const hasChangeCue = CUE.change.test(segment);

  /* --- 4. Build intents -------------------------------------------------- */

  if (chosenItems.length > 0) {
    return buildItemIntents(index, {
      segment,
      tokens,
      chosenItems,
      itemMatches,
      additions,
      removals,
      hasRemoveCue,
      hasChangeCue,
    });
  }

  // No item named. An explicit option change applies to whatever was last touched.
  if (additions.length > 0 || removals.length > 0) {
    const target: LineTarget = { by: 'last' };

    if (hasRemoveCue && additions.length > 0 && removals.length === 0) {
      // "cancel the extra cheese" — the cue makes the option a removal.
      return [{ kind: 'modify_line', target, add: [], remove: additions, sourceText: segment }];
    }

    const intents: Intent[] = [];

    // "two large" changes the count as well as the option. The count is applied
    // first: the option edit can merge the line into an identical one, which
    // would leave a later quantity change pointing at a line that is gone.
    const quantity = readQuantity(tokens, tokens.length);
    if (quantity !== null) {
      intents.push({ kind: 'set_quantity', target, quantity, sourceText: segment });
    }

    intents.push({ kind: 'modify_line', target, add: additions, remove: removals, sourceText: segment });
    return intents;
  }

  /* --- 5. A correction that names only a number: "actually make it two" ---- */

  const loneQuantity = readQuantity(tokens, tokens.length);
  if (hasChangeCue && loneQuantity !== null) {
    return [
      { kind: 'set_quantity', target: { by: 'last' }, quantity: loneQuantity, sourceText: segment },
    ];
  }

  /* --- 6. The curveball --------------------------------------------------- */

  // Checked before the category lexicon so "a beef burger" is answered as
  // off-menu rather than as "which of our burgers?".
  const offMenu = matchOffMenu(index, tokens, segment);
  if (offMenu) return [offMenu];

  /* --- 7. Order-level and conversational intents --------------------------- */

  const conversational = matchConversational(segment, rawTokens);
  if (conversational) return [conversational];

  const categoryIntent = matchCategory(index, tokens, segment, hasRemoveCue);
  if (categoryIntent) return [categoryIntent];

  if (loneQuantity !== null && tokens.every((token) => parseNumberToken(token, true) !== null)) {
    return [{ kind: 'bare_quantity', quantity: loneQuantity, sourceText: segment }];
  }

  // Nothing recognised. Treat a request-shaped sentence as an off-menu ask so
  // the caller gets a helpful answer instead of "sorry, I did not catch that".
  if (looksLikeARequest(segment)) {
    return [{ kind: 'off_menu', ruleIndex: null, phrase: segment, sourceText: segment }];
  }

  return [{ kind: 'unknown', sourceText: fullUtterance }];
}

/* -------------------------------------------------------------------------- */
/* Item intents                                                                */
/* -------------------------------------------------------------------------- */

interface ItemIntentInput {
  readonly segment: string;
  readonly tokens: readonly string[];
  readonly chosenItems: readonly PhraseMatch<ItemPhrase>[];
  readonly itemMatches: readonly PhraseMatch<ItemPhrase>[];
  readonly additions: readonly SelectionRef[];
  readonly removals: readonly SelectionRef[];
  readonly hasRemoveCue: boolean;
  readonly hasChangeCue: boolean;
}

function buildItemIntents(index: MenuIndex, input: ItemIntentInput): Intent[] {
  const intents: Intent[] = [];

  for (const [position, match] of input.chosenItems.entries()) {
    const quantity = readQuantity(input.tokens, match.start) ?? 1;

    // Options attach to the first item in the segment; a second item in the
    // same breath ("a zinger with cheese and a coke") is a separate segment.
    const additions = position === 0 ? input.additions : [];
    const removals = position === 0 ? input.removals : [];

    const rivals = collectAmbiguity(input.itemMatches, match, (payload) => payload.itemId);
    if (rivals.length > 1) {
      intents.push({
        kind: 'clarify_item',
        candidateItemIds: rivals.map((rival) => rival.payload.itemId),
        quantity,
        selections: additions,
        sourceText: input.segment,
      });
      continue;
    }

    const itemId = match.payload.itemId;
    const target: LineTarget = { by: 'item', itemId, selections: additions };

    if (input.hasRemoveCue) {
      intents.push({ kind: 'remove_item', target, sourceText: input.segment });
      continue;
    }

    if (input.hasChangeCue) {
      // "make it three fries" puts the number first; "make the fries three"
      // puts it last. Only a correction looks forward, so a plain order is
      // never confused by a number that belongs to the next clause.
      const explicitQuantity =
        readQuantity(input.tokens, match.start) ?? readQuantityAfter(input.tokens, match.end);
      if (explicitQuantity !== null) {
        intents.push({
          kind: 'set_quantity',
          target,
          quantity: explicitQuantity,
          sourceText: input.segment,
        });
      }
      if (additions.length > 0 || removals.length > 0) {
        intents.push({
          kind: 'modify_line',
          target,
          add: additions,
          remove: removals,
          sourceText: input.segment,
        });
      }
      if (explicitQuantity !== null || additions.length > 0 || removals.length > 0) continue;
      // "actually, a zinger" with nothing to change — fall through to an add.
    }

    intents.push({
      kind: 'add_item',
      itemId,
      quantity,
      selections: [...match.payload.impliedSelections, ...additions],
      sourceText: input.segment,
    });
  }

  return intents;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/** Words that join an item to its options rather than to another item. */
const CONNECTIVES: ReadonlySet<string> = new Set([
  'with',
  'plus',
  'a',
  'an',
  'the',
  'of',
  'some',
  'extra',
]);

/**
 * Re-reads a trailing "item" as an option of the item before it.
 *
 * "sprite" is both a drink on its own and the drink *inside* a combo, so
 * "a classic combo with sprite" would otherwise ring up a combo and a separate
 * Sprite. When the trailing phrase names a choice in a group the leading item
 * allows, and only connectives sit between them, it is a modifier — so the item
 * reading is dropped and the ordinary option matcher picks the phrase up.
 *
 * Genuinely separate requests are unaffected: "a classic combo and a sprite"
 * is split into two segments long before this runs.
 */
function dropItemsThatModifyTheLead(
  index: MenuIndex,
  chosen: readonly PhraseMatch<ItemPhrase>[],
  choiceMatches: readonly PhraseMatch<ChoicePhrase>[],
  tokens: readonly string[],
): PhraseMatch<ItemPhrase>[] {
  const lead = chosen[0];
  if (chosen.length < 2 || !lead) return [...chosen];

  const leadItem = index.itemsById.get(lead.payload.itemId);
  if (!leadItem || leadItem.optionGroupIds.length === 0) return [...chosen];

  const kept: PhraseMatch<ItemPhrase>[] = [lead];
  let previousEnd = lead.end;

  for (const candidate of chosen.slice(1)) {
    const gapIsConnective = tokens
      .slice(previousEnd, candidate.start)
      .every((token) => CONNECTIVES.has(token));

    const namesAnAllowedOption = choiceMatches.some(
      (match) =>
        match.start === candidate.start &&
        match.end === candidate.end &&
        match.payload.refs.some((ref) => leadItem.optionGroupIds.includes(ref.groupId)),
    );

    previousEnd = candidate.end;
    if (gapIsConnective && namesAnAllowedOption) continue; // it is a modifier
    kept.push(candidate);
  }

  return kept;
}

function claimedIndices(matches: readonly PhraseMatch<unknown>[]): Set<number> {
  const claimed = new Set<number>();
  for (const match of matches) {
    for (let index = match.start; index < match.end; index += 1) claimed.add(index);
  }
  return claimed;
}

function overlapsClaimed(match: PhraseMatch<unknown>, claimed: ReadonlySet<number>): boolean {
  for (let index = match.start; index < match.end; index += 1) {
    if (claimed.has(index)) return true;
  }
  return false;
}

/**
 * Decides whether each matched option is being asked for or taken away.
 *
 * "extra cheese"        -> addition
 * "no onions"           -> addition (the *option* is "No Onions")
 * "no cheese"           -> removal of Extra Cheese
 * "without the avocado" -> removal of Avocado
 */
function splitByNegation(
  tokens: readonly string[],
  matches: readonly PhraseMatch<ChoicePhrase>[],
): { additions: SelectionRef[]; removals: SelectionRef[] } {
  const additions: SelectionRef[] = [];
  const removals: SelectionRef[] = [];

  for (const match of matches) {
    const selfNegating = SELF_NEGATING_PHRASE.test(match.phrase);
    const previous = lookBehind(tokens, match.start);
    const negatedByContext = previous !== null && CUE.negation.test(previous);

    if (!selfNegating && negatedByContext) removals.push(...match.payload.refs);
    else additions.push(...match.payload.refs);
  }

  return { additions, removals };
}

/** Nearest meaningful token before an index, skipping articles. */
function lookBehind(tokens: readonly string[], start: number): string | null {
  const SKIPPABLE = new Set(['the', 'a', 'an', 'any', 'some', 'my', 'that', 'this', 'it']);
  for (let index = start - 1; index >= 0 && index >= start - 3; index -= 1) {
    const token = tokens[index];
    if (token === undefined) break;
    if (SKIPPABLE.has(token)) continue;
    return token;
  }
  return null;
}

/**
 * The quantity for an item is the last number appearing before it — "two large
 * fries" is 2, and the "two" in "no. 2 combo" style phrasing stays out of the
 * way because item aliases claim their own tokens first.
 */
function readQuantity(tokens: readonly string[], beforeIndex: number): number | null {
  for (let index = Math.min(beforeIndex, tokens.length) - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    const value = parseNumberToken(token, false);
    if (value !== null && value > 0) return value;
    // Only look across articles and adjectives, not across another noun.
    if (index < beforeIndex - 3) break;
  }
  return null;
}

/** Scans a short way forward for a count, for "make the fries three". */
function readQuantityAfter(tokens: readonly string[], fromIndex: number, span = 2): number | null {
  const limit = Math.min(tokens.length, fromIndex + span);
  for (let index = fromIndex; index < limit; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    const value = parseNumberToken(token, false);
    if (value !== null && value > 0) return value;
  }
  return null;
}

function matchCategory(
  index: MenuIndex,
  tokens: readonly string[],
  segment: string,
  hasRemoveCue: boolean,
): Intent | null {
  const lexicon = getLexicon(index);
  const matches = selectNonOverlapping(findMatches(tokens, lexicon.categories));
  const best = matches[0];
  if (!best) return null;

  if (hasRemoveCue) {
    return {
      kind: 'remove_item',
      target: { by: 'category', categoryId: best.payload.categoryId },
      sourceText: segment,
    };
  }

  if (CUE.menu.test(segment)) {
    return { kind: 'list_menu', categoryId: best.payload.categoryId };
  }

  return {
    kind: 'clarify_category',
    categoryId: best.payload.categoryId,
    quantity: readQuantity(tokens, best.start) ?? 1,
    sourceText: segment,
  };
}

function matchConversational(segment: string, rawTokens: readonly string[]): Intent | null {
  if (CUE.finish.test(segment)) return { kind: 'finish' };
  if (CUE.repeat.test(segment)) return { kind: 'repeat_order' };
  if (CUE.total.test(segment)) return { kind: 'read_total' };
  if (CUE.menu.test(segment)) return { kind: 'list_menu', categoryId: null };
  if (CUE.deny.test(segment)) return { kind: 'deny' };
  if (CUE.confirm.test(segment)) return { kind: 'confirm' };
  if (CUE.greeting.test(segment) && rawTokens.length <= 4) return { kind: 'greeting' };
  return null;
}

function matchOffMenu(index: MenuIndex, tokens: readonly string[], segment: string): Intent | null {
  const lexicon = getLexicon(index);
  const matches = selectNonOverlapping(findMatches(tokens, lexicon.offMenu));
  const best = matches[0];
  if (!best) return null;
  return {
    kind: 'off_menu',
    ruleIndex: best.payload.ruleIndex,
    phrase: best.phrase,
    sourceText: segment,
  };
}

/** Sentence shapes that mean "I would like something", even if we missed what. */
function looksLikeARequest(segment: string): boolean {
  return /\b(can i|could i|i want|i would like|i will have|i will take|give me|let me have|do you have|got any|any chance|how about)\b/.test(
    segment,
  );
}

/**
 * Folds a trailing modifier clause back into the item it belongs to.
 *
 * "a zinger with extra cheese and no onions" segments into an add plus a
 * dangling "no onions", because the split happens on "and". Re-attaching it
 * keeps the reply to one sentence instead of an add followed by an edit.
 */
function foldTrailingModifiers(intents: readonly Intent[]): Intent[] {
  const result: Intent[] = [];

  for (const intent of intents) {
    const previous = result.at(-1);
    const isDanglingAddition =
      intent.kind === 'modify_line' &&
      intent.target.by === 'last' &&
      intent.remove.length === 0 &&
      intent.add.length > 0;

    if (isDanglingAddition && previous?.kind === 'add_item') {
      result[result.length - 1] = {
        ...previous,
        selections: [...previous.selections, ...intent.add],
      };
      continue;
    }

    if (isDanglingAddition && previous?.kind === 'clarify_item') {
      result[result.length - 1] = {
        ...previous,
        selections: [...previous.selections, ...intent.add],
      };
      continue;
    }

    result.push(intent);
  }

  return result;
}

/** Collapses repeated conversational intents from a multi-clause utterance. */
function dedupe(intents: readonly Intent[]): Intent[] {
  const seen = new Set<string>();
  const result: Intent[] = [];
  for (const intent of intents) {
    const isSingleton =
      intent.kind === 'confirm' ||
      intent.kind === 'deny' ||
      intent.kind === 'finish' ||
      intent.kind === 'greeting' ||
      intent.kind === 'read_total' ||
      intent.kind === 'repeat_order' ||
      intent.kind === 'cancel_order' ||
      intent.kind === 'unknown';
    if (!isSingleton) {
      result.push(intent);
      continue;
    }
    if (seen.has(intent.kind)) continue;
    seen.add(intent.kind);
    result.push(intent);
  }

  // An `unknown` alongside anything actionable is noise from a stray clause.
  const actionable = result.filter((intent) => intent.kind !== 'unknown');
  const meaningful = actionable.length > 0 ? actionable : result;

  // "Hi, can I get a zinger" is one request, not a greeting and a request.
  const withoutPleasantries = meaningful.filter((intent) => intent.kind !== 'greeting');
  return withoutPleasantries.length > 0 ? withoutPleasantries : meaningful;
}
