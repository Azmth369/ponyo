import 'dotenv/config';
import { db, upsert } from './db.js';
import { getClan, getCurrentWar, getWarLog, getCapitalRaids, getCwlGroup, getCwlWar, getPlayer } from './cocApi.js';

const clanTag = process.env.COC_CLAN_TAG;
const now = () => new Date().toISOString();

const iso = s => {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
};

const warKey = war => `${clanTag}:${war.startTime ?? war.createdDate ?? 'unknown'}:${war.endTime ?? 'unknown'}`;

export async function run(job, fn) {
  const started = now();
  try {
    const details = await fn();
    await db.from('sync_runs').insert({ job, status: 'ok', details, started_at: started, finished_at: now() });
    return details;
  } catch (error) {
    await db.from('sync_runs').insert({ job, status: 'error', details: { message: error.message }, started_at: started, finished_at: now() });
    console.error(`[${job}]`, error);
    return null;
  }
}

function attacksAvailableFor(state) { return state === 'preparation' || state === 'warEnded' || state === 'warlog' ? 0 : 2; }

async function normalizeWar(war, key, stateOverride = null, saveAttackTable = true) {
  const own = war.clan?.tag === clanTag ? war.clan : null;
  const opponent = war.clan?.tag === clanTag ? war.opponent : null;
  if (!own) return { members: 0, attacks: 0 };
  const state = stateOverride ?? war.state;
  const available = attacksAvailableFor(state);
  const ownMembers = own.members ?? [];
  const opponentByTag = new Map((opponent?.members ?? []).map(m => [m.tag, m]));

  const memberRows = ownMembers.map(m => ({
    war_key: key, clan_tag: clanTag, player_tag: m.tag, player_name: m.name,
    map_position: m.mapPosition ?? null, attacks_available: available,
    attacks_used: m.attacks?.length ?? 0,
    stars_earned: (m.attacks ?? []).reduce((sum, a) => sum + Number(a.stars ?? 0), 0),
    destruction_percentage: (m.attacks?.length ?? 0) ? m.attacks.reduce((sum, a) => sum + Number(a.destructionPercentage ?? 0), 0) / m.attacks.length : 0,
    data: m
  }));
  if (memberRows.length) await upsert('war_members', memberRows);

  if (!saveAttackTable) return { members: memberRows.length, attacks: 0, state };

  const attackRows = [];
  for (const m of ownMembers) for (const a of m.attacks ?? []) {
    const defender = opponentByTag.get(a.defenderTag);
    attackRows.push({
      war_key: key, clan_tag: clanTag, attacker_tag: m.tag, attacker_name: m.name,
      defender_tag: a.defenderTag ?? null, defender_name: a.defenderName ?? defender?.name ?? null,
      stars: a.stars ?? null, destruction_percentage: a.destructionPercentage ?? null,
      order_no: a.order ?? attackRows.length + 1,
      duration_seconds: a.duration ?? null,
      attack_time: iso(a.attackTime), observed_at: now(), data: a
    });
  }
  if (attackRows.length) await upsert('war_attacks', attackRows);
  return { members: memberRows.length, attacks: attackRows.length, state };
}

async function saveCwlAttacks(war, seasonKey, warTag, roundNo) {
  const own = war.clan?.tag === clanTag ? war.clan : null;
  const opponent = war.clan?.tag === clanTag ? war.opponent : war.clan;
  if (!own) return 0;
  const opponentByTag = new Map((opponent?.members ?? []).map(m => [m.tag, m]));
  const rows = [];
  for (const m of own.members ?? []) for (const a of m.attacks ?? []) {
    const defender = opponentByTag.get(a.defenderTag);
    rows.push({
      season_key: seasonKey, war_tag: warTag, round_no: roundNo, clan_tag: clanTag,
      attacker_tag: m.tag, attacker_name: m.name,
      defender_tag: a.defenderTag ?? null, defender_name: a.defenderName ?? defender?.name ?? null,
      stars: a.stars ?? null, destruction_percentage: a.destructionPercentage ?? null,
      order_no: a.order ?? rows.length + 1, duration_seconds: a.duration ?? null,
      attack_time: iso(a.attackTime), observed_at: now(), data: a
    });
  }
  if (rows.length) await upsert('cwl_attacks', rows);
  return rows.length;
}

export async function syncClan(captureSnapshots = false) {
  const clan = await getClan();
  await upsert('clans', [{ tag: clan.tag, data: clan, synced_at: now() }]);
  const rows = (clan.memberList ?? []).map(m => ({
    tag: m.tag, clan_tag: clan.tag, name: m.name, role: m.role ?? null,
    town_hall_level: m.townHallLevel ?? null, trophies: m.trophies ?? null,
    donations: m.donations ?? null, donations_received: m.donationsReceived ?? null,
    attack_wins: m.attackWins ?? null, defense_wins: m.defenseWins ?? null,
    data: m, updated_at: now()
  }));
  if (rows.length) await upsert('players', rows);
  if (captureSnapshots) for (const m of clan.memberList ?? []) {
    try { await db.from('player_snapshots').insert({ player_tag: m.tag, clan_tag: clan.tag, data: await getPlayer(m.tag) }); }
    catch (error) { console.error(`[player:${m.tag}]`, error.message); }
  }
  return { members: rows.length, snapshots: captureSnapshots };
}

export async function syncWar() {
  const war = await getCurrentWar();
  if (!war || war.state === 'notInWar') return { state: 'notInWar' };
  const key = warKey(war);
  await upsert('wars', [{ clan_tag: clanTag, war_key: key, state: war.state ?? null, start_time: iso(war.startTime), end_time: iso(war.endTime), data: war, synced_at: now() }]);
  return { state: war.state, warKey: key, ...(await normalizeWar(war, key)) };
}

