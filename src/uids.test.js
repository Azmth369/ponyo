import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSeq, formatSeq, nextSeq, isLegacyUid,
  warAttackUid, cwlDayUid, cwlAttackUid, capitalRaidUid, capitalAttackUid
} from './uids.js';
import { formatIST, formatDiscordTimestamps } from './format.js';

test('formatSeq pads sequences to three digits', () => {
  assert.equal(formatSeq('CW', 1), 'CW001');
  assert.equal(formatSeq('CW', 47), 'CW047');
  assert.equal(formatSeq('CWL', 1234, 3), 'CWL1234');
});

test('parseSeq reads the sequence number back out', () => {
  assert.equal(parseSeq('CW047', 'CW'), 47);
  assert.equal(parseSeq('CWL012', 'CWL'), 12);
  assert.equal(parseSeq('not-a-uid', 'CW'), null);
  assert.equal(parseSeq('#CLAN:20260915T071500.000Z:open', 'CW'), null);
});

test('nextSeq returns max+1 over mixed existing UIDs and ignores legacy formats', () => {
  const existing = ['CW001', 'CW003', '#CLAN:20260915T071500.000Z:20260917T071500.000Z', 'CW002'];
  assert.equal(nextSeq(existing, 'CW'), 4);
  assert.equal(nextSeq([], 'CW'), 1);
  assert.equal(nextSeq(null, 'CW'), 1);
});

test('isLegacyUid detects the old timestamp-based format', () => {
  assert.equal(isLegacyUid('#CLAN:20260915T071500.000Z:open'), true);
  assert.equal(isLegacyUid('CW001'), false);
  assert.equal(isLegacyUid(undefined), false);
});

test('attack and day UID builders follow the spreadsheet scheme', () => {
  assert.equal(warAttackUid('CW001', 1), 'CW001-ATK001');
  assert.equal(warAttackUid('CW001', 12), 'CW001-ATK012');
  assert.equal(cwlDayUid('CWL001', 2), 'CWL001-D2');
  assert.equal(cwlAttackUid('CWL001-D2', 3), 'CWL001-D2-ATK03');
  assert.equal(capitalRaidUid('CR001', 2), 'CR001-R2');
  assert.equal(capitalAttackUid('CR001-R2', 5), 'CR001-R2-ATK005');
});

test('formatIST renders IST with DD/MM/YYYY and 24h time', () => {
  // 05:00 UTC = 10:30 IST
  assert.equal(formatIST('2026-09-15T05:00:00Z'), '15/09/2026 10:30 IST');
});

test('formatDiscordTimestamps converts ISO and date-only strings', () => {
  const out = formatDiscordTimestamps('Start: 2026-09-15T05:00:00Z and on 2026-09-16');
  assert.ok(out.includes('15/09/2026 10:30 IST'));
  assert.ok(out.includes('16/09/2026'));
  assert.ok(!out.includes('2026-09-15T05:00:00Z'));
});
