import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const overlayPath = new URL('../../overlay/ManagerZigbee.mts', import.meta.url);

async function createFixture(backend: 'bridge' | 'ember') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'homey-ember-selector-'));
  const managerDirectory = path.join(root, 'app/apps/homey-shs/lib');
  const emberDirectory = path.join(root, 'app/enhancements/0001-zigbee-ember/src');
  await fs.mkdir(managerDirectory, { recursive: true });
  await fs.mkdir(emberDirectory, { recursive: true });
  await fs.writeFile(
    path.join(root, 'app/apps/homey-shs/config.mts'),
    `export const config = { HOMEY_ZIGBEE_BACKEND: '${backend}' };\n`,
  );
  await fs.writeFile(
    path.join(managerDirectory, 'ManagerZigbeeBridge.mts'),
    'export class ManagerZigbee {}\n',
  );
  await fs.writeFile(
    path.join(emberDirectory, 'ManagerZigbeeEmber.mts'),
    'export class ManagerZigbeeEmber {}\n',
  );
  await fs.copyFile(overlayPath, path.join(managerDirectory, 'ManagerZigbee.mts'));
  return { root, managerPath: path.join(managerDirectory, 'ManagerZigbee.mts') };
}

test('selects the Bridge backend once when configured as bridge', async () => {
  const fixture = await createFixture('bridge');
  try {
    const selected = await import(pathToFileURL(fixture.managerPath).href);
    assert.equal(selected.ManagerZigbee.name, 'ManagerZigbee');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('selects the Ember backend once when configured as ember', async () => {
  const fixture = await createFixture('ember');
  try {
    const selected = await import(pathToFileURL(fixture.managerPath).href);
    assert.equal(selected.ManagerZigbee.name, 'ManagerZigbeeEmber');
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
