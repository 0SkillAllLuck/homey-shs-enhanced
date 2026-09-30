import { createRequire } from 'node:module';

import type { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const facade = require('./homey-ember.cjs') as {
  setLogger(logger: HerdsmanLogger): void;
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

type LogMessage = string | (() => string);

export interface HerdsmanLogger {
  debug(message: LogMessage, namespace: string): void;
  info(message: LogMessage, namespace: string): void;
  warning(message: LogMessage, namespace: string): void;
  error(message: LogMessage, namespace: string): void;
}

interface Debugger {
  (format: string, ...args: unknown[]): void;
  readonly enabled: boolean;
}

// The enhancement's node_modules carries its own `debug` (a serialport dependency). Resolve the
// copy Homey's packages use, so Homey's Zigbee debug toggle (ZigbeeLocal.setDebug) reaches it.
const homeyDebug = createRequire(import.meta.resolve('@athombv/homey-local'))('debug') as (
  namespace: string,
) => Debugger;

const debuggers = new Map<string, Debugger>();
const text = (message: LogMessage) => (typeof message === 'function' ? message() : message);

// herdsman's default logger prints every level to the console, down to a line per ASH frame.
// Keep info and above, and put debug behind Homey's `zigbee:*` namespaces: off by default, on
// while Zigbee debug logging is enabled in Homey. Lazy messages are only built when enabled.
facade.setLogger({
  debug(message, namespace) {
    let log = debuggers.get(namespace);
    if (!log) debuggers.set(namespace, (log = homeyDebug(`zigbee:${namespace}`)));
    if (log.enabled) log('%s', text(message));
  },
  info: (message, namespace) => console.info(`${namespace}: ${text(message)}`),
  warning: (message, namespace) => console.warn(`${namespace}: ${text(message)}`),
  error: (message, namespace) => console.error(`${namespace}: ${text(message)}`),
});

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
  transmitPower?: number;
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
