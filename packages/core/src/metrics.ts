import type { Fact, FactKind } from "./facts";
import { add, money, ratioBps, sub, type Currency, type Money } from "./money";

/**
 * Metric engine (M3). Every formula here is CANDIDATE_UNAPPROVED until the founder signs it off (Project files 20 and 21).
 * A result always states its availability and what is missing. Missing inputs never become zero; no result is labelled
 * "profit"; component facts of one flow are never added together as sales.
 */
export type Availability = "complete" | "partial" | "estimate" | "unavailable";

export interface MetricResult<V> {
  readonly metricId: string;
  readonly formulaVersion: "0.1.0-draft";
  readonly approval: "CANDIDATE_UNAPPROVED";
  readonly label: string;
  readonly basis: string;
  readonly value: V | null;
  readonly availability: Availability;
  /** What is present and what is missing: shown beside the number everywhere it appears. */
  readonly coverage: { readonly present: readonly string[]; readonly missing: readonly string[] };
  readonly reason: string | null;
  /** Identifiers of the facts used, so a number can be traced to its evidence. */
  readonly inputs: readonly string[];
}

export interface Period { readonly from: string; readonly to: string } // inclusive, YYYY-MM-DD

const meta = (metricId: string, label: string, basis: string) => ({ metricId, formulaVersion: "0.1.0-draft" as const, approval: "CANDIDATE_UNAPPROVED" as const, label, basis });
const unavailable = <V>(m: ReturnType<typeof meta>, reason: string, missing: string[], inputs: string[] = []): MetricResult<V> =>
  ({ ...m, value: null, availability: "unavailable", coverage: { present: [], missing }, reason, inputs });

/** Facts of a kind inside the period. Undated facts are excluded and reported, never guessed into a period. */
function select(facts: readonly Fact[], kind: FactKind, period: Period | undefined, currency: Currency) {
  const ofKind = facts.filter((f) => f.kind === kind);
  const undated = period ? ofKind.filter((f) => f.occurredOn === null) : [];
  const inRange = period ? ofKind.filter((f) => f.occurredOn !== null && f.occurredOn >= period.from && f.occurredOn <= period.to) : ofKind;
  const unknown = inRange.filter((f) => f.amount === null);
  const otherCurrency = inRange.filter((f) => f.amount !== null && f.amount.currency !== currency);
  const usable = inRange.filter((f) => f.amount !== null && f.amount.currency === currency);
  return { all: inRange, undated, unknown, otherCurrency, usable };
}
const total = (fs: readonly Fact[], currency: Currency): Money => fs.reduce((a, f) => add(a, f.amount as Money), money(0, currency));
const ids = (fs: readonly Fact[]) => fs.map((f) => f.externalId);
function gaps(label: string, s: ReturnType<typeof select>): string[] {
  const g: string[] = [];
  if (s.unknown.length) g.push(`${s.unknown.length} ${label} with unknown amount`);
  if (s.otherCurrency.length) g.push(`${s.otherCurrency.length} ${label} in another currency (not converted)`);
  if (s.undated.length) g.push(`${s.undated.length} undated ${label} excluded from the period`);
  return g;
}
/** Integer division rounded half away from zero. */
function divRound(n: number, d: number): number { const x = n / d; return x < 0 ? -Math.round(-x) : Math.round(x); }

export function orderCount(facts: readonly Fact[], currency: Currency, period?: Period): MetricResult<number> {
  const m = meta("ECOM.ORDER_COUNT", "Orders (all statuses; cancelled/test policy not modelled yet)", "count of order facts in period");
  const s = select(facts, "order", period, currency);
  if (s.all.length === 0) return unavailable(m, "no order facts in the period", ["orders"]);
  const g = s.undated.length ? [`${s.undated.length} undated orders excluded from the period`] : [];
  return { ...m, value: s.all.length, availability: g.length ? "partial" : "complete", coverage: { present: ["orders"], missing: g }, reason: null, inputs: ids(s.all) };
}

