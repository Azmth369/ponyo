-- Reconcile the existing normal-war attack table with the current schema.
-- The table may have been created before duration_seconds was added to schema.sql.
-- This is safe to run even if the column already exists.

begin;

alter table war_attacks
  add column if not exists duration_seconds int;

create index if not exists war_attacks_war_idx on war_attacks(war_key, order_no);
create index if not exists war_attacks_attacker_idx on war_attacks(attacker_tag, observed_at desc);

commit;
