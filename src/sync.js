// Sync layer: pulls data from the Clash of Clans API and writes it into the
// Ponyo Supabase schema using the human-readable UID system
// (CW001, CW001-ATK001, CWL001-D1-ATK01, CR001-R1-ATK001).
//
// Pure payload transformations live in transform.js; this module only handles
// scheduling, UID resolution and database writes.

import 'dotenv/config';
import { db, upsert } from './db.js';
import { getClan, getCurrentWar, getWarLog, getCwlGroup, getCwlWar } from './cocApi.js';
import { cwlDayUid, cwlAttackUid } from './uids.js';
import {
  cocStamp, mapLabel, warResultFromSummary, sortedWarAttacks, normalWarRows
} from './transform.js';
import { allocateSeq, findWarSessionUid, findCwlSeasonUid, findCwlDayUid } from './uidAlloc.js';

const clanTag = process.env.COC_CLAN_TAG;
const nowIso = () => new Date().toISOString();

// Pure transforms are re-exported for compatibility with older imports.
export { cocStamp, mapLabel, warResultFromSummary, sortedWarAttacks, normalWarRows };

async function logSyncStatus(job, status, details = null, message = null) {
  try {
    const { error } = await db.from('sync_runs').insert({
      job,
      status,
      details: details ?? undefined,
      message: message ?? undefined,
      finished_at: nowIso()
    });
    if (error) throw error;
  } catch (error) {
    console.error(`[${job}] failed to write sync status:`, error.message);
  }
}

