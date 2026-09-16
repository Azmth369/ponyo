import 'dotenv/config';
import fs from 'node:fs/promises';
import { db, upsert } from './db.js';

const filePath = process.argv[2];
if (!filePath) throw new Error('Usage: npm run import:legacy -- <path-to-csv>');

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

const csv = await fs.readFile(filePath, 'utf8');
const rows = parseCsv(csv);
const required = ['clan_tag', 'context', 'context_ref', 'attacker_tag', 'attacker_name', 'defender_tag', 'defender_name', 'stars', 'destruction_percent', 'attack_order', 'recorded_at'];
for (const column of required) if (!rows.every(r => Object.hasOwn(r, column))) throw new Error(`CSV is missing required column: ${column}`);

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
  source: 'legacy_attack_log_csv',
  legacy_id: numberOrNull(row.id),
  original_context: row.context,
  original_context_ref: row.context_ref,
  original_recorded_at: row.recorded_at
});

const capitalRows = rows.filter(r => r.context.toLowerCase() === 'capital');
const warRows = rows.filter(r => r.context.toLowerCase() === 'war');
const unsupportedRows = rows.filter(r => !['capital', 'war'].includes(r.context.toLowerCase()));

if (unsupportedRows.length) {
  throw new Error(`Unsupported context values found: ${[...new Set(unsupportedRows.map(r => r.context))].join(', ')}`);
}

// Legacy Capital events get their own namespace so they can never overwrite
// a live/API-synced Capital season with the same start time.
const capitalSeasonKey = row => `legacy:capital:${row.clan_tag}:${row.context_ref}`;

const capitalAttackRows = [];
for (const row of capitalRows) {
  const match = String(row.defender_tag).match(/^([^:]+):(\d+)$/);
  if (!match) throw new Error(`Cannot parse Capital defender tag: ${row.defender_tag}`);
  const [, opponentTag, districtId] = match;
  capitalAttackRows.push({
    season_key: capitalSeasonKey(row),
    clan_tag: row.clan_tag,
    opponent_clan_tag: opponentTag,
    opponent_clan_name: row.defender_name?.replace(/\s+—\s+.*$/, '') || null,
    attacker_tag: row.attacker_tag,
    attacker_name: row.attacker_name || null,
    district_id: Number(districtId),
    district_name: row.defender_name?.split(' — ').slice(1).join(' — ') || null,
    attack_number: Number(row.attack_order) + 1,
    stars: numberOrNull(row.stars),
    destruction_percentage: numberOrNull(row.destruction_percent),
    duration_seconds: null,
    attack_time: null,
    observed_at: isoOrNull(row.recorded_at) ?? new Date().toISOString(),
    data: sourceData(row)
  });
}

const warAttackRows = [];
for (const row of warRows) {
  const warKey = `legacy:war:${row.clan_tag}:${row.context_ref}`;
  warAttackRows.push({
    war_key: warKey,
    clan_tag: row.clan_tag,
    attacker_tag: row.attacker_tag,
    attacker_name: row.attacker_name || null,
    defender_tag: row.defender_tag || null,
    defender_name: row.defender_name || null,
    stars: numberOrNull(row.stars),
    destruction_percentage: numberOrNull(row.destruction_percent),
    order_no: numberOrNull(row.attack_order),
    duration_seconds: null,
    attack_time: null,
    observed_at: isoOrNull(row.recorded_at) ?? new Date().toISOString(),
    data: sourceData(row)
  });
}

if (capitalAttackRows.length) await upsert('capital_attacks', capitalAttackRows);
if (warAttackRows.length) await upsert('war_attacks', warAttackRows);

// Add lightweight historical event records so the AI can discover imported events
// without pretending that missing summary fields are known.
const capitalSeasonKeys = [...new Set(capitalRows.map(capitalSeasonKey))];
for (const seasonKey of capitalSeasonKeys) {
  const seasonRows = capitalRows.filter(r => capitalSeasonKey(r) === seasonKey);
  const opponents = [...new Set(seasonRows.map(r => r.defender_tag.split(':')[0]))];
  const { data: existing } = await db.from('capital_raids').select('season_key').eq('season_key', seasonKey).maybeSingle();
  if (!existing) {
    await db.from('capital_raids').insert({
      clan_tag: seasonRows[0].clan_tag,
      season_key: seasonKey,
      data: {
        source: 'legacy_attack_log_csv',
        startTime: cocTimestampToIso(seasonRows[0].context_ref),
        importedAttackRows: seasonRows.length,
        opponentClanTags: opponents,
        note: 'Attack details imported from legacy CSV. Summary fields not present in the source were intentionally left unknown.'
      },
      synced_at: new Date().toISOString()
    });
  }
}

const warKeys = [...new Set(warRows.map(r => `legacy:war:${r.clan_tag}:${r.context_ref}`))];
for (const warKey of warKeys) {
  const eventRows = warRows.filter(r => `legacy:war:${r.clan_tag}:${r.context_ref}` === warKey);
  const defenders = [...new Set(eventRows.map(r => r.defender_name).filter(Boolean))];
  const clans = [...new Set(eventRows.map(r => r.clan_tag))];
  await upsert('wars', [{
    clan_tag: clans[0],
    war_key: warKey,
    state: 'legacy_import',
    start_time: cocTimestampToIso(eventRows[0].context_ref),
    end_time: null,
    data: {
      source: 'legacy_attack_log_csv',
      context: 'war',
      contextRef: eventRows[0].context_ref,
      importedAttackRows: eventRows.length,
      defenderNames: defenders,
      note: 'Only attack rows were present in the source CSV; opponent clan name, war result, members and timestamps were not inferred.'
    },
    synced_at: new Date().toISOString()
  }]);
}

console.log(JSON.stringify({
  source: filePath,
  totalRows: rows.length,
  imported: { capitalAttacks: capitalAttackRows.length, warAttacks: warAttackRows.length },
  createdEventRecords: { capitalSeasons: capitalSeasonKeys.length, wars: warKeys.length },
  unsupportedRows: unsupportedRows.length
}, null, 2));
