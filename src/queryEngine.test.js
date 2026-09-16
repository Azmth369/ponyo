import test from 'node:test';
import assert from 'node:assert/strict';
import { understandQuestion, deterministicWarMembers, deterministicMemberMetric, deterministicRole } from './queryEngine.js';

const members = [
  { player_name: 'A', attacks_used: 0, attacks_available: 2, map_position: 1 },
  { player_name: 'B', attacks_used: 1, attacks_available: 2, map_position: 2 },
  { player_name: 'C', attacks_used: 2, attacks_available: 2, map_position: 3 }
];

test('understands unused current-war attacks', () => {
  const plan = understandQuestion("Who hasn't used an attack in the current war?");
  assert.equal(plan.scope, 'war');
  assert.equal(plan.intent, 'war_attack_usage');
  assert.equal(plan.unused, true);
});

test('understands attacks remaining and exact attacks used', () => {
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
