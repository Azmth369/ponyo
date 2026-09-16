import { getCurrentWar, getWarMembers } from './retrieval.js';

// These questions are better answered deterministically from war_members than
// by an LLM. Include common Discord-style spellings without apostrophes.
const UNUSED_ATTACK_PATTERNS = [
  /\b(?:has|have|had)\s+(?:not|n't|hasnt|haven't|havent|hasn['’]?t)\s+used\b/i,
  /\b(?:hasn['’]?t|haven['’]?t|didn['’]?t|didnt)\s+(?:use|used|make|made|do|done)\b/i,
  /\b(?:has|have|had)\s+(?:not|n't)\s+(?:made|done|used)\b/i,
  /\b(?:hasn['’]?t|haven['’]?t|didn['’]?t|didnt)\s+attacked\b/i,
  /\b(?:who|which|what)\b.*\b(?:hasn['’]?t|hasnt|haven['’]?t|havent|didn['’]?t|didnt)\b.*\b(?:attack|attacked|used|use)\b/i,
  /\b(?:no|zero)\s+attacks?\b/i,
  /\b(?:unused|un-used)\s+attacks?\b/i,
  /\b(?:without|yet to)\s+(?:use|make|do)\s+(?:any\s+)?attacks?\b/i,
  /\b(?:0|zero)\s+out\s+of\s+(?:1|2)\s+(?:used|attack|attacks)\b/i
];

export function isUnusedCurrentWarAttackQuestion(question = '') {
  const q = String(question).trim();
  if (!q) return false;

  const explicitlyHistorical = /\b(?:last|previous|past|historical|history)\s+(?:war|wars|attack|attacks)\b/i.test(q);
  const explicitlyOtherMode = /\b(?:cwl|clan war league|capital raid|capital raids)\b/i.test(q);
  if (explicitlyHistorical || explicitlyOtherMode) return false;

  const mentionsWar = /\b(?:current|ongoing|this)\s+(?:clan\s+)?war\b|\bcurrentwar\b|\bclan\s+war\b/i.test(q);
  const mentionsClanParticipants = /\bparticipants?\s+(?:of|from)\s+(?:our|the)\s+clan\b|\bparticipants?\s+of\s+our\s+clan\b/i.test(q);
  const asksWho = /\b(?:who|which|what)\b/i.test(q);

  return (mentionsWar || mentionsClanParticipants || asksWho) && UNUSED_ATTACK_PATTERNS.some(pattern => pattern.test(q));
}

export async function answerUnusedCurrentWarAttackQuestion(question = '') {
  if (!isUnusedCurrentWarAttackQuestion(question)) return null;

  const war = await getCurrentWar();
  if (!war?.war_key) return 'There is no current Clan War available in the synced data.';

  const members = await getWarMembers(war.war_key, 100);
  const unused = members
    .filter(member => Number(member.attacks_used ?? 0) === 0)
    .sort((a, b) => {
      const aPos = Number(a.map_position ?? Number.MAX_SAFE_INTEGER);
      const bPos = Number(b.map_position ?? Number.MAX_SAFE_INTEGER);
      return aPos - bPos || String(a.player_name ?? '').localeCompare(String(b.player_name ?? ''));
    });

  if (!unused.length) return 'All current-war participants have used at least one attack.';

  // Deliberately return names only. The user did not ask for player tags,
  // attack counts, or map positions; ordering is already deterministic above.
  return [
    'Players who have not used any attack yet:',
    ...unused.map((member, index) => `${index + 1}. ${member.player_name}`)
  ].join('\n');
}
