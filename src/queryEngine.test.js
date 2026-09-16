import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQueryPlan, understandQuestion, deterministicWarMembers, deterministicMemberMetric, deterministicRole } from './queryEngine.js';

const members = [
  { player_name: 'A', attacks_used: 0, attacks_available: 2, map_position: 1 },
  { player_name: 'B', attacks_used: 1, attacks_available: 2, map_position: 2 },
  { player_name: 'C', attacks_used: 2, attacks_available: 2, map_position: 3 }
];

test('routes normal war questions by broad dataset and generic operation', () => {
  const opponent = buildQueryPlan('Which clan are we currently at war with?');
  assert.equal(opponent.scope, 'war');
  assert.equal(opponent.operation, 'opponent');
  assert.equal(opponent.intent, 'general');

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
  const exact = understandQuestion('Who attacked twice?');
  assert.equal(exact.intent, 'war_attack_usage');
  assert.equal(exact.attacks_used, 2);
});

test('understands CWL and Capital Raid attack usage', () => {
  const cwl = understandQuestion('Who has one attack left in CWL?');
  assert.equal(cwl.scope, 'cwl');
  assert.equal(cwl.intent, 'war_attack_usage');
  const capital = understandQuestion('Who has not attacked in the Capital Raid?');
  assert.equal(capital.scope, 'capital');
  assert.equal(capital.intent, 'war_attack_usage');
});

test('filters deterministically and orders by map position', () => {
  const result = deterministicWarMembers('Who has one attack left?', members);
  assert.deepEqual(result.rows.map(r => r.player_name), ['B']);
  const zero = deterministicWarMembers("Who hasn't used an attack?", members);
  assert.deepEqual(zero.rows.map(r => r.player_name), ['A']);
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
