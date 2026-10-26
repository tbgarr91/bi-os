# bi-os

Business Intelligence OS. Private repository. Planning documents and decisions live in the "Business Intel. OS" Claude Project (decision register `09`, Phase 1 plan `31`). This repository holds code only.

**Status: Milestone M0 (skeleton).** No database, no provider connections, no real data. Everything here uses synthetic fixtures.

## Layout
- `packages/core` – domain logic, host-independent (money in integer cents, later: metric engine, authorization, connectors).
- `packages/fixtures` – synthetic golden fixtures (the only data allowed in this repository).
- `packages/host` – the single interface to hosting (secrets, jobs), with Vercel (primary) and Cloudflare (secondary) adapters. See `docs/HOSTING-SWITCH.md`.
- `apps/web` – the web application (Next.js).

## Commands
`pnpm install`, `pnpm check` (typecheck + tests).

## Rules (also in `CLAUDE.md` and `docs/PRIVACY-COMMITMENTS.md`)
No real business data, no secrets, no customer personal data in this repository. Money is integer cents; missing data is never zero.
