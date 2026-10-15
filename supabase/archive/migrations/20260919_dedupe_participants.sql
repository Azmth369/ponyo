-- Legacy SQL retained for audit only; do not run as a pending CLI migration.
-- The live database already has canonical participant uniqueness constraints.
-- Running the original version would recreate redundant uniq_* constraints.

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

-- Original migration's add-constraint block is intentionally omitted from
-- this archived copy because it created redundant unique indexes alongside
-- the canonical constraints in ponyo_schema.sql.
