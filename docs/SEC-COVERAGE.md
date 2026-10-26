# Security test coverage (M1)

Tests live in `packages/db/test/security.test.ts` (tenancy and authorization) and `packages/db/test/evidence.test.ts` (M2 evidence layer) and run against a **real PostgreSQL** (system binaries, throwaway cluster, synthetic data only) as the `anon` and `authenticated` API roles. Supabase's Auth and roles are stood in by `test/shim-supabase.sql`. The shim is a test double: behaviour on a hosted Supabase project is **not yet verified** (no project exists; gate A3 is on hold).

Run: `pnpm --filter @bi-os/db test` (needs PostgreSQL server binaries; set `BIOS_PG_BIN` or install `postgresql`. GitHub's Ubuntu runners include it).

| ID (file 17 §11) | Status | Where |
|---|---|---|
| SEC-01 cross-workspace guessing | Implemented | "SEC-01" |
| SEC-02/03 entity-scoped access | Implemented | "SEC-02/03" |
| SEC-04 role without finance scope | Implemented | "SEC-04" |
| SEC-07 workspace id tampering | Implemented | "SEC-07/08" |
| SEC-08 cross-workspace reference | Implemented (composite foreign keys) | "SEC-07/08" |
| SEC-11 stale session / revoked / expired grants | Implemented (live table checks) | "SEC-11" |
| SEC-13 privilege inspection | Implemented (RLS on, anon has no grants, definer functions pinned, reviewed function list) | "SEC-13" |
| SEC-14 escalation, last owner | Implemented | "SEC-14" |
| SEC-16 outsiders, anon | Implemented | "SEC-16" |
| Audit append-only | Implemented | "audit log" |
| SEC-05, 06, 09, 10, 12, 15, 17-20 | **Not yet implemented** (need features not built: storage, connectors, exports, jobs) | n/a |

Mutation check done once by hand: removing `enable row level security` on `financial_records` makes many tests fail.

## M2 evidence layer (`evidence.test.ts`, 18 tests)
Entity-scoped read and import (accountant on entity One cannot see or write entity Two; viewer and outsiders see nothing); cross-workspace and cross-entity composite foreign keys; append-only evidence for every role including superuser; API roles hold only SELECT and INSERT; same identity plus content stored once (idempotent re-import); a changed row is a new superseding version and forks are refused; unknown amount stays NULL and an amount without a currency is refused; short data-quality messages. Core (`packages/core`, 40 tests): exact amount parsing, mapping, reconciliation of fixtures A, C, D, missing-is-never-zero cases, privacy of issue messages, row minimization (only mapped columns are stored).

Mutation check: switching row level security off on `commerce_facts` fails 5 tests.
Strengthened in M2: privilege inspection now also covers column-level grants (they are not listed in `role_table_grants`).
