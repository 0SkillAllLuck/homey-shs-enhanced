import { createRequire } from 'node:module';

import type { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const facade = require('./homey-ember.cjs') as {
  BackupUtils: { toUnifiedBackup(backup: unknown): unknown };
  HomeyEmberAdapter: new (
    networkOptions: HerdsmanNetworkOptions,
    serialPortOptions: HerdsmanSerialOptions,
    backupPath: string,
    adapterOptions: HerdsmanAdapterOptions,
  ) => HomeyEmberAdapterLike;
  HomeyEmberStatusError: new (...args: any[]) => Error;
  ZSpec: Record<string, any>;
  Zdo: Record<string, any>;
};

export interface HerdsmanNetworkOptions {
  panID: number;
  extendedPanID: number[];
  channelList: number[];
  networkKey: number[];
  networkKeyDistribute: false;
}

export interface HerdsmanSerialOptions {
  adapter: 'ember';
  path: string;
  baudRate: number;
  rtscts: boolean;
}

export interface HerdsmanAdapterOptions {
  disableLED: boolean;
}

export interface RawZdoFrame {
  sender: number;
  endpoint: number;
  sequence: number;
  clusterId: number;
  payload: Buffer;
  response?: [number, any];
  parseError?: unknown;
}

export interface HomeyEmberAdapterLike extends EventEmitter {
  start(): Promise<'resumed' | 'reset' | 'restored'>;
  stop(): Promise<void>;
  getCoordinatorIEEE(): Promise<string>;
  getCoordinatorVersion(): Promise<{ type: string; meta: Record<string, string | number> }>;
  getNetworkParameters(): Promise<{
    panID: number;
    extendedPanID: string;
    channel: number;
    nwkUpdateID: number;
  }>;
  addInstallCode(ieeeAddress: string, key: Buffer, hashed: boolean): Promise<void>;
  permitJoin(seconds: number, networkAddress?: number): Promise<void>;
  sendZdo(
    ieeeAddress: string,
    networkAddress: number,
    clusterId: number,
    payload: Buffer,
    disableResponse: boolean,
  ): Promise<[number, any] | undefined>;
  sendHomeyZdo(options: {
    ieeeAddress: string;
    networkAddress: number;
    clusterId: number;
    payload: Buffer;
    disableResponse?: boolean;
    timeout?: number;
    signal?: AbortSignal;
  }): Promise<[number, any] | undefined>;
  sendRawZclFrame(options: {
    ieeeAddress: string;
    networkAddress: number;
    endpoint: number;
    clusterId: number;
    data: Buffer;
    forceRouteDiscovery: boolean;
    timeout?: number;
    signal?: AbortSignal;
  }): Promise<unknown>;
  addMulticastGroup(groupId: number, signal?: AbortSignal): Promise<void>;
  removeMulticastGroup(groupId: number, signal?: AbortSignal): Promise<void>;
  backup(ieeeAddresses: string[]): Promise<unknown>;
}

export type AdapterFactory = (options: {
  networkOptions: HerdsmanNetworkOptions;
  serialPortOptions: HerdsmanSerialOptions;
  backupPath: string;
  adapterOptions: HerdsmanAdapterOptions;
}) => HomeyEmberAdapterLike;

export const { BackupUtils, HomeyEmberStatusError, ZSpec, Zdo } = facade;

export const defaultAdapterFactory: AdapterFactory = ({
  networkOptions,
  serialPortOptions,
  backupPath,
  adapterOptions,
}) => new facade.HomeyEmberAdapter(networkOptions, serialPortOptions, backupPath, adapterOptions);
