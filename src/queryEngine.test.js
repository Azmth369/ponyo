import test from 'node:test';
import assert from 'node:assert/strict';
import { understandQuestion, deterministicWarMembers } from './queryEngine.js';

const members = [
  { player_name: 'A', attacks_used: 0, attacks_available: 2, map_position: 1 },
  { player_name: 'B', attacks_used: 1, attacks_available: 2, map_position: 2 },
  { player_name: 'C', attacks_used: 2, attacks_available: 2, map_position: 3 }
];

test('understands unused current-war attacks', () => {
  const plan = understandQuestion("Who hasn't used an attack in the current war?");
  assert.equal(plan.intent, 'war_attack_usage');
  assert.equal(plan.unused, true);
});

test('understands attacks remaining', () => {
  const plan = understandQuestion('Who has one attack left?');
  assert.equal(plan.intent, 'war_attack_usage');
  assert.equal(plan.attacks_remaining, 1);
});

test('understands exact attacks used', () => {
  const plan = understandQuestion('Who attacked twice?');
  assert.equal(plan.intent, 'war_attack_usage');
  assert.equal(plan.attacks_used, 2);
});

test('filters deterministically and orders by map position', () => {
  const result = deterministicWarMembers('Who has one attack left?', members);
  assert.deepEqual(result.rows.map(r => r.player_name), ['B']);
  const zero = deterministicWarMembers("Who hasn't used an attack?", members);
  assert.deepEqual(zero.rows.map(r => r.player_name), ['A']);
});
