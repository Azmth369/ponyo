-- Removes duplicate event-participant rows that accumulated when the live
-- database was missing the unique constraints from ponyo_schema.sql, then
-- enforces those constraints so the upsert-based syncs dedupe naturally.
-- Safe to run more than once.

-- Keep only the newest row (highest index_no) per player per event.
delete from public.capital_raid_participants a
using public.capital_raid_participants b
where a.index_no < b.index_no
  and a.capital_raid_uid = b.capital_raid_uid
  and a.player_id = b.player_id;

delete from public.cwl_season_participants a
using public.cwl_season_participants b
where a.index_no < b.index_no
  and a.cwl_day_uid = b.cwl_day_uid
  and a.player_id = b.player_id;

delete from public.cw_session_participants a
using public.cw_session_participants b
where a.index_no < b.index_no
  and a.cw_uid = b.cw_uid
  and a.player_id = b.player_id;

-- Add the unique constraints if they are missing (no-op when present).
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'uniq_capital_raid_participants') then
    alter table public.capital_raid_participants
      add constraint uniq_capital_raid_participants unique (capital_raid_uid, player_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'uniq_cwl_season_participants') then
    alter table public.cwl_season_participants
      add constraint uniq_cwl_season_participants unique (cwl_day_uid, player_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'uniq_cw_session_participants') then
    alter table public.cw_session_participants
      add constraint uniq_cw_session_participants unique (cw_uid, player_id);
  end if;
end $$;
