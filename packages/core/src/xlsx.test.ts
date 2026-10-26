import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { factFromManual, mapRows, parseXlsx, summarize, reconcilePayouts, type Mapping } from "./index";

const mapping: Mapping = { kind: { column: "type", values: { order: "order", payment: "payment", fee: "fee", payout: "payout" } }, externalId: "id", amount: "amount", currency: { column: "currency" }, occurredOn: "date", related: { column: "refs", separator: ";" } };

async function book(rows: unknown[][], opts: { extraSheet?: boolean } = {}): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sales");
  rows.forEach((r) => ws.addRow(r));
  if (opts.extraSheet) wb.addWorksheet("Other").addRow(["x"]);
  const buf = await wb.xlsx.writeBuffer();
  return buf instanceof ArrayBuffer ? buf : new Uint8Array(buf as Buffer).slice().buffer;
}

describe("XLSX import shares the CSV pipeline", () => {
  it("reads numbers, text and dates; fixture A reconciles", async () => {
    const data = await book([
      ["type", "id", "amount", "currency", "date", "refs"],
      ["order", "O1", 100, "USD", new Date("2026-01-02T00:00:00Z"), ""],
      ["payment", "P1", 100, "USD", "2026-01-02", "O1"],
      ["fee", "F1", 3, "USD", "2026-01-02", "P1"],
      ["payout", "PO1", 97, "USD", "2026-01-05", "P1"],
    ]);
    const { rows } = await parseXlsx(data);
    const { facts, issues } = mapRows(rows, mapping);
    expect(issues).toEqual([]);
    expect(summarize(facts, "USD").netOrderSales?.cents).toBe(10000);
    expect(reconcilePayouts(facts, "USD")[0]!.status).toBe("matched");
  });
  it("empty cells and float noise are unknown, never zero", async () => {
    const data = await book([["type", "id", "amount", "currency", "date", "refs"], ["order", "O1", null, "USD", null, null], ["order", "O2", 0.1 + 0.2, "USD", null, null]]);
    const { facts, issues } = mapRows((await parseXlsx(data)).rows, mapping);
    expect(facts.map((f) => f.amount)).toEqual([null, null]);
    expect(issues.map((i) => i.code)).toEqual(["missing_amount", "invalid_amount"]);
  });
  it("selects a sheet and skips blank rows", async () => {
    const data = await book([["type", "id", "amount", "currency"], [null, null, null, null], ["order", "O1", 5, "USD"]], { extraSheet: true });
    expect((await parseXlsx(data, 1)).rows).toHaveLength(1);
  });
  it("rejects duplicate or empty headers, bad files and oversize input without echoing content", async () => {
    await expect(parseXlsx(await book([["a", "a"], [1, 2]]))).rejects.toThrow(/duplicate/);
    await expect(parseXlsx(await book([["a", null], [1, 2]]))).rejects.toThrow(/empty column/);
    await expect(parseXlsx(new TextEncoder().encode("not a workbook with secret@example.com").buffer as ArrayBuffer)).rejects.toThrow(/could not read/);
    const err = await parseXlsx(new TextEncoder().encode("secret@example.com").buffer as ArrayBuffer).catch((e: Error) => e.message);
    expect(err).not.toContain("secret@example.com");
    await expect(parseXlsx(new ArrayBuffer(11 * 1024 * 1024))).rejects.toThrow(/larger than/);
  });
});

describe("manual entry uses the same validation", () => {
  it("accepts a valid payment", () => {
    const { fact, issues } = factFromManual({ kind: "payment", externalId: "P9", amount: "12.34", currency: "USD", occurredOn: "2026-02-01", relatedIds: ["O9"] });
    expect(issues).toEqual([]);
    expect(fact).toMatchObject({ kind: "payment", relatedIds: ["O9"] });
    expect(fact!.amount?.cents).toBe(1234);
  });
  it("a blank amount is unknown with an issue, not zero", () => {
    const { fact, issues } = factFromManual({ kind: "fee", externalId: "F9", amount: "", currency: "USD" });
    expect(fact!.amount).toBeNull();
    expect(issues[0]!.code).toBe("missing_amount");
  });
  it("a missing id yields no fact", () => {
    expect(factFromManual({ kind: "order", externalId: " ", amount: "5.00", currency: "USD" }).fact).toBeNull();
  });
});
