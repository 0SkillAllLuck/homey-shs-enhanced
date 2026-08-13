import assert from 'node:assert/strict';
import test from 'node:test';

import {
  jitterBackoffMs,
  nextBackoffMs,
  RETRY_INITIAL_MS,
  RETRY_MAX_MS,
  waitForDelay,
} from '../../src/backoff.mts';

test('doubles retry delays up to the sixty-second cap', () => {
  assert.equal(nextBackoffMs(RETRY_INITIAL_MS), 4_000);
  assert.equal(nextBackoffMs(16_000), 32_000);
  assert.equal(nextBackoffMs(32_000), RETRY_MAX_MS);
  assert.equal(nextBackoffMs(RETRY_MAX_MS), RETRY_MAX_MS);
});

test('applies deterministic plus or minus twenty-percent jitter', () => {
  assert.equal(jitterBackoffMs(10_000, () => 0), 8_000);
  assert.equal(jitterBackoffMs(10_000, () => 0.5), 10_000);
  assert.equal(jitterBackoffMs(10_000, () => 1), 12_000);
});

test('caps the final jittered retry delay at sixty seconds', () => {
  assert.equal(jitterBackoffMs(RETRY_MAX_MS, () => 1), RETRY_MAX_MS);
});

test('waitForDelay rejects immediately for an already-aborted signal', async () => {
  const controller = new AbortController();
  const reason = new Error('stop retrying');
  controller.abort(reason);

  await assert.rejects(waitForDelay(60_000, controller.signal), reason);
});

test('waitForDelay can be interrupted while waiting', async () => {
  const controller = new AbortController();
  const reason = new Error('shutdown');
  const waiting = waitForDelay(60_000, controller.signal);

  controller.abort(reason);

  await assert.rejects(waiting, reason);
});
