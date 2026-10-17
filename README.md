# Ponyo — Clash of Clans Discord AI Bot

A production-oriented Discord assistant combining **Clash of Clans API data, a dedicated Supabase database, the Ponyo UID system, deterministic analytics, and two AI providers** (Sarvam for `/ask`, Gemini for `/tell`).

## Commands

- `/ask` → Sarvam AI for fast everyday clan analysis.
- `/tell` → Gemini for deeper analysis.

Factual questions are answered deterministically when possible, so the bot does not invent clan-specific counts.

## Automatic event reports

Ponyo can automatically publish final Normal Clan War and Capital Raid Weekend reports to your Discord `#data-report` channel.

- Tracks events while their recorded end time is still in the future.
- Waits for a configurable settling delay, then refreshes final war-log / raid data.
- Uses deterministic formatting and alphabetically sorted player lists.
- Uses a Supabase publication ledger and Discord nonce to prevent duplicate reports.
- Retries when final participant or attack data is incomplete.
- All report dates are displayed in IST (`DD/MM/YYYY`).

### Setup

1. Apply `supabase/migrations/20261018030000_event_report_publications.sql` in the Supabase SQL Editor.
2. In Render, add `PONYO_DATA_REPORT_CHANNEL_ID` with the numeric ID of your Discord `#data-report` channel. The bot needs permission to view the channel and send messages.
3. Ensure `DISCORD_TOKEN`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY` are configured as they are for the existing bot.
4. Set `ENABLE_EVENT_REPORTS=true`, `REPORT_POLL_MS=60000`, `PONYO_REPORT_SETTLE_DELAY_MS=120000`, and `PONYO_REPORT_ROSTER_SIZE=44` in Render.
5. Deploy the `feature/automatic-event-reports` branch after reviewing the pull request.

Reports are generated from saved API-backed rows, not from an AI-generated guess. If the service was not running while an event was active, that event may not have an active tracking record and may not be auto-reported; existing historical records are not automatically bulk-posted.

## Architecture and data

- Clan/member data and snapshots in Supabase.
- Normal Clan War sessions, participants, and attack log.
- CWL seasons, daywise attacks, participants, and attack log.
- Capital Raid seasons, participants, and attack log.
- Sync status and backend-only AI conversation state.
- Configurable polling intervals and per-job enable flags.

## Testing

```bash
npm test
```

The event report formatter has unit tests for alphabetical sorting, attack counts, participation percentage, destruction tiebreaks, and incomplete data.

## Requirements

- Node.js >= 22.
- Apply the base schema in `supabase/ponyo_schema.sql` and the required migrations.
- Environment variables are documented in `env.example`.
