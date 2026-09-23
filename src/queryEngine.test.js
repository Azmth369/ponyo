import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQueryPlan, understandQuestion, deterministicWarMembers, deterministicMemberMetric, deterministicRole, applyAttackUsageFilters } from './queryEngine.js';

const members = [
  { player_name: 'A', player_id: '#PA', attacks_used: 0, attacks_available: 2, map_position: 1 },
  { player_name: 'B', player_id: '#PB', attacks_used: 1, attacks_available: 2, map_position: 2 },
  { player_name: 'C', player_id: '#PC', attacks_used: 2, attacks_available: 2, map_position: 3 }
];

test('routes normal war questions by broad dataset and generic operation', () => {
  const opponent = buildQueryPlan('Which clan are we currently at war with?');
  assert.equal(opponent.scope, 'war');
  assert.equal(opponent.operation, 'opponent');
  assert.equal(opponent.intent, 'general');

  const fighting = buildQueryPlan('Who are we fighting right now?');
  assert.equal(fighting.scope, 'war');
  assert.equal(fighting.operation, 'opponent');
  assert.equal(fighting.intent, 'general');

  const state = buildQueryPlan('What is the current war state?');
  assert.equal(state.scope, 'war');
  assert.equal(state.operation, 'state');
  assert.equal(state.intent, 'general');
});

test('does not create a sentence-specific intent for different current-war questions', () => {
  const questions = [
    'Who are we fighting?',
    'What is the current war status?',
    'When does the war end?',
    'How many members are in the war?',
    'What is our war score?',
    'Who has not attacked yet?'
  ];
  const plans = questions.map(buildQueryPlan);
  assert.deepEqual(plans.slice(0, 5).map(p => p.scope), ['war', 'war', 'war', 'war', 'war']);
  assert.equal(plans[0].intent, 'general');
  assert.equal(plans[1].intent, 'general');
  assert.equal(plans[2].intent, 'general');
  assert.equal(plans[3].intent, 'general');
  assert.equal(plans[4].intent, 'general');
  assert.equal(plans[5].operation, 'member_attack_usage');
});

test('understands reusable attack filters across war types', () => {
  const unused = understandQuestion("Who hasn't used an attack in the current war?");
  assert.equal(unused.scope, 'war');
  assert.equal(unused.intent, 'war_attack_usage');
  assert.equal(unused.unused, true);
  const remaining = understandQuestion('Who has one attack left?');
  assert.equal(remaining.intent, 'war_attack_usage');
  assert.equal(remaining.attacks_remaining, 1);
  assert.equal(remaining.attacks_used, null);
  const exact = understandQuestion('Who attacked twice?');
  assert.equal(exact.intent, 'war_attack_usage');
  assert.equal(exact.attacks_used, 2);
});

test('understands CWL and Capital Raid attack usage', () => {
  const cwl = understandQuestion('Who has one attack left in CWL?');
  assert.equal(cwl.scope, 'cwl');
  assert.equal(cwl.intent, 'war_attack_usage');
  assert.equal(cwl.attacks_remaining, 1);
  const capital = understandQuestion('Who has not attacked in the Capital Raid?');
  assert.equal(capital.scope, 'capital');
  assert.equal(capital.intent, 'war_attack_usage');
  assert.equal(capital.unused, true);
});

test('filters deterministically and orders by map position', () => {
  const result = deterministicWarMembers('Who has one attack left?', members);
  assert.deepEqual(result.rows.map(r => r.player_name), ['B']);
  const zero = deterministicWarMembers("Who hasn't used an attack?", members);
  assert.deepEqual(zero.rows.map(r => r.player_name), ['A']);
  const explicit = deterministicWarMembers('Who has not attacked yet?', members);
  assert.deepEqual(explicit.rows.map(r => r.player_name), ['A']);
});

test('finds lowest donation member', () => {
  const players = [
    { name: 'A', tag: '#A', troops_donated: 50 },
    { name: 'B', tag: '#B', troops_donated: 10 }
  ];
  const result = deterministicMemberMetric('who has the lowest donations?', players);
  assert.equal(result.rows[0].name, 'B');
});

