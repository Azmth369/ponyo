-- Idempotent publication state for automatic Clan War and Capital Raid reports.
create table if not exists public.event_report_publications (
  event_type text not null check (event_type in ('war', 'capital_raid')),
  event_uid text not null,
  expected_end timestamptz not null,
  state text not null default 'active' check (state in ('active', 'ready', 'publishing', 'published')),
  attempts integer not null default 0,
  last_error text,
  publishing_since timestamptz,
  last_refresh_at timestamptz,
  published_at timestamptz,
  discord_message_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (event_type, event_uid)
);
create index if not exists event_report_publications_due_idx on public.event_report_publications (state, expected_end);
alter table public.event_report_publications enable row level security;
revoke all on public.event_report_publications from anon, authenticated;
