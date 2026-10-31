import { describe, expect, it } from "vitest";
import { mapSupplierCharges, minimizeSupplierRow, orderBasisRollup, orderContribution, parseCsv, parseDecimal, periodContribution, podOrderComponents, type PeriodRecord, type SupplierMapping } from "./index";

const mapping: SupplierMapping = { kind: { column: "type", values: { production: "production", print: "print_surcharge", shipping: "supplier_shipping", tax: "supplier_tax", reprint: "reprint" } }, externalId: "id", orderRef: "order", amount: "amount", currency: { column: "currency" }, occurredOn: "date" };
const H = "id,order,type,amount,currency,date,customer_email\n";
const usd = (s: string) => parseDecimal(s, "USD");
const act = (s: string) => ({ amount: usd(s), basis: "actual" as const });
const side = (orderRef: string) => ({ currency: "USD", orderRef, netProductRevenue: act("46.00"), netShippingRevenue: act("4.99"), paymentFees: act("1.63"), otherVariable: act("0.75") });
const charges = (csv: string) => mapSupplierCharges(parseCsv(csv).rows, mapping);

describe("supplier charges", () => {
  it("founder POD example: charges + customer side reproduce $22.66", () => {
    const { charges: c, issues } = charges(H + "S1,O1,production,20.45,USD,2026-03-01,a@x.test\nS2,O1,shipping,5.50,USD,2026-03-01,a@x.test\nS3,O1,tax,0.00,USD,2026-03-01,a@x.test\n");
    expect(issues).toEqual([]);
    const r = orderContribution(podOrderComponents(side("O1"), c));
    expect(r.availability).toBe("complete");
    expect(r.value?.contribution.cents).toBe(2266);
    expect(r.value?.marginBps).toBe(4444);
  });
  it("no supplier shipping row means unknown, not free: the order is unavailable and says what is missing", () => {
    const { charges: c } = charges(H + "S1,O1,production,20.45,USD,2026-03-01,\nS3,O1,tax,0.00,USD,2026-03-01,\n");
    const r = orderContribution(podOrderComponents(side("O1"), c));
    expect(r.availability).toBe("unavailable");
    expect(r.value).toBeNull();
    expect(r.coverage.missing).toContain("supplierShipping");
  });
  it("an unreadable amount stays unknown and the issue never echoes the cell", () => {
    const { charges: c, issues } = charges(H + "S1,O1,production,abc-secret,USD,2026-03-01,\nS2,O1,shipping,,USD,2026-03-01,\n");
    expect(c.map((x) => x.amount)).toEqual([null, null]);
    expect(issues.map((i) => i.code)).toEqual(["invalid_amount", "missing_amount"]);
    expect(JSON.stringify(issues)).not.toMatch(/abc-secret/);
    const r = orderContribution(podOrderComponents(side("O1"), c));
    expect(r.availability).toBe("unavailable");
  });
  it("a reprint is added to cost; no reprint row is not applicable", () => {
    const base = H + "S1,O1,production,20.45,USD,,\nS2,O1,shipping,5.50,USD,,\nS3,O1,tax,0.00,USD,,\n";
    const without = orderContribution(podOrderComponents(side("O1"), charges(base).charges));
    const withRe = orderContribution(podOrderComponents(side("O1"), charges(base + "S4,O1,reprint,20.45,USD,,\n").charges));
    expect(withRe.value!.contribution.cents).toBe(without.value!.contribution.cents - 2045);
  });
  it("charges for other orders and other currencies are not mixed in", () => {
    const { charges: c } = charges(H + "S1,O1,production,20.45,USD,,\nS9,O2,production,99.00,USD,,\nS2,O1,shipping,5.50,EUR,,\nS3,O1,tax,0.00,USD,,\n");
    const r = orderContribution(podOrderComponents(side("O1"), c));
    expect(r.availability).toBe("unavailable"); // EUR shipping is not converted
  });
  it("unknown charge kinds and missing order refs are skipped with issues", () => {
    const { charges: c, issues } = charges(H + "S1,O1,gift,1.00,USD,,\nS2,,production,1.00,USD,,\n");
    expect(c).toEqual([]);
    expect(issues.map((i) => i.code)).toEqual(["unknown_kind", "missing_id"]);
  });
  it("minimization drops columns that are not mapped", () => {
    const row = parseCsv(H + "S1,O1,production,20.45,USD,2026-03-01,a@x.test\n").rows[0]!;
    expect(Object.keys(minimizeSupplierRow(row, mapping)).sort()).toEqual(["amount", "currency", "date", "id", "order", "type"]);
  });
  it("roll-up sums only fully costed orders and reports the rest", () => {
    const full = H + "S1,O1,production,20.45,USD,,\nS2,O1,shipping,5.50,USD,,\nS3,O1,tax,0.00,USD,,\nS4,O2,production,20.45,USD,,\n";
    const c = charges(full).charges;
    const rs = [orderContribution(podOrderComponents(side("O1"), c)), orderContribution(podOrderComponents(side("O2"), c))];
    const roll = orderBasisRollup(rs as never, "USD");
    expect(roll.value?.contribution.cents).toBe(2266);
    expect(roll.value?.ordersCovered).toBe(1);
    expect(roll.availability).toBe("partial");
    expect(roll.coverage.missing[0]).toMatch(/1 of 2/);
    expect(orderBasisRollup([], "USD").availability).toBe("unavailable");
  });
});