test('filters Elder role using the Clash of Clans role value', () => {
  const players = [
    { name: 'A', role: 'admin' },
    { name: 'B', role: 'member' }
  ];
  const result = deterministicRole('who are the elders?', players);
  assert.deepEqual(result.rows.map(p => p.name), ['A']);
});

test('co-leader phrasings with and without space map to coLeader', () => {
  for (const question of ['who are the co leaders', 'list the co-leaders', 'and co leaders']) {
    const players = [
      { name: 'A', role: 'coLeader' },
      { name: 'B', role: 'leader' },
      { name: 'C', role: 'admin' }
    ];
    const result = deterministicRole(question, players);
    assert.equal(result.plan.role, 'coLeader', question);
    assert.deepEqual(result.rows.map(p => p.name), ['A'], question);
  }
});

test('applyAttackUsageFilters is shared logic: unused, exact and remaining', () => {
  const plan = buildQueryPlan('who did not attack');
  assert.deepEqual(applyAttackUsageFilters(members, plan).map(r => r.player_name), ['A']);
  const exactPlan = buildQueryPlan('who used one attack');
  assert.deepEqual(applyAttackUsageFilters(members, exactPlan).map(r => r.player_name), ['B']);
  const remPlan = buildQueryPlan('who has two attacks remaining');
  assert.deepEqual(applyAttackUsageFilters(members, remPlan).map(r => r.player_name), ['A']);
});

test('at-least attack questions filter by a minimum, not an exact count', () => {
  const plan = buildQueryPlan('who has done atleast one attack');
  assert.equal(plan.attacks_used_min, 1);
  assert.equal(plan.attacks_used, null);
  assert.deepEqual(applyAttackUsageFilters(members, plan).map(r => r.player_name), ['B', 'C']);
});

test('how-are-we-performing maps to war statistics', () => {
  const plan = buildQueryPlan('how we are performing in our current clan war');
  assert.equal(plan.scope, 'war');
  assert.equal(plan.operation, 'statistics');
});

test('negated dataset mentions do not hijack the scope', () => {
  const correction = buildQueryPlan('i mean the clan war, not capital raid');
  assert.equal(correction.scope, 'war');
  const correction2 = buildQueryPlan('not cwl, the normal war');
  assert.equal(correction2.scope, 'war');
  const stillCapital = buildQueryPlan('capital raid not war');
  assert.equal(stillCapital.scope, 'capital');
});

test('clan identity and member metric questions', () => {
  const identity = buildQueryPlan("what is our clan's tag");
  assert.equal(identity.operation, 'clan_identity');
  assert.equal(identity.identity_field, 'tag');
  const count = buildQueryPlan('how many members are in the clan');
  assert.equal(count.scope, 'clan');
  assert.equal(count.operation, 'members');
});

test('missed / skipped / pending phrasing maps to attack usage with attacks left', () => {
  for (const q of ['who missed their attacks in the war', 'who skipped attacks in cwl', 'how many attacks are pending in war', 'who still needs to attack in war']) {
    const plan = buildQueryPlan(q);
    assert.equal(plan.operation, 'member_attack_usage', q);
    assert.equal(plan.attacks_remaining_any, true, q);
  }
});

test("'hasn't hit', 'yet to attack' and Hinglish map to unused", () => {
  for (const q of ["who hasn't hit in this war", 'who is yet to attack in war', 'kaun attack nahi kiya war me']) {
    assert.equal(buildQueryPlan(q).unused, true, q);
  }
});

test('top N donors returns a member metric with a list length', () => {
  const plan = buildQueryPlan('top 5 donors');
  assert.equal(plan.operation, 'member_metric');
  assert.equal(plan.limit, 5);
  assert.equal(plan.sort, 'desc');
});

test('advice questions are not answered as role lookups', () => {
  assert.equal(buildQueryPlan('who should we promote to elder').operation, 'general');
  assert.equal(buildQueryPlan('who are the elders').operation, 'role_members');
});
