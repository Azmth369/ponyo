-- Phase 4: owner/permission-controlled Discord report retries and per-event pause/enable.
-- Apply after 20261018030000_event_report_publications.sql and before enabling report controls.

alter table public.event_report_publications
  add column if not exists enabled boolean not null default true;

alter table public.event_report_publications
  drop constraint if exists event_report_publications_state_check;
alter table public.event_report_publications
  add constraint event_report_publications_state_check
  check (state in ('active', 'ready', 'waiting_for_data', 'publishing', 'published', 'failed'));

create index if not exists event_report_publications_enabled_state_idx
  on public.event_report_publications (enabled, state, expected_end);

create or replace function public.set_event_report_enabled(
  p_actor_email text, p_event_type text, p_event_uid text, p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare saved public.event_report_publications;
begin
  if p_event_type not in ('war', 'capital_raid') or nullif(trim(p_event_uid), '') is null then
    raise exception 'Invalid report identity';
  end if;

  update public.event_report_publications
     set enabled = p_enabled, updated_at = now()
   where event_type = p_event_type
     and event_uid = trim(p_event_uid)
     and state <> 'published'
   returning * into saved;

  if not found then
    return null;
  end if;

  insert into public.dashboard_audit_log(actor_email, action, target_email, details)
  values (
    lower(trim(p_actor_email)),
    case when p_enabled then 'report.enabled' else 'report.paused' end,
    null,
    jsonb_build_object('event_type', saved.event_type, 'event_uid', saved.event_uid,
                       'enabled', saved.enabled, 'state', saved.state)
  );

  return jsonb_build_object(
    'event_type', saved.event_type, 'event_uid', saved.event_uid,
    'enabled', saved.enabled, 'state', saved.state, 'attempts', saved.attempts,
    'last_error', saved.last_error, 'updated_at', saved.updated_at
  );
end;
$$;

create or replace function public.retry_event_report(
  p_actor_email text, p_event_type text, p_event_uid text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare saved public.event_report_publications;
begin
  if p_event_type not in ('war', 'capital_raid') or nullif(trim(p_event_uid), '') is null then
    raise exception 'Invalid report identity';
  end if;

  -- Only an explicitly failed, enabled, never-published report can be retried.
  update public.event_report_publications
     set state = 'ready', last_error = null, publishing_since = null, updated_at = now()
   where event_type = p_event_type
     and event_uid = trim(p_event_uid)
     and state = 'failed'
     and enabled = true
     and published_at is null
     and discord_message_id is null
   returning * into saved;

  if not found then
    return null;
  end if;

  insert into public.dashboard_audit_log(actor_email, action, target_email, details)
  values (
    lower(trim(p_actor_email)), 'report.retry_requested', null,
    jsonb_build_object('event_type', saved.event_type, 'event_uid', saved.event_uid,
                       'attempts', saved.attempts)
  );

  return jsonb_build_object(
    'event_type', saved.event_type, 'event_uid', saved.event_uid,
    'enabled', saved.enabled, 'state', saved.state, 'attempts', saved.attempts,
    'updated_at', saved.updated_at
  );
end;
$$;

revoke all on function public.set_event_report_enabled(text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.retry_event_report(text, text, text) from public, anon, authenticated;
grant execute on function public.set_event_report_enabled(text, text, text, boolean) to service_role;
grant execute on function public.retry_event_report(text, text, text) to service_role;
