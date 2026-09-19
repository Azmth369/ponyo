import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQueryPlan,
  applyAttackUsageFilters,
  deterministicWarMembers,
  deterministicMemberMetric,
  deterministicRole
} from './queryEngine.js';

const members = [
  { player_name: 'A', player_id: '#AAA', map_position: 3, attacks_used: 0, attacks_available: 2, stars_earned: 0, destruction_percentage: 0 },
  { player_name: 'B', player_id: '#BBB', map_position: 1, attacks_used: 1, attacks_available: 2, stars_earned: 3, destruction_percentage: 78.5 },
  { player_name: 'C', player_id: '#CCC', map_position: 2, attacks_used: 2, attacks_available: 2, stars_earned: 5, destruction_percentage: 92.1 }
];

test('understands unused and unused-like phrasings', () => {
  for (const q of ['who has not attacked', "who hasn't used their attacks", 'who is yet to attack', 'who did not attack', 'who used no attacks']) {
    const plan = buildQueryPlan(q);
    assert.equal(plan.unused, true, q);
    assert.equal(plan.operation, 'member_attack_usage', q);
  }
});

test('understands remaining attacks before used attacks', () => {
  const plan = buildQueryPlan('who has one attack left');
  assert.equal(plan.attacks_remaining, 1);
  assert.equal(plan.attacks_used, null);
  const rows = deterministicWarMembers('who has one attack left', members).rows.map(r => r.player_name);
  assert.deepEqual(rows, ['B']);
});

test('understands reusable attack filters across war types', () => {
  for (const scope of ['current war', 'cwl', 'capital raid']) {
    const plan = buildQueryPlan(`who has unused attacks in the ${scope}`);
    assert.equal(plan.unused, true);
    assert.equal(plan.scope, scope === 'cwl' ? 'cwl' : scope === 'capital raid' ? 'capital' : 'war');
  }
});

test('understands CWL and Capital Raid attack usage', () => {
  const cwl = buildQueryPlan('who has one attack remaining in cwl');
  assert.equal(cwl.attacks_remaining, 1);
  assert.equal(cwl.scope, 'cwl');
  const capital = buildQueryPlan('who used two attacks in the capital raid');
  assert.equal(capital.attacks_used, 2);
  assert.equal(capital.scope, 'capital');
});

test('filters deterministically and orders by map position', () => {
  const result = deterministicWarMembers('who has not attacked', members);
  assert.deepEqual(result.rows.map(r => r.player_name), ['A']);
  const all = deterministicWarMembers('who has unused attacks', members);
  assert.deepEqual(all.rows.map(r => r.player_name), ['A']);
});

test('member metric questions use numeric fields', () => {
  const players = [
    { name: 'A', tag: '#A', troops_donated: 500, trophies: 4000 },
    { name: 'B', tag: '#B', troops_donated: 10, trophies: 3000 }
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

test('clan identity and member metric questions', () => {
  const identity = buildQueryPlan("what is our clan's tag");
  assert.equal(identity.operation, 'clan_identity');
  assert.equal(identity.identity_field, 'tag');
  const count = buildQueryPlan('how many members are in the clan');
  assert.equal(count.scope, 'clan');
  assert.equal(count.operation, 'members');
});
