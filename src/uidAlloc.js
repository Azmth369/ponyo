// Database-backed UID allocation and natural-key lookups.
//
// The sync scheduler is single-writer (an overlap guard in index.js prevents
// concurrent syncs), so max+1 allocation is safe. Re-syncing the same event
// resolves to its existing UID through a natural-key lookup, so no duplicates
// are created when the current war or a league day is polled repeatedly.

import { db } from './db.js';
import { formatSeq, nextSeq, warWindowsOverlap } from './uids.js';

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

// PostgREST returns timestamptz as "2026-09-18T07:00:00+00:00" while the
// CoC API path produces "2026-09-18T07:00:00.000Z", so timestamps must be
// compared by instant, never by string equality (string comparison made every
// re-sync allocate a brand-new UID, duplicating each war/season ~10 times).
const sameInstant = (a, b) =>
  a != null && b != null && new Date(a).getTime() === new Date(b).getTime();

// A normal war session is identified by its battle window. The currentwar
// endpoint provides startTime; warlog entries only provide endTime, so both
// are accepted as identity.
export async function findWarSessionUid({ battleStart, battleEnd, opponentTag = null }) {
  const rows = await recentRows(
    'cw_session',
    'cw_uid,battle_start,battle_end,opponent_clan_id',
    [{ column: 'battle_start', ascending: false, nullsFirst: false }],
    300
  );
  // Prefer exact timestamp identity first; start/end values can be absent on
  // war-log summaries, so retain the matching fallbacks for those payloads.
  const exact = rows.find(r =>
    sameInstant(battleStart, r.battle_start) && sameInstant(battleEnd, r.battle_end)
  ) ?? rows.find(r => sameInstant(battleStart, r.battle_start))
    ?? rows.find(r => sameInstant(battleEnd, r.battle_end));
  if (exact) return exact.cw_uid;

  // During preparation -> inWar, CoC can change the reported time window.
  // A same-opponent overlapping window is a safe fallback because a clan cannot
  // have two normal wars running simultaneously. Never match by opponent alone.
  if (opponentTag && battleStart && battleEnd) {
    const normalizeTag = value => String(value ?? '').replace(/^#/, '').toUpperCase();
    const targetTag = normalizeTag(opponentTag);
    const overlapping = rows.find(r =>
      normalizeTag(r.opponent_clan_id) === targetTag &&
      warWindowsOverlap(battleStart, battleEnd, r.battle_start, r.battle_end)
    );
    if (overlapping) return overlapping.cw_uid;
  }
  return null;
}

// CWL seasons are identified by the league season date in the group payload.
export async function findCwlSeasonUid(season, clanTag) {
  if (season == null || !clanTag) return null;
  const normalizeTag = value => String(value ?? '').replace(/^#/, '').toUpperCase();
  const targetTag = normalizeTag(clanTag);
  const rows = await recentRows('cwl_seasons', 'generated_cwl_id,data', [{ column: 'battle_start', ascending: false, nullsFirst: false }], 500);
  const row = rows.find(r =>
    r.data?.season === season &&
    Array.isArray(r.data?.clans) &&
    r.data.clans.some(clan => normalizeTag(clan.tag) === targetTag)
  );
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
  const row = rows.find(r => sameInstant(battleStart, r.battle_start));
  return row?.generated_uid ?? null;
}