export async function run(job, fn) {
  try {
    const details = await fn();
    await logSyncStatus(job, 'ok', details);
    return details;
  } catch (error) {
    await logSyncStatus(job, 'error', null, error.message);
    console.error(`[${job}]`, error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Normal Clan War (CW)
// ---------------------------------------------------------------------------

// Attack rows are delete+inserted per session so the sequential ATK numbering
// always matches the current API state exactly.
export async function saveNormalWar(war, cwUid) {
  const rows = normalWarRows(war, cwUid, clanTag);
  if (!rows.session) return { members: 0, attacks: 0, cwUid };

  await upsert('cw_session', [rows.session]);

  const removed = await db.from('cw_attacklog').delete().eq('cw_uid', cwUid);
  if (removed.error) throw removed.error;
  if (rows.attacks.length) await upsert('cw_attacklog', rows.attacks);

  if (rows.participants.length) await upsert('cw_session_participants', rows.participants);
  return { members: rows.participants.length, attacks: rows.attacks.length, cwUid };
}

async function resolveWarUid(war) {
  const existing = await findWarSessionUid({
    battleStart: cocStamp(war.startTime),
    battleEnd: cocStamp(war.endTime)
  });
  return existing ?? await allocateSeq('cw_session', 'cw_uid', 'CW');
}

export async function syncWar() {
  const war = await getCurrentWar();
  if (!war || war.state === 'notInWar') return { state: 'notInWar' };
  const cwUid = await resolveWarUid(war);
  return { state: war.state, ...(await saveNormalWar(war, cwUid)) };
}

export async function syncHistory() {
  const warlog = await getWarLog();
  let saved = 0;
  for (const war of warlog.items ?? []) {
    const cwUid = await resolveWarUid(war);
    await saveNormalWar({ ...war, state: 'warEnded' }, cwUid);
    saved++;
  }
  return { wars: saved, note: 'Historical warlog records contain summaries; attack rows come only from captured currentwar snapshots.' };
}

// ---------------------------------------------------------------------------
// Clan roster and snapshots
// ---------------------------------------------------------------------------

// The most recent snapshot batch before the next one is written.
async function latestSnapshotBatch() {
  const { data, error } = await db
    .from('clan_info_snap')
    .select('date_time,player_id,trophies,troops_donated,troops_received')
    .order('date_time', { ascending: false })
    .limit(400);
  if (error) throw error;
  const rows = data ?? [];
  if (!rows.length) return { time: null, players: new Map() };
  const latest = rows[0].date_time;
  const players = new Map();
  for (const row of rows) {
    if (row.date_time === latest) players.set(row.player_id, row);
  }
  return { time: latest, players };
}

// Keep only the N most recent snapshot batches (default 12, per the database
// design notes; override with SNAPSHOT_KEEP_BATCHES).
export async function trimSnapshots(keep = Number(process.env.SNAPSHOT_KEEP_BATCHES ?? 12)) {
  const { data, error } = await db
    .from('clan_info_snap')
    .select('date_time')
    .order('date_time', { ascending: false })
    .limit(3000);
  if (error) throw error;
  const times = [...new Set((data ?? []).map(r => r.date_time))];
  if (times.length <= keep) return { batches: times.length, deleted: 0 };
  const cutoff = times[keep];
  const removed = await db.from('clan_info_snap').delete().lt('date_time', cutoff);
  if (removed.error) throw removed.error;
  return { batches: keep, deleted: removed.count ?? null };
}

export async function syncClan(captureSnapshots = false) {
  const clan = await getClan();
  const members = clan.memberList ?? [];
  const rows = members.map(m => ({
    player_id: m.tag,
    name: m.name,
    role: m.role ?? null,
    th: m.townHallLevel ?? null,
    lvl: m.expLevel ?? null,
    trophies: m.trophies ?? null,
    troops_donated: m.donations ?? null,
    troops_received: m.donationsReceived ?? null,
    date_time: nowIso(),
    data: m
  }));
  if (rows.length) await upsert('clan_info', rows);

  let snapshotInfo = null;
  if (captureSnapshots && members.length) {
    const snapshotTime = nowIso();
    const previous = await latestSnapshotBatch();

    const snapshotRows = members.map(m => ({
      date_time: snapshotTime,
      player_id: m.tag,
      name: m.name,
      role: m.role ?? null,
      th: m.townHallLevel ?? null,
      lvl: m.expLevel ?? null,
      trophies: m.trophies ?? null,
      troops_donated: m.donations ?? null,
      troops_received: m.donationsReceived ?? null
    }));
    const { error } = await db.from('clan_info_snap').insert(snapshotRows);
    if (error) throw new Error(`clan_info_snap insert failed: ${error.message}`);

    // Last activity: a member counts as active when any tracked stat changed
    // compared to the previous snapshot batch (the design described in
    // database/notes.txt).
    const changed = [];
    for (const m of members) {
      const prev = previous.players.get(m.tag);
      if (!prev) continue;
      if (prev.trophies !== (m.trophies ?? null) ||
          prev.troops_donated !== (m.donations ?? null) ||
          prev.troops_received !== (m.donationsReceived ?? null)) {
        changed.push(m.tag);
      }
    }
    if (changed.length) {
      const { error: updateError } = await db.from('clan_info')
        .update({ last_active: snapshotTime })
        .in('player_id', changed);
      if (updateError) throw updateError;
    }

    const trimmed = await trimSnapshots();
    snapshotInfo = { snapshots: snapshotRows.length, active: changed.length, ...trimmed };
  }

  return { members: rows.length, snapshots: snapshotInfo };
}

// ---------------------------------------------------------------------------
// Clan War Leagues (CWL)
// ---------------------------------------------------------------------------

async function saveCwlWar(war, dayUid, roundNo) {
  const own = war.clan?.tag === clanTag ? war.clan : war.opponent;
  const opponent = war.clan?.tag === clanTag ? war.opponent : war.clan;
  if (!own) return { participants: 0, attacks: 0 };

  const members = own.members ?? [];
  const battleStart = cocStamp(war.startTime);
  const battleEnd = cocStamp(war.endTime);

  await upsert('cwl_daywise_attacklog', [{
    generated_cwl_day_id: dayUid,
    battle_day: roundNo,
    battle_start: battleStart,
    battle_end: battleEnd,
    size: (members.length || war.teamSize) ?? null,
    opponent_clan_name: opponent?.name ?? null,
    opponent_clan_id: opponent?.tag ?? null,
    our_clan_score: own.stars ?? null,
    opponent_clan_score: opponent?.stars ?? null,
    our_participants: members.map(m => ({ player_id: m.tag, name: m.name, map_position: m.mapPosition ?? null })),
    opponent_participants: (opponent?.members ?? []).map(m => ({ player_id: m.tag, name: m.name, map_position: m.mapPosition ?? null })),
    data: { ...war }
  }]);

  const attackRows = sortedWarAttacks(members).map((row, index) => ({
    row,
    uid: cwlAttackUid(dayUid, index + 1)
  }));

  const removed = await db.from('cwl_attacklog').delete().eq('cwl_day_uid', dayUid);
  if (removed.error) throw removed.error;
  if (attackRows.length) {
    const opponentByTag = new Map((opponent?.members ?? []).map(m => [m.tag, m]));
    await upsert('cwl_attacklog', attackRows.map(({ row, uid }) => {
      const { member: m, attack: a } = row;
      const defender = opponentByTag.get(a.defenderTag);
      return {
        generated_cwl_attack_uid: uid,
        battle_day: roundNo,
        attacker_clan_name: own.name ?? null,
        attacker_name_with_map_position: mapLabel(m.name, m.mapPosition),
        defender_name_with_map_position: mapLabel(a.defenderName ?? defender?.name, defender?.mapPosition),
        star_scored: a.stars ?? null,
        destruction_caused: a.destructionPercentage ?? null,
        attacking_date_time: cocStamp(a.attackTime),
        attacker_id: m.tag,
        cwl_day_uid: dayUid,
        data: a
      };
    }));
  }

  const participants = members.map(m => {
    const attacks = m.attacks ?? [];
    const uids = attackRows.filter(a => a.row.member.tag === m.tag).map(a => a.uid);
    return {
      cwl_day_uid: dayUid,
      player_name: m.name,
      player_id: m.tag,
      attacks_used: attacks.length,
      attacks_available: 1,
      stars_scored: attacks.reduce((s, a) => s + Number(a.stars ?? 0), 0),
      destruction_caused: attacks.length ? attacks.reduce((s, a) => s + Number(a.destructionPercentage ?? 0), 0) / attacks.length : 0,
      cwl_attack_uid: uids[0] ?? null,
      player_map_position: m.mapPosition ?? null,
      battle_day_start: battleStart,
      battle_day_end: battleEnd,
      size: members.length || null,
      data: m
    };
  });
  if (participants.length) await upsert('cwl_season_participants', participants);
  return { participants: participants.length, attacks: attackRows.length, dayUid };
}

export async function syncCwl() {
  let group;
  try {
    group = await getCwlGroup();
  } catch (error) {
    if (error.status === 404 && /notFound/i.test(error.message)) return { state: 'notInCwl' };
    throw error;
  }
  if (!group || group.state === 'notInWar') return { state: group?.state ?? 'notInCwl' };

  const seasonKey = group.season ?? null;
  let seasonUid = await findCwlSeasonUid(seasonKey);
  if (!seasonUid) seasonUid = await allocateSeq('cwl_seasons', 'generated_cwl_id', 'CWL');

  const starts = [];
  const ends = [];
  let stars = 0;
  const playerIds = new Set();
  let wars = 0;

  for (const [index, round] of (group.rounds ?? []).entries()) {
    const roundNo = index + 1;
    for (const warTag of round.warTags ?? []) {
      if (!warTag || warTag === '#0') continue;
      try {
        const war = await getCwlWar(warTag);
        // The war tag is kept in the day's data so re-syncs resolve the same day.
        const warWithTag = { ...war, warTag };
        let dayUid = await findCwlDayUid(warTag);
        if (!dayUid) dayUid = cwlDayUid(seasonUid, roundNo);
        await saveCwlWar(warWithTag, dayUid, roundNo);
        wars++;
        const start = cocStamp(war.startTime);
        const end = cocStamp(war.endTime);
        if (start) starts.push(start);
        if (end) ends.push(end);
        const own = war.clan?.tag === clanTag ? war.clan : war.opponent;
        stars += Number(own?.stars ?? 0);
        for (const m of own?.members ?? []) playerIds.add(m.tag);
      } catch (error) {
        console.error(`[cwl:${warTag}]`, error.message);
      }
    }
  }

  await upsert('cwl_seasons', [{
    generated_cwl_id: seasonUid,
    battle_start: starts.length ? starts.sort()[0] : null,
    battle_end: ends.length ? ends.sort().at(-1) : null,
    stars_scored: stars,
    clan_participants_no: playerIds.size,
    data: { ...group, rounds: group.rounds?.length ?? 0 }
  }]);

  return { season: seasonUid, wars, participants: playerIds.size };
}
