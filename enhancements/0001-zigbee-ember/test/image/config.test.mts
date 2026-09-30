import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Parses the patched upstream config.mts in a child process, as the server does at startup.
async function loadTxPower(value?: string) {
  const env = { ...process.env };
  delete env.HOMEY_ZIGBEE_TX_POWER;
  if (value !== undefined) env.HOMEY_ZIGBEE_TX_POWER = value;
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--conditions=typescript',
      '--input-type=module',
      '-e',
      "const { config } = await import('/app/apps/homey-shs/config.mts'); console.log(JSON.stringify({ txPower: config.HOMEY_ZIGBEE_TX_POWER ?? null }))",
    ],
    { env },
  );
  return JSON.parse(stdout).txPower;
}

test('HOMEY_ZIGBEE_TX_POWER is unset by default and accepts integer dBm within range', async () => {
  assert.equal(await loadTxPower(), null);
  assert.equal(await loadTxPower(''), null);
  assert.equal(await loadTxPower('20'), 20);
  assert.equal(await loadTxPower('0'), 0);
  assert.equal(await loadTxPower('-20'), -20);
});

test('HOMEY_ZIGBEE_TX_POWER rejects out-of-range and non-integer values at startup', async () => {
  for (const value of ['21', '-21', '10.5', 'max', '20dBm']) {
    await assert.rejects(loadTxPower(value), (error: any) => {
      assert.match(error.stderr, /HOMEY_ZIGBEE_TX_POWER/, `value ${value}`);
      return true;
    });
  }
});
