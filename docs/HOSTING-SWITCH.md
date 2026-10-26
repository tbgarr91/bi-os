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