export function netSales(facts: readonly Fact[], currency: Currency, opts: { period?: Period; orderAmountsNetOfDiscounts: boolean }): MetricResult<Money> {
  const m = meta("FIN.NET_SALES", "Net sales (order-based view)", "order amounts less refunds recorded in the period; not cash, not profit");
  const o = select(facts, "order", opts.period, currency), r = select(facts, "refund", opts.period, currency);
  const missing = [...gaps("orders", o), ...gaps("refunds", r)];
  if (o.all.length === 0) return unavailable(m, "no order facts in the period", ["orders"]);
  if (o.unknown.length || o.otherCurrency.length) return unavailable(m, "an order amount is unknown or in another currency", missing, ids(o.all));
  if (r.unknown.length || r.otherCurrency.length) return unavailable(m, "a refund amount is unknown or in another currency", missing, [...ids(o.all), ...ids(r.all)]);
  if (!opts.orderAmountsNetOfDiscounts) missing.push("discounts: order amounts may be gross of discounts");
  const value = sub(total(o.usable, currency), total(r.usable, currency));
  const complete = missing.length === 0;
  return { ...m, value, availability: complete ? "complete" : "partial", coverage: { present: ["orders", ...(r.all.length ? ["refunds"] : ["refunds: none recorded"])], missing }, reason: null, inputs: [...ids(o.usable), ...ids(r.usable)] };
}

export function averageOrderValue(facts: readonly Fact[], currency: Currency, period?: Period): MetricResult<Money> {
  const m = meta("ECOM.AOV", "Average order value", "order amounts / order count, rounded to the cent");
  const o = select(facts, "order", period, currency);
  if (o.all.length === 0) return unavailable(m, "no order facts in the period", ["orders"]);
  if (o.unknown.length || o.otherCurrency.length) return unavailable(m, "an order amount is unknown or in another currency", gaps("orders", o), ids(o.all));
  const value = money(divRound(total(o.usable, currency).cents, o.usable.length), currency);
  const g = gaps("orders", o);
  return { ...m, value, availability: g.length ? "partial" : "complete", coverage: { present: ["orders"], missing: g }, reason: null, inputs: ids(o.usable) };
}

export function refundRate(facts: readonly Fact[], currency: Currency, period?: Period): MetricResult<number> {
  const m = meta("ECOM.REFUND_RATE", "Refund rate (basis points)", "refunds recorded in period / orders in period; not a cohort rate");
  const o = select(facts, "order", period, currency), r = select(facts, "refund", period, currency);
  const missing = [...gaps("orders", o), ...gaps("refunds", r)];
  if (o.all.length === 0) return unavailable(m, "no order facts in the period", ["orders"]);
  if (o.unknown.length || o.otherCurrency.length || r.unknown.length || r.otherCurrency.length) return unavailable(m, "an amount is unknown or in another currency", missing, [...ids(o.all), ...ids(r.all)]);
  const orders = total(o.usable, currency);
  const value = ratioBps(total(r.usable, currency), orders);
  if (value === null) return unavailable(m, "order total is zero", missing);
  return { ...m, value, availability: missing.length ? "partial" : "complete", coverage: { present: ["orders", ...(r.all.length ? ["refunds"] : ["refunds: none recorded"])], missing }, reason: null, inputs: [...ids(o.usable), ...ids(r.usable)] };
}

export function feeRate(facts: readonly Fact[], currency: Currency, period?: Period): MetricResult<number> {
  const m = meta("ECOM.FEE_RATE", "Payment processing fee rate (basis points)", "processor fees / captured payments, only for payments that have a fee row");
  const p = select(facts, "payment", period, currency), f = select(facts, "fee", period, currency);
  const missing = [...gaps("payments", p), ...gaps("fees", f)];
  if (p.all.length === 0) return unavailable(m, "no payment facts in the period", ["payments"]);
  if (p.unknown.length || p.otherCurrency.length || f.unknown.length || f.otherCurrency.length) return unavailable(m, "an amount is unknown or in another currency", missing, [...ids(p.all), ...ids(f.all)]);
  const feed = new Set(f.usable.flatMap((x) => x.relatedIds));
  const withFee = p.usable.filter((x) => feed.has(x.externalId));
  const without = p.usable.length - withFee.length;
  if (withFee.length === 0) return unavailable(m, "no payment has a fee row; fee unknown, not zero", [...missing, "fees"]);
  if (without) missing.push(`${without} payments have no fee row and are excluded from the rate`);
  const value = ratioBps(total(f.usable.filter((x) => x.relatedIds.some((r) => withFee.some((w) => w.externalId === r))), currency), total(withFee, currency));
  if (value === null) return unavailable(m, "payment total is zero", missing);
  return { ...m, value, availability: missing.length ? "partial" : "complete", coverage: { present: ["payments", "fees"], missing }, reason: null, inputs: [...ids(withFee), ...ids(f.usable)] };
}

