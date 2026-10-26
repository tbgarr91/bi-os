/** M2 evidence-layer security and integrity tests, against a real Postgres as API roles. Synthetic data only. */
import { beforeAll, describe, expect, it } from "vitest";
import { admin, asUser, buildWorld, denied, uuid, type World } from "./helpers";

let w: World;

const hex = (c: string) => c.repeat(64);

interface Chain { dataset: string; batch: string; record: string }

/** Imports one record and one fact the way the app will: dataset, batch, record, fact, as the calling user. */
async function importOne(user: string, ws: string, entity: string, opts: { id?: string; amount?: number | null; currency?: string | null; identity?: string; content?: string } = {}): Promise<Chain> {
  return asUser(user, async (c) => {
    const ds = (await c.query("insert into public.source_datasets (workspace_id, entity_id, name, source_kind, created_by) values ($1,$2,'Synthetic CSV','csv',$3) returning id", [ws, entity, user])).rows[0].id;
    const b = (await c.query("insert into public.ingestion_batches (workspace_id, entity_id, dataset_id, file_sha256, rows_read, rows_added, rows_unchanged, rows_revised, rows_flagged, created_by) values ($1,$2,$3,$4,1,1,0,0,0,$5) returning id", [ws, entity, ds, hex("c"), user])).rows[0].id;
    const r = (await c.query("insert into public.source_records (workspace_id, entity_id, dataset_id, batch_id, identity, content_sha256, payload, source_row) values ($1,$2,$3,$4,$5,$6,'{\"id\":\"O1\"}',1) returning id", [ws, entity, ds, b, opts.identity ?? `id:${opts.id ?? "O1"}`, opts.content ?? hex("d")])).rows[0].id;
    const amount = opts.amount === undefined ? 10000 : opts.amount;
    await c.query("insert into public.commerce_facts (workspace_id, entity_id, source_record_id, kind, external_id, amount_cents, currency) values ($1,$2,$3,'order',$4,$5,$6)", [ws, entity, r, opts.id ?? "O1", amount, opts.currency === undefined ? "USD" : opts.currency]);
    return { dataset: ds, batch: b, record: r };
  });
}
const count = (user: string | null, sql: string, args: unknown[] = []) => asUser(user, async (c) => (await c.query(sql, args)).rowCount as number);

let e1: Chain, e2: Chain, b1: Chain;
beforeAll(async () => {
  w = await buildWorld();
  e1 = await importOne(w.accountant, w.A, w.E1);          // accountant imports into entity One
  e2 = await importOne(w.owner, w.A, w.E2);                // owner imports into entity Two
  b1 = await importOne(w.ownerB, w.B, w.EB);               // other workspace
});

describe("who can import and read", () => {
  it("accountant scoped to entity One reads entity One evidence only", async () => {
    for (const t of ["source_datasets", "ingestion_batches", "source_records", "commerce_facts"]) {
      const rows = await asUser(w.accountant, async (c) => (await c.query(`select entity_id from public.${t}`)).rows);
      expect(rows.length, t).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r.entity_id)), t).toEqual(new Set([w.E1]));
    }
  });
  it("accountant cannot import into entity Two", async () => {
    await denied(importOne(w.accountant, w.A, w.E2, { id: "X" }));
  });
  it("owner reads both entities", async () => {
    const rows = await asUser(w.owner, async (c) => (await c.query("select distinct entity_id from public.commerce_facts where workspace_id=$1", [w.A])).rows);
    expect(rows.map((r) => r.entity_id).sort()).toEqual([w.E1, w.E2].sort());
  });
  it("viewer (no source_data.read) sees none of it and cannot import", async () => {
    for (const t of ["source_datasets", "ingestion_batches", "source_records", "commerce_facts", "data_quality_issues"]) expect(await count(w.viewer, `select 1 from public.${t}`), t).toBe(0);
    await denied(importOne(w.viewer, w.A, w.E1, { id: "V" }));
  });
  it("outsider and anon see and write nothing", async () => {
    for (const t of ["source_datasets", "ingestion_batches", "source_records", "commerce_facts", "data_quality_issues"]) {
      expect(await count(w.outsider, `select 1 from public.${t}`), t).toBe(0);
      await denied(asUser(null, (c) => c.query(`select 1 from public.${t}`)));
    }
    await denied(importOne(w.outsider, w.A, w.E1, { id: "O" }));
  });
});

