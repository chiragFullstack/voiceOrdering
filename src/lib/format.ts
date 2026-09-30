/**
 * Display formatting for the browser.
 *
 * The server sends money as integer minor units. These helpers render them and
 * never do arithmetic: every number on screen was derived by `pricing.ts`.
 */

import type { CurrencyInfo } from '@/domain/types';

function decimalsFor(currency: CurrencyInfo): number {
  return Math.max(0, Math.round(Math.log10(currency.minorUnitsPerUnit)));
}

/** `AED 42.00` */
export function money(minorValue: number, currency: CurrencyInfo): string {
  const units = minorValue / currency.minorUnitsPerUnit;
  return `${currency.code} ${units.toFixed(decimalsFor(currency))}`;
}

/** `42.00` — for columns where the currency code is already in the header. */
export function amount(minorValue: number, currency: CurrencyInfo): string {
  return (minorValue / currency.minorUnitsPerUnit).toFixed(decimalsFor(currency));
}

/** `+4.00`, `free` */
export function delta(minorValue: number, currency: CurrencyInfo): string {
  if (minorValue === 0) return 'free';
  const sign = minorValue > 0 ? '+' : '−';
  return `${sign}${amount(Math.abs(minorValue), currency)}`;
}
