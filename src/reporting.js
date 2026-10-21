import 'dotenv/config';
import { createHash } from 'node:crypto';
import { db } from './db.js';
import { buildCapitalRaidReport, buildWarReport } from './reportFormat.js';

const SETTLE_DELAY_MS = Math.max(0, Number(process.env.PONYO_REPORT_SETTLE_DELAY_MS ?? 120000));
const ROSTER_SIZE = Math.max(1, Number(process.env.PONYO_REPORT_ROSTER_SIZE ?? 44));
const token = process.env.DISCORD_TOKEN;
const channelId = process.env.PONYO_DATA_REPORT_CHANNEL_ID;

async function rows(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}
async function one(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data ?? null;
}

async function trackIfMissing(type, uid, end) {
  const existing = await one(db.from('event_report_publications').select('state').eq('event_type', type).eq('event_uid', uid).maybeSingle());
  if (existing) return;
  const { error } = await db.from('event_report_publications').insert({ event_type: type, event_uid: uid, expected_end: end, state: 'active' });
  if (error && error.code !== '23505') throw error;
}

async function observeActiveEvents() {
  const now = new Date().toISOString();
  // A future battle_end alone is not enough to identify a live war: war-log
  // summaries and stale preparation snapshots can retain future timestamps.
  // Only a currentwar payload explicitly in the battle phase should create a
  // new automatic war-report publication row.
  const wars = await rows(db.from('cw_session').select('cw_uid,battle_end,data').gt('battle_end', now).not('battle_end', 'is', null).order('battle_end', { ascending: true }).limit(20));
  for (const w of wars) {
    if (w.cw_uid && w.battle_end && w.data?.state === 'inWar') {
      await trackIfMissing('war', w.cw_uid, w.battle_end);
    }
  }
  const raids = await rows(db.from('capital_raid_season').select('generated_uid,battle_end').gt('battle_end', now).not('battle_end', 'is', null).order('battle_end', { ascending: true }).limit(5));
  for (const r of raids) if (r.generated_uid && r.battle_end) await trackIfMissing('capital_raid', r.generated_uid, r.battle_end);
}

async function recoverStaleClaims() {
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { error } = await db.from('event_report_publications').update({ state: 'failed', publishing_since: null, last_error: 'Publisher stopped during an in-flight attempt. Check Discord before manually retrying.', updated_at: new Date().toISOString() }).eq('state', 'publishing').lt('publishing_since', cutoff);
  if (error) throw error;
}

async function prepareDueEvents() {
  const cutoff = new Date(Date.now() - SETTLE_DELAY_MS).toISOString();
  const due = await rows(db.from('event_report_publications').select('event_type,event_uid,expected_end,state').eq('state', 'active').eq('enabled', true).lte('expected_end', cutoff).order('expected_end', { ascending: true }).limit(10));
  for (const event of due) {
    if (event.event_type === 'war') {
      const session = await one(db.from('cw_session').select('result,data').eq('cw_uid', event.event_uid).maybeSingle());
      // A due timestamp alone is not proof that the war has ended. In
      // particular, do not publish a stale preparation snapshot as a result.
      if (!session || (session.data?.state !== 'warEnded' && session.result == null)) {
        console.warn(`[reports] keeping war ${event.event_uid} active until sync confirms warEnded`);
        continue;
      }
    }
    const { error } = await db.from('event_report_publications').update({ state: 'ready', last_error: null, updated_at: new Date().toISOString() }).eq('event_type', event.event_type).eq('event_uid', event.event_uid).eq('state', 'active').eq('enabled', true);
    if (error) throw error;
  }
  return due;
}

async function createReport(event) {
  if (event.event_type === 'war') {
    const session = await one(db.from('cw_session').select('*').eq('cw_uid', event.event_uid).maybeSingle());
    if (!session) return null;
    const players = await rows(db.from('cw_session_participants').select('player_name,attacks_used,attacks_available').eq('cw_uid', event.event_uid).order('player_name', { ascending: true }));
    return buildWarReport(session, players);
  }
  if (event.event_type === 'capital_raid') {
    const season = await one(db.from('capital_raid_season').select('*').eq('generated_uid', event.event_uid).maybeSingle());
    if (!season) return null;
    const players = await rows(db.from('capital_raid_participants').select('player_name,attacks_used,attacks_available').eq('capital_raid_uid', event.event_uid).order('player_name', { ascending: true }));
    return buildCapitalRaidReport(season, players, ROSTER_SIZE);
  }
  return null;
}

