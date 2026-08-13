import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RadioStore, type StoredNetwork } from '../../src/RadioStore.mts';

const NETWORK: StoredNetwork = {
  panId: 0x1234,
  extendedPanId: '00:12:4b:00:01:ab:cd:ef',
  channel: 15,
  networkKey: '00:01:02:03:04:05:06:07:08:09:0a:0b:0c:0d:0e:0f',
};

async function withStore(run: (store: RadioStore) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'homey-ember-radio-store-'));
  try {
    await run(new RadioStore(path.join(root, 'zigbee-ember')));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('writes network state atomically with private permissions', async () => {
  await withStore(async (store) => {
    await store.writeNetwork(NETWORK);

    assert.deepEqual(JSON.parse(await fs.readFile(store.networkPath, 'utf8')), NETWORK);
    assert.equal((await fs.stat(store.directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(store.networkPath)).mode & 0o777, 0o600);
    assert.deepEqual(
      (await fs.readdir(store.directory)).filter((entry) => entry.endsWith('.tmp')),
      [],
    );
  });
});

test('loads persisted credentials instead of applying a later initial channel', async () => {
  await withStore(async (store) => {
    await store.writeNetwork(NETWORK);

    // A process killed before rename can leave only its temporary file. The last committed
    // network must remain the sole source of truth on restart.
    await fs.writeFile(`${store.networkPath}.interrupted.tmp`, '{"panId":', { mode: 0o600 });

    assert.deepEqual(await store.loadOrCreateNetwork(26), NETWORK);
  });
});

test('creates valid credentials on first start', async () => {
  await withStore(async (store) => {
    const network = await store.loadOrCreateNetwork(20);

    assert.equal(network.channel, 20);
    assert.ok(Number.isInteger(network.panId));
    assert.ok(network.panId >= 1 && network.panId <= 0xfffe);
    assert.match(network.extendedPanId, /^(?:[0-9a-f]{2}:){7}[0-9a-f]{2}$/);
    assert.match(network.networkKey, /^(?:[0-9a-f]{2}:){15}[0-9a-f]{2}$/);
    assert.deepEqual(JSON.parse(await fs.readFile(store.networkPath, 'utf8')), network);
  });
});

test('reset replaces network state and removes the old coordinator backup', async () => {
  await withStore(async (store) => {
    await store.writeNetwork(NETWORK);
    await store.writeBackup({ metadata: { source: 'test' } });

    const reset = await store.resetNetwork(25);

    assert.equal(reset.channel, 25);
    assert.deepEqual(JSON.parse(await fs.readFile(store.networkPath, 'utf8')), reset);
    await assert.rejects(fs.access(store.backupPath), { code: 'ENOENT' });
  });
});

test('rejects malformed persisted or requested network state', async () => {
  await withStore(async (store) => {
    await store.init();
    await fs.writeFile(store.networkPath, '{"panId": 0}\n', { mode: 0o600 });

    await assert.rejects(store.loadOrCreateNetwork(11), /Invalid PAN ID/);
    await assert.rejects(store.writeNetwork({ ...NETWORK, channel: 27 }), /Invalid channel/);
    assert.throws(() => store.createNetwork(10), /Invalid Zigbee channel/);
  });
});
