// Applies the zigbee-ember enhancement to an extracted Homey SHS /app tree.
//
// Verifies the pinned SHS and @athombv/zigbee contents against compatibility.json
// before changing anything, so an upstream bump fails the build instead of being
// patched blind. config.mts is deliberately not hash-verified: the repo's patch
// series edits it first, and the exact-anchor replacement below is its own guard.
//
// Usage:
//   node apply.mjs [root] [manifest] [overlay]   apply to <root> (default /)
//   node apply.mjs --list                        print the /app-relative files this
//                                                script modifies or creates, then exit
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

const CHANGED_FILES = [
  'apps/homey-shs/config.mts',
  'apps/homey-shs/lib/System.mts',
  'apps/homey-shs/lib/ManagerZigbee.mts',
  'apps/homey-shs/lib/ManagerZigbeeBridge.mts',
];

if (process.argv[2] === '--list') {
  console.log(CHANGED_FILES.join('\n'));
  process.exit(0);
}

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = process.argv[2] ?? '/';
const manifestPath = process.argv[3] ?? path.join(here, 'compatibility.json');
const overlayPath = process.argv[4] ?? path.join(here, 'overlay/ManagerZigbee.mts');

const resolveRoot = (absolutePath) => path.join(root, absolutePath.replace(/^\//, ''));
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

for (const [file, expectedHash] of Object.entries(manifest.files)) {
  const contents = await fs.readFile(resolveRoot(file));
  const actualHash = createHash('sha256').update(contents).digest('hex');
  if (actualHash !== expectedHash) {
    throw new Error(
      `Unsupported Homey SHS contents at ${file}: expected sha256:${expectedHash}, got sha256:${actualHash}`,
    );
  }
}

const shsPackagePath = resolveRoot('/app/apps/homey-shs/package.json');
const zigbeePackagePath = resolveRoot('/app/node_modules/@athombv/zigbee/package.json');
const shsPackage = JSON.parse(await fs.readFile(shsPackagePath, 'utf8'));
const zigbeePackage = JSON.parse(await fs.readFile(zigbeePackagePath, 'utf8'));

if (shsPackage.version !== manifest.homeyShsVersion) {
  throw new Error(
    `Unsupported Homey SHS version: expected ${manifest.homeyShsVersion}, got ${shsPackage.version}`,
  );
}
if (zigbeePackage.version !== manifest.zigbeeVersion) {
  throw new Error(
    `Unsupported @athombv/zigbee version: expected ${manifest.zigbeeVersion}, got ${zigbeePackage.version}`,
  );
}

async function replaceExact(file, oldValue, newValue) {
  const filePath = resolveRoot(file);
  const contents = await fs.readFile(filePath, 'utf8');
  const first = contents.indexOf(oldValue);
  const last = contents.lastIndexOf(oldValue);
  if (first === -1 || first !== last) {
    throw new Error(`Compatibility patch did not find exactly one expected block in ${file}`);
  }
  await fs.writeFile(filePath, contents.replace(oldValue, newValue));
}

await replaceExact(
  '/app/apps/homey-shs/config.mts',
  "  HOMEY_LOCAL_ADDRESS: z.string().nullable().optional(),\n",
  `  HOMEY_LOCAL_ADDRESS: z.string().nullable().optional(),

  HOMEY_ZIGBEE_BACKEND: z.enum(['bridge', 'ember']).default('bridge'),
  HOMEY_ZIGBEE_DEVICE: z.string().min(1).default('/dev/zigbee'),
  HOMEY_ZIGBEE_BAUDRATE: z.preprocess(
    (val) => (val != null ? Number(val) : 460800),
    z.number().int().positive(),
  ),
  HOMEY_ZIGBEE_RTSCTS: z.preprocess((val) => {
    if (val == null || val === '') return true;
    if (val === true || val === 'true' || val === '1') return true;
    if (val === false || val === 'false' || val === '0') return false;
    return val;
  }, z.boolean()),
  HOMEY_ZIGBEE_CHANNEL: z.preprocess(
    (val) => (val != null ? Number(val) : 11),
    z.number().int().min(11).max(26),
  ),
`,
);

await replaceExact(
  '/app/apps/homey-shs/lib/System.mts',
  "import { SystemLocal } from '@athombv/homey-local';\n",
  "import { SystemLocal } from '@athombv/homey-local';\n\nimport { config } from '../config.mts';\n",
);
await replaceExact(
  '/app/apps/homey-shs/lib/System.mts',
  '  override hasZigbee() {\n    return false;\n  }',
  "  override hasZigbee() {\n    return config.HOMEY_ZIGBEE_BACKEND === 'ember';\n  }",
);

const managerPath = resolveRoot('/app/apps/homey-shs/lib/ManagerZigbee.mts');
const bridgeManagerPath = resolveRoot('/app/apps/homey-shs/lib/ManagerZigbeeBridge.mts');
await fs.copyFile(managerPath, bridgeManagerPath, fs.constants.COPYFILE_EXCL);
await fs.copyFile(overlayPath, managerPath);

console.log(
  `Applied Homey SHS ${manifest.homeyShsVersion} Ember overlay for @athombv/zigbee ${manifest.zigbeeVersion}`,
);
