import { MoneyError, money, type Currency, type Money } from "./money";

/**
 * Typed commercial and financial facts read from a source. An order, a payment, a fee, a refund and a payout are
 * DIFFERENT facts about one flow and are never added together as sales (Project file 16, section 1).
 * `amount` is null when the source value is missing or invalid: missing is never zero.
 */
export type FactKind = "order" | "payment" | "refund" | "fee" | "payout";

export interface Fact {
  readonly kind: FactKind;
  readonly externalId: string;
  readonly amount: Money | null;
  readonly occurredOn: string | null; // YYYY-MM-DD as given by the source
  readonly relatedIds: readonly string[];
  readonly sourceRow: number; // 1-based data row
}

export interface Issue {
  readonly row: number;
  readonly code: "missing_amount" | "invalid_amount" | "missing_id" | "unknown_kind" | "missing_currency" | "invalid_currency" | "invalid_date";
  /** Never contains cell values: source rows may contain personal or financial detail. */
  readonly message: string;
}

/** Parses "$1,234.50", "1234.5", "-12.00" and "(12.00)" exactly into cents. Returns null for anything else. */
export function parseAmountCell(raw: string | undefined, currency: Currency): Money | null {
  if (raw === undefined) return null;
  let t = raw.trim();
  if (t === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(t)) { negative = true; t = t.slice(1, -1).trim(); }
  if (t.startsWith("-")) { negative = !negative; t = t.slice(1).trim(); }
  t = t.replace(/^\$/, "").replace(/,/g, "");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  try { return money(negative ? -cents : cents, currency); } catch (e) { if (e instanceof MoneyError) return null; throw e; }
}
