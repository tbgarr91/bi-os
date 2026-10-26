import { randomUUID } from "node:crypto";
import pg from "pg";

const config = () => ({ host: "127.0.0.1", port: Number(process.env.BIOS_TEST_PG_PORT), user: "postgres", password: "pw", database: "postgres" });
export const pool = new pg.Pool({ ...config(), max: 5 });
export const uuid = () => randomUUID();

/** Superuser access: for test SETUP only (like the hosted platform's service role). Never used for assertions about access. */
export async function admin<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { return await fn(c); } finally { c.release(); }
}

/** Run as the API role `authenticated` (or `anon` when userId is null) with a given user id, like a real request. */
export async function asUser<T>(userId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query(userId ? "set local role authenticated" : "set local role anon");
    await c.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? ""]);
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

export interface World {
  A: string; B: string;                       // workspace ids
  owner: string; accountant: string; viewer: string; outsider: string; ownerB: string;  // user ids
  E1: string; E2: string; EB: string;          // legal entities (E1,E2 in A; EB in B)
  rec1: string; rec2: string; recB: string;    // financial records
}

/** Builds two workspaces through the real RPCs and policies. All data is synthetic. */
export async function buildWorld(): Promise<World> {
  const w = { owner: uuid(), accountant: uuid(), viewer: uuid(), outsider: uuid(), ownerB: uuid() } as World;
  w.A = await asUser(w.owner, async (c) => (await c.query("select public.create_workspace('Synthetic A') id")).rows[0].id);
  w.B = await asUser(w.ownerB, async (c) => (await c.query("select public.create_workspace('Synthetic B') id")).rows[0].id);
  const mkEntity = (user: string, ws: string, name: string) =>
    asUser(user, async (c) => (await c.query("insert into public.legal_entities (workspace_id, name) values ($1,$2) returning id", [ws, name])).rows[0].id as string);
  w.E1 = await mkEntity(w.owner, w.A, "Entity One");
  w.E2 = await mkEntity(w.owner, w.A, "Entity Two");
  w.EB = await mkEntity(w.ownerB, w.B, "Entity B");
  const mkRec = (user: string, ws: string, entity: string, cents: number) =>
    asUser(user, async (c) => (await c.query(
      "insert into public.financial_records (workspace_id, entity_id, amount_cents, currency, occurred_on, created_by) values ($1,$2,$3,'USD','2026-01-15',$4) returning id",
      [ws, entity, cents, user])).rows[0].id as string);
  w.rec1 = await mkRec(w.owner, w.A, w.E1, 5099);
  w.rec2 = await mkRec(w.owner, w.A, w.E2, 2266);
  w.recB = await mkRec(w.ownerB, w.B, w.EB, 100000);
  const grant = (caller: string, ws: string, user: string, role: string, entity: string | null) =>
    asUser(caller, async (c) => (await c.query("select public.grant_access($1,$2,$3,$4) id", [ws, user, role, entity])).rows[0].id as string);
  await grant(w.owner, w.A, w.accountant, "finance_accountant", w.E1); // accountant: entity One only
  await grant(w.owner, w.A, w.viewer, "viewer", null);                  // viewer: workspace-wide read
  return w;
}

/** Assert a statement is refused by the database (privilege, policy, constraint or guard), not merely empty. */
export async function denied(p: Promise<unknown>, codes: string[] = ["42501", "23503", "23514", "P0001", "22023"]) {
  let err: unknown;
  try { await p; } catch (e) { err = e; }
  if (!err) throw new Error("expected the database to refuse this, but it succeeded");
  const code = (err as { code?: string }).code ?? "";
  if (!codes.includes(code)) throw new Error(`refused with unexpected code ${code}: ${(err as Error).message}`);
}
