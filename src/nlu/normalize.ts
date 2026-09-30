/**
 * Text normalisation for speech input.
 *
 * Speech-to-text output is messy in predictable ways: contractions, filler
 * words, spelled-out numbers, stray punctuation, and inconsistent casing. This
 * module flattens all of that into a canonical token stream so the matcher
 * downstream compares like with like.
 */

/** Longest multi-word alias we will ever try to match, in tokens. */
export const MAX_PHRASE_TOKENS = 4;

const CONTRACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bcan['’]?t\b/g, 'can not'],
  [/\bwon['’]?t\b/g, 'will not'],
  [/\bdon['’]?t\b/g, 'do not'],
  [/\bdoesn['’]?t\b/g, 'does not'],
  [/\bdidn['’]?t\b/g, 'did not'],
  [/\bisn['’]?t\b/g, 'is not'],
  [/\baren['’]?t\b/g, 'are not'],
  [/\bwasn['’]?t\b/g, 'was not'],
  [/\bi['’]?m\b/g, 'i am'],
  [/\bi['’]?d\b/g, 'i would'],
  [/\bi['’]?ll\b/g, 'i will'],
  [/\bi['’]?ve\b/g, 'i have'],
  [/\bthat['’]?s\b/g, 'that is'],
  [/\bthats\b/g, 'that is'],
  [/\bit['’]?s\b/g, 'it is'],
  [/\bwhat['’]?s\b/g, 'what is'],
  [/\bwhats\b/g, 'what is'],
  [/\blet['’]?s\b/g, 'let us'],
  [/\byou['’]?re\b/g, 'you are'],
  [/\bgimme\b/g, 'give me'],
  [/\blemme\b/g, 'let me'],
  [/\bwanna\b/g, 'want to'],
  [/\bgonna\b/g, 'going to'],
  [/\bcuz\b/g, 'because'],
  [/\bya\b/g, 'yeah'],
];

/** Words that carry no ordering meaning and only confuse phrase matching. */
const FILLER_WORDS: ReadonlySet<string> = new Set([
  'um',
  'uh',
  'erm',
  'ah',
  'eh',
  'hmm',
  'like',
  'please',
  'thanks',
  'thank',
  'ok',
  'okay',
  'right',
  'so',
  'well',
  'just',
  'basically',
  'actually', // meaning is captured separately as a correction cue
]);

const NUMBER_WORDS: ReadonlyMap<string, number> = new Map([
  ['zero', 0],
  ['none', 0],
  ['one', 1],
  ['two', 2],
  ['to', 2], // common STT slip for "two" — only used in quantity position
  ['too', 2],
  ['three', 3],
  ['four', 4],
  ['for', 4], // ditto
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['ate', 8],
  ['nine', 9],
  ['ten', 10],
  ['eleven', 11],
  ['twelve', 12],
  ['thirteen', 13],
  ['fourteen', 14],
  ['fifteen', 15],
  ['sixteen', 16],
  ['seventeen', 17],
  ['eighteen', 18],
  ['nineteen', 19],
  ['twenty', 20],
  ['couple', 2],
  ['pair', 2],
  ['dozen', 12],
]);

/** Words that are only numbers when they sit directly before a noun phrase. */
const AMBIGUOUS_NUMBER_WORDS: ReadonlySet<string> = new Set(['to', 'too', 'for', 'ate']);

/**
 * Lowercases, strips diacritics and punctuation, and expands contractions.
 * Apostrophes are resolved before punctuation is stripped so "don't" does not
 * collapse into the single token "dont".
 */
export function normalizeText(raw: string): string {
  let text = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  text = text.toLowerCase();
  for (const [pattern, replacement] of CONTRACTIONS) {
    text = text.replace(pattern, replacement);
  }
  text = text
    .replace(/[&]/g, ' and ')
    .replace(/[+]/g, ' plus ')
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9\s,.]/g, ' ')
    .replace(/[,.]+/g, ' , ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

export function tokenize(normalized: string): string[] {
  return normalized.split(' ').filter((token) => token.length > 0 && token !== ',');
}

/** Tokenises and drops filler words. Used for phrase matching, not for intent cues. */
export function contentTokens(normalized: string): string[] {
  return tokenize(normalized).filter((token) => !FILLER_WORDS.has(token));
}

export function isFiller(token: string): boolean {
  return FILLER_WORDS.has(token);
}

/**
 * Reads a token as a count. `allowAmbiguous` gates homophones like "to"/"for",
 * which should only be treated as numbers when a quantity is plausible.
 */
export function parseNumberToken(token: string, allowAmbiguous = false): number | null {
  if (/^\d{1,3}$/.test(token)) {
    const value = Number.parseInt(token, 10);
    return Number.isNaN(value) ? null : value;
  }
  if (!allowAmbiguous && AMBIGUOUS_NUMBER_WORDS.has(token)) return null;
  return NUMBER_WORDS.get(token) ?? null;
}

export function isNumberWord(token: string): boolean {
  return parseNumberToken(token, true) !== null;
}

/** Turns 1..20 back into words so the agent speaks "two", not "2". */
const SPOKEN_NUMBERS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
] as const;

export function spokenNumber(value: number): string {
  return SPOKEN_NUMBERS[value] ?? String(value);
}

/**
 * Splits an utterance into independently-interpretable segments.
 *
 * Callers chain requests with "and", "plus", commas and "also". Splitting on
 * those lets each clause be parsed on its own, while "with" and "but" are
 * deliberately *not* split on because they introduce modifiers that belong to
 * the clause before them ("a zinger with no onions").
 */
export function segmentUtterance(normalized: string): string[] {
  const segments = normalized
    .split(/\s*,\s*|\s+and then\s+|\s+and also\s+|\s+plus\s+|\s+also\s+|\s+then\s+|\s+and\s+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments : [normalized];
}
