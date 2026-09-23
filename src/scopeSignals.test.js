import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDatasetSignal, resolveRetrievalQuestion, WAR, MONTHS } from './scopeSignals.js';
import { buildQueryPlan } from './queryEngine.js';

test('word boundaries: no false positives inside other words', () => {
  assert.equal(WAR.test('when did it start'), false);      // "star" in "start"
  assert.equal(WAR.test('within the week'), false);        // "hit" in "within"
  assert.equal(MONTHS.test('you may want to check'), false);
  assert.equal(MONTHS.test('how do i build a base'), false);
});

test('follow-up without a dataset inherits the previous question scope', () => {
  const r = resolveRetrievalQuestion('what about them?', ['who has not attacked in capital raid']);
  assert.match(r, /capital raid/);
  assert.equal(buildQueryPlan(r).scope, 'capital');
});

test('self-contained question and corrections are never overridden by history', () => {
  const prev = ['who has not attacked in capital raid'];
  assert.equal(resolveRetrievalQuestion('i mean the clan war, not capital raid', prev), 'i mean the clan war, not capital raid');
  assert.equal(resolveRetrievalQuestion('who has the lowest donations', prev), 'who has the lowest donations');
  assert.equal(hasDatasetSignal('hello'), false);
});
