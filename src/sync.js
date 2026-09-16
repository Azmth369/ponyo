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

export async function run(job, fn) {
  const started = now();
  try {
    const details = await fn();
    await db.from('ai_chat').insert({ messenger: 'sync', context: { job, status: 'ok', details }, date_time: now() }).catch(() => {});
    return details;
  } catch (error) {
    await db.from('ai_chat').insert({ messenger: 'sync', context: { job, status: 'error', message: error.message }, date_time: now() }).catch(() => {});
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
  // A normal Clan War always grants two attacks. Keep this value even after the war
  // has ended so historical participant rows can still answer remaining-attack queries.
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
  const rows = (clan.memberList ?? []).map(m => ({
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
  if (captureSnapshots) for (const m of clan.memberList ?? []) {
    try {
      const player = await getPlayer(m.tag);
      await db.from('clan_info_snap').insert({ date_time: now(), player_id: m.tag, name: player.name ?? m.name, role: player.role ?? m.role ?? null, th: player.townHallLevel ?? m.townHallLevel ?? null, lvl: player.expLevel ?? m.expLevel ?? null, trophies: player.trophies ?? m.trophies ?? null, troops_donated: m.donations ?? null, troops_received: m.donationsReceived ?? null, data: player });
    } catch (error) { console.error(`[player:${m.tag}]`, error.message); }
  }
  return { members: rows.length, snapshots: captureSnapshots };
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
  let synced = 0;
  for (let i = 0; i < roundCount; i++) {
    const round = group.rounds[i];
    for (const warTag of round.warTags ?? []) {
      if (!warTag || warTag === '#0') continue;
      try {
        const war = await getCwlWar(warTag);
        if (war.clan?.tag === clanTag || war.opponent?.tag === clanTag) {
          const own = war.clan?.tag === clanTag ? war.clan : war.opponent;
          const saved = await saveCwlWar(war, seasonKey, i + 1, warTag);
          participantsNo = Math.max(participantsNo, saved.participants);
          stars += Number(own?.stars ?? 0);
          if (war.startTime) startTimes.push(iso(war.startTime));
          if (war.endTime) endTimes.push(iso(war.endTime));
          synced++;
        }
      } catch (error) { console.error(`[cwl:${warTag}]`, error.message); }
    }
  }
  await upsert('cwl_seasons', [{
    generated_cwl_id: seasonKey,
    battle_start: startTimes.filter(Boolean).sort()[0] ?? null,
    battle_end: endTimes.filter(Boolean).sort().at(-1) ?? null,
    stars_scored: stars,
    clan_participants_no: participantsNo,
    data: group
  }]);
  return { state: group.state, seasonKey, wars: synced };
}

function capitalSeasonUid(season) { return uid(clanTag, 'CAPITAL', season.startTime ?? season.endTime ?? JSON.stringify(season)); }

export async function syncCapital() {
  const data = await getCapitalRaids();
  let seasons = 0;
  let attacks = 0;
  for (const season of data.items ?? []) {
    const seasonUid = capitalSeasonUid(season);
    const members = season.members ?? [];
    const attackLog = season.attackLog ?? [];
    const totalLoot = Number(season.capitalTotalLoot ?? season.totalLoot ?? 0);
    const raidsWon = Number(season.raidsCompleted ?? season.raidsWon ?? 0);
    const attackUidByPlayer = new Map();
    const bonusAttackByPlayer = new Set();
    for (const entry of attackLog) {
      for (const district of entry.districts ?? []) {
        for (let i = 0; i < (district.attacks ?? []).length; i++) {
          const a = district.attacks[i];
          const attacker = a.attacker ?? {};
          const attackerId = attacker.tag ?? a.attackerTag;
          if (!attackerId) continue;
          const attackUid = uid(seasonUid, attackerId, district.id ?? district.districtId ?? '', i + 1, a.attackTime ?? '');
          if (!attackUidByPlayer.has(attackerId)) attackUidByPlayer.set(attackerId, attackUid);
          if (Number(a.stars ?? 0) >= 3) bonusAttackByPlayer.add(attackerId);
        }
      }
    }
    await upsert('capital_raid_season', [{
      generated_uid: seasonUid,
      battle_start: iso(season.startTime),
      battle_end: iso(season.endTime),
      total_loot: totalLoot,
      raids_won: raidsWon,
      total_attacks: Number(season.totalAttacks ?? 0),
      participants_no: members.length,
      absentees_no: 0,
      participants_name: members.map(m => m.name),
      absentees_name: [],
      data: season
    }]);
    if (members.length) await upsert('capital_raid_participants', members.map(m => {
      const attacksUsed = Number(m.attacks ?? m.attackCount ?? 0);
      const hasBonus = bonusAttackByPlayer.has(m.tag) || attacksUsed > 5;
      return {
        capital_raid_uid: seasonUid,
        player_name: m.name,
        player_id: m.tag,
        attacks_used: attacksUsed,
        attacks_available: hasBonus ? 6 : 5,
        total_loot_gained: Number(m.capitalResourcesLooted ?? 0),
        capital_raid_attack_uid: attackUidByPlayer.get(m.tag) ?? null,
        capital_raid_start: iso(season.startTime),
        capital_raid_end: iso(season.endTime),
        data: m
      };
    }));
    for (const entry of attackLog) {
      const opponent = entry.defender ?? {};
      for (const district of entry.districts ?? []) {
        const districtName = district.name ?? district.districtName ?? null;
        const districtId = district.id ?? district.districtId ?? null;
        for (let i = 0; i < (district.attacks ?? []).length; i++) {
          const a = district.attacks[i];
          const attacker = a.attacker ?? {};
          const attackerId = attacker.tag ?? a.attackerTag;
          if (!attackerId) continue;
          const attackUid = uid(seasonUid, attackerId, districtId, i + 1, a.attackTime ?? '');
          await upsert('capital_raid_attacklog', [{
            generated_uid: attackUid,
            raid_no: i + 1,
            clan_name: clanTag,
            district_name: districtName,
            attacker_name: attacker.name ?? null,
            star_scored: a.stars ?? null,
            destruction_caused: a.destructionPercent ?? a.destructionPercentage ?? null,
            loot_gained: Number(a.capitalResourcesLooted ?? a.loot ?? 0),
            attacking_date_time: iso(a.attackTime),
            attacker_id: attackerId,
            capital_raid_uid: seasonUid,
            data: { ...a, district, opponentClanTag: opponent.tag ?? null, opponentClanName: opponent.name ?? null }
          }]);
          attacks++;
        }
      }
    }
    seasons++;
  }
  return { seasons, attacks };
}

export async function syncOnce({ captureSnapshots = false, includeCwl = true } = {}) {
  await run('clan', () => syncClan(captureSnapshots));
  await run('current-war', syncWar);
  await run('war-history', syncHistory);
  await run('capital-raids', syncCapital);
  if (includeCwl) await run('cwl', syncCwl);
}

if (process.argv[1]?.endsWith('/sync.js')) { await syncOnce({ captureSnapshots: true }); console.log('Sync complete'); }
