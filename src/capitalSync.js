import 'dotenv/config';
import { db, upsert } from './db.js';
import { getCapitalRaids, getClan } from './cocApi.js';

const clanTag = process.env.COC_CLAN_TAG;
const now = () => new Date().toISOString();
const iso = value => {
  if (!value) return null;
  const m = String(value).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString() : null;
};
const uid = (...parts) => parts.map(x => String(x ?? '').replace(/[^A-Za-z0-9#:_-]/g, '_')).join(':');

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
  return (clan.memberList ?? []).map(member => ({
    player_id: member.tag,
    name: member.name
  }));
}

function participantStats(raid, roster) {
  const members = raid.members ?? [];
  // A Capital participant is counted here only after using at least one attack.
  const attackedMembers = members.filter(member => Number(member.attacks ?? 0) > 0);
  const attackedIds = new Set(attackedMembers.map(member => member.tag));
  const rosterRows = roster ?? [];

  const participants = attackedMembers.map(member => member.name).filter(Boolean);
  const absentees = rosterRows
    .filter(member => !attackedIds.has(member.player_id))
    .map(member => member.name)
    .filter(Boolean);

  return {
    participantsNo: participants.length,
    participants,
    absenteesNo: absentees.length,
    absentees,
    rosterSize: rosterRows.length
  };
}

function capitalSeasonUid(raid) {
  return uid(clanTag, raid.startTime ?? raid.endTime ?? now());
}

export async function syncCapital() {
  const response = await getCapitalRaids();
  const items = response.items ?? [];
  let seasons = 0;
  let participants = 0;
  let attacks = 0;

  for (const raid of items) {
    const seasonId = capitalSeasonUid(raid);
    const start = iso(raid.startTime);
    const end = iso(raid.endTime);
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

    const participantRows = members.map(member => ({
      capital_raid_uid: seasonId,
      player_name: member.name ?? null,
      player_id: member.tag,
      total_attacks: Number(member.attacks ?? 0),
      total_loot_gained: Number(member.capitalResourcesLooted ?? 0),
      capital_raid_attack_uid: null,
      capital_raid_start: start,
      capital_raid_end: end,
      data: {
        ...member,
        attacksAvailable: Number(member.attackLimit ?? 5) + Number(member.bonusAttackLimit ?? 0)
      }
    }));

    if (participantRows.length) {
      await upsert('capital_raid_participants', participantRows);
      participants += participantRows.length;
    }

    const attackRows = [];
    for (const clanEntry of raid.attackLog ?? []) {
      const clanName = clanEntry.defender?.name ?? null;
      for (const district of clanEntry.districts ?? []) {
        for (const attack of district.attacks ?? []) {
          const attacker = attack.attacker ?? {};
          attackRows.push({
            generated_uid: uid(seasonId, attacker.tag, district.id, attackRows.length + 1),
            raid_no: null,
            clan_name: clanName,
            district_name: district.name ?? null,
            attacker_name: attacker.name ?? null,
            star_scored: attack.stars ?? null,
            destruction_caused: attack.destructionPercent ?? null,
            loot_gained: null,
            attacking_date_time: null,
            attacker_id: attacker.tag ?? null,
            capital_raid_uid: seasonId,
            data: attack
          });
        }
      }
    }

    if (attackRows.length) {
      await upsert('capital_raid_attacklog', attackRows);
      attacks += attackRows.length;
    }

    seasons += 1;
    console.log(`[capital] ${seasonId}: roster=${stats.rosterSize}, participants=${stats.participantsNo}, absentees=${stats.absenteesNo}, attacks=${raid.totalAttacks ?? 0}`);
  }

  console.log(`[capital] synced ${seasons} seasons, ${participants} participants, ${attacks} attacks`);
  return { seasons, participants, attacks };
}
