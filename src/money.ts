import type { Millicents } from './types.ts';

export const MC_PER_CENT = 1000;

/** Convert a cents amount from an API caller (may be fractional) to integer millicents. */
export function centsToMc(cents: number): Millicents {
  return Math.round(cents * MC_PER_CENT);
}

/** Cents as a plain number with at most 3 decimals, for JSON output. */
export function mcToCents(mc: Millicents): number {
  return mc / MC_PER_CENT;
}

/** USD string with 5 decimals, enough to show a 0.001 cent price exactly. */
export function mcToUsd(mc: Millicents): string {
  const sign = mc < 0 ? '-' : '';
  const abs = Math.abs(mc);
  const dollars = Math.floor(abs / 100_000);
  const rest = String(abs % 100_000).padStart(5, '0');
  return `${sign}$${dollars}.${rest}`;
}
