// One-time importer for legacy attack-log CSV exports (from the old
// coc-watcher database) into the Ponyo schema with the CW/CR UID system.
//
// Usage: npm run import:legacy -- <path-to-csv>
//
// Imported events are marked with data.source = 'legacy_attack_log_csv' so
// they can be identified, and re-running the importer is idempotent for
// legacy events (existing legacy sessions are reused instead of duplicated).

import 'dotenv/config';
import fs from 'node:fs/promises';
import { db, upsert } from './db.js';
import { warAttackUid, capitalRaidUid, capitalAttackUid, formatSeq, nextSeq } from './uids.js';

const filePath = process.argv[2];
if (!filePath) throw new Error('Usage: npm run import:legacy -- <path-to-csv>');

const clanTag = process.env.COC_CLAN_TAG;
const SOURCE = 'legacy_attack_log_csv';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }

  if (!rows.length) return [];
  const headers = rows.shift().map(h => h.trim());
  return rows.filter(r => r.some(v => String(v ?? '').trim() !== '')).map(values =>
    Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']))
  );
}

const numberOrNull = value => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const isoOrNull = value => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const cocTimestampToIso = value => {
  const m = String(value ?? '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z?$/);
  if (!m) return isoOrNull(value);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
};

const sourceData = row => ({
  source: SOURCE,
  legacy_id: numberOrNull(row.id),
  original_context: row.context,
  original_context_ref: row.context_ref,
  original_recorded_at: row.recorded_at
});

// Allocate the next sequential UID that does not collide with existing rows.
async function allocateLegacySeq(table, column, prefix) {
  const { data, error } = await db.from(table).select(column).limit(5000);
  if (error) throw error;
  return formatSeq(prefix, nextSeq((data ?? []).map(r => r[column]), prefix));
}

async function findLegacySession(table, column, battleStart) {
  const { data, error } = await db.from(table).select(`${column},data,battle_start`).limit(5000);
  if (error) throw error;
  return (data ?? []).find(r => r.battle_start === battleStart && r.data?.source === SOURCE) ?? null;
}

const csv = await fs.readFile(filePath, 'utf8');
const rows = parseCsv(csv);
const required = ['clan_tag', 'context', 'context_ref', 'attacker_tag', 'attacker_name', 'defender_tag', 'defender_name', 'stars', 'destruction_percent', 'attack_order', 'recorded_at'];
for (const column of required) if (!rows.every(r => Object.hasOwn(r, column))) throw new Error(`CSV is missing required column: ${column}`);

const capitalRows = rows.filter(r => r.context.toLowerCase() === 'capital');
const warRows = rows.filter(r => r.context.toLowerCase() === 'war');
const unsupportedRows = rows.filter(r => !['capital', 'war'].includes(r.context.toLowerCase()));
if (unsupportedRows.length) {
  throw new Error(`Unsupported context values found: ${[...new Set(unsupportedRows.map(r => r.context))].join(', ')}`);
}

// ---------------------------------------------------------------------------
// Normal wars
// ---------------------------------------------------------------------------

const warGroups = new Map(); // context_ref -> rows
for (const row of warRows) {
  const key = `${row.clan_tag}:${row.context_ref}`;
  if (!warGroups.has(key)) warGroups.set(key, []);
  warGroups.get(key).push(row);
}

let importedWarAttacks = 0;
let createdWars = 0;

for (const [key, eventRows] of warGroups) {
  const battleStart = cocTimestampToIso(eventRows[0].context_ref);
  const sorted = [...eventRows].sort((a, b) => (numberOrNull(a.attack_order) ?? 0) - (numberOrNull(b.attack_order) ?? 0));

  const existing = battleStart ? await findLegacySession('cw_session', 'cw_uid', battleStart) : null;
  const cwUid = existing?.cw_uid ?? await allocateLegacySeq('cw_session', 'cw_uid', 'CW');
  if (!existing) createdWars++;

  // Lightweight historical session record: only attack rows were present in
  // the source CSV, so unknown summary fields are intentionally left null.
  const attackers = [...new Set(sorted.map(r => r.attacker_tag))];
  await upsert('cw_session', [{
    cw_uid: cwUid,
    opponent_clan_name: null,
    opponent_clan_id: null,
    size: attackers.length || null,
    battle_start: battleStart,
    battle_end: null,
    result: null,
    participants_size: attackers.length,
    our_participants: attackers.map(tag => ({ player_id: tag, name: sorted.find(r => r.attacker_tag === tag)?.attacker_name ?? null, map_position: null })),
    opponent_participants: [],
    data: {
      source: SOURCE,
      context: 'war',
      contextRef: eventRows[0].context_ref,
      clanTag: eventRows[0].clan_tag,
      importedAttackRows: sorted.length,
      note: 'Only attack rows were present in the source CSV; opponent clan name, war result and timestamps were not inferred.'
    }
  }]);

  const removed = await db.from('cw_attacklog').delete().eq('cw_uid', cwUid);
  if (removed.error) throw removed.error;

  const attackRows = sorted.map((row, index) => ({
    cw_attack_uid: warAttackUid(cwUid, index + 1),
    attacker_clan_name: null,
    attacker_clan_id: row.clan_tag ?? clanTag ?? null,
    attacker_name_with_map_position: row.attacker_name || null,
    defender_name_with_map_position: row.defender_name || null,
    star_scored: numberOrNull(row.stars),
    destruction_caused: numberOrNull(row.destruction_percent),
    attacking_date_time: null,
    attacker_id: row.attacker_tag,
    cw_uid: cwUid,
    data: sourceData(row)
  }));
  if (attackRows.length) {
    await upsert('cw_attacklog', attackRows);
    importedWarAttacks += attackRows.length;
  }

  const participants = attackers.map(tag => {
    const own = attackRows.filter(a => a.attacker_id === tag);
    return {
      cw_uid: cwUid,
      player_name: own[0]?.attacker_name_with_map_position ?? null,
      player_id: tag,
      attacks_used: own.length,
      attacks_available: 2,
      stars_scored: own.reduce((s, a) => s + Number(a.star_scored ?? 0), 0),
      destruction_caused: own.length ? own.reduce((s, a) => s + Number(a.destruction_caused ?? 0), 0) / own.length : 0,
      cw_attack_uid: own.map(a => a.cw_attack_uid).join(',') || null,
      player_map_position: null,
      battle_start: battleStart,
      battle_end: null,
      size: attackers.length || null,
      data: { source: SOURCE }
    };
  });
  if (participants.length) await upsert('cw_session_participants', participants);
}

// ---------------------------------------------------------------------------
// Capital raids
// ---------------------------------------------------------------------------

const capitalGroups = new Map();
for (const row of capitalRows) {
  const key = `${row.clan_tag}:${row.context_ref}`;
  if (!capitalGroups.has(key)) capitalGroups.set(key, []);
  capitalGroups.get(key).push(row);
}

let importedCapitalAttacks = 0;
let createdCapitalSeasons = 0;

for (const [key, seasonRows] of capitalGroups) {
  const battleStart = cocTimestampToIso(seasonRows[0].context_ref);

  const existing = battleStart ? await findLegacySession('capital_raid_season', 'generated_uid', battleStart) : null;
  const seasonUid = existing?.generated_uid ?? await allocateLegacySeq('capital_raid_season', 'generated_uid', 'CR');
  if (!existing) createdCapitalSeasons++;

  await upsert('capital_raid_season', [{
    generated_uid: seasonUid,
    battle_start: battleStart,
    battle_end: null,
    total_loot: null,
    raids_won: null,
    total_attacks: seasonRows.length,
    participants_no: [...new Set(seasonRows.map(r => r.attacker_tag))].length,
    participants_name: [...new Set(seasonRows.map(r => r.attacker_name).filter(Boolean))],
    absentees_name: [],
    data: {
      source: SOURCE,
      contextRef: seasonRows[0].context_ref,
      clanTag: seasonRows[0].clan_tag,
      note: 'Attack details imported from legacy CSV. Summary fields not present in the source were intentionally left unknown.'
    }
  }]);

  const removed = await db.from('capital_raid_attacklog').delete().eq('capital_raid_uid', seasonUid);
  if (removed.error) throw removed.error;

  // Raids (defender clans) are numbered by first appearance, matching the
  // live sync's grouping behaviour.
  const raidNumbers = new Map();
  let attackNo = 0;
  const attackRows = [];
  for (const row of seasonRows) {
    const match = String(row.defender_tag).match(/^([^:]+):(\d+)$/);
    if (!match) throw new Error(`Cannot parse Capital defender tag: ${row.defender_tag}`);
    const [, opponentTag, districtId] = match;
    const opponentName = row.defender_name?.replace(/\s+—\s+.*$/, '') || null;
    const identity = `${opponentTag}|${opponentName}`;
    if (!raidNumbers.has(identity)) raidNumbers.set(identity, raidNumbers.size + 1);
    const raidNo = raidNumbers.get(identity);
    attackNo++;
    attackRows.push({
      generated_uid: capitalAttackUid(capitalRaidUid(seasonUid, raidNo), attackNo),
      raid_no: raidNo,
      clan_name: opponentName,
      district_name: row.defender_name?.split(' — ').slice(1).join(' — ') || null,
      attacker_name: row.attacker_name || null,
      star_scored: numberOrNull(row.stars),
      destruction_caused: numberOrNull(row.destruction_percent),
      loot_gained: null,
      attacking_date_time: null,
      attacker_id: row.attacker_tag,
      capital_raid_uid: seasonUid,
      data: { ...sourceData(row), districtId: Number(districtId), opponentClanTag: opponentTag }
    });
  }
  if (attackRows.length) {
    await upsert('capital_raid_attacklog', attackRows);
    importedCapitalAttacks += attackRows.length;
  }

  const participants = [...new Set(seasonRows.map(r => r.attacker_tag))].map(tag => {
    const own = attackRows.filter(a => a.attacker_id === tag);
    return {
      capital_raid_uid: seasonUid,
      player_name: own[0]?.attacker_name ?? seasonRows.find(r => r.attacker_tag === tag)?.attacker_name ?? null,
      player_id: tag,
      attacks_used: own.length,
      attacks_available: null,
      total_loot_gained: null,
      capital_raid_attack_uid: own.map(a => a.generated_uid).join(',') || null,
      capital_raid_start: battleStart,
      capital_raid_end: null,
      data: { source: SOURCE }
    };
  });
  if (participants.length) await upsert('capital_raid_participants', participants);
}

console.log(JSON.stringify({
  source: filePath,
  totalRows: rows.length,
  imported: { capitalAttacks: importedCapitalAttacks, warAttacks: importedWarAttacks },
  createdEventRecords: { capitalSeasons: createdCapitalSeasons, wars: createdWars },
  unsupportedRows: unsupportedRows.length
}, null, 2));
