import { MoneyError, add, money, sub, type Currency, type Money } from "./money";
import type { Fact } from "./facts";

export type PayoutStatus = "matched" | "discrepancy" | "needs_review" | "unresolved";

export interface PayoutMatch {
  readonly payoutId: string;
  readonly status: PayoutStatus;
  readonly expected: Money | null;
  readonly actual: Money | null;
  readonly difference: Money | null; // actual minus expected
  readonly reasons: readonly string[];
}

/**
 * Many-to-one settlement check: a payout settles the payments it names, less the fees on those payments.
 * Matching uses explicit references only, never amount or date alone. Anything we cannot fully explain is
 * `needs_review` or `unresolved`, never silently `matched`. Refunds touching the settled payments are not netted
 * here yet (rule not approved), so the payout is sent to review instead of guessed.
 */
export function reconcilePayouts(facts: readonly Fact[], currency: Currency): PayoutMatch[] {
  const byId = (kind: Fact["kind"]) => new Map(facts.filter((f) => f.kind === kind).map((f) => [f.externalId, f]));
  const payments = byId("payment");
  const fees = facts.filter((f) => f.kind === "fee");
  const refunds = facts.filter((f) => f.kind === "refund");
  return facts.filter((f) => f.kind === "payout").map((p): PayoutMatch => {
    const reasons: string[] = [];
    if (p.amount === null) return { payoutId: p.externalId, status: "unresolved", expected: null, actual: null, difference: null, reasons: ["payout amount unknown"] };
    if (p.amount.currency !== currency) return { payoutId: p.externalId, status: "needs_review", expected: null, actual: p.amount, difference: null, reasons: ["payout currency differs; no implicit conversion"] };
    if (p.relatedIds.length === 0) return { payoutId: p.externalId, status: "unresolved", expected: null, actual: p.amount, difference: null, reasons: ["payout names no payments; amount-only matching is not allowed"] };
    let expected = money(0, currency);
    let complete = true;
    const settled = new Set<string>();
    for (const id of p.relatedIds) {
      const pay = payments.get(id);
      if (!pay) { complete = false; reasons.push("a referenced payment is not in the data"); continue; }
      if (pay.amount === null) { complete = false; reasons.push("a referenced payment has an unknown amount"); continue; }
      if (pay.amount.currency !== currency) { complete = false; reasons.push("a referenced payment is in another currency"); continue; }
      settled.add(id);
      expected = add(expected, pay.amount);
    }
    for (const fee of fees.filter((f) => f.relatedIds.some((r) => settled.has(r)))) {
      if (fee.amount === null || fee.amount.currency !== currency) { complete = false; reasons.push("a fee on a settled payment is unknown or in another currency"); continue; }
      expected = sub(expected, fee.amount);
    }
    // A payment with no fee row at all may simply be missing fee data: say so rather than assume zero fee.
    for (const id of settled) {
      if (!fees.some((f) => f.relatedIds.includes(id))) { complete = false; reasons.push("a settled payment has no fee row; fee unknown, not zero"); }
    }
    if (refunds.some((r) => r.relatedIds.some((x) => settled.has(x)))) { complete = false; reasons.push("a refund relates to a settled payment; netting rule not approved"); }
    if (!complete) return { payoutId: p.externalId, status: "needs_review", expected, actual: p.amount, difference: sub(p.amount, expected), reasons };
    const difference = sub(p.amount, expected);
    return { payoutId: p.externalId, status: difference.cents === 0 ? "matched" : "discrepancy", expected, actual: p.amount, difference, reasons: difference.cents === 0 ? [] : ["payout differs from payments less fees"] };
  });
}

export interface FlowSummary {
  readonly currency: Currency;
  /** Each total is null when there are no facts of that kind OR any of them has an unknown amount (then see `incomplete`). */
  readonly orderSales: Money | null;
  readonly paymentsReceived: Money | null;
  readonly fees: Money | null;
  readonly refunds: Money | null;
  readonly payoutsSettled: Money | null;
  /** Order sales less refunds; null unless both are fully known. Labelled order-based, not profit. */
  readonly netOrderSales: Money | null;
  readonly incomplete: readonly string[];
  readonly basis: "order-based commerce view; components are different facts of one flow and are never added together";
}

/** Totals per kind, kept SEPARATE. There is deliberately no function that adds orders, payments and payouts. */
export function summarize(facts: readonly Fact[], currency: Currency): FlowSummary {
  const incomplete: string[] = [];
  const total = (kind: Fact["kind"]): Money | null => {
    const of = facts.filter((f) => f.kind === kind);
    if (of.length === 0) return null;
    let acc = money(0, currency);
    for (const f of of) {
      if (f.amount === null) { incomplete.push(`${kind}: at least one amount unknown`); return null; }
      if (f.amount.currency !== currency) { incomplete.push(`${kind}: other currency present (${f.amount.currency}); not converted`); return null; }
      acc = add(acc, f.amount);
    }
    return acc;
  };
  const orderSales = total("order");
  const refunds = total("refund");
  let netOrderSales: Money | null = null;
  if (orderSales !== null && refunds !== null) netOrderSales = sub(orderSales, refunds);
  else if (orderSales !== null && !facts.some((f) => f.kind === "refund")) netOrderSales = orderSales;
  return { currency, orderSales, paymentsReceived: total("payment"), fees: total("fee"), refunds, payoutsSettled: total("payout"), netOrderSales, incomplete, basis: "order-based commerce view; components are different facts of one flow and are never added together" };
}

export { MoneyError };
