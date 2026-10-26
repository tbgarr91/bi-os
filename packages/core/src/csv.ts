import Papa from "papaparse";
import { parseAmountCell, type Fact, type FactKind, type Issue } from "./facts";

export interface ParsedCsv {
  readonly headers: readonly string[];
  readonly rows: readonly Record<string, string>[];
  readonly errors: readonly string[]; // structural problems only, never cell contents
}

export function parseCsv(text: string): ParsedCsv {
  const r = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy" });
  return {
    headers: r.meta.fields ?? [],
    rows: r.data,
    errors: r.errors.map((e) => `row ${e.row === undefined ? "?" : e.row + 1}: ${e.type}/${e.code}`),
  };
}

/** Founder-reviewed mapping from source columns to facts. Versioned and stored with the dataset (mapping_versions). */
export interface Mapping {
  /** Either one fixed kind, or a column whose values map to kinds. */
  readonly kind: FactKind | { readonly column: string; readonly values: Readonly<Record<string, FactKind>> };
  readonly externalId: string;
  readonly amount: string;
  readonly currency: string | { readonly column: string };
  readonly occurredOn?: string;
  readonly related?: { readonly column: string; readonly separator: string };
}

export function mapRows(rows: readonly Record<string, string>[], mapping: Mapping): { facts: Fact[]; issues: Issue[] } {
  const facts: Fact[] = [];
  const issues: Issue[] = [];
  rows.forEach((row, i) => {
    const n = i + 1;
    const kind: FactKind | undefined = typeof mapping.kind === "string" ? mapping.kind : mapping.kind.values[(row[mapping.kind.column] ?? "").trim()];
    if (!kind) { issues.push({ row: n, code: "unknown_kind", message: "row kind is not in the mapping; row skipped" }); return; }
    const externalId = (row[mapping.externalId] ?? "").trim();
    if (!externalId) { issues.push({ row: n, code: "missing_id", message: "no identifier; row skipped" }); return; }
    const cur = (typeof mapping.currency === "string" ? mapping.currency : row[mapping.currency.column] ?? "").trim().toUpperCase();
    let amount = null as Fact["amount"];
    if (!cur) issues.push({ row: n, code: "missing_currency", message: "currency missing; amount left unknown" });
    else if (!/^[A-Z]{3}$/.test(cur)) issues.push({ row: n, code: "invalid_currency", message: "currency is not a 3-letter code; amount left unknown" });
    else {
      const raw = row[mapping.amount];
      amount = parseAmountCell(raw, cur);
      if (amount === null) issues.push({ row: n, code: raw === undefined || raw.trim() === "" ? "missing_amount" : "invalid_amount", message: "amount missing or not a valid 2-decimal value; left unknown, not zero" });
    }
    let occurredOn: string | null = null;
    if (mapping.occurredOn) {
      const d = (row[mapping.occurredOn] ?? "").trim();
      if (d === "") occurredOn = null;
      else if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d))) occurredOn = d;
      else issues.push({ row: n, code: "invalid_date", message: "date is not YYYY-MM-DD; left unknown" });
    }
    const relatedIds = mapping.related
      ? (row[mapping.related.column] ?? "").split(mapping.related.separator).map((s) => s.trim()).filter(Boolean)
      : [];
    facts.push({ kind, externalId, amount, occurredOn, relatedIds, sourceRow: n });
  });
  return { facts, issues };
}

/** Keeps ONLY the columns named in the mapping. Everything else in a source row (names, emails, addresses...) is dropped before storage. */
export function minimizeRow(row: Readonly<Record<string, string>>, mapping: Mapping): Record<string, string> {
  const cols = new Set<string>([mapping.externalId, mapping.amount]);
  if (typeof mapping.kind !== "string") cols.add(mapping.kind.column);
  if (typeof mapping.currency !== "string") cols.add(mapping.currency.column);
  if (mapping.occurredOn) cols.add(mapping.occurredOn);
  if (mapping.related) cols.add(mapping.related.column);
  const out: Record<string, string> = {};
  for (const c of cols) if (row[c] !== undefined) out[c] = row[c];
  return out;
}
