import { describe, expect, it } from "vitest";
import { mapRows, parseCsv, planImport, reconcilePayouts, rowHash, summarize, parseAmountCell, format, type Mapping } from "./index";

const mapping: Mapping = {
  kind: { column: "type", values: { order: "order", payment: "payment", refund: "refund", fee: "fee", payout: "payout" } },
  externalId: "id", amount: "amount", currency: { column: "currency" }, occurredOn: "date", related: { column: "refs", separator: ";" },
};
const load = (csv: string) => mapRows(parseCsv(csv).rows, mapping);

const FIXTURE_A = `type,id,amount,currency,date,refs
order,O1,100.00,USD,2026-01-02,
payment,P1,100.00,USD,2026-01-02,O1
fee,F1,3.00,USD,2026-01-02,P1
payout,PO1,97.00,USD,2026-01-05,P1
`;

describe("amount parsing (exact, no floats)", () => {
  it.each([["$1,234.50", 123450], ["12", 1200], ["12.5", 1250], ["-3.00", -300], ["(3.00)", -300], ["0.07", 7]])("%s -> %i cents", (raw, cents) => {
    expect(parseAmountCell(raw, "USD")?.cents).toBe(cents);
  });
  it.each(["", "   ", "abc", "1.234", "1e3", "12,50.00x", "NaN", "--3"])("rejects %j as unknown, not zero", (raw) => {
    expect(parseAmountCell(raw, "USD")).toBeNull();
  });
  it("is exact where floats are not (0.1 + 0.2 style)", () => {
    expect(parseAmountCell("0.30", "USD")?.cents).toBe(30);
    expect(parseAmountCell("1.15", "USD")?.cents).toBe(115);
  });
});

describe("Fixture A: order -> payment -> fee -> payout", () => {
  it("reconciles to a match and never sums the flow as sales", () => {
    const { facts, issues } = load(FIXTURE_A);
    expect(issues).toEqual([]);
    const s = summarize(facts, "USD");
    expect(format(s.orderSales!)).toBe("100.00 USD");
    expect(format(s.paymentsReceived!)).toBe("100.00 USD");
    expect(format(s.fees!)).toBe("3.00 USD");
    expect(format(s.payoutsSettled!)).toBe("97.00 USD");
    expect(s.netOrderSales?.cents).toBe(10000); // not 29700, not 19700
    const [m] = reconcilePayouts(facts, "USD");
    expect(m).toMatchObject({ status: "matched", payoutId: "PO1" });
    expect(m!.difference?.cents).toBe(0);
  });
});

describe("Fixture C: refund", () => {
  it("net order sales 75.00 while payment and refund stay separate facts", () => {
    const { facts } = load(`type,id,amount,currency,date,refs\norder,O1,100.00,USD,2026-01-02,\nrefund,R1,25.00,USD,2026-01-09,O1\n`);
    const s = summarize(facts, "USD");
    expect(s.netOrderSales?.cents).toBe(7500);
    expect(s.refunds?.cents).toBe(2500);
    expect(s.basis).toMatch(/order-based/);
  });
});

describe("Fixture D: three payments settle in one payout", () => {
  const csv = `type,id,amount,currency,date,refs
payment,P1,40.00,USD,,
payment,P2,60.00,USD,,
payment,P3,100.00,USD,,
fee,F1,1.20,USD,,P1
fee,F2,1.80,USD,,P2
fee,F3,3.00,USD,,P3
payout,PO1,194.00,USD,,P1;P2;P3
`;
  it("matches 200.00 less 6.00 fees = 194.00", () => {
    const { facts } = load(csv);
    const [m] = reconcilePayouts(facts, "USD");
    expect(m).toMatchObject({ status: "matched" });
    expect(m!.expected?.cents).toBe(19400);
  });
  it("a payout 1.00 short is a discrepancy, not a match", () => {
    const { facts } = load(csv.replace("194.00", "193.00"));
    const [m] = reconcilePayouts(facts, "USD");
    expect(m).toMatchObject({ status: "discrepancy" });
    expect(m!.difference?.cents).toBe(-100);
  });
  it("a missing referenced payment is needs_review, never matched", () => {
    const { facts } = load(csv.replace("P1;P2;P3", "P1;P2;P9"));
    expect(reconcilePayouts(facts, "USD")[0]!.status).toBe("needs_review");
  });
});

describe("missing is never zero (Fixture F)", () => {
  it("a blank or invalid amount becomes null plus an issue, and the total is unknown", () => {
    const { facts, issues } = load(`type,id,amount,currency,date,refs\norder,O1,100.00,USD,,\norder,O2,,USD,,\norder,O3,abc,USD,,\n`);
    expect(issues.map((i) => i.code)).toEqual(["missing_amount", "invalid_amount"]);
    expect(facts.map((f) => f.amount === null)).toEqual([false, true, true]);
    const s = summarize(facts, "USD");
    expect(s.orderSales).toBeNull();
    expect(s.netOrderSales).toBeNull();
    expect(s.incomplete.length).toBeGreaterThan(0);
  });
  it("no cost rows means no total, not a zero total", () => {
    const { facts } = load(`type,id,amount,currency,date,refs\norder,O1,100.00,USD,,\n`);
    const s = summarize(facts, "USD");
    expect(s.fees).toBeNull();
    expect(s.paymentsReceived).toBeNull();
  });
  it("a settled payment with no fee row is needs_review (fee unknown, not zero)", () => {
    const { facts } = load(`type,id,amount,currency,date,refs\npayment,P1,100.00,USD,,\npayout,PO1,100.00,USD,,P1\n`);
    expect(reconcilePayouts(facts, "USD")[0]!.status).toBe("needs_review");
  });
  it("EUR is never silently added to USD", () => {
    const { facts } = load(`type,id,amount,currency,date,refs\norder,O1,100.00,USD,,\norder,O2,50.00,EUR,,\n`);
    const s = summarize(facts, "USD");
    expect(s.orderSales).toBeNull();
    expect(s.incomplete.join(" ")).toMatch(/EUR/);
  });
  it("a payout with no payment references is unresolved (no amount-only matching)", () => {
    const { facts } = load(`type,id,amount,currency,date,refs\npayment,P1,97.00,USD,,\npayout,PO1,97.00,USD,,\n`);
    expect(reconcilePayouts(facts, "USD")[0]!.status).toBe("unresolved");
  });
  it("refund on a settled payment is sent to review", () => {
    const { facts } = load(`type,id,amount,currency,date,refs\npayment,P1,100.00,USD,,\nfee,F1,3.00,USD,,P1\nrefund,R1,10.00,USD,,P1\npayout,PO1,97.00,USD,,P1\n`);
    expect(reconcilePayouts(facts, "USD")[0]!.status).toBe("needs_review");
  });
});

