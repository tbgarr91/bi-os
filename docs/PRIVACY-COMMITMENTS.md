# Privacy-by-design commitments (from Phase 1 plan, file 31 section 3)

1. Separate development and production environments (P-9). No real business data in development; synthetic fixtures only.
2. Data minimization (P-6): Shopify Level 1 only. No customer name, email, phone or address. Customer ID, if kept, stored as a keyed hash (pending Level 1 verification).
3. Secrets: provider tokens encrypted at the application layer; keys in the host secret store; never in code, logs or chat; secret scanning on every commit.
4. No sensitive payloads in logs or error reports; audit events record who/what/when, not raw amounts or documents.
5. Row isolation by workspace on every customer table (RLS, GRANTs, composite foreign keys) with positive and negative tests against a real database.
6. Workspace export and full deletion (including source files and derived metrics) built and tested.
7. No third-party sharing, no model training on user data.
8. Claude's access to real data only with the founder's explicit approval; verification from exports the founder provides.
9. Encrypted backups with a restore test before any real data enters production.
10. Plain-language data statement before any outside user (Phase 2 gate).

Status: commitments only. Nothing here is implemented beyond the repository guards (no-real-data fixtures test, git-ignore rules, secret scanning in CI).
