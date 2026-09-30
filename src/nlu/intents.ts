/**
 * Intent vocabulary.
 *
 * The parser's only job is to turn a sentence into these structures. It knows
 * nothing about the current order, so it cannot decide *which* line "that"
 * refers to — it emits a `LineTarget` describing the reference and lets the
 * agent resolve it against live state. Keeping the two apart is what makes the
 * parser exhaustively testable on strings alone.
 */

import type { SelectionRef } from '@/domain/types';

/** How a caller referred to a line they want changed. */
export type LineTarget =
  /** "cancel the fries" — by item, optionally narrowed by its options. */
  | { readonly by: 'item'; readonly itemId: string; readonly selections: readonly SelectionRef[] }
  /** "make it two" — whatever was touched last. */
  | { readonly by: 'last' }
  /** An exact line, used when the agent already knows which one it asked about. */
  | { readonly by: 'line'; readonly lineId: string }
  /** "cancel the drink" — by category, when no specific item was named. */
  | { readonly by: 'category'; readonly categoryId: string };

export type Intent =
  | {
      readonly kind: 'add_item';
      readonly itemId: string;
      readonly quantity: number;
      readonly selections: readonly SelectionRef[];
      readonly sourceText: string;
    }
  | {
      readonly kind: 'set_quantity';
      readonly target: LineTarget;
      readonly quantity: number;
      readonly sourceText: string;
    }
  | { readonly kind: 'remove_item'; readonly target: LineTarget; readonly sourceText: string }
  | {
      readonly kind: 'modify_line';
      readonly target: LineTarget;
      readonly add: readonly SelectionRef[];
      readonly remove: readonly SelectionRef[];
      readonly sourceText: string;
    }
  /** Several menu items matched equally well — the agent must ask which. */
  | {
      readonly kind: 'clarify_item';
      readonly candidateItemIds: readonly string[];
      readonly quantity: number;
      readonly selections: readonly SelectionRef[];
      readonly sourceText: string;
    }
  /** A category was named but not an item ("a burger please"). */
  | {
      readonly kind: 'clarify_category';
      readonly categoryId: string;
      readonly quantity: number;
      readonly sourceText: string;
    }
  /** The curveball: something recognisably food, but not ours. */
  | {
      readonly kind: 'off_menu';
      readonly ruleIndex: number | null;
      readonly phrase: string;
      readonly sourceText: string;
    }
  /** A bare number or bare option, meaningful only as an answer to a question. */
  | { readonly kind: 'bare_quantity'; readonly quantity: number; readonly sourceText: string }
  | { readonly kind: 'read_total' }
  | { readonly kind: 'repeat_order' }
  | { readonly kind: 'list_menu'; readonly categoryId: string | null }
  | { readonly kind: 'confirm' }
  | { readonly kind: 'deny' }
  | { readonly kind: 'finish' }
  | { readonly kind: 'cancel_order' }
  | { readonly kind: 'greeting' }
  | { readonly kind: 'unknown'; readonly sourceText: string };

export type IntentKind = Intent['kind'];

export interface ParseResult {
  readonly original: string;
  readonly normalized: string;
  readonly intents: readonly Intent[];
}
