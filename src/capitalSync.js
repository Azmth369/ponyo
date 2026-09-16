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

    // CapitalRaidSeason does not contain capital_trophies, clan, or clan capitalPoints.
    // Keep only fields that exist in the current target schema/API mapping.
    await upsert('capital_raid_season', [{
      generated_uid: seasonId,
      raid_start: start,
      raid_end: end,
      state: raid.state ?? null,
      clan_name: null,
      clan_id: clanTag ?? null,
      total_loot: raid.capitalTotalLoot ?? null,
      data: raid
    }]);

    const memberList = raid.members ?? [];
    const participantRows = memberList.map(member => {
      const used = Number(member.attacks ?? 0);
      const normalLimit = Number(member.attackLimit ?? 5);
      const bonusLimit = Number(member.bonusAttackLimit ?? 0);
      return {
        capital_raid_uid: seasonId,
        player_id: member.tag,
        player_name: member.name,
        attacks_used: used,
        attacks_available: normalLimit + bonusLimit,
        capital_loot: member.capitalResourcesLooted ?? null,
        districts_destroyed: null,
        data: member
      };
    });

    if (participantRows.length) {
      await upsert('capital_raid_participants', participantRows);
      participants += participantRows.length;
    }

    // The official Capital Raid API stores attack history at raid.attackLog,
    // not inside each member. Flatten district attacks into our attack-log schema.
    const attackRows = [];
    for (const clanEntry of raid.attackLog ?? []) {
      for (const district of clanEntry.districts ?? []) {
        for (const attack of district.attacks ?? []) {
          const attacker = attack.attacker ?? {};
          attackRows.push({
            generated_uid: uid(seasonId, attacker.tag, district.id, attackRows.length + 1),
            capital_raid_uid: seasonId,
            player_id: attacker.tag ?? null,
            player_name: attacker.name ?? null,
            attack_order: null,
            district_name: district.name ?? null,
            district_id: district.id ?? null,
            stars: attack.stars ?? null,
            destruction: attack.destructionPercent ?? attack.destructionPercentage ?? null,
            attacking_date_time: null,
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
