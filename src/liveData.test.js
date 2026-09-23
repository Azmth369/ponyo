import test from 'node:test';
import assert from 'node:assert/strict';

// cocApi.js requires a token at import time; provide a dummy before the
// dynamic import so this test never needs real credentials or network access.
process.env.COC_API_TOKEN ||= 'test-token';
const { normalizeLiveWar, normalizeLiveCapital } = await import('./liveData.js');

const NOW = Date.parse('2026-09-19T12:00:00Z');

const baseWar = {
  state: 'inWar',
  teamSize: 10,
  startTime: '2026-09-19T10:00:00Z',
  endTime: '2026-09-19T22:00:00Z',
  clan: {
    tag: '#OURTAG', name: 'Never Die', stars: 12, destructionPercentage: 64.2,
    memberList: [
      { tag: '#P1', name: 'A', mapPosition: 1, attacks: [{ stars: 3, destructionPercentage: 80 }, { stars: 2, destructionPercentage: 60 }] },
      { tag: '#P2', name: 'B', mapPosition: 2, attacks: [{ stars: 1, destructionPercentage: 40 }] },
      { tag: '#P3', name: 'C', mapPosition: 3, attacks: [] }
    ]
  },
  opponent: {
    tag: '#FOE', name: 'Rivals', stars: 8, destructionPercentage: 51.5,
    memberList: [{ tag: '#F1', name: 'Foe A', mapPosition: 1, attacks: [{ stars: 3, destructionPercentage: 90 }] }]
  }
};

test('normalizeLiveWar maps the live payload to member rows with attack usage', () => {
  const live = normalizeLiveWar(baseWar, NOW);
  assert.equal(live.state, 'inWar');
  assert.equal(live.time_left_ms, Date.parse('2026-09-19T22:00:00Z') - NOW);
  assert.equal(live.our_clan.name, 'Never Die');
  assert.equal(live.our_clan.attacks_used, 3);
  assert.equal(live.our_clan.attacks_available, 6);
  assert.equal(live.opponent.stars, 8);
  assert.deepEqual(live.our_members.map(m => [m.player_name, m.attacks_used, m.attacks_available]), [
    ['A', 2, 2], ['B', 1, 2], ['C', 0, 2]
  ]);
});

test('normalizeLiveWar resolves preparation and ended states from the battle window', () => {
  const prep = normalizeLiveWar({ ...baseWar, state: 'preparation', startTime: '2026-09-19T18:00:00Z', endTime: '2026-09-20T06:00:00Z' }, NOW);
  assert.equal(prep.state, 'preparation');
  assert.equal(prep.preparation_ends_in_ms, Date.parse('2026-09-19T18:00:00Z') - NOW);

  const ended = normalizeLiveWar({ ...baseWar, state: 'inWar', endTime: '2026-09-19T11:00:00Z' }, NOW);
  assert.equal(ended.state, 'warEnded');
  assert.equal(ended.time_left_ms, 0);
});

test('normalizeLiveWar returns null outside a war', () => {
  assert.equal(normalizeLiveWar(null, NOW), null);
  assert.equal(normalizeLiveWar({ state: 'notInWar' }, NOW), null);
  assert.equal(normalizeLiveWar({ state: 'inWar', clan: {} }, NOW), null);
});

test('normalizeLiveCapital reports the latest weekend state', () => {
  const ongoing = normalizeLiveCapital([{
    startTime: '2026-09-18T00:00:00Z',
    endTime: '2026-09-20T00:00:00Z',
    raidsCompleted: 4, totalAttacks: 220, capitalTotalLoot: 12345
  }], NOW);
  assert.equal(ongoing.state, 'ongoing');
  assert.equal(ongoing.time_left_ms, Date.parse('2026-09-20T00:00:00Z') - NOW);
  assert.equal(ongoing.raids_completed, 4);

  const ended = normalizeLiveCapital([{
    startTime: '2026-09-12T00:00:00Z',
    endTime: '2026-09-14T00:00:00Z'
  }], NOW);
  assert.equal(ended.state, 'ended');
  assert.equal(ended.time_left_ms, 0);

  assert.equal(normalizeLiveCapital([], NOW), null);
});
