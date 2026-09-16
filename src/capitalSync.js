import 'dotenv/config';
import { db, upsert } from './db.js';
import { getCapitalRaids } from './cocApi.js';

const clanTag = process.env.COC_CLAN_TAG;
const now = () => new Date().toISOString();
const iso = value => {
  if (!value) return null;
  const m = String(value).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString() : null;
};
const uid = (...parts) => parts.map(x => String(x ?? '').replace(/[^A-Za-z0-9#:_-]/g, '_')).join(':');

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
    const members = raid.members ?? [];

    // Keep this row exactly aligned with supabase/schema.sql.
    await upsert('capital_raid_season', [{
      generated_uid: seasonId,
      battle_start: start,
      battle_end: end,
      total_loot: Number(raid.capitalTotalLoot ?? 0),
      raids_won: Number(raid.raidsCompleted ?? 0),
      total_attacks: Number(raid.totalAttacks ?? 0),
      participants_no: members.length,
      absentees_no: 0,
      participants_name: members.map(m => m.name).filter(Boolean),
      absentees_name: [],
      data: raid
    }]);

    // Capital participant schema intentionally uses TOTAL ATTACKS rather than
    // the CW/CWL ATTACKS_USED + ATTACKS_AVAILABLE pair.
    const participantRows = members.map(member => ({
      capital_raid_uid: seasonId,
      player_name: member.name ?? null,
      player_id: member.tag,
      total_attacks: Number(member.attacks ?? 0),
      total_loot_gained: Number(member.capitalResourcesLooted ?? 0),
      capital_raid_attack_uid: null,
      capital_raid_start: start,
      capital_raid_end: end,
      data: member
    }));

    if (participantRows.length) {
      await upsert('capital_raid_participants', participantRows);
      participants += participantRows.length;
    }

    // Official Capital Raid data stores attack history as:
    // attackLog -> clan entry -> districts -> attacks.
    const attackRows = [];
    for (const clanEntry of raid.attackLog ?? []) {
      const clanName = clanEntry.defender?.name ?? null;
      for (const district of clanEntry.districts ?? []) {
        for (const attack of district.attacks ?? []) {
          const attacker = attack.attacker ?? {};
          const attackUid = uid(seasonId, attacker.tag, district.id, attackRows.length + 1);
          attackRows.push({
            generated_uid: attackUid,
            raid_no: null,
            clan_name: clanName,
            district_name: district.name ?? null,
            attacker_name: attacker.name ?? null,
            star_scored: attack.stars ?? null,
            destruction_caused: attack.destructionPercent ?? null,
            loot_gained: null,
            attacking_date_time: iso(attack.attackTime),
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
  }

  console.log(`[capital] synced ${seasons} seasons, ${participants} participants, ${attacks} attacks`);
  return { seasons, participants, attacks };
}
