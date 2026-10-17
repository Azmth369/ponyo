# Ponyo Control Panel — Phase 1–2

A separate, read-only Node.js dashboard for the existing Ponyo service. It is intended to deploy as a separate Render web service so dashboard releases do not replace the existing bot process.

## Current scope

- Supabase Auth password sign-in
- Server-side owner/admin email allowlist
- HTTP-only, SameSite=Lax session cookie; Secure cookie in production
- Login attempt throttling and same-origin checks for login/logout
- Server-side proxy to Ponyo's existing bearer-key API
- Read-only overview, sync run history, report ledger, clan summary/activity, current war, CWL and Capital Raid history
- Responsive desktop/mobile UI
- No management mutations, report retries, sync triggers, or admin-invite controls in this phase

## Render setup

Create a **new Web Service** for this repository. Do not change the existing Ponyo bot service.

- Repository: Azmth369/ponyo
- Branch: feature/control-panel-phase-1-2 for review/testing; switch to main after the pull request is approved and merged
- Root Directory: dashboard
- Runtime: Node
- Build Command: npm install
- Start Command: npm start
- Health Check Path: /health
- Node version: 22 or newer

Set these environment variables on the **dashboard service only**:

| Variable | Value |
| --- | --- |
| NODE_ENV | production |
| SUPABASE_URL | Existing Supabase project URL |
| SUPABASE_ANON_KEY | Supabase publishable/anon key for the same project |
| DASHBOARD_OWNER_EMAIL | Email address for the owner account |
| DASHBOARD_ADMIN_EMAILS | Comma-separated emails approved as clan admins |
| PONYO_API_URL | https://ponyo-v845.onrender.com |
| PONYO_API_KEY | Same server-side API key configured on the existing Ponyo service |

Never use the Supabase service-role key in the dashboard. The anon key is used only for Supabase Auth calls from the server; it is not sent to browser code. Never commit real credentials or put the Ponyo API key in a browser-exposed variable.

## Supabase Auth prerequisites

1. Enable Email/Password sign-in in Supabase Auth.
2. Create the owner account and selected clan-admin accounts in Supabase Auth.
3. Add only approved account emails to the dashboard service allowlist.
4. Configure email confirmation/password reset according to your Supabase Auth settings.
5. Users not in the allowlist are denied even if they have a valid Supabase account.

This initial phase uses an environment allowlist rather than a self-service admin-management screen. Change the allowlist and redeploy when administrators change. A database-backed role manager and audit trail are later-phase work.

## Read-only Ponyo API dependency

The dashboard expects the existing Ponyo API's bearer-key-protected endpoints, including /api/v1/operations/summary. That operational summary endpoint is added in the same feature branch and only reads existing sync/report tables.

Dashboard data is fetched server-to-server. The browser only calls same-origin /api/* endpoints. API keys and Supabase access tokens are not returned to browser code.

## Local smoke test

From this directory:

1. Run npm run check.
2. Set the environment variables above in your local environment (do not commit a .env file).
3. Run npm start.
4. Open http://localhost:10000/health, then http://localhost:10000.

Use HTTPS when testing production cookie behavior. No production service should be deployed until the pull request has been reviewed and the required Render/Auth configuration is ready.

## Known limitations

- All views are read-only.
- Session lifetime is capped at one hour; sign in again when it expires.
- Operational status depends on the existing bot service and recorded data.
- Some historical CoC data may be incomplete; missing values are shown as unavailable instead of fabricated.
- No Render management credentials are used or exposed.
