// One-time migration: converts legacy timestamp-based UIDs
// (e.g. "#TAG:20260915T071500.000Z:...") to the human-readable scheme
// (CW001, CW001-ATK001, CWL001-D1, CR001-R1-ATK001).
//
// Runs automatically at startup before the sync scheduler starts. It is a
// no-op once no legacy-format UIDs remain, and it is safe to re-run.

import { db } from './db.js';
import {
  formatSeq, nextSeq, parseSeq, isLegacyUid,
  warAttackUid, cwlDayUid, cwlAttackUid,
  capitalRaidUid, capitalAttackUid
} from './uids.js';

async function fetchAll(table, select, orders, limit = 5000) {
  let q = db.from(table).select(select);
  for (const { column, ascending = true, nullsFirst } of orders) {
    const opts = { ascending };
    if (nullsFirst != null) opts.nullsFirst = nullsFirst;
    q = q.order(column, opts);
  }
  const { data, error } = await q.limit(limit);
  if (error) throw error;
  return data ?? [];
}

async function hasLegacyRows(table, column) {
  const rows = await fetchAll(table, column, [{ column, ascending: true }], 5000);
  return rows.some(row => isLegacyUid(row[column]));
}

export async function migrateLegacyUids() {
  const results = {};
  if (await hasLegacyRows('cw_session', 'cw_uid')) results.normalWars = await migrateNormalWars();
  if (await hasLegacyRows('cwl_seasons', 'generated_cwl_id')) results.cwl = await migrateCwl();
  if (await hasLegacyRows('capital_raid_season', 'generated_uid')) results.capital = await migrateCapital();
  return Object.keys(results).length ? results : null;
}

// ---------------------------------------------------------------------------
// Normal wars
// ---------------------------------------------------------------------------

async function migrateNormalWars() {
  const sessions = await fetchAll(
    'cw_session', '*',
    [{ column: 'battle_start', ascending: true, nullsFirst: true }],
    5000
  );
  const existingMax = Math.max(0, ...sessions.map(s => parseSeq(s.cw_uid, 'CW') ?? 0));
  const legacy = sessions.filter(s => isLegacyUid(s.cw_uid));

  let seq = existingMax;
  for (const session of legacy) {
    const oldUid = session.cw_uid;
    seq += 1;
    const newUid = formatSeq('CW', seq);

    const attacks = await fetchAll(
      'cw_attacklog', '*',
      [{ column: 'attacking_date_time', ascending: true, nullsFirst: true }, { column: 'index_no', ascending: true }],
      500
    ).then(rows => rows.filter(a => a.cw_uid === oldUid));

    const attackMap = new Map();
    attacks.forEach((attack, index) => {
      attackMap.set(attack.cw_attack_uid, warAttackUid(newUid, index + 1));
    });

    if (attacks.length) {
      const removed = await db.from('cw_attacklog').delete().eq('cw_uid', oldUid);
      if (removed.error) throw removed.error;
      const reinserted = attacks.map(attack => ({
        ...attack,
        cw_attack_uid: attackMap.get(attack.cw_attack_uid),
        cw_uid: newUid
      }));
      const { error } = await db.from('cw_attacklog').insert(reinserted);
      if (error) throw error;
    }

    const participants = await fetchAll(
      'cw_session_participants', '*',
      [{ column: 'player_map_position', ascending: true }],
      200
    ).then(rows => rows.filter(p => p.cw_uid === oldUid));

    for (const p of participants) {
      const newList = String(p.cw_attack_uid ?? '')
        .split(',')
        .filter(Boolean)
        .map(old => attackMap.get(old))
        .filter(Boolean)
        .join(',');
      const { error } = await db.from('cw_session_participants')
        .update({ cw_uid: newUid, cw_attack_uid: newList || null })
        .eq('index_no', p.index_no);
      if (error) throw error;
    }

    const { error } = await db.from('cw_session').update({ cw_uid: newUid }).eq('cw_uid', oldUid);
    if (error) throw error;
  }

  return { sessions: legacy.length };
}

// ---------------------------------------------------------------------------
// CWL
// ---------------------------------------------------------------------------

