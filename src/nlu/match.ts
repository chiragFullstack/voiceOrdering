/**
 * Phrase matching.
 *
 * Callers rarely say an item's exact catalogue name, and speech-to-text adds
 * its own noise ("mozarella", "zinger burga"). The matcher slides a window over
 * the token stream and scores each window against every known phrase: exact
 * matches win outright, near-misses are accepted above a similarity floor, and
 * genuinely ambiguous windows are reported as such so the agent can ask rather
 * than guess.
 */

import { MAX_PHRASE_TOKENS } from './normalize';

export interface PhraseEntry<TPayload> {
  /** Normalised alias, e.g. `spicy zinger burger`. */
  readonly phrase: string;
  readonly tokens: readonly string[];
  readonly payload: TPayload;
  /** Tie-breaker when two phrases score equally. Higher wins. */
  readonly weight: number;
}

export interface PhraseMatch<TPayload> {
  readonly payload: TPayload;
  readonly phrase: string;
  /** Inclusive start index into the token array. */
  readonly start: number;
  /** Exclusive end index into the token array. */
  readonly end: number;
  /** 0..1, where 1 is an exact alias match. */
  readonly score: number;
  /** Copied from the entry, so ranking never has to inspect the payload. */
  readonly weight: number;
}

export interface MatchOptions {
  /** Minimum similarity for a fuzzy match to be accepted. */
  readonly threshold?: number;
  /** Shortest token that may be fuzzy-matched — stops "a" matching "avocado". */
  readonly minFuzzyLength?: number;
}

const DEFAULT_THRESHOLD = 0.82;
const DEFAULT_MIN_FUZZY_LENGTH = 4;

/* -------------------------------------------------------------------------- */
/* Similarity                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Levenshtein distance with a cut-off. Bailing out once the best possible
 * result already exceeds `maxDistance` keeps this cheap inside the window loop.
 */
export function levenshtein(a: string, b: string, maxDistance = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMinimum = current[0] as number;
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (current[j - 1] as number) + 1,
        (previous[j] as number) + 1,
        (previous[j - 1] as number) + substitutionCost,
      );
      current[j] = value;
      if (value < rowMinimum) rowMinimum = value;
    }
    if (rowMinimum > maxDistance) return maxDistance + 1;
    [previous, current] = [current, previous];
  }

  return previous[b.length] as number;
}

/** Normalised similarity in 0..1. */
export function similarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  const maxDistance = Math.ceil(longest * 0.4);
  const distance = levenshtein(a, b, maxDistance);
  if (distance > maxDistance) return 0;
  return 1 - distance / longest;
}

/* -------------------------------------------------------------------------- */
/* Index                                                                       */
/* -------------------------------------------------------------------------- */

export interface PhraseIndex<TPayload> {
  /** Entries bucketed by token count, so windows only compare against peers. */
  readonly byTokenCount: ReadonlyMap<number, readonly PhraseEntry<TPayload>[]>;
  readonly maxTokens: number;
}

export function buildPhraseIndex<TPayload>(
  entries: readonly PhraseEntry<TPayload>[],
): PhraseIndex<TPayload> {
  const byTokenCount = new Map<number, PhraseEntry<TPayload>[]>();
  let maxTokens = 1;
  for (const entry of entries) {
    const count = entry.tokens.length;
    if (count === 0 || count > MAX_PHRASE_TOKENS) continue;
    maxTokens = Math.max(maxTokens, count);
    const bucket = byTokenCount.get(count);
    if (bucket) bucket.push(entry);
    else byTokenCount.set(count, [entry]);
  }
  return { byTokenCount, maxTokens };
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * All matches above the threshold, longest and strongest first. Overlapping
 * matches are all returned; callers decide how to resolve them.
 */
export function findMatches<TPayload>(
  tokens: readonly string[],
  index: PhraseIndex<TPayload>,
  options: MatchOptions = {},
): PhraseMatch<TPayload>[] {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const minFuzzyLength = options.minFuzzyLength ?? DEFAULT_MIN_FUZZY_LENGTH;
  const matches: PhraseMatch<TPayload>[] = [];

  for (let start = 0; start < tokens.length; start += 1) {
    const maxLength = Math.min(index.maxTokens, tokens.length - start);
    for (let length = 1; length <= maxLength; length += 1) {
      const window = tokens.slice(start, start + length);
      const windowText = window.join(' ');
      const candidates = index.byTokenCount.get(length);
      if (!candidates) continue;

      for (const entry of candidates) {
        let score: number;
        if (entry.phrase === windowText) {
          score = 1;
        } else if (windowText.length < minFuzzyLength || entry.phrase.length < minFuzzyLength) {
          continue; // too short to fuzzy-match safely
        } else {
          score = similarity(windowText, entry.phrase);
          if (score < threshold) continue;
        }
        matches.push({
          payload: entry.payload,
          phrase: entry.phrase,
          start,
          end: start + length,
          score,
          weight: entry.weight,
        });
      }
    }
  }

  return matches.sort(compareMatches);
}

/** Strongest first; longer phrases beat shorter ones; then declared weight. */
function compareMatches<TPayload>(a: PhraseMatch<TPayload>, b: PhraseMatch<TPayload>): number {
  if (b.score !== a.score) return b.score - a.score;
  const lengthDifference = b.end - b.start - (a.end - a.start);
  if (lengthDifference !== 0) return lengthDifference;
  return b.weight - a.weight;
}

/**
 * Picks the best non-overlapping set of matches, greedily.
 *
 * "double chicken smash" therefore resolves to the three-token item rather than
 * the one-token alias "smash" that also sits inside it.
 */
export function selectNonOverlapping<TPayload>(
  matches: readonly PhraseMatch<TPayload>[],
): PhraseMatch<TPayload>[] {
  const claimed = new Set<number>();
  const selected: PhraseMatch<TPayload>[] = [];

  for (const match of matches) {
    let overlaps = false;
    for (let index = match.start; index < match.end; index += 1) {
      if (claimed.has(index)) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) continue;
    for (let index = match.start; index < match.end; index += 1) claimed.add(index);
    selected.push(match);
  }

  return selected.sort((a, b) => a.start - b.start);
}

/**
 * Groups equally-strong matches that cover the same window but point at
 * different targets — "chicken burger" is a real alias of both the Grilled and
 * the Crispy burger, and the agent must ask which one rather than pick.
 */
export function collectAmbiguity<TPayload>(
  matches: readonly PhraseMatch<TPayload>[],
  best: PhraseMatch<TPayload>,
  identify: (payload: TPayload) => string,
): PhraseMatch<TPayload>[] {
  const seen = new Set<string>();
  const rivals: PhraseMatch<TPayload>[] = [];
  for (const match of matches) {
    if (match.start !== best.start || match.end !== best.end) continue;
    if (match.score !== best.score) continue;
    const id = identify(match.payload);
    if (seen.has(id)) continue;
    seen.add(id);
    rivals.push(match);
  }
  return rivals;
}
