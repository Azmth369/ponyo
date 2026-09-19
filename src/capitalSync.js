// Capital Raid sync: writes capital_raid_season, capital_raid_participants
// and capital_raid_attacklog using the CR001 / CR001-R1-ATK001 UID system.
// A "raid" (R1, R2, ...) is one attacked defender clan within the weekend.

import 'dotenv/config';
import { db, upsert } from './db.js';
import { getCapitalRaids, getClan } from './cocApi.js';
import { cocStamp, capitalAttackRows, participantStats } from './transform.js';
import { allocateSeq, findCapitalSeasonUid } from './uidAlloc.js';

// Pure transforms are re-exported for compatibility with older imports.
export { cocStamp, capitalAttackRows, participantStats };

async function rosterAtOrBefore(dateTime) {
  // Prefer a clan snapshot from the raid start so absentees are compared
  // with the roster that existed when the Raid Weekend began.
  if (dateTime) {
    const { data: latest, error: latestError } = await db
      .from('clan_info_snap')
      .select('date_time')
      .lte('date_time', dateTime)
      .order('date_time', { ascending: false })
      .limit(1);
    if (latestError) throw latestError;

    if (latest?.length) {
      const snapshotTime = latest[0].date_time;
      const { data: snapshot, error } = await db
        .from('clan_info_snap')
        .select('player_id,name')
        .eq('date_time', snapshotTime)
        .limit(100);
      if (error) throw error;
      if (snapshot?.length) return snapshot;
    }
  }

  // Older seasons may have no snapshot yet; use the current clan roster as a
  // fallback rather than inventing historical membership.
  const clan = await getClan();
  return (clan.memberList ?? []).map(member => ({ player_id: member.tag, name: member.name }));
}

export async function syncCapital() {
  const response = await getCapitalRaids();
  const items = response.items ?? [];
  let seasons = 0;
  let participants = 0;
  let attacks = 0;

  for (const raid of items) {
    const start = cocStamp(raid.startTime);
    const end = cocStamp(raid.endTime);

    // Re-syncing the same season must reuse its CR UID.
    let seasonId = await findCapitalSeasonUid(start);
    if (!seasonId) seasonId = await allocateSeq('capital_raid_season', 'generated_uid', 'CR');

    const roster = await rosterAtOrBefore(start);
    const stats = participantStats(raid, roster);
    const members = raid.members ?? [];

    await upsert('capital_raid_season', [{
      generated_uid: seasonId,
      battle_start: start,
      battle_end: end,
      total_loot: Number(raid.capitalTotalLoot ?? 0),
      raids_won: Number(raid.raidsCompleted ?? 0),
      total_attacks: Number(raid.totalAttacks ?? 0),
      participants_no: stats.participantsNo,
      absentees_no: stats.absenteesNo,
      participants_name: stats.participants,
      absentees_name: stats.absentees,
      data: {
        ...raid,
        clanRosterSize: stats.rosterSize,
        participantNames: stats.participants,
        absenteeNames: stats.absentees
      }
    }]);

    const attackRows = capitalAttackRows(seasonId, raid);

    // Attacks are delete+inserted per season so ATK numbering always
    // matches the current API state exactly.
    const removed = await db.from('capital_raid_attacklog').delete().eq('capital_raid_uid', seasonId);
    if (removed.error) throw removed.error;
    if (attackRows.length) {
      await upsert('capital_raid_attacklog', attackRows);
      attacks += attackRows.length;
    }

    // Attack UIDs per attacker, for the participants reference column.
    const uidByAttacker = new Map();
    for (const row of attackRows) {
      const list = uidByAttacker.get(row.attacker_id) ?? [];
      list.push(row.generated_uid);
      uidByAttacker.set(row.attacker_id, list);
    }

    const participantRows = members.map(member => ({
      capital_raid_uid: seasonId,
      player_name: member.name ?? null,
      player_id: member.tag,
      attacks_used: Number(member.attacks ?? 0),
      attacks_available: Number(member.attackLimit ?? 5) + Number(member.bonusAttackLimit ?? 0),
      total_loot_gained: Number(member.capitalResourcesLooted ?? 0),
      capital_raid_attack_uid: (uidByAttacker.get(member.tag) ?? []).join(',') || null,
      capital_raid_start: start,
      capital_raid_end: end,
      data: member
    }));

    // Participants are delete+inserted per season (like the attack rows) so
    // re-syncs can never accumulate duplicate players, even on databases
    // where the unique constraint is missing.
    const removedParticipants = await db.from('capital_raid_participants').delete().eq('capital_raid_uid', seasonId);
    if (removedParticipants.error) throw removedParticipants.error;
    if (participantRows.length) {
      await upsert('capital_raid_participants', participantRows);
      participants += participantRows.length;
    }

    seasons += 1;
    console.log(`[capital] ${seasonId}: roster=${stats.rosterSize}, participants=${stats.participantsNo}, absentees=${stats.absenteesNo}, attacks=${raid.totalAttacks ?? 0}`);
  }

  console.log(`[capital] synced ${seasons} seasons, ${participants} participants, ${attacks} attacks`);
  return { seasons, participants, attacks };
}
