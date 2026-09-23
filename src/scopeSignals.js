import { stripNegatedDatasets } from './queryEngine.js';

// All patterns use word boundaries: the old unbounded versions matched inside
// unrelated words ("star" in "started", "hit" in "within", "may" in "you may"),
// which loaded the wrong datasets and buried the real answer in noise.
export const MONTHS = /\b(?:january|february|march|april|june|july|august|september|october|november|december|months?|year|years|trends?|history|historical|improv\w*|declin\w*|lately|last (?:week|month|season))\b/i;
export const WAR = /\b(?:wars?|attacks?|attacked|defen[cs]es?|stars?|opponents?|missed?|hits?|battles?|participants?|participated)\b/i;
export const CAPITAL = /\b(?:capital|raids?)\b/i;
export const CWL = /\b(?:cwl|clan war league|league day)\b/i;
export const MEMBER = /\b(?:members?|players?|donat\w*|donors?|troph(?:y|ies)|town hall|th\d{1,2}|inactive|role|elders?|co-?leaders?|leaders?|lowest|highest|tag)\b/i;

// True when a question names a dataset (war / cwl / capital / members / history)
// by itself. Pure follow-ups ("what about them?", "and last week?") do not.
export function hasDatasetSignal(question = '') {
  const q = stripNegatedDatasets(String(question).toLowerCase());
  return WAR.test(q) || CAPITAL.test(q) || CWL.test(q) || MEMBER.test(q) || MONTHS.test(q);
}

// Follow-ups keep their scope: when the CURRENT question names no dataset, the
// retrieval question borrows the previous user question (never old answers).
// Questions that name their own dataset -- including corrections such as
// "i mean the clan war, not capital raid" -- are left untouched, so old turns
// can still never hijack routing of a self-contained question.
export function resolveRetrievalQuestion(question, previousQuestions = []) {
  if (hasDatasetSignal(question)) return question;
  const last = [...previousQuestions].reverse().find(q => hasDatasetSignal(q));
  return last ? `${last} ${question}` : question;
}