describe("CONTRIB.PERIOD", () => {
  const p = { from: "2026-03-01", to: "2026-03-31" };
  const rec = (id: string, kind: PeriodRecord["kind"], source: string | null, amt: string | null, date: string | null = "2026-03-10"): PeriodRecord => ({ id, kind, source, amount: amt === null ? null : usd(amt), occurredOn: date });
  const base = [rec("R1", "revenue", null, "1000.00"), rec("C1", "cost", "rent", "300.00"), rec("C2", "cost", "supplies", "100.00")];
  it("complete when every declared cost source is present", () => {
    const r = periodContribution({ currency: "USD", period: p, records: base, expectedCostSources: ["rent", "supplies"] });
    expect(r.availability).toBe("complete");
    expect(r.value?.contribution.cents).toBe(60000);
    expect(r.value?.coverageBps).toBe(10000);
    expect(r.label).toContain("not profit");
  });
  it("a declared source that is absent makes it partial and is named, never costed at zero", () => {
    const r = periodContribution({ currency: "USD", period: p, records: base, expectedCostSources: ["rent", "supplies", "insurance"] });
    expect(r.availability).toBe("partial");
    expect(r.value?.sourcesPresent).toBe(2);
    expect(r.value?.sourcesExpected).toBe(3);
    expect(r.value?.coverageBps).toBe(6667);
    expect(r.coverage.missing.join()).toMatch(/insurance/);
  });
  it("the threshold is adjustable", () => {
    const strict = periodContribution({ currency: "USD", period: p, records: base, expectedCostSources: ["rent", "supplies", "insurance"], thresholdBps: 9500 });
    const loose = periodContribution({ currency: "USD", period: p, records: base, expectedCostSources: ["rent", "supplies", "insurance"], thresholdBps: 6000 });
    expect([strict.availability, loose.availability]).toEqual(["partial", "complete"]);
  });
  it("no declared expected sources can never be complete", () => {
    const r = periodContribution({ currency: "USD", period: p, records: base, expectedCostSources: [] });
    expect(r.availability).toBe("partial");
    expect(r.value?.coverageBps).toBeNull();
  });
  it("owner transfers, loan proceeds and internal transfers are excluded and reported", () => {
    const recs = [...base, rec("T1", "owner_transfer", null, "5000.00"), rec("T2", "loan_proceeds", null, "2000.00"), rec("T3", "internal_transfer", null, "50.00")];
    const r = periodContribution({ currency: "USD", period: p, records: recs, expectedCostSources: ["rent", "supplies"] });
    expect(r.value?.contribution.cents).toBe(60000);
    expect(r.coverage.missing.join()).toMatch(/3 transfers/);
  });
  it("records outside the period are ignored; undated are reported not guessed", () => {
    const recs = [...base, rec("R2", "revenue", null, "9999.00", "2026-04-02"), rec("C3", "cost", "rent", "1.00", null)];
    const r = periodContribution({ currency: "USD", period: p, records: recs, expectedCostSources: ["rent", "supplies"] });
    expect(r.value?.revenue.cents).toBe(100000);
    expect(r.coverage.missing.join()).toMatch(/1 undated/);
  });
  it("an unknown amount makes the period unavailable instead of zero", () => {
    const r = periodContribution({ currency: "USD", period: p, records: [...base, rec("C9", "cost", "supplies", null)], expectedCostSources: ["rent", "supplies"] });
    expect(r.availability).toBe("unavailable");
    expect(r.value).toBeNull();
  });
  it("no revenue is unavailable; cost without a source is unavailable; other currency is not converted", () => {
    expect(periodContribution({ currency: "USD", period: p, records: [rec("C1", "cost", "rent", "5.00")], expectedCostSources: ["rent"] }).availability).toBe("unavailable");
    expect(periodContribution({ currency: "USD", period: p, records: [...base, rec("C8", "cost", null, "5.00")], expectedCostSources: ["rent"] }).availability).toBe("unavailable");
    const eur: PeriodRecord = { id: "E1", kind: "revenue", source: null, amount: parseDecimal("10.00", "EUR"), occurredOn: "2026-03-05" };
    expect(periodContribution({ currency: "USD", period: p, records: [...base, eur], expectedCostSources: ["rent", "supplies"] }).availability).toBe("unavailable");
  });
  it("costs from an undeclared source are reported", () => {
    const r = periodContribution({ currency: "USD", period: p, records: [...base, rec("C5", "cost", "software", "20.00")], expectedCostSources: ["rent", "supplies"] });
    expect(r.coverage.missing.join()).toMatch(/not declared as expected: software/);
    expect(r.value?.contribution.cents).toBe(58000);
  });
});
