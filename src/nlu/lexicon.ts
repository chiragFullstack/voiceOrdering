/**
 * The lexicon.
 *
 * Everything the agent can recognise is derived from `data/menu.json` — there
 * is no second list of words to keep in sync. Add an item or an alias to the
 * catalogue and the agent understands it on the next boot.
 */

import type { MenuIndex, SelectionRef } from '@/domain/types';
import { buildPhraseIndex, type PhraseEntry, type PhraseIndex } from './match';
import { contentTokens, normalizeText } from './normalize';

/* -------------------------------------------------------------------------- */
/* Payloads                                                                    */
/* -------------------------------------------------------------------------- */

export interface ItemPhrase {
  readonly itemId: string;
  /** Options implied by the phrase itself, e.g. "coke" implies flavour=Coke. */
  readonly impliedSelections: readonly SelectionRef[];
  readonly weight: number;
}

export interface ChoicePhrase {
  /**
   * Every catalogue option this phrase could mean. "large" is a size in two
   * different groups; which one applies is decided later, when the item is
   * known, by dropping the groups that item does not allow.
   */
  readonly refs: readonly SelectionRef[];
  readonly weight: number;
}

export interface CategoryPhrase {
  readonly categoryId: string;
  readonly weight: number;
}

export interface OffMenuPhrase {
  readonly ruleIndex: number;
  readonly weight: number;
}

export interface Lexicon {
  readonly items: PhraseIndex<ItemPhrase>;
  readonly choices: PhraseIndex<ChoicePhrase>;
  readonly categories: PhraseIndex<CategoryPhrase>;
  readonly offMenu: PhraseIndex<OffMenuPhrase>;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                */
/* -------------------------------------------------------------------------- */

function toEntry<T>(phrase: string, payload: T, weight: number): PhraseEntry<T> | null {
  const normalized = normalizeText(phrase);
  const tokens = contentTokens(normalized);
  if (tokens.length === 0) return null;
  return { phrase: tokens.join(' '), tokens, payload, weight };
}

/** Extra spoken forms for a category, beyond its catalogue name. */
const CATEGORY_EXTRA_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
  ['burgers', ['burger', 'burgers', 'sandwich burger']],
  ['sides', ['side', 'sides', 'side dish', 'side order']],
  ['drinks', ['drink', 'drinks', 'beverage', 'beverages', 'something to drink']],
  ['combos', ['combo', 'combos', 'meal', 'meals', 'combo meal', 'value meal']],
]);

export function buildLexicon(index: MenuIndex): Lexicon {
  return {
    items: buildPhraseIndex(buildItemEntries(index)),
    choices: buildPhraseIndex(buildChoiceEntries(index)),
    categories: buildPhraseIndex(buildCategoryEntries(index)),
    offMenu: buildPhraseIndex(buildOffMenuEntries(index)),
  };
}

function buildItemEntries(index: MenuIndex): PhraseEntry<ItemPhrase>[] {
  const entries: PhraseEntry<ItemPhrase>[] = [];

  for (const item of index.menu.items) {
    if (!item.available) continue;

    const phrases = new Set<string>([item.name, ...item.aliases]);
    for (const phrase of phrases) {
      // Longer, more specific aliases outrank short generic ones on a tie.
      const weight = 100 + phrase.length;
      const entry = toEntry(phrase, { itemId: item.id, impliedSelections: [], weight }, weight);
      if (entry) entries.push(entry);
    }

    for (const shortcut of item.shortcuts ?? []) {
      for (const phrase of shortcut.phrases) {
        // Shortcuts carry options, so they should beat the bare item alias.
        const weight = 200 + phrase.length;
        const entry = toEntry(
          phrase,
          { itemId: item.id, impliedSelections: shortcut.selections, weight },
          weight,
        );
        if (entry) entries.push(entry);
      }
    }
  }

  return entries;
}

function buildChoiceEntries(index: MenuIndex): PhraseEntry<ChoicePhrase>[] {
  /** phrase -> every option it could refer to, across all groups. */
  const byPhrase = new Map<string, SelectionRef[]>();

  for (const group of index.menu.optionGroups) {
    for (const choice of group.choices) {
      const phrases = new Set<string>([choice.name, ...choice.aliases]);
      for (const phrase of phrases) {
        const normalized = contentTokens(normalizeText(phrase)).join(' ');
        if (normalized.length === 0) continue;
        const refs = byPhrase.get(normalized) ?? [];
        if (!refs.some((ref) => ref.groupId === group.id && ref.choiceId === choice.id)) {
          refs.push({ groupId: group.id, choiceId: choice.id });
        }
        byPhrase.set(normalized, refs);
      }
    }
  }

  const entries: PhraseEntry<ChoicePhrase>[] = [];
  for (const [phrase, refs] of byPhrase) {
    const weight = 100 + phrase.length;
    const entry = toEntry(phrase, { refs, weight }, weight);
    if (entry) entries.push(entry);
  }
  return entries;
}

function buildCategoryEntries(index: MenuIndex): PhraseEntry<CategoryPhrase>[] {
  const entries: PhraseEntry<CategoryPhrase>[] = [];
  for (const category of index.menu.categories) {
    const phrases = new Set<string>([
      category.name,
      ...(CATEGORY_EXTRA_ALIASES.get(category.id) ?? []),
    ]);
    for (const phrase of phrases) {
      // Below item weight: a specific item always beats its category.
      const weight = 10 + phrase.length;
      const entry = toEntry(phrase, { categoryId: category.id, weight }, weight);
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

function buildOffMenuEntries(index: MenuIndex): PhraseEntry<OffMenuPhrase>[] {
  const entries: PhraseEntry<OffMenuPhrase>[] = [];
  index.menu.offMenu.forEach((rule, ruleIndex) => {
    for (const phrase of rule.match) {
      const weight = 50 + phrase.length;
      const entry = toEntry(phrase, { ruleIndex, weight }, weight);
      if (entry) entries.push(entry);
    }
  });
  return entries;
}

/* -------------------------------------------------------------------------- */
/* Singleton                                                                   */
/* -------------------------------------------------------------------------- */

const cache = new WeakMap<MenuIndex, Lexicon>();

/** Built once per catalogue and memoised — the menu never changes at runtime. */
export function getLexicon(index: MenuIndex): Lexicon {
  let lexicon = cache.get(index);
  if (!lexicon) {
    lexicon = buildLexicon(index);
    cache.set(index, lexicon);
  }
  return lexicon;
}
