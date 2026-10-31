import { parseAmountCell, type Issue } from "./facts";
import { add, money, type Currency, type Money } from "./money";
import type { OrderComponents, Slot } from "./metrics";

/**
 * Supplier charges (decision P-2): what a print-on-demand supplier billed for an order. They are a different fact from the
 * customer's order and payment, and arrive through CSV, XLSX or manual entry (never a seventh connector).
 * `amount` is null when the source value is missing or invalid: missing is never zero.
 */
export type ChargeKind = "production" | "print_surcharge" | "supplier_shipping" | "supplier_tax" | "reprint";

export interface SupplierCharge {
  readonly kind: ChargeKind;
  readonly externalId: string;
  readonly orderRef: string; // the order this charge belongs to
  readonly amount: Money | null;
  readonly occurredOn: string | null;
  readonly sourceRow: number;
}

export interface SupplierMapping {
  readonly kind: ChargeKind | { readonly column: string; readonly values: Readonly<Record<string, ChargeKind>> };
  readonly externalId: string;
  readonly orderRef: string;
  readonly amount: string;
  readonly currency: string | { readonly column: string };
  readonly occurredOn?: string;
}

/** Same rules as `mapRows`: bad cells become issues without echoing values, and the amount stays unknown (null). */
export function mapSupplierCharges(rows: readonly Record<string, string>[], mapping: SupplierMapping): { charges: SupplierCharge[]; issues: Issue[] } {
  const charges: SupplierCharge[] = [];
  const issues: Issue[] = [];
  rows.forEach((row, i) => {
    const n = i + 1;
    const kind = typeof mapping.kind === "string" ? mapping.kind : mapping.kind.values[(row[mapping.kind.column] ?? "").trim()];
    if (!kind) { issues.push({ row: n, code: "unknown_kind", message: "charge kind is not in the mapping; row skipped" }); return; }
    const externalId = (row[mapping.externalId] ?? "").trim();
    const orderRef = (row[mapping.orderRef] ?? "").trim();
    if (!externalId || !orderRef) { issues.push({ row: n, code: "missing_id", message: "charge id or order reference missing; row skipped" }); return; }
    const cur = (typeof mapping.currency === "string" ? mapping.currency : row[mapping.currency.column] ?? "").trim().toUpperCase();
    let amount: Money | null = null;
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
    charges.push({ kind, externalId, orderRef, amount, occurredOn, sourceRow: n });
  });
  return { charges, issues };
}

/** Columns kept before storage: only those named in the mapping. */
export function minimizeSupplierRow(row: Readonly<Record<string, string>>, mapping: SupplierMapping): Record<string, string> {
  const cols = new Set<string>([mapping.externalId, mapping.orderRef, mapping.amount]);
  if (typeof mapping.kind !== "string") cols.add(mapping.kind.column);
  if (typeof mapping.currency !== "string") cols.add(mapping.currency.column);
  if (mapping.occurredOn) cols.add(mapping.occurredOn);
  const out: Record<string, string> = {};
  for (const c of cols) if (row[c] !== undefined) out[c] = row[c];
  return out;
}

type Sum = { kind: "none" } | { kind: "unknown" } | { kind: "known"; amount: Money };
function sumKinds(charges: readonly SupplierCharge[], kinds: readonly ChargeKind[], currency: Currency): Sum {
  const rows = charges.filter((c) => kinds.includes(c.kind));
  if (rows.length === 0) return { kind: "none" };
  // An unknown amount, or one in another currency (never converted), makes the whole component unknown.
  if (rows.some((c) => c.amount === null || c.amount.currency !== currency)) return { kind: "unknown" };
  return { kind: "known", amount: rows.reduce((a, c) => add(a, c.amount as Money), money(0, currency)) };
}

export interface CustomerSide {
  readonly currency: Currency;
  readonly orderRef: string;
  readonly netProductRevenue: Slot;
  readonly netShippingRevenue: Slot;
  readonly paymentFees: Slot;
  readonly channelFees?: Slot;
  readonly packaging?: Slot;
  readonly otherVariable?: Slot;
}

/**
 * Builds the CONTRIB.ORDER inputs for a POD order from its supplier charges.
 *  - No production charge for the order => product cost is UNKNOWN (null): the order is not costed, never costed at zero.
 *  - No supplier shipping / supplier tax rows => UNKNOWN as well: a supplier invoice that omits shipping is a gap to
 *    report, not evidence that shipping was free.
 *  - Reprint rows exist only when a reprint happened, so no reprint row is "n/a", not zero and not unknown.
 *    (Whether that reading is right is a founder decision; recorded as an open question in file 31.)
 */
export function podOrderComponents(side: CustomerSide, charges: readonly SupplierCharge[]): OrderComponents {
  const mine = charges.filter((c) => c.orderRef === side.orderRef);
  const slot = (s: Sum, whenNone: Slot): Slot => s.kind === "none" ? whenNone : s.kind === "unknown" ? null : { amount: s.amount, basis: "actual" };
  return {
    currency: side.currency,
    orderRef: side.orderRef,
    netProductRevenue: side.netProductRevenue,
    netShippingRevenue: side.netShippingRevenue,
    productCost: slot(sumKinds(mine, ["production", "print_surcharge"], side.currency), null),
    supplierShipping: slot(sumKinds(mine, ["supplier_shipping"], side.currency), null),
    supplierTax: slot(sumKinds(mine, ["supplier_tax"], side.currency), null),
    reprintCosts: slot(sumKinds(mine, ["reprint"], side.currency), "n/a"),
    paymentFees: side.paymentFees,
    channelFees: side.channelFees ?? "n/a",
    packaging: side.packaging ?? "n/a",
    otherVariable: side.otherVariable ?? "n/a",
  };
}