export async function syncHistory() {
  const warlog = await getWarLog();
  let matchedExisting = 0;
  for (const war of warlog.items ?? []) {
    const endTime = iso(war.endTime);
    const { data: existingRows } = endTime
      ? await db.from('wars').select('war_key,start_time,end_time,data').eq('clan_tag', clanTag).eq('end_time', endTime).limit(1)
      : { data: [] };
    const existing = existingRows?.[0] ?? null;
    const key = existing?.war_key ?? warKey(war);
    if (existing) matchedExisting++;

    // Keep the full currentwar snapshot if we already captured this war. The
    // warlog response is summary-only and must not overwrite start time or
    // detailed attack/member data captured earlier.
    const mergedData = { ...(existing?.data ?? {}), ...war };
    await upsert('wars', [{
      clan_tag: clanTag,
      war_key: key,
      state: existing?.state === 'warEnded' ? 'warEnded' : 'warlog',
      start_time: existing?.start_time ?? iso(war.startTime),
      end_time: existing?.end_time ?? endTime,
      data: mergedData,
      synced_at: now()
    }]);

    // Ended warlog records are summary-only, so do not try to manufacture attack rows here.
    await normalizeWar({ ...war, state: 'warlog' }, key, 'warlog', false);
  }
  return { wars: (warlog.items ?? []).length, matched_existing: matchedExisting };
}

export async function syncCwl() {
  let group;
  try { group = await getCwlGroup(); }
  catch (error) {
    if (error.status === 404 && /notFound/i.test(error.message)) return { state: 'notInCwl' };
    throw error;
  }
  if (!group || group.state === 'notInWar') return { state: group?.state ?? 'notInCwl' };
  const seasonKey = `${clanTag}:${group.season ?? new Date().toISOString().slice(0, 7)}`;
  await upsert('cwl_seasons', [{ clan_tag: clanTag, season_key: seasonKey, data: group, synced_at: now() }]);
  let synced = 0;
  let attackLog = 0;
  for (let roundNo = 0; roundNo < (group.rounds ?? []).length; roundNo++) {
    const round = group.rounds[roundNo];
    for (const warTag of round.warTags ?? []) {
      if (!warTag || warTag === '#0') continue;
      try {
        const war = await getCwlWar(warTag);
        const own = war.clan?.tag === clanTag ? war.clan : war.opponent;
        const opponent = war.clan?.tag === clanTag ? war.opponent : war.clan;
        await upsert('cwl_rounds', [{ clan_tag: clanTag, season_key: seasonKey, round_no: roundNo + 1, opponent_tag: opponent?.tag ?? null, opponent_name: opponent?.name ?? null, state: war.state ?? null, data: round }]);
        await upsert('cwl_wars', [{ season_key: seasonKey, war_tag: warTag, clan_tag: clanTag, opponent_clan_tag: opponent?.tag ?? null, opponent_name: opponent?.name ?? null, state: war.state ?? null, data: war, synced_at: now() }]);
        if (own) {
          const result = await normalizeWar({ ...war, clan: own, state: war.state ?? 'warlog' }, `cwl:${warTag}`, war.state ?? 'warlog', false);
          attackLog += await saveCwlAttacks({ ...war, clan: own, opponent }, seasonKey, warTag, roundNo + 1);
          result.attackLog = attackLog;
        }
        synced++;
      } catch (error) { console.error(`[cwl:${warTag}]`, error.message); }
    }
  }
  return { state: group.state, seasonKey, wars: synced, attackLog };
}

function flattenCapitalAttacks(season, seasonKey) {
  const rows = [];
  for (const entry of season.attackLog ?? []) {
    const opponent = entry.defender ?? {};
    for (const district of entry.districts ?? []) {
      const districtId = district.id ?? district.districtId ?? null;
      const districtName = district.name ?? district.districtName ?? null;
      for (let index = 0; index < (district.attacks ?? []).length; index++) {
        const a = district.attacks[index];
        const attacker = a.attacker ?? {};
        const attackerTag = attacker.tag ?? a.attackerTag ?? null;
        if (!attackerTag) continue;
        rows.push({
          season_key: seasonKey, clan_tag: clanTag,
          opponent_clan_tag: opponent.tag ?? null, opponent_clan_name: opponent.name ?? null,
          attacker_tag: attackerTag, attacker_name: attacker.name ?? null,
          district_id: districtId, district_name: districtName,
          attack_number: index + 1,
          stars: a.stars ?? null,
          destruction_percentage: a.destructionPercent ?? a.destructionPercentage ?? null,
          duration_seconds: a.duration ?? null,
          attack_time: iso(a.attackTime), observed_at: now(),
          data: { ...a, district }
        });
      }
    }
  }
  return rows;
}

export async function syncCapital() {
  const data = await getCapitalRaids();
  let attackLog = 0;
  for (const season of data.items ?? []) {
    const key = `${clanTag}:${season.startTime ?? season.endTime ?? JSON.stringify(season)}`;
    await upsert('capital_raids', [{ clan_tag: clanTag, season_key: key, data: season, synced_at: now() }]);
    const rows = flattenCapitalAttacks(season, key);
    if (rows.length) { await upsert('capital_attacks', rows); attackLog += rows.length; }
  }
  return { seasons: (data.items ?? []).length, attackLog };
}

export async function syncOnce({ captureSnapshots = false, includeCwl = true } = {}) {
  await run('clan', () => syncClan(captureSnapshots));
  await run('current-war', syncWar);
  await run('war-history', syncHistory);
  await run('capital-raids', syncCapital);
  if (includeCwl) await run('cwl', syncCwl);
}

if (process.argv[1]?.endsWith('/sync.js')) { await syncOnce({ captureSnapshots: true }); console.log('Sync complete'); }