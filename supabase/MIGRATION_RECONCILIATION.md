# Supabase migration tracking reconciliation

The active `supabase/migrations/` directory is intended to mirror the migrations recorded by the linked Supabase project.

## Active migrations

These files correspond to entries in `supabase_migrations.schema_migrations`:

- `20261012214833_player_capital_contribution_snapshots.sql`
- `20261015211346_restrict_ai_state_anonymous_reads.sql`
- `20261015212504_remove_duplicate_participant_unique_constraints.sql`

The last migration was applied to the linked project and verified: the three redundant `uniq_*` constraints are gone, while the canonical uniqueness constraints remain.

## Legacy SQL

Three older scripts were present in `supabase/migrations/` but had no corresponding entries in the database migration history. Their effects were partly visible in the live schema, so they were moved to `supabase/archive/migrations/` rather than being treated as pending migrations:

- `20260919_dedupe_participants.sql`: historical participant deduplication and uniqueness constraints.
- `20260919_sync_runs.sql`: historical `sync_runs` table creation; the table exists in the live database.
- `20260919b_dedupe_event_copies.sql`: historical cleanup that deletes stale event rows. The live database currently has no duplicate war or Capital Raid event windows.

The archived files are retained for audit/reference only and must not be automatically run as pending migrations. In particular, the original participant deduplication script can recreate redundant unique indexes, and the event-copy cleanup script deletes data.

## Empty placeholder

The empty `supabase/migrations/aaaa` placeholder was removed because it is not a valid migration.

## Operational note

Before applying future schema changes, compare `supabase migration list` (local and remote) and inspect this directory. Do not manually insert rows into `supabase_migrations.schema_migrations` to make histories appear aligned; use Supabase's migration repair workflow when repairing a confirmed historical application record.
