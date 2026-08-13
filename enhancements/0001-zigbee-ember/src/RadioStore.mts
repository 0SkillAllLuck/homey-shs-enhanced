import { randomBytes, randomInt } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { formatHomeyHex, homeyHexToBuffer } from './address.mts';

export interface StoredNetwork {
  panId: number;
  extendedPanId: string;
  channel: number;
  networkKey: string;
}

const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;

function assertStoredNetwork(value: unknown): asserts value is StoredNetwork {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid network.json');
  const network = value as Record<string, unknown>;
  if (!Number.isInteger(network.panId) || Number(network.panId) < 1 || Number(network.panId) > 0xfffe) {
    throw new TypeError('Invalid PAN ID in network.json');
  }
  if (!Number.isInteger(network.channel) || Number(network.channel) < 11 || Number(network.channel) > 26) {
    throw new TypeError('Invalid channel in network.json');
  }
  homeyHexToBuffer(String(network.extendedPanId), 8, 'extended PAN ID');
  homeyHexToBuffer(String(network.networkKey), 16, 'network key');
}

export class RadioStore {
  readonly directory: string;
  readonly networkPath: string;
  readonly backupPath: string;

  constructor(directory = '/homey/user/zigbee-ember') {
    this.directory = directory;
    this.networkPath = path.join(directory, 'network.json');
    this.backupPath = path.join(directory, 'coordinator-backup.json');
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true, mode: DIRECTORY_MODE });
    await fs.chmod(this.directory, DIRECTORY_MODE);
  }

  createNetwork(channel: number): StoredNetwork {
    if (!Number.isInteger(channel) || channel < 11 || channel > 26) {
      throw new RangeError(`Invalid Zigbee channel: ${channel}`);
    }
    return {
      panId: randomInt(1, 0xffff),
      extendedPanId: formatHomeyHex(randomBytes(8), 8, 'extended PAN ID'),
      channel,
      networkKey: formatHomeyHex(randomBytes(16), 16, 'network key'),
    };
  }

  async loadOrCreateNetwork(initialChannel: number) {
    await this.init();
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.networkPath, 'utf8'));
      assertStoredNetwork(parsed);
      await fs.chmod(this.networkPath, FILE_MODE);
      return parsed;
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
      const network = this.createNetwork(initialChannel);
      await this.writeNetwork(network);
      return network;
    }
  }

  async resetNetwork(channel: number) {
    const network = this.createNetwork(channel);
    // Delete the old backup first. A crash between these operations then leaves a complete old
    // network.json without a backup, never a new network.json paired with the old backup.
    await fs.rm(this.backupPath, { force: true });
    await this.writeNetwork(network);
    return network;
  }

  async writeNetwork(network: StoredNetwork) {
    assertStoredNetwork(network);
    await this.writeJsonAtomic(this.networkPath, network);
  }

  async writeBackup(backup: unknown) {
    await this.writeJsonAtomic(this.backupPath, backup);
  }

  private async writeJsonAtomic(target: string, value: unknown) {
    await this.init();
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await fs.open(temporary, 'wx', FILE_MODE);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await fs.rm(temporary, { force: true });
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }
    try {
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    await fs.chmod(target, FILE_MODE);
  }
}
