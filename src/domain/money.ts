/**
 * Money.
 *
 * All monetary values in this system are **integer minor units** (fils for AED,
 * 100 per dirham). Floating-point arithmetic is never used for money: `0.1 +
 * 0.2 !== 0.3` is not an acceptable property for a till.
 *
 * The `Minor` brand makes it a type error to pass a raw "dirhams" number where
 * minor units are expected.
 */

declare const MINOR_BRAND: unique symbol;

/** An integer amount in the currency's minor unit (e.g. fils). */
export type Minor = number & { readonly [MINOR_BRAND]: true };

/** Largest amount we will ever represent — guards against overflow nonsense. */
const MAX_MINOR = 1_000_000_00;

export function minor(value: number): Minor {
  if (!Number.isInteger(value)) {
    throw new TypeError(`Monetary value must be an integer in minor units, received: ${value}`);
  }
  if (Math.abs(value) > MAX_MINOR) {
    throw new RangeError(`Monetary value out of range: ${value}`);
  }
  return value as Minor;
}

export const ZERO: Minor = 0 as Minor;

export function addMinor(...values: readonly Minor[]): Minor {
  return minor(values.reduce<number>((sum, value) => sum + value, 0));
}

export function multiplyMinor(value: Minor, factor: number): Minor {
  if (!Number.isInteger(factor)) {
    throw new TypeError(`Multiplier must be a whole number, received: ${factor}`);
  }
  return minor(value * factor);
}

/**
 * Applies a percentage (e.g. VAT) using half-up rounding on the minor unit,
 * which is what tax authorities and POS systems expect.
 */
export function percentageOfMinor(value: Minor, percent: number): Minor {
  if (!Number.isFinite(percent) || percent < 0) {
    throw new RangeError(`Percentage must be a non-negative finite number, received: ${percent}`);
  }
  if (percent === 0) return ZERO;
  const exact = (value * percent) / 100;
  return minor(Math.sign(exact) * Math.round(Math.abs(exact)));
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

export interface CurrencyConfig {
  readonly code: string;
  readonly spokenName: string;
  readonly minorUnitsPerUnit: number;
}

/** Written form for the UI, e.g. `AED 42.00`. */
export function formatMoney(value: Minor, currency: CurrencyConfig): string {
  const units = value / currency.minorUnitsPerUnit;
  const decimals = Math.max(0, Math.round(Math.log10(currency.minorUnitsPerUnit)));
  return `${currency.code} ${units.toFixed(decimals)}`;
}

/**
 * Spoken form for text-to-speech, e.g. `42 dirhams` or `42 dirhams 50 fils`.
 * Speech engines read "AED 42.00" as "A-E-D forty two point zero zero", which
 * sounds robotic on a call — so amounts are spelled out in words-friendly form.
 */
export function speakMoney(value: Minor, currency: CurrencyConfig): string {
  const per = currency.minorUnitsPerUnit;
  const whole = Math.trunc(value / per);
  const fraction = Math.abs(value % per);
  if (fraction === 0) return `${whole} ${currency.spokenName}`;
  return `${whole} ${currency.spokenName} ${fraction}`;
}

/** Signed written delta, e.g. `+AED 4.00`. Used on modifier chips. */
export function formatDelta(value: Minor, currency: CurrencyConfig): string {
  if (value === 0) return 'free';
  const sign = value > 0 ? '+' : '-';
  return `${sign}${formatMoney(Math.abs(value) as Minor, currency)}`;
}
