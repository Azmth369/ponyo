# Ponyo — Clash of Clans Discord AI Bot

A production-oriented Discord assistant combining **Clash of Clans API data, a dedicated Supabase database, the Ponyo UID system, deterministic analytics, and two AI providers** (Sarvam for `/ask`, Gemini for `/tell`).

## Commands

- `/ponyo` → **Ponyo AI repository assistant**. It reads the current local Ponyo source tree, selects the most relevant files for the question, and uses Gemini to explain architecture, trace data flow, diagnose likely bugs, or propose implementation changes. It also uses the existing one-hour Discord conversation memory, so follow-up questions can refer to "that file" or "the previous function".

- `/ask` → **Sarvam AI** (`sarvam-105b`) for the fast everyday clan analysis path.
- `/tell` → **Gemini** for the deeper analysis path.

Factual questions ("who has one attack left?", "who has the lowest donations?", "who are the elders?") are answered **deterministically in code** before any AI provider is involved — they are instant, free and cannot hallucinate counts. Only questions the deterministic engine cannot parse reach the AI providers, and even then the embedded structured result is authoritative.

## Architecture

```text
Clash of Clans API
        │
        ▼
 Sync scheduler ──────► Dedicated Supabase (Ponyo schema)
  (server-side key)       │  CW001 / CWL001 / CR001 UID system
                          │
                          ├── read-only AI retrieval (anon key, RLS)
                          │       ▼
                          │   Deterministic query engine ──► direct answer
                          │       ▼ (unparsed questions)
                          │   Sarvam / Gemini
                          │       ▼
                          │    Discord
                          │
                          └── backend-only AI state
                              (ai_answers, ai_conversations, ai_chat, sync_runs)
```

## The UID system

Every event is identified by a human-readable UID (mirrors the spreadsheet design in `database/`):

| Domain | Session | Day / Raid | Attack |
|---|---|---|---|
| Normal Clan War | `CW001` | — | `CW001-ATK001` |
| CWL | `CWL001` | `CWL001-D1` | `CWL001-D1-ATK01` |
| Capital Raid | `CR001` | `CR001-R1` | `CR001-R1-ATK001` |

- UIDs are allocated sequentially and re-syncs resolve the **same** event via natural-key lookups (battle window, CWL war tag, capital season start), so no duplicates are created.
- Attack rows are numbered in a stable order (map position, then attack order) and rewritten per event on each sync, so numbering always matches the current API state.
- Old timestamp-based UIDs (`#CLAN:20260915T...`) are migrated automatically at startup by `src/migrateUids.js`.

## Data collection

- Clan/member data (`clan_info`) with rolling snapshots (`clan_info_snap`, last 12 batches by default — see `SNAPSHOT_KEEP_BATCHES`), used to compute **last activity** per member.
- Current war polling + war-log history (`cw_session`, `cw_session_participants`, `cw_attacklog`).
- CWL seasons, league days, members and attacks (`cwl_seasons`, `cwl_daywise_attacklog`, `cwl_season_participants`, `cwl_attacklog`).
- Capital raid seasons, raids and attacks (`capital_raid_season`, `capital_raid_participants`, `capital_raid_attacklog`), with participants/absentees computed against the roster snapshot from the raid start.
- Sync status/error logging (`sync_runs`).
- Configurable polling intervals and per-job enable flags (all environment-controlled).
- One-time importer for legacy attack-log exports: `npm run import:legacy -- <path-to-csv>`.

## AI retrieval

Questions are classified before retrieval so the model receives relevant data instead of an uncontrolled database dump:

1. Match the question to a data domain (query engine).
2. Answer deterministically when the intent is structured (attack usage, member metrics, roles, war state/timing/opponent).
3. Otherwise retrieve the narrowest useful context and give it to the requested provider.
4. If a named opponent search returns nothing, expand to recent war history.
5. The provider must never invent or recompute clan-specific facts.

Timestamps shown to users are always converted to IST (DD/MM/YYYY, 24-hour).

## Persistent long-answer controls

Long responses are split into Discord-safe chunks with **See more** / **See less** controls. The full answer is stored in the backend-only `ai_answers` table for 30 days, and one-hour conversation memory lives in `ai_conversations`, so both survive restarts and redeploys. Every question and answer is also logged to `ai_chat`.

## Testing

```bash
npm test        # query engine, UID system, and payload transformations
```

Pure payload transformations live in `src/transform.js` with no I/O, so they are fully unit-tested; CI (GitHub Actions, Node 22) runs the suite on every push and pull request.

## Requirements

- Node.js >= 22 (supabase-js requires native WebSocket).
- A Supabase project with the Ponyo schema applied: run `supabase/ponyo_schema.sql` once, then `supabase/migrations/20260919_sync_runs.sql`.
- Environment variables per `env.example`.

## AI provider failure alerts

The bot can send detailed, private provider failure alerts to a dedicated Discord channel via `PONYO_ALERT_CHANNEL_ID`. Provider errors are classified separately for context-window, quota/rate-limit, API-key, temporary and unknown failures; users receive a short safe message instead of the raw provider response.
