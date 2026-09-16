import { getCurrentWar, getWarMembers } from './retrieval.js';
import { deterministicWarMembers, understandQuestion } from './queryEngine.js';

export function isUnusedCurrentWarAttackQuestion(question = '') {
  const plan = understandQuestion(question);
  return plan.scope === 'war' && plan.intent === 'war_attack_usage' && (plan.unused || plan.attacks_remaining !== null || plan.attacks_used !== null);
}

export async function answerUnusedCurrentWarAttackQuestion(question = '') {
  const plan = understandQuestion(question);
  if (!isUnusedCurrentWarAttackQuestion(question)) return null;
  if (plan.scope === 'cwl' || plan.scope === 'capital') return null;

  const war = await getCurrentWar();
  if (!war?.war_key) return 'There is no current Clan War available in the synced data.';

  const members = await getWarMembers(war.war_key, 100);
  const result = deterministicWarMembers(question, members);
  if (!result) return null;
  if (!result.rows.length) {
    if (plan.unused) return 'All current-war participants have used at least one attack.';
    if (plan.attacks_remaining !== null) return `No current-war participants have ${plan.attacks_remaining} attack remaining.`;
    return `No current-war participants have used exactly ${plan.attacks_used} attacks.`;
  }

  const heading = plan.unused
    ? 'Players who have not used any attack yet:'
    : plan.attacks_remaining !== null
      ? `Players with ${plan.attacks_remaining} attack remaining:`
      : `Players who have used ${plan.attacks_used} attacks:`;

  return [heading, ...result.rows.map((member, index) => `${index + 1}. ${member.player_name}`)].join('\n');
}
