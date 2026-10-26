/**
 * Money is stored as integer minor units (cents) with an explicit currency.
 * Floating point is never used for amounts. Missing data is NEVER zero:
 * absence is represented by `null`/`undefined` at the call site, not by Cents(0).
 */
export type Currency = string; // ISO 4217, e.g. "USD"

export interface Money {
  readonly cents: number; // integer, may be negative (refunds, reversals)
  readonly currency: Currency;
}

export class MoneyError extends Error {}

const DECIMAL = /^-?\d+(\.\d{1,2})?$/;

export function money(cents: number, currency: Currency): Money {
  if (!Number.isSafeInteger(cents)) throw new MoneyError(`cents must be a safe integer, got ${cents}`);
  if (!/^[A-Z]{3}$/.test(currency)) throw new MoneyError(`invalid currency: ${currency}`);
  return { cents, currency };
}

/** Parse a decimal string like "50.99" exactly (no float math). Rejects more than 2 decimals. */
export function parseDecimal(text: string, currency: Currency): Money {
  const t = text.trim();
  if (!DECIMAL.test(t)) throw new MoneyError(`not a valid 2-decimal amount: "${text}"`);
  const negative = t.startsWith("-");
  const [whole = "0", frac = ""] = (negative ? t.slice(1) : t).split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return money(negative ? -cents : cents, currency);
}

export function format(m: Money): string {
  const sign = m.cents < 0 ? "-" : "";
  const abs = Math.abs(m.cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")} ${m.currency}`;
}

function same(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`currency mismatch: ${a.currency} vs ${b.currency} (no implicit conversion)`);
  }
}

export const add = (a: Money, b: Money): Money => (same(a, b), money(a.cents + b.cents, a.currency));
export const sub = (a: Money, b: Money): Money => (same(a, b), money(a.cents - b.cents, a.currency));

export function sum(items: readonly Money[], currency: Currency): Money {
  return items.reduce((acc, m) => add(acc, m), money(0, currency));
}

/** Percentage as an integer count of basis points, rounded half away from zero. Returns null if denominator is 0. */
export function ratioBps(numerator: Money, denominator: Money): number | null {
  same(numerator, denominator);
  if (denominator.cents === 0) return null;
  const x = (numerator.cents * 10000) / denominator.cents;
  return x < 0 ? -Math.round(-x) : Math.round(x);
}
