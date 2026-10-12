import 'dotenv/config';
import { db } from './db.js';
import { getClan, getPlayer } from './cocApi.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function syncCapitalContributionSnapshots() {
  const clan = await getClan();
  const roster = clan.memberList ?? [];
  const observedAt = new Date().toISOString();
  const clanTag = clan.tag ?? process.env.COC_CLAN_TAG;
  const rows = [];
  const errors = [];

  // Keep requests sequential with a small delay to avoid bursting the CoC API.
  for (const member of roster) {
    try {
      const profile = await getPlayer(member.tag);
      const value = Number(profile.clanCapitalContributions);
      if (!Number.isFinite(value) || value < 0) {
        errors.push({ playerTag: member.tag, reason: 'missing_or_invalid_contribution' });
      } else {
        rows.push({
          clan_tag: clanTag,
          player_tag: profile.tag ?? member.tag,
          player_name: profile.name ?? member.name,
          contribution: Math.trunc(value),
          observed_at: observedAt,
          source: 'clash_of_clans_player_api'
        });
      }
    } catch (error) {
      errors.push({ playerTag: member.tag, reason: error?.message ?? 'profile_fetch_failed' });
    }
    await sleep(180);
  }

  if (rows.length) {
    const { error } = await db.from('player_capital_contribution_snap').insert(rows);
    if (error) throw error;
  }

  const result = {
    clanTag,
    observedAt,
    rosterCount: roster.length,
    savedSnapshots: rows.length,
    failedProfiles: errors.length,
    errors: errors.slice(0, 10)
  };
  console.log('[capital-contribution-snapshot]', result);
  return result;
}
