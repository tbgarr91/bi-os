import { add, money, ratioBps, sub, type Currency, type Money } from "./money";
import type { Availability, MetricResult, Period } from "./metrics";

/**
 * CONTRIB.PERIOD (CANDIDATE_UNAPPROVED): revenue recorded for the period less the costs present in the source data for the
 * period, for businesses without order-level records. Absent costs are NOT zero: coverage is the share of the cost sources
 * the user declared as expected that actually appear in the period. Owner transfers, loan proceeds and internal transfers
 * are not revenue or cost and are excluded. Labelled contribution, never profit; not an accounting measure.
 */
export type PeriodRecordKind = "revenue" | "cost" | "owner_transfer" | "loan_proceeds" | "internal_transfer";

export interface PeriodRecord {
  readonly id: string;
  readonly kind: PeriodRecordKind;
  /** Which declared cost source this belongs to (for example "rent", "supplies"). Required for costs. */
  readonly source: string | null;
  readonly amount: Money | null;
  readonly occurredOn: string | null;
}

export interface PeriodContributionValue {
  readonly revenue: Money;
  readonly costs: Money;
  readonly contribution: Money;
  readonly marginBps: number | null;
  readonly sourcesPresent: number;
  readonly sourcesExpected: number;
  /** Share of expected cost sources present, in basis points. Null when none were declared. */
  readonly coverageBps: number | null;
}

export const DEFAULT_COVERAGE_THRESHOLD_BPS = 9500;
const EXCLUDED: readonly PeriodRecordKind[] = ["owner_transfer", "loan_proceeds", "internal_transfer"];

export function periodContribution(input: {
  currency: Currency;
  period: Period;
  records: readonly PeriodRecord[];
  expectedCostSources: readonly string[];
  thresholdBps?: number;
}): MetricResult<PeriodContributionValue> {
  const { currency, period } = input;
  const threshold = input.thresholdBps ?? DEFAULT_COVERAGE_THRESHOLD_BPS;
  const m = { metricId: "CONTRIB.PERIOD", formulaVersion: "0.1.0-draft" as const, approval: "CANDIDATE_UNAPPROVED" as const, label: "Period contribution (not profit)", basis: "revenue recorded in the period less costs present in the source data; owner transfers, loan proceeds and internal transfers excluded; not an accounting measure" };
  const fail = (reason: string, missing: string[], inputs: string[] = []): MetricResult<PeriodContributionValue> => ({ ...m, value: null, availability: "unavailable", coverage: { present: [], missing }, reason, inputs });

  const dated = input.records.filter((r) => r.occurredOn !== null && r.occurredOn >= period.from && r.occurredOn <= period.to);
  const undated = input.records.filter((r) => r.occurredOn === null).length;
  const excluded = dated.filter((r) => EXCLUDED.includes(r.kind));
  const revenue = dated.filter((r) => r.kind === "revenue");
  const costs = dated.filter((r) => r.kind === "cost");
  const all = [...revenue, ...costs];
  const ids = all.map((r) => r.id);
  const gaps: string[] = [];
  if (undated) gaps.push(`${undated} undated records excluded from the period`);
  if (excluded.length) gaps.push(`${excluded.length} transfers/loan records excluded by rule (not revenue or cost)`);

  if (revenue.length === 0) return fail("no revenue records in the period", ["revenue", ...gaps]);
  const bad = all.filter((r) => r.amount === null || r.amount.currency !== currency);
  if (bad.length) return fail(`${bad.length} record(s) have an unknown amount or another currency; nothing is assumed to be zero`, [`${bad.length} records with unknown amount or other currency (not converted)`, ...gaps], ids);
  const noSource = costs.filter((c) => !c.source);
  if (noSource.length) return fail(`${noSource.length} cost record(s) have no source, so coverage cannot be judged`, ["cost source on every cost record", ...gaps], ids);

  const expected = [...new Set(input.expectedCostSources)];
  const seen = new Set(costs.map((c) => c.source as string));
  const presentSources = expected.filter((s) => seen.has(s));
  const missingSources = expected.filter((s) => !seen.has(s));
  const undeclared = [...seen].filter((s) => !expected.includes(s));
  const coverageBps = expected.length === 0 ? null : Math.round((presentSources.length * 10000) / expected.length);

  const sumOf = (rs: readonly PeriodRecord[]): Money => rs.reduce((a, r) => add(a, r.amount as Money), money(0, currency));
  const rev = sumOf(revenue), cost = sumOf(costs);
  const contribution = sub(rev, cost);

  const missing = [...gaps, ...missingSources.map((s) => `expected cost source not present: ${s}`)];
  if (expected.length === 0) missing.push("no expected cost sources declared: coverage cannot be judged");
  if (undeclared.length) missing.push(`cost sources present but not declared as expected: ${undeclared.join(", ")}`);

  // Complete only when coverage is judged and meets the threshold. With no declared sources it is never complete.
  const availability: Availability = coverageBps !== null && coverageBps >= threshold ? "complete" : "partial";
  return {
    ...m,
    value: { revenue: rev, costs: cost, contribution, marginBps: ratioBps(contribution, rev), sourcesPresent: presentSources.length, sourcesExpected: expected.length, coverageBps },
    availability,
    coverage: { present: [`revenue (${revenue.length} records)`, `cost sources ${presentSources.length} of ${expected.length}`, ...presentSources], missing },
    reason: availability === "partial" ? (expected.length === 0 ? "no expected cost sources declared" : "cost-source coverage is below the threshold; figure is partial") : null,
    inputs: ids,
  };
}

/** Roll-up of order contributions for one business: only orders with complete (actual) contribution are summed. */
export function orderBasisRollup(results: readonly MetricResult<{ contribution: Money }>[], currency: Currency, thresholdBps = DEFAULT_COVERAGE_THRESHOLD_BPS): MetricResult<{ contribution: Money; ordersCovered: number; ordersTotal: number; coverageBps: number }> {
  const m = { metricId: "CONTRIB.ORDER", formulaVersion: "0.1.0-draft" as const, approval: "CANDIDATE_UNAPPROVED" as const, label: "Order contribution, all included orders (not profit)", basis: "sum of orders whose components are all actual; orders with missing or estimated components are listed, never added as zero" };
  const total = results.length;
  const ok = results.filter((r) => r.availability === "complete" && r.value !== null && r.value.contribution.currency === currency);
  const notOk = total - ok.length;
  const missing = notOk ? [`${notOk} of ${total} orders not fully costed with actuals (missing or estimated components), excluded from the sum`] : [];
  if (total === 0) return { ...m, value: null, availability: "unavailable", coverage: { present: [], missing: ["orders"] }, reason: "no orders", inputs: [] };
  if (ok.length === 0) return { ...m, value: null, availability: "unavailable", coverage: { present: [], missing }, reason: "no order is fully costed", inputs: results.flatMap((r) => r.inputs) };
  const sum = ok.reduce((a, r) => add(a, (r.value as { contribution: Money }).contribution), money(0, currency));
  const coverageBps = Math.round((ok.length * 10000) / total);
  return { ...m, value: { contribution: sum, ordersCovered: ok.length, ordersTotal: total, coverageBps }, availability: coverageBps >= thresholdBps ? "complete" : "partial", coverage: { present: [`${ok.length} of ${total} orders fully costed`], missing }, reason: coverageBps >= thresholdBps ? null : "coverage below threshold; figure is partial", inputs: ok.flatMap((r) => r.inputs) };
}
