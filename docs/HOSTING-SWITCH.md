# Hosting: Vercel primary, Cloudflare secondary

Decision (founder, 2026-10-25, revised): **Vercel is the primary host; Cloudflare is the secondary.** An earlier same-day decision chose Cloudflare first; it was reversed after the founder found his earlier limit concern was Supabase, not Vercel. Both adapters stay built, tested and in CI so either can be the deployment. Nothing is deployed yet.

## Rules that keep the switch cheap
1. Business logic lives in `packages/core` with no host-specific imports.
2. All host capabilities (secrets, job dispatch) go through the interface in `packages/host`. Adapters: `cloudflare`, `vercel`.
3. Heavy work (imports, backfills) sits behind the job interface so it can run in a Cloudflare job runtime, a Node worker, or a Vercel runner.
4. Database and auth are independent of the host (managed Postgres), so no data migration is needed to switch.
5. Parsers are chosen and tested for Workers compatibility. If a needed library does not run there, imports move to a small Node worker container for that job only.

## Switch test (must pass before Milestone M1)
- `pnpm --filter @bi-os/web build:vercel` (plain `next build`) succeeds.
- `pnpm --filter @bi-os/web build:cloudflare` (OpenNext for Cloudflare) succeeds.
- `pnpm --filter @bi-os/host test` passes for both adapters.

## Steps to switch the live deployment between hosts (either direction)
1. Create the project on the other host from this repository, root `apps/web` (Vercel: framework Next.js; Cloudflare: `build:cloudflare`).
2. Copy environment variable names (not values) from one host's secret store; enter values through the provider's secret UI, never via chat.
3. Select the adapter with `BIOS_HOST=vercel` or `BIOS_HOST=cloudflare`.
4. Point DNS, verify, then retire the old deployment.

## Vercel-specific note
Serverless functions have time limits (the founder's TBG.OS hit a 300-second ceiling). Long imports and backfills must run as chunked, resumable jobs behind the job interface (a queue or workflow service chosen in M2), never as one long request.

## M0 results (2026-10-25, verified locally)
- `next build` (Vercel path) succeeds for `apps/web`.
- OpenNext for Cloudflare build (`pnpm --filter @bi-os/web build:cloudflare`) succeeds and produces `.open-next/worker.js`.
- In the local Workers runtime (workerd, via `pnpm --filter @bi-os/runtime-compat compat`), these parsers ran correctly on synthetic data: `papaparse` (CSV), `read-excel-file` (XLSX, web-worker build), `exceljs` (XLSX).
- **Not yet verified:** behaviour on large files (memory and CPU limits), and on the deployed Cloudflare edge rather than locally. Heavy imports therefore stay behind the job interface; a Node import worker remains the fallback.
- The wrangler dev server logs a harmless blocked call to workers.cloudflare.com in this sandbox.