async function sendDiscordReport(event, content) {
  if (!token || !channelId) throw new Error('Set DISCORD_TOKEN and PONYO_DATA_REPORT_CHANNEL_ID to enable automatic report posting.');
  if (content.length > 1900) throw new Error(`Report has ${content.length} characters; refusing to split it and risk partial publication.`);
  const nonce = createHash('sha256').update(`${event.event_type}:${event.event_uid}`).digest('hex').slice(0, 24);
  const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, nonce, enforce_nonce: true, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Discord message send failed (${response.status}): ${(await response.text()).slice(0, 1000)}`);
  return response.json();
}

async function publishReadyEvents() {
  const ready = await rows(db.from('event_report_publications').select('event_type,event_uid,expected_end,attempts,last_refresh_at,state').in('state', ['ready', 'waiting_for_data']).eq('enabled', true).order('expected_end', { ascending: true }).limit(10));
  const results = [];
  for (const event of ready) {
    try {
      const lastRefresh = event.last_refresh_at ? Date.parse(event.last_refresh_at) : 0;
      if (!lastRefresh || Date.now() - lastRefresh >= 5 * 60 * 1000) {
        const { error } = await db.from('event_report_publications').update({ last_refresh_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('event_type', event.event_type).eq('event_uid', event.event_uid).in('state', ['ready', 'waiting_for_data']).eq('enabled', true);
        if (error) throw error;
        if (event.event_type === 'war') {
          const { syncHistory } = await import('./sync.js');
          await syncHistory();
        } else {
          const { syncCapital } = await import('./capitalSync.js');
          await syncCapital();
        }
      }

      const content = await createReport(event);
      if (!content) {
        const message = 'Waiting for final report data. Ponyo will check again on the next report poll.';
        await db.from('event_report_publications').update({ state: 'waiting_for_data', last_error: message, updated_at: new Date().toISOString() }).eq('event_type', event.event_type).eq('event_uid', event.event_uid).in('state', ['ready', 'waiting_for_data']).eq('enabled', true);
        results.push({ event: event.event_uid, state: 'waiting_for_data' });
        continue;
      }

      const { data: claim, error: claimError } = await db.from('event_report_publications')
        .update({ state: 'publishing', publishing_since: new Date().toISOString(), attempts: Number(event.attempts ?? 0) + 1, last_error: null, updated_at: new Date().toISOString() })
        .eq('event_type', event.event_type).eq('event_uid', event.event_uid)
        .in('state', ['ready', 'waiting_for_data']).eq('enabled', true).is('published_at', null).is('discord_message_id', null)
        .select('event_uid').maybeSingle();
      if (claimError) throw claimError;
      if (!claim) continue;
      try {
        const message = await sendDiscordReport(event, content);
        const { error } = await db.from('event_report_publications').update({ state: 'published', published_at: new Date().toISOString(), discord_message_id: message.id ?? null, publishing_since: null, last_error: null, updated_at: new Date().toISOString() }).eq('event_type', event.event_type).eq('event_uid', event.event_uid).eq('state', 'publishing');
        if (error) throw error;
        console.log(`[reports] published ${event.event_type} ${event.event_uid} to Discord message ${message.id}`);
        results.push({ event: event.event_uid, state: 'published' });
      } catch (error) {
        await db.from('event_report_publications').update({ state: 'failed', publishing_since: null, last_error: String(error?.message ?? error).slice(0, 1000), updated_at: new Date().toISOString() }).eq('event_type', event.event_type).eq('event_uid', event.event_uid).eq('state', 'publishing');
        throw error;
      }
    } catch (error) {
      const message = String(error?.message ?? error).slice(0, 1000);
      // Stop automatic retry loops after any per-report preparation or send failure.
      // A user with reports.manage can inspect the error and explicitly retry.
      await db.from('event_report_publications')
        .update({ state: 'failed', publishing_since: null, last_error: message, updated_at: new Date().toISOString() })
        .eq('event_type', event.event_type).eq('event_uid', event.event_uid)
        .in('state', ['ready', 'waiting_for_data']).eq('enabled', true);
      console.error(`[reports] failed ${event.event_type} ${event.event_uid}:`, message);
      results.push({ event: event.event_uid, state: 'error', error: message });
    }
  }
  return results;
}

let postingConfigWarningShown = false;

export async function processEventReports() {
  try {
    await observeActiveEvents();
    await recoverStaleClaims();
    const due = await prepareDueEvents();
    if (!token || !channelId) {
      if (!postingConfigWarningShown) {
        console.warn('[reports] tracking events, but automatic posting is paused: configure DISCORD_TOKEN and PONYO_DATA_REPORT_CHANNEL_ID.');
        postingConfigWarningShown = true;
      }
      return { observed: true, due: due.length, postingConfigured: false, results: [] };
    }
    const results = await publishReadyEvents();
    return { observed: true, due: due.length, postingConfigured: true, results };
  } catch (error) {
    console.error('[reports] scheduler tick failed:', error?.message ?? error);
    return { error: String(error?.message ?? error) };
  }
}