export function payoutsReceived(facts: readonly Fact[], currency: Currency, period?: Period): MetricResult<Money> {
  const m = meta("CASH.PAYOUTS_RECEIVED", "Payouts received (cash view, not revenue)", "sum of payout facts in period; never estimated from orders");
  const s = select(facts, "payout", period, currency);
  if (s.all.length === 0) return unavailable(m, "no payout source: cash received is unavailable, not estimated from orders", ["payouts"]);
  const g = gaps("payouts", s);
  if (s.unknown.length || s.otherCurrency.length) return unavailable(m, "a payout amount is unknown or in another currency", g, ids(s.all));
  return { ...m, value: total(s.usable, currency), availability: g.length ? "partial" : "complete", coverage: { present: ["payouts"], missing: g }, reason: null, inputs: ids(s.usable) };
}

/* ---------------------------------------------------------------- CONTRIB.ORDER */

export interface Component { readonly amount: Money; readonly basis: "actual" | "estimate" }
/** A cost or revenue component that may be applicable-and-known, applicable-and-unknown (null), or not applicable. */
export type Slot = Component | null | "n/a";

export interface OrderComponents {
  readonly currency: Currency;
  readonly orderRef: string;
  // revenue (always applicable)
  readonly netProductRevenue: Slot;
  readonly netShippingRevenue: Slot;
  // costs: each is "n/a" when the business model does not have it, null when it applies but is not yet known
  readonly productCost: Slot; // COGS, or supplier production + print charges
  readonly supplierShipping: Slot;
  readonly supplierTax: Slot;
  readonly paymentFees: Slot;
  readonly channelFees: Slot;
  readonly packaging: Slot;
  readonly reprintCosts: Slot;
  readonly otherVariable: Slot;
}
const REVENUE = ["netProductRevenue", "netShippingRevenue"] as const;
const COSTS = ["productCost", "supplierShipping", "supplierTax", "paymentFees", "channelFees", "packaging", "reprintCosts", "otherVariable"] as const;

export interface ContributionValue { readonly revenue: Money; readonly variableCosts: Money; readonly contribution: Money; readonly marginBps: number | null }

/**
 * Order contribution: revenue less every variable cost that applies to this business model. If an applicable component is
 * unknown, the result is UNAVAILABLE and lists what is missing. If any component is an estimate, the result is labelled
 * `estimate`. It is never called profit.
 */
export function orderContribution(c: OrderComponents): MetricResult<ContributionValue> {
  const m = meta("CONTRIB.ORDER", "Order contribution (not profit)", "net revenue less applicable variable costs for one order; excludes fixed costs, overhead, tax and owner pay");
  const present: string[] = [], missing: string[] = [];
  let estimate = false;
  let revenue = money(0, c.currency), costs = money(0, c.currency);
  const check = (name: string, slot: Slot, isCost: boolean) => {
    if (slot === "n/a") return;
    if (slot === null) { missing.push(name); return; }
    if (slot.amount.currency !== c.currency) { missing.push(`${name} (other currency, not converted)`); return; }
    present.push(name);
    if (slot.basis === "estimate") estimate = true;
    if (isCost) costs = add(costs, slot.amount); else revenue = add(revenue, slot.amount);
  };
  for (const k of REVENUE) check(k, c[k], false);
  for (const k of COSTS) check(k, c[k], true);
  if (c.netProductRevenue === "n/a" && c.netShippingRevenue === "n/a") return unavailable(m, "no revenue component applies", ["revenue"], [c.orderRef]);
  if (missing.length) return { ...m, value: null, availability: "unavailable", coverage: { present, missing }, reason: "an applicable component is unknown; nothing is assumed to be zero", inputs: [c.orderRef] };
  const contribution = sub(revenue, costs);
  return { ...m, value: { revenue, variableCosts: costs, contribution, marginBps: ratioBps(contribution, revenue) }, availability: estimate ? "estimate" : "complete", coverage: { present, missing }, reason: estimate ? "at least one component is an estimate, not an actual" : null, inputs: [c.orderRef] };
}
