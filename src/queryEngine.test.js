import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent, executeIntent } from './queryEngine.js';

test('detects unused current-war attacks', () => {
  const intent = parseIntent("Who hasn't used their attacks in this war?");
  assert.equal(intent.currentWar, true);
  assert.equal(intent.unused, true);
});

test('filters one attack left deterministically', () => {
  const result = executeIntent('Who has one attack left in the current war?', {
    currentWarMembers: [
      { player_name: 'A', player_tag: '#A', map_position: 2, attacks_used: 1, attacks_available: 2 },
      { player_name: 'B', player_tag: '#B', map_position: 1, attacks_used: 2, attacks_available: 2 },
      { player_name: 'C', player_tag: '#C', map_position: 3, attacks_used: 0, attacks_available: 2 }
    ]
  });
  assert.deepEqual(result.result.map(x => x.name), ['A']);
});

test('sorts lowest donations without LLM interpretation', () => {
  const result = executeIntent('Who has the lowest donations?', {
    players: [
      { name: 'A', tag: '#A', troops_donated: 50, role: 'member' },
      { name: 'B', tag: '#B', troops_donated: 5, role: 'member' },
      { name: 'C', tag: '#C', troops_donated: 20, role: 'member' }
    ]
  });
  assert.deepEqual(result.result.map(x => x.name), ['B', 'C', 'A']);
});

test('filters exact attack count and keeps map-position order', () => {
  const result = executeIntent('Who attacked twice in this war?', {
    currentWarMembers: [
      { player_name: 'A', player_tag: '#A', map_position: 3, attacks_used: 2, attacks_available: 2 },
      { player_name: 'B', player_tag: '#B', map_position: 1, attacks_used: 1, attacks_available: 2 },
      { player_name: 'C', player_tag: '#C', map_position: 2, attacks_used: 2, attacks_available: 2 }
    ]
  });
  assert.deepEqual(result.result.map(x => x.name), ['C', 'A']);
});
