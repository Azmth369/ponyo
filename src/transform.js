// Pure data transformations: CoC API payloads -> Ponyo schema rows.
// This module performs no I/O (no database, no network, no environment
// access beyond the default clan tag) so it is fully unit-testable.

import { warAttackUid, capitalRaidUid, capitalAttackUid } from './uids.js';

// CoC API timestamps look like 20260915T183000.000Z.
export function cocStamp(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString() : null;
}

export const mapLabel = (name, position) => `${name ?? 'Unknown'} [${position ?? '?'}]`;

// ---------------------------------------------------------------------------
// Normal Clan War (CW)
// ---------------------------------------------------------------------------

export function warResultFromSummary(war, own, opponent) {
  if (war.result) {
    // warlog values are win/lose/tie; normalise to win/loss/draw.
    if (war.result === 'lose') return 'loss';
    if (war.result === 'tie') return 'draw';
    return war.result;
  }
  const state = war.state ?? null;
  if (state !== 'warEnded' || !own || !opponent) return null;
  if (Number(own.stars ?? 0) > Number(opponent.stars ?? 0)) return 'win';
  if (Number(own.stars ?? 0) < Number(opponent.stars ?? 0)) return 'loss';
  return 'draw';
}

// Attacks are numbered in a stable order (map position, then attack order)
// so re-syncing a war in progress produces the same CW001-ATK00x UIDs.
export function sortedWarAttacks(members = []) {
  const rows = [];
  for (const m of members) {
    for (const a of m.attacks ?? []) rows.push({ member: m, attack: a, order: a.order ?? 0 });
  }
  rows.sort((x, y) =>
    (x.member.mapPosition ?? 9999) - (y.member.mapPosition ?? 9999) ||
    x.order - y.order);
  return rows;
}

export function normalWarRows(war, cwUid, clanTagValue = process.env.COC_CLAN_TAG) {
  const own = war.clan?.tag === clanTagValue ? war.clan : null;
  const opponent = war.clan?.tag === clanTagValue ? war.opponent : null;
  if (!own) return { session: null, participants: [], attacks: [] };

  const members = own.members ?? [];
  const opponentByTag = new Map((opponent?.members ?? []).map(m => [m.tag, m]));
  const battleStart = cocStamp(war.startTime);
  const battleEnd = cocStamp(war.endTime);

  const session = {
    cw_uid: cwUid,
    opponent_clan_name: opponent?.name ?? null,
    opponent_clan_id: opponent?.tag ?? null,
    size: (members.length || war.teamSize) ?? null,
    battle_start: battleStart,
    battle_end: battleEnd,
    result: warResultFromSummary(war, own, opponent),
    our_clan_score: own.stars ?? null,
    opponent_clan_score: opponent?.stars ?? null,
    our_clan_destruction: own.destructionPercentage ?? null,
    opponent_clan_destruction: opponent?.destructionPercentage ?? null,
    participants_size: members.length,
    our_participants: members.map(m => ({ player_id: m.tag, name: m.name, map_position: m.mapPosition ?? null })),
    opponent_participants: (opponent?.members ?? []).map(m => ({ player_id: m.tag, name: m.name, map_position: m.mapPosition ?? null })),
    data: war
  };

  const attackRows = sortedWarAttacks(members).map((row, index) => ({
    row,
    uid: warAttackUid(cwUid, index + 1)
  }));

  const attacksByPlayer = new Map();
  for (const { row, uid } of attackRows) {
    if (!attacksByPlayer.has(row.member.tag)) {
      const list = attackRows.filter(a => a.row.member.tag === row.member.tag).map(a => a.uid);
      attacksByPlayer.set(row.member.tag, list);
    }
  }

  const participants = members.map(m => {
    const attacks = m.attacks ?? [];
    return {
      cw_uid: cwUid,
      player_name: m.name,
      player_id: m.tag,
      attacks_used: attacks.length,
      attacks_available: 2,
      stars_scored: attacks.reduce((s, a) => s + Number(a.stars ?? 0), 0),
      destruction_caused: attacks.length ? attacks.reduce((s, a) => s + Number(a.destructionPercentage ?? 0), 0) / attacks.length : 0,
      cw_attack_uid: (attacksByPlayer.get(m.tag) ?? []).join(',') || null,
      player_map_position: m.mapPosition ?? null,
      battle_start: battleStart,
      battle_end: battleEnd,
      size: members.length || null,
      data: m
    };
  });

  const attacks = attackRows.map(({ row, uid }) => {
    const { member: m, attack: a } = row;
    const defender = opponentByTag.get(a.defenderTag);
    return {
      cw_attack_uid: uid,
      attacker_clan_name: own.name ?? null,
      attacker_clan_id: own.tag ?? clanTagValue,
      attacker_name_with_map_position: mapLabel(m.name, m.mapPosition),
      defender_name_with_map_position: mapLabel(a.defenderName ?? defender?.name, defender?.mapPosition),
      star_scored: a.stars ?? null,
      destruction_caused: a.destructionPercentage ?? null,
      attacking_date_time: cocStamp(a.attackTime),
      attacker_id: m.tag,
      cw_uid: cwUid,
      data: a
    };
  });

  return { session, participants, attacks };
}

// ---------------------------------------------------------------------------
// Capital Raid (CR)
// ---------------------------------------------------------------------------

export function participantStats(raid, roster) {
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

// Attacks are grouped by defender clan in API order; each group becomes a
// raid number (R1, R2, ...), numbered stably across re-syncs.
export function capitalAttackRows(seasonUid, raid) {
  const rows = [];
  const raidNumbers = new Map();
  for (const clanEntry of raid.attackLog ?? []) {
    const clanName = clanEntry.defender?.name ?? null;
    if (!raidNumbers.has(clanName)) raidNumbers.set(clanName, raidNumbers.size + 1);
    const raidNo = raidNumbers.get(clanName);
    const raidUid = capitalRaidUid(seasonUid, raidNo);
    let attackNo = 0;
    for (const district of clanEntry.districts ?? []) {
      for (const attack of district.attacks ?? []) {
        attackNo++;
        const attacker = attack.attacker ?? {};
        rows.push({
          generated_uid: capitalAttackUid(raidUid, attackNo),
          raid_no: raidNo,
          clan_name: clanName,
          district_name: district.name ?? null,
          attacker_name: attacker.name ?? null,
          star_scored: attack.stars ?? null,
          destruction_caused: attack.destructionPercent ?? null,
          loot_gained: null,
          attacking_date_time: cocStamp(attack.attackTime),
          attacker_id: attacker.tag ?? null,
          capital_raid_uid: seasonUid,
          data: { ...attack, districtId: district.id ?? null, defenderClanTag: clanEntry.defender?.tag ?? null }
        });
      }
    }
  }
  return rows;
}