describe("cross-workspace and cross-entity integrity", () => {
  it("workspace B cannot read workspace A evidence by guessing ids", async () => {
    expect(await count(w.ownerB, "select 1 from public.source_records where id=$1", [e1.record])).toBe(0);
    expect(await count(w.ownerB, "select 1 from public.commerce_facts where source_record_id=$1", [e1.record])).toBe(0);
    expect(await count(w.ownerB, "select 1 from public.source_datasets where id=$1", [e1.dataset])).toBe(0);
  });
  it("workspace B cannot attach a record or fact to workspace A's dataset or record", async () => {
    await denied(asUser(w.ownerB, (c) => c.query(
      "insert into public.source_records (workspace_id, entity_id, dataset_id, batch_id, identity, content_sha256, payload, source_row) values ($1,$2,$3,$4,'id:Z',$5,'{}',1)",
      [w.B, w.EB, e1.dataset, b1.batch, hex("e")])), ["23503"]);
    await denied(asUser(w.ownerB, (c) => c.query(
      "insert into public.commerce_facts (workspace_id, entity_id, source_record_id, kind, external_id) values ($1,$2,$3,'order','Z')", [w.B, w.EB, e1.record])), ["23503"]);
  });
  it("a record cannot claim a different entity than its dataset (even for a user with both)", async () => {
    await denied(asUser(w.owner, (c) => c.query(
      "insert into public.source_records (workspace_id, entity_id, dataset_id, batch_id, identity, content_sha256, payload, source_row) values ($1,$2,$3,$4,'id:M',$5,'{}',1)",
      [w.A, w.E2, e1.dataset, e1.batch, hex("f")])), ["23503"]);
  });
  it("a fact cannot claim a different entity than its record", async () => {
    const bare = await asUser(w.owner, async (c) => (await c.query(
      "insert into public.source_records (workspace_id, entity_id, dataset_id, batch_id, identity, content_sha256, payload, source_row) values ($1,$2,$3,$4,'id:BARE',$5,'{}',1) returning id",
      [w.A, w.E1, e1.dataset, e1.batch, hex("7")])).rows[0].id);
    await denied(asUser(w.owner, (c) => c.query(
      "insert into public.commerce_facts (workspace_id, entity_id, source_record_id, kind, external_id) values ($1,$2,$3,'order','Q')", [w.A, w.E2, bare])), ["23503"]);
  });
});

describe("append-only evidence", () => {
  it("nobody can update, delete or truncate evidence: API roles, owner, or superuser", async () => {
    for (const t of ["source_datasets", "ingestion_batches", "source_records", "commerce_facts", "data_quality_issues"]) {
      await denied(asUser(w.owner, (c) => c.query(`delete from public.${t}`)));
      await denied(asUser(w.owner, (c) => c.query(`update public.${t} set created_at = now()`)));
      await denied(admin((c) => c.query(`delete from public.${t}`)), ["42501"]);
      await denied(admin((c) => c.query(`update public.${t} set created_at = now()`)), ["42501"]);
      await denied(admin((c) => c.query(`truncate public.${t} cascade`)), ["42501"]);
    }
  });
  it("API roles hold only SELECT and INSERT on evidence tables", async () => {
    // column-level grants appear in column_privileges, not role_table_grants: check both
    const rows = (await admin((c) => c.query(
      `select privilege_type from information_schema.role_table_grants where grantee in ('authenticated','anon','public') and table_schema='public' and table_name = any($1)
       union select privilege_type from information_schema.column_privileges where grantee in ('authenticated','anon','public') and table_schema='public' and table_name = any($1)`,
      [["source_datasets", "ingestion_batches", "source_records", "commerce_facts", "data_quality_issues"]]))).rows;
    expect(rows.map((r) => r.privilege_type).sort()).toEqual(["INSERT", "SELECT"]);
  });
});

