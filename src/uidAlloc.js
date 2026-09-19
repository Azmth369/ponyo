// Database-backed UID allocation and natural-key lookups.
//
// The sync scheduler is single-writer (an overlap guard in index.js prevents
// concurrent syncs), so max+1 allocation is safe. Re-syncing the same event
// resolves to its existing UID through a natural-key lookup, so no duplicates
// are created when the current war or a league day is polled repeatedly.

import { db } from './db.js';
import { formatSeq, nextSeq } from './uids.js';

async function selectUids(table, column, limit = 5000) {
  const { data, error } = await db.from(table).select(column).limit(limit);
  if (error) throw error;
  return (data ?? []).map(row => row[column]).filter(Boolean);
}

// Allocate the next sequential UID of the form CW047 / CWL012 / CR003.
export async function allocateSeq(table, column, prefix, width = 3) {
  const uids = await selectUids(table, column);
  return formatSeq(prefix, nextSeq(uids, prefix), width);
}

async function recentRows(table, select, orders, limit) {
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

// A normal war session is identified by its battle window. The currentwar
// endpoint provides startTime; warlog entries only provide endTime, so both
// are accepted as identity.
export async function findWarSessionUid({ battleStart, battleEnd }) {
  const rows = await recentRows(
    'cw_session',
    'cw_uid,battle_start,battle_end',
    [{ column: 'battle_start', ascending: false, nullsFirst: false }],
    300
  );
  const row = rows.find(r =>
    (battleStart != null && r.battle_start === battleStart) ||
    (battleEnd != null && r.battle_end === battleEnd)
  );
  return row?.cw_uid ?? null;
}

// CWL seasons are identified by the league season date in the group payload.
export async function findCwlSeasonUid(season) {
  if (season == null) return null;
  const rows = await recentRows('cwl_seasons', 'generated_cwl_id,data', [{ column: 'battle_start', ascending: false, nullsFirst: false }], 500);
  const row = rows.find(r => r.data?.season === season);
  return row?.generated_cwl_id ?? null;
}

// CWL league days are identified by their war tag (stored inside data).
export async function findCwlDayUid(warTag) {
  if (!warTag) return null;
  const rows = await recentRows('cwl_daywise_attacklog', 'generated_cwl_day_id,data', [{ column: 'battle_day', ascending: true }], 2000);
  const row = rows.find(r => r.data?.warTag === warTag);
  return row?.generated_cwl_day_id ?? null;
}

// Capital raid seasons are identified by their battle start.
export async function findCapitalSeasonUid(battleStart) {
  if (battleStart == null) return null;
  const rows = await recentRows('capital_raid_season', 'generated_uid,battle_start', [{ column: 'battle_start', ascending: false, nullsFirst: false }], 200);
  const row = rows.find(r => r.battle_start === battleStart);
  return row?.generated_uid ?? null;
}
