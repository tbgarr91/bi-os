import { describe, expect, it } from "vitest";
import { format, parseDecimal, ratioBps, sub, sum } from "@bi-os/core";
import { fixtures } from "./index";

const usd = (s: string) => parseDecimal(s, "USD");
const PII_KEYS = /(^|_)(email|phone|address|zip|postal|first_?name|last_?name|customer_?name|ssn|card)(_|$)/i;

function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysDeep(x, out);
    }
  }
  return out;
}

describe("fixture hygiene (privacy rule: no real data in the repository)", () => {
  it("every fixture is explicitly synthetic and unapproved", () => {
    for (const f of fixtures) {
      expect(f.synthetic).toBe(true);
      expect(f.status).toBe("CANDIDATE_UNAPPROVED");
    }
  });
  it("no fixture carries personal-data field names", () => {
    for (const f of fixtures) {
      const bad = keysDeep(f).filter((k) => PII_KEYS.test(k));
      expect(bad, `${f.id} has personal-data keys`).toEqual([]);
    }
  });
});

describe("golden arithmetic (fixtures agree with their own components; this is not the metric engine)", () => {
  it("POD founder example: contribution $22.66, 44.44%, listed spread stays an estimate", () => {
    const f = fixtures[0];
    const c = f.components;
    const revenue = sub(sum([usd(c.product_price), usd(c.customer_shipping_charged)], "USD"), usd(c.discount));
    const costs = sum([usd(c.supplier_production), usd(c.supplier_shipping), usd(c.processor_fee), usd(c.extra_variable_costs)], "USD");
    const contribution = sub(revenue, costs);
    expect(format(revenue)).toBe(format(usd(f.expected.eligible_order_revenue)));
    expect(format(costs)).toBe(format(usd(f.expected.variable_costs)));
    expect(format(contribution)).toBe(format(usd(f.expected.order_contribution)));
    expect(ratioBps(contribution, revenue)).toBe(f.expected.contribution_margin_bps);
    const spread = sub(usd(c.product_price), usd(c.supplier_production));
    expect(format(spread)).toBe(format(usd(f.expected.supplier_listed_spread_estimate)));
    expect(spread.cents).not.toBe(contribution.cents); // estimate is never the actual contribution
  });
  it("Fixture A: one flow, not 297 or 197", () => {
    const f = fixtures[1];
    const c = f.components;
    expect(format(sub(usd(c.payment), usd(c.fee)))).toBe(format(usd(f.expected.payout)));
    for (const bad of f.expected.must_not_equal) expect(usd(c.order).cents).not.toBe(usd(bad).cents);
  });
  it("Fixture C: refund nets sales to 75", () => {
    const f = fixtures[2];
    expect(format(sub(usd(f.components.order), usd(f.components.refund)))).toBe(format(usd(f.expected.net_sales_when_refund_in_period)));
  });
  it("Fixture D: three payments less 6 in fees settle as one 194 payout", () => {
    const f = fixtures[3];
    const gross = sum(f.components.payments.map(usd), "USD");
    expect(format(sub(gross, usd(f.components.total_fees)))).toBe(format(usd(f.expected.payout)));
  });
});
