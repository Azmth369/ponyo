// Human-readable UID system, mirroring the spreadsheet design in database/.
//
//   Normal Clan War: CW001           session
//                    CW001-ATK001    attack
//   CWL:             CWL001          season
//                     CWL001-D1       league day
//                      CWL001-D1-ATK01 attack
//   Capital Raid:    CR001           season
//                    CR001-R1        raid against one opponent
//                    CR001-R1-ATK001 attack
//
// The pure helpers below have no side effects so they can be unit-tested.
// The database-backed allocator lives in uidAlloc.js.

const seqPattern = prefix => new RegExp(`^${prefix}(\\d+)$`);

export function parseSeq(uid, prefix) {
  const match = String(uid ?? '').match(seqPattern(prefix));
  return match ? Number(match[1]) : null;
}

export function formatSeq(prefix, n, width = 3) {
  return `${prefix}${String(Math.max(1, Math.trunc(n))).padStart(width, '0')}`;
}

export function nextSeq(existingUids, prefix) {
  let max = 0;
  for (const uid of existingUids ?? []) {
    const n = parseSeq(uid, prefix);
    if (n != null && n > max) max = n;
  }
  return max + 1;
}

export const isLegacyUid = uid => typeof uid === 'string' && uid.startsWith('#');

export const warAttackUid = (cwUid, n) => `${cwUid}-ATK${String(n).padStart(3, '0')}`;
export const cwlDayUid = (seasonUid, day) => `${seasonUid}-D${day}`;
export const cwlAttackUid = (dayUid, n) => `${dayUid}-ATK${String(n).padStart(2, '0')}`;
export const capitalRaidUid = (seasonUid, raidNo) => `${seasonUid}-R${raidNo}`;
export const capitalAttackUid = (raidUid, n) => `${raidUid}-ATK${String(n).padStart(3, '0')}`;
