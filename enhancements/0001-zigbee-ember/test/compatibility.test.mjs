import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const patchScript = fileURLToPath(new URL('../apply.mjs', import.meta.url));

const CONFIG = `import { z } from 'zod';

const schema = z.object({
  HOMEY_LOCAL_ADDRESS: z.string().nullable().optional(),
});
`;
const SYSTEM = `import { SystemLocal } from '@athombv/homey-local';

export class System extends SystemLocal {
  override hasZigbee() {
    return false;
  }
}
`;
const MANAGER = 'export class ManagerZigbee {}\n';
const OVERLAY = 'export const ManagerZigbee = class EmberManager {};\n';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function write(root, absolutePath, contents) {
  const target = path.join(root, absolutePath.replace(/^\//, ''));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
  return target;
}

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'homey-shs-patch-'));
  const shsPackage = `${JSON.stringify({ version: '13.3.1' })}\n`;
  const zigbeePackage = `${JSON.stringify({ version: '4.5.2' })}\n`;
  const sourceFiles = {
    '/app/apps/homey-shs/config.mts': CONFIG,
    '/app/apps/homey-shs/lib/System.mts': SYSTEM,
    '/app/apps/homey-shs/lib/ManagerZigbee.mts': MANAGER,
    '/app/apps/homey-shs/package.json': shsPackage,
    '/app/node_modules/@athombv/zigbee/package.json': zigbeePackage,
  };
  for (const [file, contents] of Object.entries(sourceFiles)) {
    await write(root, file, contents);
  }
  const overlay = await write(root, '/overlay/ManagerZigbee.mts', OVERLAY);
  const manifest = {
    homeyShsVersion: '13.3.1',
    zigbeeVersion: '4.5.2',
    files: Object.fromEntries(
      Object.entries(sourceFiles).map(([file, contents]) => [file, sha256(contents)]),
    ),
  };
  const manifestPath = await write(root, '/compatibility.json', `${JSON.stringify(manifest)}\n`);
  return { root, manifestPath, overlay };
}

async function runPatch(fixture) {
  return execFileAsync(process.execPath, [patchScript, fixture.root, fixture.manifestPath, fixture.overlay]);
}

test('patches only the guarded SHS files and preserves the Bridge manager', async () => {
  const fixture = await createFixture();
  try {
    const { stdout } = await runPatch(fixture);
    const appRoot = path.join(fixture.root, 'app/apps/homey-shs');
    const config = await fs.readFile(path.join(appRoot, 'config.mts'), 'utf8');
    const system = await fs.readFile(path.join(appRoot, 'lib/System.mts'), 'utf8');

    assert.match(stdout, /Applied Homey SHS 13\.3\.1 Ember overlay/);
    assert.match(config, /HOMEY_ZIGBEE_BACKEND: z\.enum\(\['bridge', 'ember'\]\)\.default\('bridge'\)/);
    assert.match(config, /HOMEY_ZIGBEE_DEVICE: z\.string\(\)\.min\(1\)\.default\('\/dev\/zigbee'\)/);
    assert.match(config, /HOMEY_ZIGBEE_BAUDRATE:[\s\S]*460800/);
    assert.match(config, /HOMEY_ZIGBEE_RTSCTS:[\s\S]*val === '0'/);
    assert.match(config, /HOMEY_ZIGBEE_CHANNEL:[\s\S]*min\(11\)\.max\(26\)/);
    assert.match(system, /import \{ config \} from '\.\.\/config\.mts';/);
    assert.match(system, /return config\.HOMEY_ZIGBEE_BACKEND === 'ember';/);
    assert.equal(await fs.readFile(path.join(appRoot, 'lib/ManagerZigbeeBridge.mts'), 'utf8'), MANAGER);
    assert.equal(await fs.readFile(path.join(appRoot, 'lib/ManagerZigbee.mts'), 'utf8'), OVERLAY);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects an unknown SHS file before applying any patch', async () => {
  const fixture = await createFixture();
  try {
    await write(fixture.root, '/app/apps/homey-shs/config.mts', `${CONFIG}// upstream drift\n`);

    await assert.rejects(runPatch(fixture), (error) => {
      assert.match(error.stderr, /Unsupported Homey SHS contents.*config\.mts/);
      return true;
    });
    await assert.rejects(
      fs.access(path.join(fixture.root, 'app/apps/homey-shs/lib/ManagerZigbeeBridge.mts')),
      { code: 'ENOENT' },
    );
    assert.equal(
      await fs.readFile(path.join(fixture.root, 'app/apps/homey-shs/lib/ManagerZigbee.mts'), 'utf8'),
      MANAGER,
    );
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('rejects mismatched package versions even when source hashes match', async () => {
  const fixture = await createFixture();
  try {
    const packagePath = path.join(fixture.root, 'app/apps/homey-shs/package.json');
    const mismatchedPackage = `${JSON.stringify({ version: '13.3.2' })}\n`;
    await fs.writeFile(packagePath, mismatchedPackage);
    const manifest = JSON.parse(await fs.readFile(fixture.manifestPath, 'utf8'));
    manifest.files['/app/apps/homey-shs/package.json'] = sha256(mismatchedPackage);
    await fs.writeFile(fixture.manifestPath, `${JSON.stringify(manifest)}\n`);

    await assert.rejects(runPatch(fixture), (error) => {
      assert.match(error.stderr, /Unsupported Homey SHS version: expected 13\.3\.1, got 13\.3\.2/);
      return true;
    });
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});