describe("mapping issues never echo cell contents (privacy)", () => {
  it("messages contain no source values", () => {
    const secret = "jane.doe@example.com";
    const { issues } = load(`type,id,amount,currency,date,refs\norder,${secret},${secret},USD,${secret},\n`);
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues) expect(JSON.stringify(i)).not.toContain(secret);
  });
  it("skips rows without an id or with an unknown kind, and says so", () => {
    const { facts, issues } = load(`type,id,amount,currency,date,refs\norder,,5.00,USD,,\nmystery,X1,5.00,USD,,\n`);
    expect(facts).toEqual([]);
    expect(issues.map((i) => i.code)).toEqual(["missing_id", "unknown_kind"]);
  });
  it("handles a UTF-8 BOM and quoted commas", () => {
    const { facts } = load(`﻿type,id,amount,currency,date,refs\norder,"O,1","1,234.50",USD,,\n`);
    expect(facts[0]).toMatchObject({ externalId: "O,1" });
    expect(facts[0]!.amount?.cents).toBe(123450);
  });
});

describe("idempotent re-import (Fixture G)", () => {
  const hashes = async (rows: Record<string, string>[]) => Promise.all(rows.map(async (r, i) => ({ externalKey: r.id ?? null, contentSha256: await rowHash(r), sourceRow: i + 1 })));
  it("re-importing the same file adds nothing", async () => {
    const rows = parseCsv(FIXTURE_A).rows as Record<string, string>[];
    const inc = await hashes(rows);
    const first = planImport([], inc);
    expect(first.added).toHaveLength(4);
    const stored = first.added.map((a) => ({ externalKey: a.identity, contentSha256: a.contentSha256 }));
    const again = planImport(stored, inc);
    expect(again.added).toHaveLength(0);
    expect(again.revised).toHaveLength(0);
    expect(again.unchanged).toHaveLength(4);
  });
  it("a changed row becomes a revision, not a new record and not a silent overwrite", async () => {
    const rows = parseCsv(FIXTURE_A).rows as Record<string, string>[];
    const first = planImport([], await hashes(rows));
    const stored = first.added.map((a) => ({ externalKey: a.identity, contentSha256: a.contentSha256 }));
    const changed = rows.map((r) => (r.id === "P1" ? { ...r, amount: "99.00" } : r));
    const plan = planImport(stored, await hashes(changed));
    expect(plan.revised.map((r) => r.identity)).toEqual(["id:P1"]);
    expect(plan.added).toHaveLength(0);
  });
  it("column order does not change a row's hash", async () => {
    expect(await rowHash({ a: "1", b: "2" })).toBe(await rowHash({ b: "2", a: "1" }));
  });
  it("two genuinely identical rows WITHOUT ids stay two records; re-import adds nothing", async () => {
    const rows = [{ amount: "5.00", date: "2026-01-01" }, { amount: "5.00", date: "2026-01-01" }];
    const inc = await Promise.all(rows.map(async (r, i) => ({ externalKey: null, contentSha256: await rowHash(r), sourceRow: i + 1 })));
    const first = planImport([], inc);
    expect(first.added).toHaveLength(2);
    expect(new Set(first.added.map((a) => a.identity)).size).toBe(2);
    const stored = first.added.map((a) => ({ externalKey: a.identity, contentSha256: a.contentSha256 }));
    expect(planImport(stored, inc).added).toHaveLength(0);
  });
  it("the same id twice in one file: identical copy ignored, conflicting copy flagged", async () => {
    const inc = [
      { externalKey: "X", contentSha256: "aa", sourceRow: 1 },
      { externalKey: "X", contentSha256: "aa", sourceRow: 2 },
      { externalKey: "X", contentSha256: "bb", sourceRow: 3 },
    ];
    const plan = planImport([], inc);
    expect(plan.added).toHaveLength(1);
    expect(plan.duplicatesInFile).toEqual([2]);
    expect(plan.conflictsInFile).toEqual([3]);
  });
});

describe("minimizeRow (privacy by construction)", () => {
  it("drops every column that is not in the mapping", async () => {
    const { minimizeRow } = await import("./index");
    const row = { type: "order", id: "O1", amount: "5.00", currency: "USD", date: "2026-01-01", refs: "", customer_name: "Jane Doe", email: "jane@example.com", address: "1 Main St" };
    const kept = minimizeRow(row, mapping);
    expect(Object.keys(kept).sort()).toEqual(["amount", "currency", "date", "id", "refs", "type"]);
    expect(JSON.stringify(kept)).not.toMatch(/Jane|example\.com|Main St/);
  });
});
