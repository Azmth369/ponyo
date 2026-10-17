import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCapitalRaidReport, buildWarReport } from './reportFormat.js';

test('war report sorts players alphabetically and includes score and attacks', () => {
  const report = buildWarReport({
    cw_uid: 'CW010', opponent_clan_name: 'Rivals', battle_start: '2026-10-16T07:00:00.000Z',
    battle_end: '2026-10-18T07:00:00.000Z', our_clan_score: 28, opponent_clan_score: 27,
    our_clan_destruction: 94.2, opponent_clan_destruction: 91.5, result: 'win', participants_size: 2
  }, [
    { player_name: 'Zed', attacks_used: 1, attacks_available: 2 },
    { player_name: 'Alice', attacks_used: 2, attacks_available: 2 }
  ]);
  assert.match(report, /Opponent Clan: Rivals/);
  assert.match(report, /Date of Battle: 16\/10\/2026/);
  assert.match(report, /Result: \(28 : 27\) stars — WIN/);
  assert.ok(report.indexOf('Alice') < report.indexOf('Zed'));
  assert.match(report, /Alice — 2 out of 2/);
});

test('war report adds destruction tiebreak when stars are tied', () => {
  const report = buildWarReport({
    cw_uid: 'CW011', battle_start: '2026-10-16T07:00:00Z', battle_end: '2026-10-18T07:00:00Z',
    opponent_clan_name: 'Rivals', our_clan_score: 30, opponent_clan_score: 30,
    our_clan_destruction: 99.5, opponent_clan_destruction: 98.2, participants_size: 1
  }, [{ player_name: 'A', attacks_used: 2, attacks_available: 2 }]);
  assert.match(report, /WIN \(decided by destruction: 99\.50% vs 98\.20%\)/);
});

test('war report waits for missing participant details', () => {
  assert.equal(buildWarReport({ cw_uid: 'CW1', battle_end: '2026-10-18T00:00:00Z', our_clan_score: 1, opponent_clan_score: 0, participants_size: 2 }, [
    { player_name: 'A', attacks_used: 2, attacks_available: 2 }
  ]), null);
});

test('capital raid report sorts names and shows participation percentage', () => {
  const report = buildCapitalRaidReport({
    generated_uid: 'CR215', battle_start: '2026-10-16T07:00:00Z', battle_end: '2026-10-19T07:00:00Z',
    participants_no: 2, participants_name: ['Zed', 'Alice']
  }, [
    { player_name: 'Zed', attacks_used: 4, attacks_available: 6 },
    { player_name: 'Alice', attacks_used: 6, attacks_available: 6 }
  ], 44);
  assert.match(report, /Raid Weekend Date: 16\/10\/2026/);
  assert.match(report, /Participants no\.: 2\/44 \(4\.55%\)/);
  assert.ok(report.indexOf('Alice') < report.indexOf('Zed'));
  assert.match(report, /Alice — 6\/6 attacks/);
});

test('capital raid report waits when participant details are incomplete', () => {
  assert.equal(buildCapitalRaidReport({
    generated_uid: 'CR1', battle_start: '2026-10-16T07:00:00Z', battle_end: '2026-10-19T07:00:00Z',
    participants_no: 2, participants_name: ['Alice', 'Zed']
  }, [{ player_name: 'Alice', attacks_used: 2, attacks_available: 6 }], 44), null);
});
