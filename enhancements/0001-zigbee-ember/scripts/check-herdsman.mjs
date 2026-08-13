// npm postinstall: refuses any zigbee-herdsman other than the build the driver in
// src/homey-ember.cjs was written against — it subclasses the Ember adapter's private
// internals, which can change in any herdsman release.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

const enhancementRoot = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
const packageRoot = path.join(enhancementRoot, 'node_modules/zigbee-herdsman');
const { version } = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));

if (version !== '10.6.2') {
  throw new Error(`Unsupported zigbee-herdsman ${version}; the Ember driver targets 10.6.2`);
}

const guardedFile = path.join(packageRoot, 'dist/adapter/ember/adapter/emberAdapter.js');
const expectedHash = '3d4aaf207f264fd29ceeb548c53573b1182c06aa037178a8557fd7c72877a403';
const actualHash = createHash('sha256').update(await fs.readFile(guardedFile)).digest('hex');
if (actualHash !== expectedHash) {
  throw new Error(
    `Unsupported zigbee-herdsman Ember adapter build: expected sha256:${expectedHash}, got sha256:${actualHash}`,
  );
}
