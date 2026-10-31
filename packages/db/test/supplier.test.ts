/** Supplier-charge storage: same security and integrity rules as the other evidence tables. Synthetic data only. */
import { beforeAll, describe, expect, it } from "vitest";
import { admin, asUser, buildWorld, denied, type World } from "./helpers";

let w: World;
const hex = (c: string) => c.repeat(64);

/** Imports one source record the way the app will, then a supplier charge for it, as the calling user. */
async function importCharge(user: string, ws: string, entity: string, opts: { kind?: string; amount?: number | null; currency?: string | null; ident?: string; bare?: boolean } = {}) {
  return asUser(user, async (c) => {
    const ds = (await c.query("insert into public.source_datasets (workspace_id, entity_id, name, source_kind, created_by) values ($1,$2,'Synthetic supplier CSV','csv',$3) returning id", [ws, entity, user])).rows[0].id;
    const b = (await c.query("insert into public.ingestion_batches (workspace_id, entity_id, dataset_id, file_sha256, rows_read, rows_added, rows_unchanged, rows_revised, rows_flagged, created_by) values ($1,$2,$3,$4,1,1,0,0,0,$5) returning id", [ws, entity, ds, hex("a"), user])).rows[0].id;
    const r = (await c.query("insert into public.source_records (workspace_id, entity_id, dataset_id, batch_id, identity, content_sha256, payload, source_row) values ($1,$2,$3,$4,$5,$6,'{\"id\":\"S1\"}',1) returning id", [ws, entity, ds, b, opts.ident ?? "charge:S1", hex("b")])).rows[0].id;
    if (opts.bare) return r as string;
    const amount = opts.amount === undefined ? 2045 : opts.amount;
    await c.query("insert into public.supplier_charges (workspace_id, entity_id, source_record_id, kind, external_id, order_ref, amount_cents, currency) values ($1,$2,$3,$4,'S1','O1',$5,$6)", [ws, entity, r, opts.kind ?? "production", amount, opts.currency === undefined ? "USD" : opts.currency]);
    return r as string;
  });
}
const count = (user: string | null, sql: string, args: unknown[] = []) => asUser(user, async (c) => (await c.query(sql, args)).rowCount as number);

let rec1: string, rec2: string, recB: string;
beforeAll(async () => {
  w = await buildWorld();
  rec1 = await importCharge(w.accountant, w.A, w.E1);
  rec2 = await importCharge(w.owner, w.A, w.E2);
  recB = await importCharge(w.ownerB, w.B, w.EB);
});

describe("supplier_charges access", () => {
  it("accountant scoped to entity One reads only entity One", async () => {
    const rows = await asUser(w.accountant, async (c) => (await c.query("select entity_id from public.supplier_charges")).rows);
    expect(new Set(rows.map((r) => r.entity_id))).toEqual(new Set([w.E1]));
  });
  it("accountant cannot import into entity Two; viewer, outsider and anon cannot read or write", async () => {
    await denied(importCharge(w.accountant, w.A, w.E2, { ident: "x" }));
    await denied(importCharge(w.viewer, w.A, w.E1, { ident: "v" }));
    await denied(importCharge(w.outsider, w.A, w.E1, { ident: "o" }));
    expect(await count(w.viewer, "select 1 from public.supplier_charges")).toBe(0);
    expect(await count(w.outsider, "select 1 from public.supplier_charges")).toBe(0);
    await denied(asUser(null, (c) => c.query("select 1 from public.supplier_charges")));
  });
  it("owner reads both entities; another workspace's owner sees none of them", async () => {
    expect(await count(w.owner, "select 1 from public.supplier_charges where workspace_id=$1", [w.A])).toBe(2);
    expect(await count(w.ownerB, "select 1 from public.supplier_charges where workspace_id=$1", [w.A])).toBe(0);
  });
});

describe("supplier_charges integrity", () => {
  it("a charge cannot point at another workspace's or another entity's source record", async () => {
    const bare = await importCharge(w.owner, w.A, w.E1, { bare: true, ident: "charge:bare" }); // a source record in A / entity One with no charge yet
    const ins = "insert into public.supplier_charges (workspace_id, entity_id, source_record_id, kind, external_id, order_ref) values ($1,$2,$3,'production','Z','O1')";
    await denied(asUser(w.ownerB, (c) => c.query(ins, [w.B, w.EB, bare])), ["23503"]);
    await denied(asUser(w.owner, (c) => c.query(ins, [w.A, w.E2, bare])), ["23503"]);
  });
  it("an unknown amount is stored as NULL, never 0; an amount needs a currency; kinds are a closed list", async () => {
    const r = await importCharge(w.owner, w.A, w.E2, { amount: null, currency: null, ident: "charge:unknown" });
    const row = (await admin((x) => x.query("select amount_cents, currency from public.supplier_charges where source_record_id=$1", [r]))).rows[0];
    expect(row.amount_cents).toBeNull();
    await denied(importCharge(w.owner, w.A, w.E2, { currency: null, ident: "charge:nocur" }), ["23514"]);
    await denied(importCharge(w.owner, w.A, w.E2, { kind: "gift", ident: "charge:kind" }), ["23514"]);
  });
  it("is append-only for every role, including a superuser, even for statements that match nothing", async () => {
    await denied(asUser(w.owner, (c) => c.query("update public.supplier_charges set amount_cents=0")), ["42501"]);
    await denied(asUser(w.owner, (c) => c.query("delete from public.supplier_charges")), ["42501"]);
    await denied(admin((c) => c.query("update public.supplier_charges set amount_cents=0 where false")), ["42501"]);
    await denied(admin((c) => c.query("truncate public.supplier_charges")), ["42501"]);
    expect(recB).toBeTruthy(); expect(rec2).toBeTruthy();
  });
  it("API roles have only select plus column-level insert, and anon has nothing", async () => {
    const t = (await admin((c) => c.query("select grantee, privilege_type from information_schema.role_table_grants where table_schema='public' and table_name='supplier_charges' and grantee in ('anon','authenticated','public')"))).rows;
    expect(t).toEqual([{ grantee: "authenticated", privilege_type: "SELECT" }]);
    const cols = (await admin((c) => c.query("select grantee, privilege_type, column_name from information_schema.column_privileges where table_schema='public' and table_name='supplier_charges' and grantee in ('anon','public') and privilege_type<>'REFERENCES'"))).rows;
    expect(cols).toEqual([]);
    const ins = (await admin((c) => c.query("select column_name from information_schema.column_privileges where table_schema='public' and table_name='supplier_charges' and grantee='authenticated' and privilege_type='INSERT'"))).rows.map((r) => r.column_name);
    expect(ins).not.toContain("id");
    expect(ins).not.toContain("created_at");
  });
});