describe("idempotent import at the database level", () => {
  it("the same content for the same identity cannot be stored twice", async () => {
    await denied(importOne(w.owner, w.A, w.E2, { id: "O1", identity: "id:O1", content: hex("d") }).then(async () => {
      // second import into the SAME dataset with the same identity+content
      await asUser(w.owner, (c) => c.query(
        "insert into public.source_records (workspace_id, entity_id, dataset_id, batch_id, identity, content_sha256, payload, source_row) values ($1,$2,$3,$4,'id:O1',$5,'{}',1)",
        [w.A, w.E2, e2.dataset, e2.batch, hex("d")]));
    }), ["23505"]);
  });
  it("a changed row is stored as a new version that supersedes the old; a fork is refused", async () => {
    const v2 = await asUser(w.owner, async (c) => (await c.query(
      "insert into public.source_records (workspace_id, entity_id, dataset_id, batch_id, identity, content_sha256, payload, source_row, supersedes_id) values ($1,$2,$3,$4,'id:O1',$5,'{\"id\":\"O1\"}',1,$6) returning id",
      [w.A, w.E2, e2.dataset, e2.batch, hex("9"), e2.record])).rows[0].id);
    expect(v2).toBeTruthy();
    await denied(asUser(w.owner, (c) => c.query(
      "insert into public.source_records (workspace_id, entity_id, dataset_id, batch_id, identity, content_sha256, payload, source_row, supersedes_id) values ($1,$2,$3,$4,'id:O1',$5,'{}',1,$6)",
      [w.A, w.E2, e2.dataset, e2.batch, hex("8"), e2.record])), ["23505"]);
    expect(await count(w.owner, "select 1 from public.source_records where id=$1", [e2.record])).toBe(1); // original retained
  });
});

describe("missing is never zero (Fixture F, at rest)", () => {
  it("an unknown amount is stored as NULL, and the database never turns it into 0", async () => {
    const c = await importOne(w.owner, w.A, w.E2, { id: "NOAMT", amount: null, currency: "USD", content: hex("1") });
    const row = (await admin((x) => x.query("select amount_cents, currency from public.commerce_facts where source_record_id=$1", [c.record]))).rows[0];
    expect(row.amount_cents).toBeNull();
  });
  it("an amount without a currency is refused", async () => {
    await denied(importOne(w.owner, w.A, w.E2, { id: "NOCUR", amount: 500, currency: null, content: hex("2") }), ["23514"]);
  });
  it("malformed values are refused: lowercase currency, bad hash, unknown kind, non-object payload", async () => {
    await denied(importOne(w.owner, w.A, w.E2, { id: "BADCUR", currency: "usd", content: hex("3") }), ["23514"]);
    await denied(asUser(w.owner, (c) => c.query(
      "insert into public.source_records (workspace_id, entity_id, dataset_id, batch_id, identity, content_sha256, payload, source_row) values ($1,$2,$3,$4,'id:H','nothex','{}',1)", [w.A, w.E2, e2.dataset, e2.batch])), ["23514"]);
    await denied(asUser(w.owner, (c) => c.query(
      "insert into public.source_records (workspace_id, entity_id, dataset_id, batch_id, identity, content_sha256, payload, source_row) values ($1,$2,$3,$4,'id:P',$5,'[]',1)", [w.A, w.E2, e2.dataset, e2.batch, hex("4")])), ["23514"]);
    await denied(asUser(w.owner, (c) => c.query(
      "insert into public.commerce_facts (workspace_id, entity_id, source_record_id, kind, external_id) values ($1,$2,$3,'sale','K')", [w.A, w.E2, e2.record])), ["23514"]);
  });
});

describe("the import cannot be impersonated", () => {
  it("created_by must be the caller on datasets and batches", async () => {
    await denied(asUser(w.accountant, (c) => c.query(
      "insert into public.source_datasets (workspace_id, entity_id, name, source_kind, created_by) values ($1,$2,'x','csv',$3)", [w.A, w.E1, w.owner])));
  });
  it("data quality issues carry short messages (no room for pasted source rows)", async () => {
    await denied(asUser(w.owner, (c) => c.query(
      "insert into public.data_quality_issues (workspace_id, entity_id, batch_id, source_row, code, message) values ($1,$2,$3,1,'invalid_amount',$4)", [w.A, w.E2, e2.batch, "x".repeat(301)])), ["23514"]);
    await asUser(w.owner, (c) => c.query(
      "insert into public.data_quality_issues (workspace_id, entity_id, batch_id, source_row, code, message) values ($1,$2,$3,1,'invalid_amount','amount missing or invalid; left unknown')", [w.A, w.E2, e2.batch]));
  });
});
