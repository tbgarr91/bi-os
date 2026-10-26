import { describe, expect, it } from "vitest";
import { averageOrderValue, feeRate, mapRows, netSales, orderContribution, orderCount, parseCsv, parseDecimal, payoutsReceived, refundRate, type Mapping, type OrderComponents, type Slot } from "./index";

const mapping: Mapping = { kind: { column: "type", values: { order: "order", payment: "payment", refund: "refund", fee: "fee", payout: "payout" } }, externalId: "id", amount: "amount", currency: { column: "currency" }, occurredOn: "date", related: { column: "refs", separator: ";" } };
const facts = (csv: string) => mapRows(parseCsv(csv).rows, mapping).facts;
const H = "type,id,amount,currency,date,refs\n";
const act = (s: string): Slot => ({ amount: parseDecimal(s, "USD"), basis: "actual" });

describe("fact-based metrics", () => {
  const f = facts(H + "order,O1,100.00,USD,2026-01-02,\norder,O2,50.00,USD,2026-01-03,\nrefund,R1,25.00,USD,2026-01-09,O1\npayment,P1,100.00,USD,2026-01-02,O1\npayment,P2,50.00,USD,2026-01-03,O2\nfee,F1,3.00,USD,2026-01-02,P1\nfee,F2,1.75,USD,2026-01-03,P2\npayout,PO1,145.25,USD,2026-01-06,P1;P2\n");
  it("order count, net sales, AOV", () => {
    expect(orderCount(f, "USD").value).toBe(2);
    const n = netSales(f, "USD", { orderAmountsNetOfDiscounts: true });
    expect(n.value?.cents).toBe(12500); // 150.00 - 25.00
    expect(n.availability).toBe("complete");
    expect(averageOrderValue(f, "USD").value?.cents).toBe(7500);
  });
  it("net sales is only partial while discounts are not known to be applied", () => {
    const n = netSales(f, "USD", { orderAmountsNetOfDiscounts: false });
    expect(n.availability).toBe("partial");
    expect(n.coverage.missing.join()).toMatch(/discounts/);
  });
  it("refund rate and fee rate in basis points", () => {
    expect(refundRate(f, "USD").value).toBe(1667); // 25/150
    expect(feeRate(f, "USD").value).toBe(317);     // 4.75/150
  });
  it("payouts received is the cash view and never estimated", () => {
    expect(payoutsReceived(f, "USD").value?.cents).toBe(14525);
    const noPayouts = payoutsReceived(facts(H + "order,O1,100.00,USD,2026-01-02,\n"), "USD");
    expect(noPayouts.value).toBeNull();
    expect(noPayouts.availability).toBe("unavailable");
  });
  it("period filter uses source dates and reports undated rows", () => {
    const g = facts(H + "order,O1,100.00,USD,2026-01-02,\norder,O2,50.00,USD,2026-02-03,\norder,O3,10.00,USD,,\n");
    const r = orderCount(g, "USD", { from: "2026-01-01", to: "2026-01-31" });
    expect(r.value).toBe(1);
    expect(r.availability).toBe("partial");
    expect(r.coverage.missing.join()).toMatch(/undated/);
    expect(r.inputs).toEqual(["O1"]);
  });
  it("any unknown amount makes the metric unavailable, never a smaller number", () => {
    const g = facts(H + "order,O1,100.00,USD,2026-01-02,\norder,O2,,USD,2026-01-03,\n");
    for (const r of [netSales(g, "USD", { orderAmountsNetOfDiscounts: true }), averageOrderValue(g, "USD"), refundRate(g, "USD")]) {
      expect(r.value).toBeNull();
      expect(r.availability).toBe("unavailable");
    }
  });
  it("another currency is never converted or summed", () => {
    const g = facts(H + "order,O1,100.00,USD,2026-01-02,\norder,O2,50.00,EUR,2026-01-03,\n");
    expect(netSales(g, "USD", { orderAmountsNetOfDiscounts: true }).value).toBeNull();
  });
  it("fee rate excludes payments with no fee row and says so; with no fee rows at all it is unavailable", () => {
    const g = facts(H + "payment,P1,100.00,USD,2026-01-02,\npayment,P2,100.00,USD,2026-01-02,\nfee,F1,3.00,USD,2026-01-02,P1\n");
    const r = feeRate(g, "USD");
    expect(r.value).toBe(300);
    expect(r.availability).toBe("partial");
    expect(feeRate(facts(H + "payment,P1,100.00,USD,2026-01-02,\n"), "USD").availability).toBe("unavailable");
  });
  it("every result is a candidate and names its inputs", () => {
    for (const r of [orderCount(f, "USD"), averageOrderValue(f, "USD"), refundRate(f, "USD")]) {
      expect(r.approval).toBe("CANDIDATE_UNAPPROVED");
      expect(r.inputs.length).toBeGreaterThan(0);
    }
  });
});

describe("CONTRIB.ORDER", () => {
  const base: OrderComponents = {
    currency: "USD", orderRef: "ORD-1",
    netProductRevenue: act("46.00"), netShippingRevenue: act("4.99"),
    productCost: act("20.45"), supplierShipping: act("5.50"), supplierTax: "n/a", paymentFees: act("1.63"),
    channelFees: "n/a", packaging: "n/a", reprintCosts: "n/a", otherVariable: act("0.75"),
  };
  it("founder example: 50.99 revenue, 28.33 costs, 22.66 contribution, 44.44%", () => {
    const r = orderContribution(base);
    expect(r.availability).toBe("complete");
    expect(r.value).toMatchObject({ marginBps: 4444 });
    expect(r.value!.revenue.cents).toBe(5099);
    expect(r.value!.variableCosts.cents).toBe(2833);
    expect(r.value!.contribution.cents).toBe(2266);
    expect(r.label).toMatch(/not profit/);
  });
  it("an applicable cost that is unknown makes the result unavailable, not higher", () => {
    const r = orderContribution({ ...base, supplierShipping: null });
    expect(r.value).toBeNull();
    expect(r.availability).toBe("unavailable");
    expect(r.coverage.missing).toEqual(["supplierShipping"]);
  });
  it("a not-applicable component is skipped without being treated as zero or unknown", () => {
    expect(orderContribution({ ...base, otherVariable: "n/a" }).value!.contribution.cents).toBe(2266 + 75);
  });
  it("an estimate is labelled estimate", () => {
    const r = orderContribution({ ...base, productCost: { amount: parseDecimal("20.45", "USD"), basis: "estimate" } });
    expect(r.availability).toBe("estimate");
    expect(r.reason).toMatch(/estimate/);
    expect(r.value!.contribution.cents).toBe(2266);
  });
  it("a merchant-paid reprint lowers contribution without any revenue event", () => {
    const r = orderContribution({ ...base, reprintCosts: act("12.00") });
    expect(r.value!.revenue.cents).toBe(5099);
    expect(r.value!.contribution.cents).toBe(2266 - 1200);
  });
  it("a negative contribution is shown as negative, not hidden", () => {
    const r = orderContribution({ ...base, reprintCosts: act("40.00") });
    expect(r.value!.contribution.cents).toBe(2266 - 4000);
    expect(r.value!.marginBps).toBeLessThan(0);
  });
  it("another currency component is not converted", () => {
    const r = orderContribution({ ...base, paymentFees: { amount: parseDecimal("1.63", "EUR"), basis: "actual" } });
    expect(r.availability).toBe("unavailable");
  });
  it("no revenue component means unavailable", () => {
    expect(orderContribution({ ...base, netProductRevenue: "n/a", netShippingRevenue: "n/a" }).availability).toBe("unavailable");
  });
});
