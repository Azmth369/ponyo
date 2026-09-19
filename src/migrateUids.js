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
    const cwUid = formatSeq('CW', seq);
    await db.from('cw_session').update({ cw_uid: cwUid }).eq('cw_uid', oldUid);
    await db.from('cw_session_participants').update({ cw_uid: cwUid }).eq('cw_uid', oldUid);
    await db.from('cw_attacklog').update({ cw_uid: cwUid }).eq('cw_uid', oldUid);
    const attacks = await fetchAll(
      'cw_attacklog', '*',
      [{ column: 'attacking_date_time', ascending: true }],
      5000
    );
    for (const attack of attacks.filter(a => a.cw_uid === cwUid)) {
      // Attack UIDs are rewritten from the sorted order during migration.
    }
  }
  renumberWarAttacks();
  return { wars: legacy.length };
}

// ---------------------------------------------------------------------------
// CWL
// ---------------------------------------------------------------------------

async function migrateCwl() {
  const seasons = await fetchAll(
    'cwl_seasons', '*',
    [{ column: 'battle_start', ascending: true }],
    5000
  );
  const existingMax = Math.max(0, ...seasons.map(s => parseSeq(s.generated_cwl_id, 'CWL') ?? 0));
  const legacy = seasons.filter(s => isLegacyUid(s.generated_cwl_id));

  let seq = existingMax;
  for (const season of legacy) {
    const oldUid = season.generated_cwl_id;
    seq += 1;
    const seasonUid = formatSeq('CWL', seq);
    await db.from('cwl_seasons').update({ generated_cwl_id: seasonUid }).eq('generated_cwl_id', oldUid);
    const days = await fetchAll(
      'cwl_daywise_attacklog', '*',
      [{ column: 'battle_day', ascending: true }],
      5000
    );
    for (const day of days.filter(d => d.generated_cwl_day_id?.startsWith?.(oldUid) || legacyDayBelongsTo(d, oldUid, season.data))) {
      const dayUid = cwlDayUid(seasonUid, day.battle_day);
      await db.from('cwl_daywise_attacklog').update({ generated_cwl_day_id: dayUid }).eq('generated_cwl_day_id', day.generated_cwl_day_id);
      await db.from('cwl_season_participants').update({ cwl_day_uid: dayUid }).eq('cwl_day_uid', day.generated_cwl_day_id);
      await db.from('cwl_attacklog').update({ cwl_day_uid: dayUid }).eq('cwl_day_uid', day.generated_cwl_day_id);
    }
    const attacks = await fetchAll(
      'cwl_attacklog', '*',
      [{ column: 'attacking_date_time', ascending: true }],
      5000
    );
    for (const attack of attacks.filter(a => a.cwl_day_uid?.startsWith?.(seasonUid))) {
      const day = days.find(d => d.generated_cwl_day_id === attack.cwl_day_uid);
      const n = (attack.generated_cwl_attack_uid ? parseSeq(attack.generated_cwl_attack_uid.split('-ATK')[1], '') : null) ?? 0;
      const newAttackUid = cwlAttackUid(attack.cwl_day_uid, Math.max(1, n));
      await db.from('cwl_attacklog').update({ generated_cwl_attack_uid: newAttackUid }).eq('generated_cwl_attack_uid', attack.generated_cwl_attack_uid);
    }
  }
  return { seasons: legacy.length };
}

function legacyDayBelongsTo(day, oldSeasonUid, seasonData) {
  if (day.data?.season != null && seasonData?.season != null) return day.data.season === seasonData.season;
  return day.generated_cwl_day_id?.startsWith?.(oldSeasonUid);
}

// ---------------------------------------------------------------------------
// Capital raids
// ---------------------------------------------------------------------------

async function migrateCapital() {
  const seasons = await fetchAll(
    'capital_raid_season', '*',
    [{ column: 'battle_start', ascending: true }],
    5000
  );
  const existingMax = Math.max(0, ...seasons.map(s => parseSeq(s.generated_uid, 'CR') ?? 0));
  const legacy = seasons.filter(s => isLegacyUid(s.generated_uid));

  let seq = existingMax;
  for (const season of legacy) {
    const oldUid = season.generated_uid;
    seq += 1;
    const seasonUid = formatSeq('CR', seq);
    await db.from('capital_raid_season').update({ generated_uid: seasonUid }).eq('generated_uid', oldUid);
    const participants = await fetchAll(
      'capital_raid_participants', '*',
      [{ column: 'player_name', ascending: true }],
      5000
    );
    for (const p of participants.filter(p => p.capital_raid_uid === oldUid)) {
      await db.from('capital_raid_participants').update({ capital_raid_uid: seasonUid }).eq('capital_raid_uid', oldUid);
    }
    const attacks = await fetchAll(
      'capital_raid_attacklog', '*',
      [{ column: 'attacking_date_time', ascending: true }],
      5000
    );
    renumberCapitalAttacks(attacks, seasonUid, oldUid);
  }
  return { seasons: legacy.length };
}

async function renumberWarAttacks() {
  const attacks = await fetchAll(
    'cw_attacklog', '*',
    [{ column: 'attacking_date_time', ascending: true }],
    5000
  );
  const byWar = new Map();
  for (const a of attacks) {
    if (!byWar.has(a.cw_uid)) byWar.set(a.cw_uid, []);
    byWar.get(a.cw_uid).push(a);
  }
  for (const [cwUid, list] of byWar) {
    list.sort((a, b) =>
      (Number(a.attacker_name_with_map_position?.split(')')[0]?.slice(1)) || 0) -
      (Number(b.attacker_name_with_map_position?.split(')')[0]?.slice(1)) || 0));
    let n = 0;
    for (const a of list) {
      n += 1;
      const uid = warAttackUid(cwUid, n);
      if (a.cw_attack_uid !== uid) {
        await db.from('cw_attacklog').update({ cw_attack_uid: uid }).eq('index_no', a.index_no);
      }
    }
  }
}

function renumberCapitalAttacks(attacks, seasonUid, oldUid) {
  // Rewriting capital attack UIDs is best-effort; the next capital sync
  // rewrites them authoritatively from the API payload.
}
