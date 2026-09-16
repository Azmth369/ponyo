# Clash of Clans Discord AI Bot

A production-oriented Discord assistant combining **Clash of Clans API data, a dedicated Supabase database, targeted retrieval, deterministic analytics, and two AI providers**.

## Commands

- `/ask` → **Sarvam AI** for the normal, faster everyday clan analysis path.
- `/tell` → **Gemini** for the deeper Gemini analysis path.

Both commands use the same database retrieval and analytics layer, so they answer from the same Clash of Clans data rather than from unrelated general knowledge.

## Architecture

```text
Clash of Clans API
        │
        ▼
 Sync scheduler ──────► Dedicated Supabase
  (server-side key)       │
                          │
                          ├── read-only AI retrieval
                          │       ▼
                          │   Sarvam / Gemini
                          │       ▼
                          │    Discord
                          │
                          └── backend-only AI state
                              (pagination + short memory)
```

This project is independent of the existing CoC watcher database. All secrets remain server-side. The AI retrieval layer uses the anonymous/read-only key for CoC data, while the combined Render runtime also uses the service-role key for the backend-only `ai_answers` and `ai_conversations` tables so Discord state survives restarts.

## Features

### Data collection
- Clan/member data
- Current war polling
- War-log history
- Normalized war members and attacks
- CWL seasons, rounds, individual CWL wars, members and attacks
- Capital raid seasons
- Player snapshots for historical trends
- Sync status/error logging
- Configurable polling intervals
- One-time importer for legacy attack-log exports

### AI retrieval
Questions are classified before retrieval so the model receives relevant data instead of an uncontrolled database dump.

Examples:

```text
/ask question:"who has the lowest donations?"
/ask question:"who didn't attack in the current war?"
/ask question:"how are we doing in the current war?"
/tell question:"summarize our wars against Dark Land"
/tell question:"show me the attacks from our war against XYZ"
/ask question:"what happened in March 2026?"
```

Retrieval follows the intended safe-expansion strategy:

1. Match the question to a data domain.
2. Retrieve the narrowest useful context.
3. If a named opponent search returns nothing, expand to recent war history.
4. Give the selected context to the requested AI provider.
5. The provider must never invent missing statistics, attacks, dates, opponents or outcomes.

### Two AI providers

`/ask` uses Sarvam's OpenAI-compatible Chat Completions API and defaults to `sarvam-105b`, with `SARVAM_MODEL` available to override it.

`/tell` uses the Gemini REST API with the existing model fallback/retry chain. `GEMINI_MODEL` controls the preferred Gemini model.

### AI provider failure alerts

The bot can send detailed, private provider failure alerts to a dedicated Discord channel by setting `PONYO_ALERT_CHANNEL_ID` to that channel's ID.

Provider errors are classified separately for:

- Context-window/token-size failures
- Quota/rate-limit failures
- API-key/authentication failures
- Temporary provider/API failures
- Unknown provider failures

Users receive a short safe message with the recommended alternative (`/tell` for Gemini) instead of the raw provider response. The private Ponyo alert contains diagnostic details such as HTTP status, error body, command, user/channel context, question, and failure timing. Do not expose that alert channel to ordinary members.

### Deterministic analytics
The application calculates evidence such as missed attacks and player trends in code before AI interpretation. This reduces hallucination risk for straightforward numerical questions.

### Persistent long-answer controls
Long AI responses are split into Discord-safe chunks. Instead of the old **Previous/Next** pagination and custom forwarding button, the response now uses **See more** and **See less** controls. Only the user who asked the question can expand or collapse that answer.

Pagination state is not dependent on an in-memory collector. The full answer is stored in the backend-only `ai_answers` table for 30 days, so the buttons can continue working after a Render restart or redeploy. The button `custom_id` also carries the current page, so navigation itself does not depend on process memory.

The previous one-hour AI conversation memory is also stored in the backend-only `ai_conversations` table. This means a normal follow-up can survive a Render restart as long as it is still inside the one-hour context window.

For sharing an answer to another Discord channel, use Discord's built-in message forwarding feature.

## Legacy attack-log import

If you have an older `attack_log` CSV export, do **not** upload the raw CSV into GitHub or commit it to the repository because it can contain player names and tags.

The repository includes a one-time importer that converts the old mixed format into the current split schema:

- `context=capital` → `capital_attacks` plus a lightweight `capital_raids` event record
- `context=war` → `war_attacks` plus a lightweight `wars` event record
- Existing rows are safely upserted using the same conflict keys as the live sync, so running the importer again does not intentionally create duplicate attack rows.
- Missing fields such as historical attack timestamps, war results, or Capital summary totals are left unknown rather than invented.

Run it from the project environment after placing the CSV somewhere accessible to that environment:

```bash
npm run import:legacy -- /path/to/attack_log_rows.csv
```

The importer uses `SUPABASE_SERVICE_ROLE_KEY`, so run it only in the trusted server environment. Never expose that key to users or client-side code.

## Environment

Configure:

- `COC_API_TOKEN`
- `COC_CLAN_TAG`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — server-side only; required by the sync scheduler and backend AI-state persistence
- `SUPABASE_ANON_KEY` — AI/Discord read-only access to the CoC data tables
- `DISCORD_TOKEN`
- `DISCORD_CLIENT_ID`
- optional `DISCORD_GUILD_ID` for instant guild command registration
- optional `PONYO_ALERT_CHANNEL_ID` — private Discord channel for detailed AI provider/quota/API failure alerts
- `SARVAM_API_KEY` — required for `/ask`
- optional `SARVAM_MODEL` (defaults to `sarvam-105b`)
- `GEMINI_API_KEY` — required for `/tell`
- optional `GEMINI_MODEL`

Never commit secrets or raw player data exports.

## Supabase setup

Create a **separate Supabase project** for this bot and run `supabase/schema.sql` in its SQL editor.

The CoC data tables use RLS with `anon` SELECT policies for the AI retrieval layer. The `ai_answers` and `ai_conversations` tables are backend-only and have no `anon` access. The Render runtime uses the server-side service-role key for those two state tables; that key must never be exposed to Discord users, browser code, or the repository.

## Render + UptimeRobot

The runtime exposes a lightweight `/health` endpoint on `PORT` (default `3000`). Point UptimeRobot at the Render service's `/health` URL.

UptimeRobot is useful for external monitoring and, on plans where an HTTP request wakes an idle service, can also keep a Render web service receiving traffic. It does **not** replace persistent storage: Render's service filesystem is ephemeral across deploys, while the AI state is intentionally stored in Supabase.

## Run locally

```bash
npm install
npm start
```

`npm start` launches both the Discord bot and sync scheduler. A lightweight HTTP health endpoint is available at `/health` on `PORT` (default `3000`).

Run only the sync scheduler:

```bash
npm run sync
```

Run one complete sync pass:

```bash
npm run sync:once
```

## Security model

```text
CoC API token ──► server runtime ──write──► Supabase
                       │                    │
                       │                    ├── CoC data ← anon read-only AI client
                       │                    │
                       └── backend-only AI state ← service-role key
                                                    │
                                                  Discord
```

The service-role key is a server-side secret. It is not sent to Discord clients or exposed in bot responses.
