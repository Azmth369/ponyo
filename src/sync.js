import 'dotenv/config';
import { db, upsert } from './db.js';
import { getClan, getCurrentWar, getWarLog, getCapitalRaids, getCwlGroup, getCwlWar, getPlayer } from './cocApi.js';

const clanTag = process.env.COC_CLAN_TAG;
const now = () => new Date().toISOString();
const iso = value => {
  if (!value) return null;
  const m = String(value).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString() : null;
};
const uid = (...parts) => parts.map(x => String(x ?? '').replace(/[^A-Za-z0-9#:_-]/g, '_')).join(':');
const mapLabel = (name, position) => `${name ?? 'Unknown'} [${position ?? '?'}]`;

async function logSyncStatus(job, status, details = null, message = null) {
  try {
    await db.from('ai_chat').insert({
      messenger: 'sync',
      context: { job, status, ...(details == null ? {} : { details }), ...(message == null ? {} : { message }) },
      date_time: now()
    });
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

function warResult(own, opponent, state) {
  if (state !== 'warEnded' || !own || !opponent) return null;
  if (Number(own.stars ?? 0) > Number(opponent.stars ?? 0)) return 'win';
  if (Number(own.stars ?? 0) < Number(opponent.stars ?? 0)) return 'loss';
  return 'draw';
}

function normalWarRows(war, cwUid) {
  const own = war.clan?.tag === clanTag ? war.clan : null;
  const opponent = war.clan?.tag === clanTag ? war.opponent : null;
  if (!own) return { session: null, participants: [], attacks: [] };
  const state = war.state ?? null;
  const members = own.members ?? [];
  const opponentByTag = new Map((opponent?.members ?? []).map(m => [m.tag, m]));
  const session = {
    cw_uid: cwUid,
    opponent_clan_name: opponent?.name ?? null,
    opponent_clan_id: opponent?.tag ?? null,
    size: own.members?.length ?? war.teamSize ?? null,
    battle_start: iso(war.startTime),
    battle_end: iso(war.endTime),
    result: warResult(own, opponent, state),
    our_clan_score: own.stars ?? null,
    opponent_clan_score: opponent?.stars ?? null,
    our_clan_destruction: own.destructionPercentage ?? null,
    opponent_clan_destruction: opponent?.destructionPercentage ?? null,
    participants_size: members.length,
    our_participants: members.map(m => ({ player_id: m.tag, name: m.name, map_position: m.mapPosition ?? null })),
    opponent_participants: (opponent?.members ?? []).map(m => ({ player_id: m.tag, name: m.name, map_position: m.mapPosition ?? null })),
    data: war
  };
  const available = 2;
  const participants = members.map(m => {
    const attacks = m.attacks ?? [];
    const attackIds = attacks.map(a => uid(cwUid, m.tag, a.order ?? attacks.indexOf(a) + 1));
    return {
      cw_uid: cwUid,
      player_name: m.name,
      player_id: m.tag,
      attacks_used: attacks.length,
      attacks_available: available,
      stars_scored: attacks.reduce((s, a) => s + Number(a.stars ?? 0), 0),
      destruction_caused: attacks.length ? attacks.reduce((s, a) => s + Number(a.destructionPercentage ?? 0), 0) / attacks.length : 0,
      cw_attack_uid: attackIds.join(','),
      player_map_position: m.mapPosition ?? null,
      battle_start: iso(war.startTime),
      battle_end: iso(war.endTime),
      size: own.members?.length ?? null,
      data: m
    };
  });
  const attacks = [];
  for (const m of members) for (const a of m.attacks ?? []) {
    const defender = opponentByTag.get(a.defenderTag);
    const attackUid = uid(cwUid, m.tag, a.order ?? attacks.length + 1);
    attacks.push({
      cw_attack_uid: attackUid,
      attacker_clan_name: own.name ?? null,
      attacker_clan_id: own.tag ?? clanTag,
      attacker_name_with_map_position: mapLabel(m.name, m.mapPosition),
      defender_name_with_map_position: mapLabel(a.defenderName ?? defender?.name, defender?.mapPosition),
      star_scored: a.stars ?? null,
      destruction_caused: a.destructionPercentage ?? null,
      attacking_date_time: iso(a.attackTime),
      attacker_id: m.tag,
      cw_uid: cwUid,
      data: a
    });
  }
  return { session, participants, attacks };
}

async function saveNormalWar(war, cwUid) {
  const rows = normalWarRows(war, cwUid);
  if (!rows.session) return { members: 0, attacks: 0 };
  await upsert('cw_session', [rows.session]);
  if (rows.participants.length) await upsert('cw_session_participants', rows.participants);
  if (rows.attacks.length) await upsert('cw_attacklog', rows.attacks);
  return { members: rows.participants.length, attacks: rows.attacks.length, cwUid };
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
    last_active: null,
    date_time: now(),
    data: m
  }));
  if (rows.length) await upsert('clan_info', rows);

  if (captureSnapshots && members.length) {
    // Snapshot the same authoritative member data returned by /clans/{tag}.
    // Do this as one insert and explicitly check the Supabase error; the old
    // per-player insert ignored Supabase errors and could silently leave the
    // snapshot table empty.
    const snapshotTime = now();
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
    console.log(`[player-snapshot] inserted ${snapshotRows.length} snapshots at ${snapshotTime}`);
  }

  return { members: rows.length, snapshots: captureSnapshots ? members.length : 0 };
}

export async function syncWar() {
  const war = await getCurrentWar();
  if (!war || war.state === 'notInWar') return { state: 'notInWar' };
  const cwUid = uid(clanTag, war.startTime ?? war.createdDate, war.endTime ?? 'open');
  return { state: war.state, ...(await saveNormalWar(war, cwUid)) };
}

export async function syncHistory() {
  const warlog = await getWarLog();
  let saved = 0;
  for (const war of warlog.items ?? []) {
    const cwUid = uid(clanTag, war.startTime ?? war.createdDate, war.endTime ?? 'unknown');
    await saveNormalWar({ ...war, state: 'warEnded' }, cwUid);
    saved++;
  }
  return { wars: saved, note: 'Historical warlog records contain summaries; attack rows come only from captured currentwar snapshots.' };
}

function cwlDayUid(seasonKey, roundNo, warTag) { return uid(seasonKey, `DAY${roundNo}`, warTag); }

async function saveCwlWar(war, seasonKey, roundNo, warTag) {
  const own = war.clan?.tag === clanTag ? war.clan : war.opponent;
  const opponent = war.clan?.tag === clanTag ? war.opponent : war.clan;
  if (!own) return { participants: 0, attacks: 0 };
  const dayUid = cwlDayUid(seasonKey, roundNo, warTag);
  const members = own.members ?? [];
  await upsert('cwl_daywise_attacklog', [{
    generated_cwl_day_id: dayUid,
    battle_day: roundNo,
    battle_start: iso(war.startTime),
    battle_end: iso(war.endTime),
    size: own.members?.length ?? war.teamSize ?? null,
    opponent_clan_name: opponent?.name ?? null,
    opponent_clan_id: opponent?.tag ?? null,
    our_clan_score: own.stars ?? null,
    opponent_clan_score: opponent?.stars ?? null,
    our_participants: members.map(m => ({ player_id: m.tag, name: m.name, map_position: m.mapPosition ?? null })),
    opponent_participants: (opponent?.members ?? []).map(m => ({ player_id: m.tag, name: m.name, map_position: m.mapPosition ?? null })),
    data: war
  }]);
  const participantRows = members.map(m => {
    const attacks = m.attacks ?? [];
    const first = attacks[0];
    return {
      cwl_day_uid: dayUid,
      player_name: m.name,
      player_id: m.tag,
      attacks_used: attacks.length,
      attacks_available: 1,
      stars_scored: attacks.reduce((s, a) => s + Number(a.stars ?? 0), 0),
      destruction_caused: attacks.length ? attacks.reduce((s, a) => s + Number(a.destructionPercentage ?? 0), 0) / attacks.length : 0,
      cwl_attack_uid: first ? uid(dayUid, m.tag, first.order ?? 1) : null,
      player_map_position: m.mapPosition ?? null,
      battle_day_start: iso(war.startTime),
      battle_day_end: iso(war.endTime),
      size: own.members?.length ?? null,
      data: m
    };
  });
  if (participantRows.length) await upsert('cwl_season_participants', participantRows);
  const opponentByTag = new Map((opponent?.members ?? []).map(m => [m.tag, m]));
  const attackRows = [];
  for (const m of members) for (const a of m.attacks ?? []) {
    const defender = opponentByTag.get(a.defenderTag);
    attackRows.push({
      generated_cwl_attack_uid: uid(dayUid, m.tag, a.order ?? attackRows.length + 1),
      battle_day: roundNo,
      attacker_clan_name: own.name ?? null,
      attacker_name_with_map_position: mapLabel(m.name, m.mapPosition),
      defender_name_with_map_position: mapLabel(a.defenderName ?? defender?.name, defender?.mapPosition),
      star_scored: a.stars ?? null,
      destruction_caused: a.destructionPercentage ?? null,
      attacking_date_time: iso(a.attackTime),
      attacker_id: m.tag,
      cwl_day_uid: dayUid,
      data: a
    });
  }
  if (attackRows.length) await upsert('cwl_attacklog', attackRows);
  return { participants: participantRows.length, attacks: attackRows.length };
}

export async function syncCwl() {
  let group;
  try { group = await getCwlGroup(); }
  catch (error) {
    if (error.status === 404 && /notFound/i.test(error.message)) return { state: 'notInCwl' };
    throw error;
  }
  if (!group || group.state === 'notInWar') return { state: group?.state ?? 'notInCwl' };
  const seasonKey = uid(clanTag, 'CWL', group.season ?? new Date().toISOString().slice(0, 7));
  const roundCount = group.rounds?.length ?? 0;
  const startTimes = [];
  const endTimes = [];
  let stars = 0;
  let participantsNo = 0;
  for (const [index, round] of (group.rounds ?? []).entries()) {
    const roundNo = index + 1;
    for (const warTag of round.warTags ?? []) {
      if (!warTag || warTag === '#0') continue;
      try {
        const war = await getCwlWar(warTag);
        const saved = await saveCwlWar(war, seasonKey, roundNo, warTag);
        participantsNo += saved.participants;
        const start = iso(war.startTime);
        const end = iso(war.endTime);
        if (start) startTimes.push(start);
        if (end) endTimes.push(end);
        stars += Number(war.clan?.tag === clanTag ? war.clan?.stars ?? 0 : war.opponent?.stars ?? 0);
      } catch (error) {
        console.error(`[cwl:${warTag}]`, error.message);
      }
    }
  }
  await upsert('cwl_seasons', [{
    generated_cwl_id: seasonKey,
    season: group.season ?? null,
    state: group.state ?? null,
    rounds: roundCount,
    start_date: startTimes.length ? startTimes.sort()[0] : null,
    end_date: endTimes.length ? endTimes.sort().at(-1) : null,
    clan_stars: stars,
    data: group
  }]);
  return { season: seasonKey, rounds: roundCount, participants: participantsNo };
}

function capitalSeasonUid(raid) {
  return uid(clanTag, raid.startTime ?? raid.endTime ?? new Date().toISOString());
}

export async function syncCapital() {
  const response = await getCapitalRaids();
  const items = response.items ?? [];
  let seasons = 0;
  let participants = 0;
  let attacks = 0;
  for (const raid of items) {
    const seasonId = capitalSeasonUid(raid);
    const memberList = raid.members ?? [];
    const start = iso(raid.startTime);
    const end = iso(raid.endTime);
    await upsert('capital_raid_season', [{
      generated_uid: seasonId,
      raid_start: start,
      raid_end: end,
      state: raid.state ?? null,
      clan_name: raid.clan?.name ?? null,
      clan_id: raid.clan?.tag ?? clanTag,
      capital_trophies: raid.clan?.capitalLeague ?? null,
      total_loot: raid.clan?.capitalPoints ?? null,
      data: raid
    }]);
    const participantRows = memberList.map(m => {
      const attacks = m.attackLog ?? m.attacks ?? [];
      const used = attacks.length;
      const hasBonus = used > 5 || attacks.some(a => Number(a.stars ?? 0) === 3 || a.districtDestroyed === true || a.districtDestroyed === 'true');
      const available = hasBonus ? 6 : 5;
      return {
        capital_raid_uid: seasonId,
        player_id: m.tag,
        player_name: m.name,
        attacks_used: used,
        attacks_available: available,
        capital_loot: m.capitalResourcesLooted ?? m.capitalLoot ?? null,
        districts_destroyed: m.districtsDestroyed ?? null,
        data: m
      };
    });
    if (participantRows.length) {
      await upsert('capital_raid_participants', participantRows);
      participants += participantRows.length;
    }
    const attackRows = [];
    for (const m of memberList) for (const a of (m.attackLog ?? m.attacks ?? [])) {
      attackRows.push({
        generated_uid: uid(seasonId, m.tag, a.order ?? attackRows.length + 1),
        capital_raid_uid: seasonId,
        player_id: m.tag,
        player_name: m.name,
        attack_order: a.order ?? null,
        district_name: a.districtName ?? null,
        district_id: a.districtId ?? null,
        stars: a.stars ?? null,
        destruction: a.destructionPercentage ?? a.destruction ?? null,
        attacking_date_time: iso(a.attackTime),
        data: a
      });
    }
    if (attackRows.length) {
      await upsert('capital_raid_attacklog', attackRows);
      attacks += attackRows.length;
    }
    seasons++;
  }
  return { seasons, participants, attacks };
}
