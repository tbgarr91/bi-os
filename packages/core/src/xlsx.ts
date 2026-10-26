import readXlsxFile from "read-excel-file/web-worker";
import type { ParsedCsv } from "./csv";
import { mapRows, type Mapping } from "./csv";
import type { Fact, Issue } from "./facts";
import type { FactKind } from "./facts";

export const XLSX_LIMITS = { maxBytes: 10 * 1024 * 1024, maxRows: 50_000 } as const;

export class SpreadsheetError extends Error {}

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  return String(v).trim();
};

/**
 * Reads one sheet into the same shape as parseCsv, so mapping, minimization and import planning are shared.
 * Formula cells arrive as their cached values. Dates become YYYY-MM-DD. Errors never include cell contents.
 */
export async function parseXlsx(data: ArrayBuffer, sheet: number | string = 1): Promise<ParsedCsv> {
  if (data.byteLength > XLSX_LIMITS.maxBytes) throw new SpreadsheetError(`file larger than ${XLSX_LIMITS.maxBytes} bytes`);
  let table: unknown[][];
  try { table = (await readXlsxFile(new Blob([data]), { sheet })) as unknown[][]; }
  catch { throw new SpreadsheetError("could not read the workbook or sheet"); }
  if (table.length - 1 > XLSX_LIMITS.maxRows) throw new SpreadsheetError(`more than ${XLSX_LIMITS.maxRows} rows; split the file`);
  const [head, ...body] = table;
  const headers = (head ?? []).map(cell);
  if (headers.length === 0 || headers.some((h) => h === "")) throw new SpreadsheetError("header row has an empty column name");
  if (new Set(headers).size !== headers.length) throw new SpreadsheetError("header row has duplicate column names");
  const rows = body
    .filter((r) => r.some((v) => cell(v) !== ""))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, cell(r[i])])));
  return { headers, rows, errors: [] };
}

export interface ManualEntry {
  readonly kind: FactKind;
  readonly externalId: string;
  readonly amount: string;
  readonly currency: string;
  readonly occurredOn?: string;
  readonly relatedIds?: readonly string[];
}

/** Manual entry goes through the same validation as imported rows: no entry path can create a zero from a blank. */
export function factFromManual(e: ManualEntry): { fact: Fact | null; issues: Issue[] } {
  const mapping: Mapping = { kind: e.kind, externalId: "id", amount: "amount", currency: { column: "currency" }, occurredOn: "date", related: { column: "refs", separator: "|" } };
  const { facts, issues } = mapRows([{ id: e.externalId, amount: e.amount, currency: e.currency, date: e.occurredOn ?? "", refs: (e.relatedIds ?? []).join("|") }], mapping);
  return { fact: facts[0] ?? null, issues };
}