async function migrateCwl() {
  const seasons = await fetchAll(
    'cwl_seasons', '*',
    [{ column: 'battle_start', ascending: true, nullsFirst: true }],
    1000
  );
  const existingMax = Math.max(0, ...seasons.map(s => parseSeq(s.generated_cwl_id, 'CWL') ?? 0));
  const seasonMap = new Map(); // old season uid -> new CWLxxx

  let seq = existingMax;
  for (const season of seasons) {
    if (!isLegacyUid(season.generated_cwl_id)) continue;
    seq += 1;
    seasonMap.set(season.generated_cwl_id, formatSeq('CWL', seq));
  }

  // Old day UIDs embed their season UID before ":DAY", e.g.
  // "#TAG:CWL:2026-09:DAY2:#war" -> season "#TAG:CWL:2026-09".
  const seasonUidOf = dayUid => dayUid?.split(':DAY')[0] ?? null;

  const days = await fetchAll(
    'cwl_daywise_attacklog', '*',
    [{ column: 'battle_start', ascending: true, nullsFirst: true }, { column: 'battle_day', ascending: true }],
    3000
  );
  const legacyDays = days.filter(d => isLegacyUid(d.generated_cwl_day_id));
  const dayMap = new Map(); // old day uid -> new CWL001-Dn

  for (const day of legacyDays) {
    const oldSeason = seasonUidOf(day.generated_cwl_day_id);
    const seasonUid = seasonMap.get(oldSeason) ?? formatSeq('CWL', existingMax + 1);
    dayMap.set(day.generated_cwl_day_id, cwlDayUid(seasonUid, day.battle_day ?? 1));
  }

  for (const day of legacyDays) {
    const oldDayUid = day.generated_cwl_day_id;
    const newDayUid = dayMap.get(oldDayUid);

    const attacks = await fetchAll(
      'cwl_attacklog', '*',
      [{ column: 'attacking_date_time', ascending: true, nullsFirst: true }, { column: 'index_no', ascending: true }],
      2000
    ).then(rows => rows.filter(a => a.cwl_day_uid === oldDayUid));

    const attackMap = new Map();
    attacks.forEach((attack, index) => {
      attackMap.set(attack.generated_cwl_attack_uid, cwlAttackUid(newDayUid, index + 1));
    });

    if (attacks.length) {
      const removed = await db.from('cwl_attacklog').delete().eq('cwl_day_uid', oldDayUid);
      if (removed.error) throw removed.error;
      const { error } = await db.from('cwl_attacklog').insert(
        attacks.map(attack => ({
          ...attack,
          generated_cwl_attack_uid: attackMap.get(attack.generated_cwl_attack_uid),
          cwl_day_uid: newDayUid
        }))
      );
      if (error) throw error;
    }

    const participants = await fetchAll(
      'cwl_season_participants', '*',
      [{ column: 'player_map_position', ascending: true }],
      1000
    ).then(rows => rows.filter(p => p.cwl_day_uid === oldDayUid));

    for (const p of participants) {
      const { error } = await db.from('cwl_season_participants')
        .update({
          cwl_day_uid: newDayUid,
          cwl_attack_uid: p.cwl_attack_uid ? (attackMap.get(p.cwl_attack_uid) ?? null) : null
        })
        .eq('index_no', p.index_no);
      if (error) throw error;
    }

    const { error } = await db.from('cwl_daywise_attacklog')
      .update({ generated_cwl_day_id: newDayUid })
      .eq('index_no', day.index_no);
    if (error) throw error;
  }

  for (const [oldSeasonUid, newSeasonUid] of seasonMap) {
    const { error } = await db.from('cwl_seasons')
      .update({ generated_cwl_id: newSeasonUid })
      .eq('generated_cwl_id', oldSeasonUid);
    if (error) throw error;
  }

  return { seasons: seasonMap.size, days: legacyDays.length };
}

// ---------------------------------------------------------------------------
// Capital raids
// ---------------------------------------------------------------------------

async function migrateCapital() {
  const seasons = await fetchAll(
    'capital_raid_season', '*',
    [{ column: 'battle_start', ascending: true, nullsFirst: true }],
    1000
  );
  const existingMax = Math.max(0, ...seasons.map(s => parseSeq(s.generated_uid, 'CR') ?? 0));
  const seasonMap = new Map();

  let seq = existingMax;
  for (const season of seasons) {
    if (!isLegacyUid(season.generated_uid)) continue;
    seq += 1;
    seasonMap.set(season.generated_uid, formatSeq('CR', seq));
  }

  for (const [oldSeasonUid, newSeasonUid] of seasonMap) {
    const attacks = await fetchAll(
      'capital_raid_attacklog', '*',
      [{ column: 'index_no', ascending: true }],
      5000
    ).then(rows => rows.filter(a => a.capital_raid_uid === oldSeasonUid));

    // Group attacks by defender clan in first-seen order -> R1, R2, ...
    const raidNumbers = new Map();
    for (const attack of attacks) {
      const clanName = attack.clan_name ?? attack.data?.defenderClanName ?? null;
      if (!raidNumbers.has(clanName)) raidNumbers.set(clanName, raidNumbers.size + 1);
    }

    const attackMap = new Map();
    const raidCounters = new Map();
    for (const attack of attacks) {
      const clanName = attack.clan_name ?? attack.data?.defenderClanName ?? null;
      const raidNo = raidNumbers.get(clanName) ?? 1;
      const counter = (raidCounters.get(raidNo) ?? 0) + 1;
      raidCounters.set(raidNo, counter);
      const raidUid = capitalRaidUid(newSeasonUid, raidNo);
      attackMap.set(attack.generated_uid, {
        uid: capitalAttackUid(raidUid, counter),
        raidNo
      });
    }

    if (attacks.length) {
      const removed = await db.from('capital_raid_attacklog').delete().eq('capital_raid_uid', oldSeasonUid);
      if (removed.error) throw removed.error;
      const { error } = await db.from('capital_raid_attacklog').insert(
        attacks.map(attack => ({
          ...attack,
          generated_uid: attackMap.get(attack.generated_uid)?.uid ?? attack.generated_uid,
          raid_no: attackMap.get(attack.generated_uid)?.raidNo ?? null,
          capital_raid_uid: newSeasonUid
        }))
      );
      if (error) throw error;
    }

    const participants = await fetchAll(
      'capital_raid_participants', '*',
      [{ column: 'player_name', ascending: true }],
      2000
    ).then(rows => rows.filter(p => p.capital_raid_uid === oldSeasonUid));

    for (const p of participants) {
      const { error } = await db.from('capital_raid_participants')
        .update({ capital_raid_uid: newSeasonUid })
        .eq('index_no', p.index_no);
      if (error) throw error;
    }

    const { error } = await db.from('capital_raid_season')
      .update({ generated_uid: newSeasonUid })
      .eq('generated_uid', oldSeasonUid);
    if (error) throw error;
  }

  return { seasons: seasonMap.size };
}
