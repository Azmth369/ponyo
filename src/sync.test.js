// Unit tests for the pure payload transformations in transform.js.
// No environment setup or network access is required: transform.js is
// completely side-effect free apart from the default clan tag.

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  cocStamp, mapLabel, warResultFromSummary, sortedWarAttacks, normalWarRows,
  capitalAttackRows, participantStats
} = await import('./transform.js');

const CLAN = '#TEST';

const war = {
  state: 'inWar',
  startTime: '20260915T101500.000Z',
  endTime: '20260917T101500.000Z',
  clan: {
    tag: CLAN,
    name: 'TestClan',
    stars: 12,
    destructionPercentage: 80,
    members: [
      {
        tag: '#P1', name: 'Alice', mapPosition: 1,
        attacks: [{ order: 1, stars: 3, destructionPercentage: 90, defenderTag: '#E1', defenderName: 'Foe1', attackTime: '20260915T110000.000Z' }]
      },
      { tag: '#P2', name: 'Bob', mapPosition: 2, attacks: [] }
    ]
  },
  opponent: {
    tag: '#OPP', name: 'Opponent', stars: 5, destructionPercentage: 40,
    members: [{ tag: '#E1', name: 'Foe1', mapPosition: 1 }]
  }
};

test('cocStamp parses CoC API timestamps to ISO', () => {
  assert.equal(cocStamp('20260915T101500.000Z'), '2026-09-15T10:15:00.000Z');
  assert.equal(cocStamp(null), null);
  assert.equal(cocStamp('garbage'), null);
});

test('mapLabel renders name with map position', () => {
  assert.equal(mapLabel('Alice', 1), 'Alice [1]');
  assert.equal(mapLabel(null, null), 'Unknown [?]');
});

test('warResultFromSummary prefers warlog result and maps tie to draw', () => {
  assert.equal(warResultFromSummary({ result: 'win' }, null, null), 'win');
  assert.equal(warResultFromSummary({ result: 'lose' }, null, null), 'loss');
  assert.equal(warResultFromSummary({ result: 'tie' }, null, null), 'draw');
  assert.equal(warResultFromSummary({ state: 'inWar' }, { stars: 10 }, { stars: 1 }), null);
  assert.equal(warResultFromSummary({ state: 'warEnded' }, { stars: 30 }, { stars: 29 }), 'win');
});

test('normalWarRows builds session, participants and attack UIDs in the CW scheme', () => {
  const rows = normalWarRows(war, 'CW001', CLAN);
  assert.equal(rows.session.cw_uid, 'CW001');
  assert.equal(rows.session.opponent_clan_name, 'Opponent');
  assert.equal(rows.session.battle_start, '2026-09-15T10:15:00.000Z');
  assert.equal(rows.session.result, null); // still in war

  assert.equal(rows.participants.length, 2);
  const alice = rows.participants.find(p => p.player_id === '#P1');
  const bob = rows.participants.find(p => p.player_id === '#P2');
  assert.equal(alice.attacks_used, 1);
  assert.equal(alice.stars_scored, 3);
  assert.equal(alice.cw_attack_uid, 'CW001-ATK001');
  assert.equal(bob.attacks_used, 0);
  assert.equal(bob.cw_attack_uid, null);

  assert.equal(rows.attacks.length, 1);
  assert.equal(rows.attacks[0].cw_attack_uid, 'CW001-ATK001');
  assert.equal(rows.attacks[0].attacker_id, '#P1');
  assert.equal(rows.attacks[0].defender_name_with_map_position, 'Foe1 [1]');
});

test('normalWarRows ignores payloads for other clans', () => {
  const rows = normalWarRows({ ...war, clan: { ...war.clan, tag: '#OTHER' } }, 'CW002', CLAN);
  assert.equal(rows.session, null);
});

test('sortedWarAttacks numbers attacks stably by map position then order', () => {
  const sorted = sortedWarAttacks(war.clan.members);
  assert.equal(sorted.length, 1);
  assert.equal(sorted[0].member.tag, '#P1');
  assert.equal(sorted[0].order, 1);
});

const raid = {
  members: [
    { tag: '#P1', name: 'Alice', attacks: 6, capitalResourcesLooted: 2500 },
    { tag: '#P2', name: 'Bob', attacks: 0, capitalResourcesLooted: 0 }
  ],
  attackLog: [
    { defender: { name: 'DefenderA', tag: '#DA' }, districts: [
      { id: 1, name: 'Barbarian Camp', attacks: [
        { attacker: { tag: '#P1', name: 'Alice' }, stars: 2, destructionPercent: 55 },
        { attacker: { tag: '#P1', name: 'Alice' }, stars: 3, destructionPercent: 100 }
      ] }
    ] },
    { defender: { name: 'DefenderB', tag: '#DB' }, districts: [
      { id: 2, name: 'Capital Peak', attacks: [
        { attacker: { tag: '#P2', name: 'Bob' }, stars: 1, destructionPercent: 20 }
      ] }
    ] }
  ]
};

test('capitalAttackRows groups raids by defender and numbers attack UIDs', () => {
  const rows = capitalAttackRows('CR001', raid);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].generated_uid, 'CR001-R1-ATK001');
  assert.equal(rows[1].generated_uid, 'CR001-R1-ATK002');
  assert.equal(rows[2].generated_uid, 'CR001-R2-ATK001');
  assert.equal(rows[0].raid_no, 1);
  assert.equal(rows[2].raid_no, 2);
  assert.equal(rows[0].clan_name, 'DefenderA');
  assert.equal(rows[0].district_name, 'Barbarian Camp');
});

test('participantStats counts attackers as participants and the rest as absentees', () => {
  const roster = [
    { player_id: '#P1', name: 'Alice' },
    { player_id: '#P2', name: 'Bob' },
    { player_id: '#P3', name: 'Carol' }
  ];
  const stats = participantStats(raid, roster);
  assert.equal(stats.participantsNo, 1);
  assert.deepEqual(stats.participants, ['Alice']);
  assert.deepEqual(stats.absentees, ['Bob', 'Carol']);
  assert.equal(stats.rosterSize, 3);
});
