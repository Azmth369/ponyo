-- Removes duplicate war/season copies that were created because the sync's
-- natural-key lookup compared timestamps as strings ("2026-09-18T07:00:00.000Z"
-- vs "2026-09-18 07:00:00+00"), so every re-sync allocated a new CW/CR UID for
-- the same event. Keeps the most recently allocated UID per battle window and
-- deletes the stale copies with their participants, attack logs and season rows.
-- Safe to run more than once.

begin;

create temp table tmp_capital_keep on commit drop as
  select distinct on (battle_start, battle_end) generated_uid
  from public.capital_raid_season
  order by battle_start, battle_end, generated_uid desc;

delete from public.capital_raid_participants
  where capital_raid_uid not in (select generated_uid from tmp_capital_keep);

delete from public.capital_raid_attacklog
  where capital_raid_uid not in (select generated_uid from tmp_capital_keep);

delete from public.capital_raid_season
  where generated_uid not in (select generated_uid from tmp_capital_keep);

create temp table tmp_cw_keep on commit drop as
  select distinct on (battle_start, battle_end) cw_uid
  from public.cw_session
  order by battle_start, battle_end, cw_uid desc;

delete from public.cw_session_participants
  where cw_uid not in (select cw_uid from tmp_cw_keep);

delete from public.cw_attacklog
  where cw_uid not in (select cw_uid from tmp_cw_keep);

delete from public.cw_session
  where cw_uid not in (select cw_uid from tmp_cw_keep);

commit;
