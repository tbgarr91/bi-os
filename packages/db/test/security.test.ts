/**
 * M1 isolation and authorization tests, run against a REAL Postgres (not mocks), as the API roles `anon`/`authenticated`.
 * IDs follow the SEC fixtures in Project file 17 section 11. Tests not yet implemented are listed in docs/SEC-COVERAGE.md.
 * Every allowed case has a matching denied case. All data is synthetic.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { admin, asUser, buildWorld, denied, uuid, type World } from "./helpers";

let w: World;
beforeAll(async () => { w = await buildWorld(); });

const count = (user: string | null, sql: string, args: unknown[] = []) =>
  asUser(user, async (c) => (await c.query(sql, args)).rowCount as number);

describe("SEC-01 cross-workspace guessing", () => {
  it("user in workspace B cannot read workspace A records, entities or workspace by guessing ids", async () => {
    expect(await count(w.ownerB, "select 1 from public.financial_records where id = $1", [w.rec1])).toBe(0);
    expect(await count(w.ownerB, "select 1 from public.legal_entities where id = $1", [w.E1])).toBe(0);
    expect(await count(w.ownerB, "select 1 from public.workspaces where id = $1", [w.A])).toBe(0);
    expect(await count(w.ownerB, "select 1 from public.audit_events where workspace_id = $1", [w.A])).toBe(0);
  });
  it("cannot write into workspace A either", async () => {
    await denied(asUser(w.ownerB, (c) => c.query(
      "insert into public.financial_records (workspace_id, entity_id, amount_cents, currency, occurred_on, created_by) values ($1,$2,1,'USD','2026-01-01',$3)",
      [w.A, w.E1, w.ownerB])));
    // update/delete by guess affect zero rows (invisible) rather than succeeding
    const upd = await asUser(w.ownerB, (c) => c.query("update public.financial_records set status='classified' where id=$1", [w.rec1]));
    expect(upd.rowCount).toBe(0);
  });
  it("owner of A still sees their own data (positive control)", async () => {
    expect(await count(w.owner, "select 1 from public.financial_records where workspace_id = $1", [w.A])).toBe(2);
  });
});

describe("SEC-02/03 entity-scoped access", () => {
  it("accountant scoped to entity One reads entity One records", async () => {
    const rows = await asUser(w.accountant, async (c) => (await c.query("select id from public.financial_records")).rows);
    expect(rows.map((r) => r.id)).toEqual([w.rec1]);
  });
  it("same accountant cannot see entity Two records (same workspace) by filter or by id", async () => {
    expect(await count(w.accountant, "select 1 from public.financial_records where entity_id = $1", [w.E2])).toBe(0);
    expect(await count(w.accountant, "select 1 from public.financial_records where id = $1", [w.rec2])).toBe(0);
    expect(await count(w.accountant, "select 1 from public.legal_entities where id = $1", [w.E2])).toBe(0);
  });
  it("accountant can create and classify in entity One but not entity Two", async () => {
    await asUser(w.accountant, (c) => c.query(
      "insert into public.financial_records (workspace_id, entity_id, amount_cents, currency, occurred_on, created_by) values ($1,$2,500,'USD','2026-02-01',$3)",
      [w.A, w.E1, w.accountant]));
    await denied(asUser(w.accountant, (c) => c.query(
      "insert into public.financial_records (workspace_id, entity_id, amount_cents, currency, occurred_on, created_by) values ($1,$2,500,'USD','2026-02-01',$3)",
      [w.A, w.E2, w.accountant])));
    const ok = await asUser(w.accountant, (c) => c.query("update public.financial_records set status='classified' where id=$1", [w.rec1]));
    expect(ok.rowCount).toBe(1);
  });
  it("accountant cannot record on someone else's behalf (created_by must be self)", async () => {
    await denied(asUser(w.accountant, (c) => c.query(
      "insert into public.financial_records (workspace_id, entity_id, amount_cents, currency, occurred_on, created_by) values ($1,$2,500,'USD','2026-02-01',$3)",
      [w.A, w.E1, w.owner])));
  });
});

describe("viewer preset: read-only", () => {
  it("viewer reads workspace-wide", async () => {
    expect(await count(w.viewer, "select 1 from public.financial_records where workspace_id=$1", [w.A])).toBe(3);
  });
  it("viewer cannot create, edit, delete, or see the audit log", async () => {
    await denied(asUser(w.viewer, (c) => c.query(
      "insert into public.financial_records (workspace_id, entity_id, amount_cents, currency, occurred_on, created_by) values ($1,$2,1,'USD','2026-01-01',$3)",
      [w.A, w.E1, w.viewer])));
    expect((await asUser(w.viewer, (c) => c.query("update public.financial_records set status='classified' where id=$1", [w.rec2]))).rowCount).toBe(0);
    await denied(asUser(w.viewer, (c) => c.query("delete from public.financial_records where id=$1", [w.rec2])));
    expect(await count(w.viewer, "select 1 from public.audit_events")).toBe(0);
  });
});

describe("SEC-04 role without finance scope (schema supports roles beyond the three presets)", () => {
  it("a workspace-management-only role cannot read financial records", async () => {
    await admin(async (c) => {
      await c.query("insert into public.role_definitions (code, name, is_system, exposed_in_ui) values ('test_admin_no_finance','Test admin',false,false)");
      await c.query("insert into public.role_permissions values ('test_admin_no_finance','workspace.manage_settings'),('test_admin_no_finance','membership.read')");
    });
    const adminUser = uuid();
    await admin(async (c) => {
      const m = await c.query("insert into public.workspace_memberships (workspace_id, user_id) values ($1,$2) returning id", [w.A, adminUser]);
      const ownerM = await c.query("select id from public.workspace_memberships where workspace_id=$1 and user_id=$2", [w.A, w.owner]);
      await c.query("insert into public.access_grants (workspace_id, membership_id, role_code, scope_type, granted_by_membership_id) values ($1,$2,'test_admin_no_finance','workspace',$3)",
        [w.A, m.rows[0].id, ownerM.rows[0].id]);
    });
    expect(await count(adminUser, "select 1 from public.financial_records")).toBe(0);
    expect(await count(adminUser, "select 1 from public.workspaces where id=$1", [w.A])).toBe(1); // but can see the workspace
  });
});

describe("SEC-07/08 workspace id tampering and cross-workspace references", () => {
  it("cannot change workspace_id on update (guard trigger and column privileges)", async () => {
    await denied(admin((c) => c.query("update public.financial_records set workspace_id=$1 where id=$2", [w.B, w.rec1])));
    await denied(asUser(w.owner, (c) => c.query("update public.financial_records set workspace_id=$1 where id=$2", [w.B, w.rec1])));
  });
  it("a user who belongs to BOTH workspaces cannot attach a record to the other workspace's entity", async () => {
    const dual = uuid();
    await asUser(w.owner, (c) => c.query("select public.grant_access($1,$2,'viewer',null)", [w.A, dual]).then(() => 0));
    await asUser(w.ownerB, (c) => c.query("select public.grant_access($1,$2,'owner',null)", [w.B, dual]).then(() => 0));
    // dual is owner in B and viewer in A. A record in workspace B referencing entity of workspace A must fail the composite foreign key.
    await denied(asUser(dual, (c) => c.query(
      "insert into public.financial_records (workspace_id, entity_id, amount_cents, currency, occurred_on, created_by) values ($1,$2,1,'USD','2026-01-01',$3)",
      [w.B, w.E1, dual])), ["23503"]);
  });
  it("superuser-level insert with a mismatched workspace/entity is also rejected by the database itself", async () => {
    await denied(admin((c) => c.query(
      "insert into public.financial_records (workspace_id, entity_id, amount_cents, currency, occurred_on, created_by) values ($1,$2,1,'USD','2026-01-01',$3)",
      [w.B, w.E1, w.ownerB])), ["23503"]);
  });
});

describe("SEC-11 stale session: permissions come from live tables, not token claims", () => {
  it("removing a member takes effect on the very next request with the same identity", async () => {
    const temp = uuid();
    await asUser(w.owner, (c) => c.query("select public.grant_access($1,$2,'viewer',null)", [w.A, temp]).then(() => 0));
    expect(await count(temp, "select 1 from public.financial_records where workspace_id=$1", [w.A])).toBe(3);
    await asUser(w.owner, (c) => c.query("select public.revoke_member($1,$2)", [w.A, temp]).then(() => 0));
    expect(await count(temp, "select 1 from public.financial_records where workspace_id=$1", [w.A])).toBe(0);
    expect(await count(temp, "select 1 from public.workspaces where id=$1", [w.A])).toBe(0);
  });
  it("revoked, expired and not-yet-started grants all deny", async () => {
    const u = uuid();
    const g = await asUser(w.owner, async (c) => (await c.query("select public.grant_access($1,$2,'viewer',null) id", [w.A, u])).rows[0].id);
    expect(await count(u, "select 1 from public.financial_records where workspace_id=$1", [w.A])).toBe(3);
    await admin((c) => c.query("update public.access_grants set starts_at = now() + interval '1 day', expires_at = now() + interval '2 days' where id=$1", [g]));
    expect(await count(u, "select 1 from public.financial_records where workspace_id=$1", [w.A])).toBe(0);
    await admin((c) => c.query("update public.access_grants set starts_at = now() - interval '2 days', expires_at = now() - interval '1 day' where id=$1", [g]));
    expect(await count(u, "select 1 from public.financial_records where workspace_id=$1", [w.A])).toBe(0);
    await admin((c) => c.query("update public.access_grants set starts_at = now() - interval '1 day', expires_at = null where id=$1", [g]));
    expect(await count(u, "select 1 from public.financial_records where workspace_id=$1", [w.A])).toBe(3);
    await asUser(w.owner, (c) => c.query("select public.revoke_access($1)", [g]).then(() => 0));
    expect(await count(u, "select 1 from public.financial_records where workspace_id=$1", [w.A])).toBe(0);
  });
});

describe("SEC-14 privilege escalation", () => {
  it("accountant cannot grant any role (no assign_roles) and cannot self-promote", async () => {
    await denied(asUser(w.accountant, (c) => c.query("select public.grant_access($1,$2,'viewer',null)", [w.A, uuid()])));
    await denied(asUser(w.accountant, (c) => c.query("select public.grant_access($1,$2,'owner',null)", [w.A, w.accountant])));
  });
  it("a delegate can only hand out roles made of permissions the delegate already holds", async () => {
    await admin(async (c) => {
      await c.query("insert into public.role_definitions (code, name, is_system) values ('test_delegate','Delegate',false),('test_reader','Reader',false)");
      await c.query("insert into public.role_permissions values ('test_delegate','membership.assign_roles'),('test_delegate','legal_entity.read'),('test_reader','legal_entity.read')");
    });
    const delegate = uuid();
    await asUser(w.owner, (c) => c.query("select public.grant_access($1,$2,'test_delegate',null)", [w.A, delegate]).then(() => 0));
    await asUser(delegate, (c) => c.query("select public.grant_access($1,$2,'test_reader',null)", [w.A, uuid()]).then(() => 0)); // allowed
    await denied(asUser(delegate, (c) => c.query("select public.grant_access($1,$2,'viewer',null)", [w.A, uuid()])));  // viewer has financial_record.read
    await denied(asUser(delegate, (c) => c.query("select public.grant_access($1,$2,'owner',null)", [w.A, delegate])));
  });
  it("an entity-scoped holder cannot grant workspace-wide access", async () => {
    await admin(async (c) => {
      await c.query("insert into public.role_definitions (code, name, is_system) values ('test_entity_delegate','Entity delegate',false)");
      await c.query("insert into public.role_permissions values ('test_entity_delegate','membership.assign_roles'),('test_entity_delegate','legal_entity.read')");
    });
    const d = uuid();
    await asUser(w.owner, (c) => c.query("select public.grant_access($1,$2,'test_entity_delegate',$3)", [w.A, d, w.E1]).then(() => 0));
    await denied(asUser(d, (c) => c.query("select public.grant_access($1,$2,'test_reader',null)", [w.A, uuid()]))); // assign_roles only at entity scope -> denied
  });
  it("the last owner cannot be removed or locked out (fresh workspace, single owner)", async () => {
    const solo = uuid();
    const ws = await asUser(solo, async (c) => (await c.query("select public.create_workspace('Solo') id")).rows[0].id);
    const grantId = (await admin((c) => c.query(
      "select g.id from public.access_grants g join public.workspace_memberships m on m.id=g.membership_id where g.workspace_id=$1 and m.user_id=$2 and g.role_code='owner'", [ws, solo]))).rows[0].id;
    await denied(asUser(solo, (c) => c.query("select public.revoke_access($1)", [grantId])), ["23514"]);
    await denied(asUser(solo, (c) => c.query("select public.revoke_member($1,$2)", [ws, solo])), ["23514"]);
    // with a second owner, the first can step down (positive control)
    const second = uuid();
    await asUser(solo, (c) => c.query("select public.grant_access($1,$2,'owner',null)", [ws, second]).then(() => 0));
    await asUser(solo, (c) => c.query("select public.revoke_member($1,$2)", [ws, solo]).then(() => 0));
    expect(await count(solo, "select 1 from public.workspaces where id=$1", [ws])).toBe(0);
    expect(await count(second, "select 1 from public.workspaces where id=$1", [ws])).toBe(1);
  });
  it("granting to an entity in another workspace is rejected", async () => {
    await denied(asUser(w.owner, (c) => c.query("select public.grant_access($1,$2,'viewer',$3)", [w.A, uuid(), w.EB])), ["23503"]);
  });
});

describe("SEC-16 outsiders and anonymous callers", () => {
  it("an authenticated user with no membership sees nothing", async () => {
    for (const t of ["workspaces", "legal_entities", "financial_records", "workspace_memberships", "access_grants", "audit_events"]) {
      expect(await count(w.outsider, `select 1 from public.${t}`), t).toBe(0);
    }
  });
  it("the anon role has no access to any table or function", async () => {
    for (const t of ["workspaces", "legal_entities", "financial_records", "workspace_memberships", "access_grants", "audit_events", "role_definitions"]) {
      await denied(asUser(null, (c) => c.query(`select 1 from public.${t}`)));
    }
    await denied(asUser(null, (c) => c.query("select public.create_workspace('x')")));
  });
  it("a request with no user id cannot create a workspace", async () => {
    await denied(admin(async (c) => {
      await c.query("begin"); await c.query("set local role authenticated");
      try { await c.query("select public.create_workspace('x')"); } finally { await c.query("rollback"); }
    }));
  });
});

describe("audit log", () => {
  it("records tenancy changes and is readable only with audit.read", async () => {
    expect(await count(w.owner, "select 1 from public.audit_events where workspace_id=$1 and action='access.granted'", [w.A])).toBeGreaterThanOrEqual(2);
    expect(await count(w.accountant, "select 1 from public.audit_events where workspace_id=$1", [w.A])).toBe(0);
  });
  it("is append-only, even for the owner and even for a superuser", async () => {
    await denied(asUser(w.owner, (c) => c.query("update public.audit_events set action='x'")));
    await denied(asUser(w.owner, (c) => c.query("delete from public.audit_events")));
    await denied(asUser(w.owner, (c) => c.query("insert into public.audit_events (workspace_id, action) values ($1,'forged')", [w.A])));
    await denied(admin((c) => c.query("update public.audit_events set action='x'")));
    await denied(admin((c) => c.query("delete from public.audit_events")));
    await denied(admin((c) => c.query("truncate public.audit_events")));
  });
  it("details hold identifiers and codes only (no amounts or descriptions)", async () => {
    const rows = (await admin((c) => c.query("select details from public.audit_events"))).rows;
    for (const r of rows) expect(JSON.stringify(r.details)).not.toMatch(/amount|description|cents/i);
  });
});

describe("SEC-13 automated privilege inspection (release gate)", () => {
  it("every table in public has row level security enabled", async () => {
    const rows = (await admin((c) => c.query(
      "select relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and not c.relrowsecurity"))).rows;
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
  it("anon has no table privileges at all", async () => {
    const rows = (await admin((c) => c.query("select table_name, privilege_type from information_schema.role_table_grants where grantee='anon' and table_schema='public'"))).rows;
    expect(rows).toEqual([]);
  });
  it("authenticated never has DELETE, TRUNCATE, or write access to memberships, grants or audit", async () => {
    const rows = (await admin((c) => c.query(
      "select table_name, privilege_type from information_schema.role_table_grants where grantee='authenticated' and table_schema='public'"))).rows;
    expect(rows.filter((r) => ["DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"].includes(r.privilege_type))).toEqual([]);
    const writes = rows.filter((r) => ["INSERT", "UPDATE"].includes(r.privilege_type)).map((r) => r.table_name);
    for (const t of ["workspace_memberships", "access_grants", "audit_events", "role_permissions", "role_definitions", "permission_definitions"]) {
      expect(writes, t).not.toContain(t);
    }
  });
  it("every SECURITY DEFINER function pins an empty search_path and is not executable by anon/public", async () => {
    const rows = (await admin((c) => c.query(`
      select n.nspname || '.' || p.proname as fn, p.proconfig, has_function_privilege('anon', p.oid, 'execute') as anon_exec,
             has_function_privilege('public', p.oid, 'execute') as public_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and n.nspname in ('public','private')`))).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect((r.proconfig ?? []).some((x: string) => /^search_path=("")?$/.test(x)), r.fn).toBe(true);
      expect(r.anon_exec, r.fn).toBe(false);
      expect(r.public_exec, r.fn).toBe(false);
    }
  });
  it("the set of definer functions exposed in the public (API) schema is exactly the reviewed list", async () => {
    const rows = (await admin((c) => c.query(
      "select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.prosecdef and n.nspname='public' order by 1"))).rows;
    expect(rows.map((r) => r.proname)).toEqual(["create_workspace", "grant_access", "revoke_access", "revoke_member"]);
  });
  it("API roles cannot call internal private functions' schema objects beyond the reviewed helpers", async () => {
    await denied(asUser(w.owner, (c) => c.query("select private.other_active_owners($1,$2)", [w.A, uuid()])));
  });
});

describe("presets (P-8)", () => {
  it("exactly three presets are exposed in the UI; the schema supports more without migration", async () => {
    const rows = (await admin((c) => c.query("select code from public.role_definitions where exposed_in_ui order by code"))).rows;
    expect(rows.map((r) => r.code)).toEqual(["finance_accountant", "owner", "viewer"]);
  });
  it("owner holds every defined permission", async () => {
    const r = (await admin((c) => c.query(
      "select count(*)::int n from public.permission_definitions p where not exists (select 1 from public.role_permissions rp where rp.role_code='owner' and rp.permission_code=p.code)"))).rows[0];
    expect(r.n).toBe(0);
  });
});
