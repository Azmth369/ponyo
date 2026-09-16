-- Normal Clan War: ATTACKS_AVAILABLE means total attacks allowed (2), not remaining attacks.
create or replace function ponyo_cw_participant_defaults()
returns trigger language plpgsql as $$
begin
  new.attacks_available := 2;
  return new;
end;
$$;

drop trigger if exists cw_participant_defaults on cw_session_participants;
create trigger cw_participant_defaults
before insert or update on cw_session_participants
for each row execute function ponyo_cw_participant_defaults();

-- /warlog is summary-only. Never let a summary-only refresh erase a richer
-- currentwar snapshot already captured in CW_SESSION.
create or replace function ponyo_preserve_cw_snapshot()
returns trigger language plpgsql as $$
begin
  if coalesce(jsonb_array_length(new.our_participants), 0) = 0
     and coalesce(jsonb_array_length(old.our_participants), 0) > 0 then
    new.our_participants := old.our_participants;
  end if;
  if coalesce(jsonb_array_length(new.opponent_participants), 0) = 0
     and coalesce(jsonb_array_length(old.opponent_participants), 0) > 0 then
    new.opponent_participants := old.opponent_participants;
  end if;
  if new.participants_size is null or new.participants_size = 0 then
    new.participants_size := old.participants_size;
  end if;
  return new;
end;
$$;

drop trigger if exists cw_snapshot_guard on cw_session;
create trigger cw_snapshot_guard
before update on cw_session
for each row execute function ponyo_preserve_cw_snapshot();
