# BI OS repository rules (read first)

Authority: the founder's decisions in the Claude Project "Business Intel. OS" (file 09 decision register, file 31 Phase 1 plan). Do not contradict them. Mark nothing Approved that the founder has not approved. Formulas are `CANDIDATE_UNAPPROVED` until the founder signs them off.

## Hard rules
1. **No real data, ever, in this repository**: no real orders, customer data, exports, screenshots, tokens, keys or `.env` values. Fixtures must be synthetic and flagged `"synthetic": true`. `private-data/` is git-ignored; real exports stay outside the repo.
2. **Privacy first**: Shopify Level 1 data only (no customer name, email, phone, address; ZIP excluded). No personal data in logs or error messages. Secrets only through the host interface (`packages/host`).
3. **Numbers**: integer cents with explicit currency. Missing data is never zero. Never sum an order, its payment and its payout as separate sales. Supplier-listed spread is an estimate and never labelled profit. "Profit" only with complete coverage.
4. **Host independence**: no Cloudflare- or Vercel-specific imports outside `packages/host/src/adapters` and `apps/web` config. Core logic stays plain TypeScript.
5. **Approval gates**: do not create cloud projects, provider apps, API keys or accounts, and do not connect to any live store or database, without the founder's explicit approval in the conversation (see file 31 section 6).
6. **Tests**: every change keeps `pnpm check` green. Security rules need positive and negative tests against a real database once one exists.
7. **Commit messages** end with the attribution lines required by the session.
