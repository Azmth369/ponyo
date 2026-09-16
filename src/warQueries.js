import { understandQuestion } from './queryEngine.js';
import { answerDeterministically } from './deterministicAnswer.js';

export function isUnusedCurrentWarAttackQuestion(question = '') {
  const plan = understandQuestion(question);
  return plan.intent === 'war_attack_usage' && (plan.unused || plan.attacks_remaining !== null || plan.attacks_used !== null);
}

export async function answerUnusedCurrentWarAttackQuestion(question = '') {
  // Kept as the existing Discord-facing API for compatibility. It now delegates
  // every supported deterministic query (clan metrics, roles, CW, CWL, Capital Raid)
  // to the unified query router instead of being limited to unused CW attacks.
  const result = await answerDeterministically(question);
  return result?.text ?? null;
}
