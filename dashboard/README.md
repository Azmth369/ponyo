# Ponyo Control Panel — Phases 1–5

A separate Node.js dashboard for the existing Ponyo service. Deploy it as a **new Render web service**; never replace or modify the existing bot service as part of dashboard deployment.

## Current scope

- Supabase Auth email/password sign-in and server-side session verification
- Owner-managed allowlist and permissions; all non-owner accounts are view-only by default
- Responsive overview, sync health, Discord report history, clan analytics, and war/CWL/Capital Raid history
- Owner-only access grants/revocation and audit log
- Explicitly confirmed full-sync action, protected by a separate control API key and a shared database lock
- Phase 4 per-report pause/enable controls and manual retry for eligible failed reports, guarded by the `reports.manage` permission
- Phase 5 security hardening: bounded IP-and-account login throttling, safe malformed-cookie handling, production HSTS, restrictive CSP, and additional browser security headers

## Render setup

Create a **new Web Service** from this repository.

- Repository: `Azmth369/ponyo`
- Branch for review/testing: `feature/control-panel-phase-1-2`; use `main` only after the PR is approved and merged
- Root Directory: `dashboard`
- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Health Check Path: `/health`
- Node version: 22 or newer

### Dashboard service environment

Configure these on the **new dashboard service**:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `SUPABASE_URL` | URL of the existing Ponyo Supabase project |
| `SUPABASE_ANON_KEY` | Publishable/anon key for the same project |
| `DASHBOARD_OWNER_EMAIL` | The sole owner's Supabase Auth email |
| `PONYO_API_URL` | `https://ponyo-v845.onrender.com` |
| `PONYO_API_KEY` | Existing Ponyo server API key |
| `PONYO_CONTROL_API_KEY` | A separate random secret of at least 32 characters |

### Existing Ponyo service environment

The existing Ponyo backend must also have:

- `DASHBOARD_OWNER_EMAIL`: exactly the same owner email as the dashboard
- `PONYO_CONTROL_API_KEY`: exactly the same separate control key configured on the dashboard

Keep the existing `PONYO_API_KEY` unchanged. Do not reuse it as the control key. Do not paste secrets into chat or commit them to GitHub.

## Supabase migration and accounts

Before enabling dashboard controls, ensure `supabase/migrations/20261018030000_event_report_publications.sql` has been applied (the existing report scheduler already depends on this ledger). Apply `supabase/migrations/20261018_dashboard_control_panel.sql`, then `supabase/migrations/20261018120000_dashboard_report_management.sql` to the existing Ponyo Supabase project. The control endpoints fail closed if required tables/RPC functions are missing.

1. Enable Email/Password sign-in in Supabase Auth.
2. Create the owner account and any intended viewer accounts in Supabase Auth.
3. Set `DASHBOARD_OWNER_EMAIL` on both services to the owner's email.
4. The owner signs in and adds other users in **Access management**. Leave “Allow running full syncs” unchecked for view-only access.
5. Test access grant/revocation and sync locking before production use.

The owner is identified by `DASHBOARD_OWNER_EMAIL` and cannot be revoked through the access UI. Other accounts need an active access record. Available non-owner permissions are `sync.run` and `reports.manage`; leave both unchecked for view-only access.

Never configure the Supabase service-role key on the dashboard service. The anon key is used server-side for Auth requests and is not sent to browser code. API keys and access tokens must remain server-side.

## Local checks and automated validation

From the repository root, run `npm test`; this includes the dashboard authorization integration tests alongside the existing Ponyo tests. Run `npm --prefix dashboard run check` for dashboard syntax checks.

The GitHub Actions workflow also starts a disposable PostgreSQL 16 instance, applies the dashboard migration, and runs `supabase/tests/dashboard_control_panel_smoke.sql` to check grant/revoke audit behavior, atomic rollback when audit logging fails, and lock ownership/concurrency. These tests do not connect to or modify production Supabase.

For a local dashboard smoke test:

1. Set required environment variables in your local environment; do not commit a `.env` file.
2. Run `npm start` from this directory.
3. Check `http://localhost:10000/health`, then `http://localhost:10000`.

## Safety boundaries and limitations

- The dashboard must be deployed as a separate service.
- Apply the migration and configure both services before testing control features.
- Full sync can make multiple game API requests; it does not publish Discord reports.
- A report retry is allowed only for an explicitly failed report that is enabled and has no recorded publication/message ID. Published reports are not retryable.
- Failed report sends stop automatic retries and require a permitted user to request a manual retry. The stable Discord nonce and `enforce_nonce` remain enabled to mitigate duplicate posts after ambiguous network outcomes.
- Pausing a report prevents future scheduler attempts but cannot cancel a Discord request already in progress. Reports waiting for data are shown separately and are checked again by the scheduler.
- Session lifetime is capped at one hour.
- Historical data may be incomplete; missing values should be shown as unavailable rather than fabricated.
- No Render management credentials are used or exposed.

The PR remains a draft until reviewed. Do not merge, migrate production data, or deploy until the owner explicitly approves those steps.
