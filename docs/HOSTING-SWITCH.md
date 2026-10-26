# Hosting: Cloudflare now, Vercel kept open

Decision (founder, 2026-10-25): host on Cloudflare; keep a clean path to Vercel.

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

## Steps to switch the live deployment from Cloudflare to Vercel
1. Create the Vercel project from this repository, root `apps/web`.
2. Copy environment variable names from the host secret store (values via the provider's secret UI, never via chat).
3. Select the `vercel` adapter via `BIOS_HOST=vercel`.
4. Point DNS, verify, then retire the Cloudflare deployment.
(Details to be confirmed in M0 once the web app exists.)

## M0 results (2026-10-25, verified locally)
- `next build` (Vercel path) succeeds for `apps/web`.
- OpenNext for Cloudflare build (`pnpm --filter @bi-os/web build:cloudflare`) succeeds and produces `.open-next/worker.js`.
- In the local Workers runtime (workerd, via `pnpm --filter @bi-os/runtime-compat compat`), these parsers ran correctly on synthetic data: `papaparse` (CSV), `read-excel-file` (XLSX, web-worker build), `exceljs` (XLSX).
- **Not yet verified:** behaviour on large files (memory and CPU limits), and on the deployed Cloudflare edge rather than locally. Heavy imports therefore stay behind the job interface; a Node import worker remains the fallback.
- The wrangler dev server logs a harmless blocked call to workers.cloudflare.com in this sandbox.
