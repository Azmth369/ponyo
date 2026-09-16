-- Analytics views for the Ponyo spreadsheet-shaped database.
-- Run after supabase/schema.sql.

create or replace view player_war_summary as
select
  csp.player_id,
  max(csp.player_name) as player_name,
  count(*) as wars,
  sum(coalesce(csp.attacks_used, 0)) as attacks_used,
  sum(coalesce(csp.attacks_available, 0)) as attacks_available,
  sum(coalesce(csp.stars_scored, 0)) as stars,
  round(avg(coalesce(csp.destruction_caused, 0)), 2) as avg_destruction
from cw_session_participants csp
group by csp.player_id;

create or replace view cwl_player_summary as
select
  csp.player_id,
  max(csp.player_name) as player_name,
  count(*) as league_days,
  sum(coalesce(csp.attacks_used, 0)) as attacks_used,
  sum(coalesce(csp.attacks_available, 0)) as attacks_available,
  sum(coalesce(csp.stars_scored, 0)) as stars,
  round(avg(coalesce(csp.destruction_caused, 0)), 2) as avg_destruction
from cwl_season_participants csp
group by csp.player_id;

create or replace view capital_player_summary as
select
  crp.player_id,
  max(crp.player_name) as player_name,
  count(*) as raid_seasons,
  sum(coalesce(crp.total_attacks, 0)) as attacks,
  sum(coalesce(crp.total_loot_gained, 0)) as loot
from capital_raid_participants crp
group by crp.player_id;
