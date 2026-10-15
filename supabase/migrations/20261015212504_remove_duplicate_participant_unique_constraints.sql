-- Keep the canonical unique constraints created by the base schema.
-- The extra uniq_* constraints duplicated the same unique indexes.

alter table public.cw_session_participants
  drop constraint if exists uniq_cw_session_participants;

alter table public.cwl_season_participants
  drop constraint if exists uniq_cwl_season_participants;

alter table public.capital_raid_participants
  drop constraint if exists uniq_capital_raid_participants;
