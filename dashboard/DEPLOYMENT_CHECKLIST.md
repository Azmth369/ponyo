# Phase 6 — Controlled Rollout Checklist

This checklist prepares the Ponyo Control Panel for a controlled launch. It is a readiness document, **not authorization to merge, deploy, change Render configuration, or run SQL against production**.

## 1. Current release gate

Before any live rollout, verify all of the following from the current PR head:

- [ ] Pull request #6 is reviewed and remains unmerged until the owner approves.
- [ ] Required GitHub Actions checks pass on the exact head commit.
- [ ] The migration sequence below has been reviewed against the target database.
- [ ] The target Supabase project and owner email have been confirmed privately in the provider consoles.
- [ ] A separate Render dashboard service is planned; the existing Ponyo service will not be replaced.
- [ ] No secret is included in a commit, issue, PR comment, screenshot, or chat.
- [ ] The owner explicitly approves each production change before it is made.

**Stop/go rule:** any failed check, unexpected API response, uncertain migration state, ambiguous Discord send outcome, or mismatch in owner configuration means **STOP**. Do not retry report publication to “see if it works.”

## 2. Pre-deployment verification

### Code and CI

- [ ] Confirm the PR head SHA matches the commit whose workflow run is green.
- [ ] Confirm syntax checks, the complete Node test suite, and PostgreSQL migration/safety smoke tests pass.
- [ ] Review the final PR diff and migration SQL; do not rely on an earlier green run if the head has changed.
- [ ] Keep PR #6 in draft until review and release approval are complete.

### Database prerequisites

Check migration history in the intended Supabase project before running anything. Do not infer that a migration is applied just because a table exists.

Apply only after explicit owner approval, in this order:

1. `supabase/migrations/20261018030000_event_report_publications.sql` — existing report publication ledger prerequisite.
2. `supabase/migrations/20261018_dashboard_control_panel.sql` — dashboard access/audit tables and shared sync lock.
3. `supabase/migrations/20261018120000_dashboard_report_management.sql` — report pause/retry controls.

Prefer a staging Supabase project or disposable PostgreSQL first. The CI smoke tests use disposable PostgreSQL and do not validate or modify production. Do not run migrations against the production project during this preparation phase.

### Render service isolation

Create a **new** Web Service only after explicit deployment approval:

- Repository: `Azmth369/ponyo`
- Root directory: `dashboard`
- Runtime: Node.js 22+
- Build command: `npm install`
- Start command: `npm start`
- Health path: `/health`

Configure dashboard environment variables in Render's private environment settings, never in Git or chat:

- `NODE_ENV=production`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `DASHBOARD_OWNER_EMAIL`
- `PONYO_API_URL`
- `PONYO_API_KEY`
- `PONYO_CONTROL_API_KEY`

The existing Ponyo backend also needs `DASHBOARD_OWNER_EMAIL` and the same separate `PONYO_CONTROL_API_KEY`. Use a newly generated random control key of at least 32 characters; do not reuse `PONYO_API_KEY`. Keep the Supabase service-role key off the dashboard service. Do not modify existing service variables until approved and a rollback plan is ready.

## 3. Smoke-test sequence

Use a staging environment with test accounts and test data whenever possible.

1. **Health and headers:** `GET /health` returns healthy; production HTTPS responses include HSTS and the expected security headers.
2. **Unauthenticated behavior:** dashboard data and control routes are not accessible without a valid session.
3. **Owner identity:** only the configured owner email receives owner controls; verify casing/whitespace normalization and owner protection.
4. **Viewer:** an approved viewer can read permitted dashboard information but cannot grant/revoke access, start syncs, or change reports.
5. **Permission separation:** a user with only `sync.run` cannot manage reports; a user with only `reports.manage` cannot start syncs.
6. **Revocation:** revoke a test user's access and verify subsequent requests are denied.
7. **Sync lock:** verify competing sync requests return a safe busy/conflict response; confirm lock cleanup after both success and failure.
8. **Report controls:** on a clearly identified test event only, verify pause blocks future attempts and retry is available only for enabled failed reports with no publication timestamp or Discord message ID.
9. **Audit trail:** verify access changes, sync attempts, and report actions produce the expected audit records.
10. **Existing bot:** verify the original Ponyo service remains healthy and its normal scheduled work continues.

Never test report retry against a real production Discord event. If a send may have succeeded but its response was lost, inspect Discord and the publication ledger before considering any manual action.

## 4. Go-live gates

Do not proceed until the owner explicitly approves each relevant gate:

- [ ] **Gate A — Review:** final code diff and CI reviewed.
- [ ] **Gate B — Database:** target project and migration state confirmed; production migration explicitly approved.
- [ ] **Gate C — Configuration:** owner email and control key configured consistently in private provider settings.
- [ ] **Gate D — Deployment:** new dashboard service deployment explicitly approved.
- [ ] **Gate E — Smoke tests:** auth, permissions, locks, report safety, and existing bot health verified.
- [ ] **Gate F — Launch:** owner confirms whether to enable control permissions for real users.

Do not grant `sync.run` or `reports.manage` by default. Start with view-only access and grant each extra permission deliberately.

## 5. Rollback and incident response

- If dashboard health or authorization checks fail, suspend the **dashboard service only** first; do not replace, redeploy, or stop the existing bot as an automatic rollback.
- If control calls behave unexpectedly, disable dashboard control capability through the private service configuration and investigate. Do not rotate or remove the existing `PONYO_API_KEY` as a rollback step.
- Preserve additive database tables and audit history. Do not drop migrations or tables as an improvised rollback.
- For an ambiguous Discord send, stop retries, inspect Discord and the publication ledger, and resolve the state before further action.
- Record the failed check, timestamp, affected service, and last known good commit without recording secrets.

## 6. Current status

Phase 6 preparation is documentation and verification only. Until the owner explicitly approves the relevant actions, the PR remains a draft, no production migration is run, no Render service is created or deployed, and the existing Ponyo service and production configuration remain unchanged.
