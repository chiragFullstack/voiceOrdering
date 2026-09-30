/**
 * The data model.
 *
 * Two halves, kept strictly apart:
 *
 *  1. The **catalogue** (`data/menu.json`) — immutable reference data. Items,
 *     the option groups each item allows, and the price delta of every choice.
 *  2. The **order** — mutable transaction state. Lines reference catalogue ids
 *     and carry *selections*; they never copy prices.
 *
 * Because a line stores only `itemId` + `selections[]`, the price of an order
 * is always **derived** from the catalogue at read time (see `pricing.ts`).
 * There is no stored subtotal anywhere in this system, so a total can never
 * drift out of sync with the menu.
 */

import type { Minor } from './money';

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                   */
/* -------------------------------------------------------------------------- */

export interface Category {
  readonly id: string;
  readonly name: string;
  readonly note: string;
  readonly sortOrder: number;
}

/**
 * `variant`  — mutually exclusive and required (Size, Flavour). Exactly one
 *              choice is always selected; `defaultChoiceId` supplies it when
 *              the caller does not say, so an order is never left incomplete.
 * `modifier` — optional add-ons and removals (Extra Cheese, No Onions). Zero
 *              or more, capped by `maxSelect`.
 */
export type OptionGroupKind = 'variant' | 'modifier';

export interface OptionChoice {
  readonly id: string;
  readonly name: string;
  /** Added to the item's base price when selected. May be zero or negative. */
  readonly priceDelta: Minor;
  /** Spoken forms a caller might use. Drives the NLU lexicon. */
  readonly aliases: readonly string[];
}

export interface OptionGroup {
  readonly id: string;
  readonly name: string;
  readonly kind: OptionGroupKind;
  readonly minSelect: number;
  readonly maxSelect: number;
  readonly defaultChoiceId?: string;
  /**
   * When true, the agent asks which choice the caller wants if they did not
   * say — "what size would you like?". The default is still applied straight
   * away so the line stays priceable and the caller can simply ignore the
   * question; answering replaces it.
   */
  readonly askWhenUnspecified: boolean;
  readonly choices: readonly OptionChoice[];
}

/** A fixed selection baked into a combo, e.g. the drink inside it is Medium. */
export interface SelectionRef {
  readonly groupId: string;
  readonly choiceId: string;
}

/** What a combo contains. Descriptive: the combo's own price is authoritative. */
export interface ComboComponent {
  readonly itemId: string;
  readonly quantity: number;
  readonly fixedSelections: readonly SelectionRef[];
}

/** A spoken phrase that means "this item, with these options already chosen". */
export interface ItemShortcut {
  readonly phrases: readonly string[];
  readonly selections: readonly SelectionRef[];
}

export interface MenuItem {
  readonly id: string;
  readonly categoryId: string;
  readonly name: string;
  readonly description: string;
  readonly basePrice: Minor;
  readonly available: boolean;
  /** Option groups this item allows. Groups are shared, never duplicated. */
  readonly optionGroupIds: readonly string[];
  /**
   * When set, the read-back names the item by the chosen option in this group
   * instead of by `name` — so "Soft Drink (Medium, Coke)" is spoken as
   * "a Medium Coke", which is what a caller expects to hear.
   */
  readonly speechNameGroupId?: string;
  readonly aliases: readonly string[];
  readonly shortcuts?: readonly ItemShortcut[];
  readonly components?: readonly ComboComponent[];
}

export interface OffMenuRule {
  readonly match: readonly string[];
  readonly reply: string;
  readonly suggestItemIds: readonly string[];
}

export interface RestaurantInfo {
  readonly name: string;
  readonly tagline: string;
  readonly greeting: string;
}

export interface PricingConfig {
  readonly vatRatePercent: number;
  readonly roundingMode: 'half-up';
}

export interface CurrencyInfo {
  readonly code: string;
  readonly spokenName: string;
  readonly minorUnitsPerUnit: number;
}

export interface Menu {
  readonly schemaVersion: number;
  readonly restaurant: RestaurantInfo;
  readonly currency: CurrencyInfo;
  readonly pricing: PricingConfig;
  readonly categories: readonly Category[];
  readonly optionGroups: readonly OptionGroup[];
  readonly items: readonly MenuItem[];
  readonly offMenu: readonly OffMenuRule[];
}

/**
 * The catalogue plus O(1) lookup indexes, built once at boot and frozen.
 * Every read path in the app goes through this, never through raw JSON.
 */
export interface MenuIndex {
  readonly menu: Menu;
  readonly itemsById: ReadonlyMap<string, MenuItem>;
  readonly groupsById: ReadonlyMap<string, OptionGroup>;
  readonly choicesById: ReadonlyMap<string, { group: OptionGroup; choice: OptionChoice }>;
  readonly categoriesById: ReadonlyMap<string, Category>;
  readonly itemsByCategory: ReadonlyMap<string, readonly MenuItem[]>;
}

/* -------------------------------------------------------------------------- */
/* Order                                                                       */
/* -------------------------------------------------------------------------- */

export type OrderStatus = 'draft' | 'confirming' | 'confirmed' | 'cancelled';

/**
 * One line of the order.
 *
 * A single line carries **several** modifiers at once: `selections` is a list
 * of `{ groupId, choiceId }` pairs, so "two Zingers, extra cheese, fried egg,
 * no onions" is one line with quantity 2 and three selections. Nothing about
 * price lives here.
 */
export interface OrderLine {
  readonly id: string;
  readonly itemId: string;
  readonly quantity: number;
  readonly selections: readonly SelectionRef[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Order {
  readonly id: string;
  readonly lines: readonly OrderLine[];
  readonly status: OrderStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly confirmedAt?: string;
}

/* -------------------------------------------------------------------------- */
/* Derived pricing (computed on every read — never persisted)                  */
/* -------------------------------------------------------------------------- */

export interface PricedSelection {
  readonly groupId: string;
  readonly groupName: string;
  readonly groupKind: OptionGroupKind;
  readonly choiceId: string;
  readonly choiceName: string;
  readonly priceDelta: Minor;
  /** True when the choice was supplied by the group default, not the caller. */
  readonly isDefault: boolean;
}

export interface PricedLine {
  readonly lineId: string;
  readonly itemId: string;
  readonly itemName: string;
  readonly categoryId: string;
  readonly quantity: number;
  readonly unitBasePrice: Minor;
  readonly unitModifierTotal: Minor;
  /** `unitBasePrice + unitModifierTotal` */
  readonly unitPrice: Minor;
  /** `unitPrice * quantity` */
  readonly lineTotal: Minor;
  readonly selections: readonly PricedSelection[];
  /** Human-readable summary, e.g. "2x Spicy Zinger Burger (Extra Cheese, No Onions)". */
  readonly label: string;
}

export interface OrderTotals {
  readonly subtotal: Minor;
  readonly vatRatePercent: number;
  readonly vat: Minor;
  readonly total: Minor;
  readonly itemCount: number;
  readonly lineCount: number;
}

/** The full derived view of an order. This is what the API returns. */
export interface PricedOrder {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly currency: CurrencyInfo;
  readonly lines: readonly PricedLine[];
  readonly totals: OrderTotals;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly confirmedAt?: string;
}
