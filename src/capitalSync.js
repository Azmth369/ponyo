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
  let preservedAttackHistory = 0;
  let preservedParticipantHistory = 0;

  for (const raid of items) {
    const start = cocStamp(raid.startTime);
    const end = cocStamp(raid.endTime);

    // Re-syncing the same season must reuse its CR UID.
    let seasonId = await findCapitalSeasonUid(start);
    if (!seasonId) seasonId = await allocateSeq('capital_raid_season', 'generated_uid', 'CR');

    const roster = await rosterAtOrBefore(start);
    const members = Array.isArray(raid.members) ? raid.members : [];
    const stats = participantStats(raid, roster);

    // Historical summaries can be returned without member-level details.
    // Keep previously saved participant/absentee summary fields in that case
    // instead of replacing them with zero participants and a full absentee list.
    const { data: previousSeason, error: previousSeasonError } = await db
      .from('capital_raid_season')
      .select('participants_no,absentees_no,participants_name,absentees_name,data')
      .eq('generated_uid', seasonId)
      .maybeSingle();
    if (previousSeasonError) throw previousSeasonError;

    const hasMemberDetails = members.length > 0;
    const participantNames = hasMemberDetails
      ? stats.participants
      : (previousSeason?.participants_name ?? []);
    const absenteeNames = hasMemberDetails
      ? stats.absentees
      : (previousSeason?.absentees_name ?? []);

    await upsert('capital_raid_season', [{
      generated_uid: seasonId,
      battle_start: start,
      battle_end: end,
      total_loot: Number(raid.capitalTotalLoot ?? 0),
      raids_won: Number(raid.raidsCompleted ?? 0),
      total_attacks: Number(raid.totalAttacks ?? 0),
      participants_no: hasMemberDetails ? stats.participantsNo : (previousSeason?.participants_no ?? null),
      absentees_no: hasMemberDetails ? stats.absenteesNo : (previousSeason?.absentees_no ?? null),
      participants_name: participantNames,
      absentees_name: absenteeNames,
      data: {
        ...(previousSeason?.data ?? {}),
        ...raid,
        clanRosterSize: hasMemberDetails ? stats.rosterSize : (previousSeason?.data?.clanRosterSize ?? null),
        participantNames,
        absenteeNames
      }
    }]);

    const attackLogAvailable = Array.isArray(raid.attackLog);
    const attackRows = capitalAttackRows(seasonId, raid);

    // Some historical API records contain season summaries but omit attackLog.
    // Never delete known-good history just because this response lacks details.
    // Replace detail rows only when the API returned attacks, or explicitly
    // reports a zero-attack season with an attackLog array.
    const canReplaceAttackHistory =
      attackRows.length > 0 ||
      (attackLogAvailable && Number(raid.totalAttacks ?? 0) === 0);

    if (canReplaceAttackHistory) {
      const removed = await db.from('capital_raid_attacklog').delete().eq('capital_raid_uid', seasonId);
      if (removed.error) throw removed.error;
      if (attackRows.length) {
        await upsert('capital_raid_attacklog', attackRows);
        attacks += attackRows.length;
      }
    } else {
      preservedAttackHistory += 1;
      console.warn(
        `[capital] ${seasonId}: API returned no attack details despite totalAttacks=${raid.totalAttacks ?? 'unknown'}; preserving stored attack history`
      );
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

    // Prefer authoritative per-member weekend totals whenever the API provides
    // raid.members. For older seasons without members, derive only what the
    // attack log proves: player identity and number of logged attacks. Do not
    // invent per-player loot or claim the derived rows are complete.
    if (members.length > 0) {
      const removedParticipants = await db.from('capital_raid_participants').delete().eq('capital_raid_uid', seasonId);
      if (removedParticipants.error) throw removedParticipants.error;
      await upsert('capital_raid_participants', participantRows);
      participants += participantRows.length;
    } else {
      const derived = new Map();
      for (const attack of attackRows) {
        const tag = attack.attacker_id;
        if (!tag) continue;
        const existing = derived.get(tag) ?? {
          capital_raid_uid: seasonId,
          player_name: attack.attacker_name ?? null,
          player_id: tag,
          attacks_used: 0,
          attacks_available: null,
          total_loot_gained: null,
          capital_raid_attack_uid: null,
          capital_raid_start: start,
          capital_raid_end: end,
          data: { derivedFromAttackLog: true, completeness: 'partial' }
        };
        existing.attacks_used += 1;
        derived.set(tag, existing);
      }
      const derivedRows = [...derived.values()];
      if (derivedRows.length) {
        // Preserve authoritative rows and only add missing players. Unknown
        // loot remains null instead of being written as a misleading zero.
        const { data: existingRows, error: existingError } = await db
          .from('capital_raid_participants')
          .select('player_id')
          .eq('capital_raid_uid', seasonId);
        if (existingError) throw existingError;
        const known = new Set((existingRows ?? []).map(row => row.player_id));
        const missingRows = derivedRows.filter(row => !known.has(row.player_id));
        if (missingRows.length) {
          await upsert('capital_raid_participants', missingRows);
          participants += missingRows.length;
        }
        console.warn(`[capital] ${seasonId}: API omitted members; derived ${derivedRows.length} partial participant rows from attack logs, inserted ${missingRows.length}`);
      } else {
        preservedParticipantHistory += 1;
        console.warn(`[capital] ${seasonId}: API returned no member details and no usable attack log; preserving stored participant history`);
      }
    }

    seasons += 1;
    console.log(
      `[capital] ${seasonId}: roster=${stats.rosterSize}, participants=${stats.participantsNo}, absentees=${stats.absenteesNo}, attacks=${raid.totalAttacks ?? 0}, savedAttackRows=${attackRows.length}`
    );
  }

  console.log(
    `[capital] synced ${seasons} seasons, ${participants} participants, ${attacks} attacks; preserved history for ${preservedAttackHistory} attack-log and ${preservedParticipantHistory} participant seasons`
  );
  return {
    seasons,
    participants,
    attacks,
    preservedAttackHistory,
    preservedParticipantHistory
  };
}
