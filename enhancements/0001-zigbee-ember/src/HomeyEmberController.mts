import {
  Controller,
  TimeoutError,
  ZigbeeBindingTableFullError,
  ZigbeeNodeUnreachableError,
  type IEEEAddress,
  type JoinOpts,
  type NetworkConfiguration,
  type RequestOptsInternal,
  type ZdoBindResponse,
  type ZdoBindingTableResponse,
  type ZdoMatchDescriptorResponse,
  type ZdoSimpleDescriptorResponse,
  type ZdoUnbindResponse,
} from '@athombv/zigbee';

import {
  eui64ToHomeyIeee,
  extendedPanIdToBytes,
  homeyIeeeToEui64,
  networkKeyToBytes,
} from './address.mts';
import {
  BackupUtils,
  HomeyEmberStatusError,
  ZSpec,
  Zdo,
  defaultAdapterFactory,
  type AdapterFactory,
  type HomeyEmberAdapterLike,
  type RawZdoFrame,
} from './herdsman.mts';
import { RadioStore, type StoredNetwork } from './RadioStore.mts';

const BACKUP_AFTER_TOPOLOGY_CHANGE_MS = 30_000;
const PERIODIC_BACKUP_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_ZDO_TIMEOUT_MS = 10_000;
const COORDINATOR_ENDPOINT = 1;
const RADIO_SHUTDOWN_TIMEOUT_MS = 5_000;

const UNREACHABLE_STATUSES = new Set([
  'NETWORK_DOWN',
  'NOT_JOINED',
  'MAC_NO_ACK_RECEIVED',
  'ZIGBEE_DELIVERY_FAILED',
  'ZIGBEE_SOURCE_ROUTE_FAILURE',
  'ZIGBEE_MANY_TO_ONE_ROUTE_FAILURE',
  'ZIGBEE_NO_APS_ACK',
  'ZIGBEE_SEND_UNICAST_ROUTE_DISCOVERY_UNDERWAY',
  'ZIGBEE_SEND_UNICAST_FAILURE',
  'ZIGBEE_SEND_UNICAST_NO_ROUTE',
]);

const SELF_LEAVE_EUI64 = '0x0000000000000000';

export interface HomeyEmberControllerOptions {
  device: string;
  baudRate: number;
  rtscts: boolean;
  initialChannel: number;
  store?: RadioStore;
  adapterFactory?: AdapterFactory;
}

function abortError(signal: AbortSignal) {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('The Zigbee request was aborted');
  error.name = 'AbortError';
  return error;
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError(signal);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string) {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new TimeoutError(timeoutMs, `${operation} timed out`)),
      timeoutMs,
    );
    timeout.unref?.();
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function statusLabel(status: number) {
  return String(Zdo.Status[status] ?? status);
}

function capabilities(value: Record<string, number | boolean>) {
  return {
    alternatePANCoordinator: Boolean(value.alternatePANCoordinator),
    deviceType: Boolean(value.deviceType),
    powerSourceMains: Boolean(value.powerSource),
    receiveWhenIdle: Boolean(value.rxOnWhenIdle),
    security: Boolean(value.securityCapability),
    allocateAddress: Boolean(value.allocateAddress),
  };
}

/**
 * Homey's controller contract backed directly by zigbee-herdsman's Ember adapter.
 *
 * This class owns only radio translation and persistence. Homey's base Controller remains the
 * source of truth for queues, retries, node addressing, interview state, and route repair.
 */
export class HomeyEmberController extends Controller<any> {
  readonly options: HomeyEmberControllerOptions;
  readonly store: RadioStore;

  private readonly adapterFactory: AdapterFactory;
  private adapter?: HomeyEmberAdapterLike;
  private storedNetwork?: StoredNetwork;
  private nextResetChannel?: number;
  private backupTimeout?: NodeJS.Timeout;
  private backupInterval?: NodeJS.Timeout;
  private backupInFlight?: Promise<void>;
  private started = false;
  private destroyed = false;
  private destroyPromise?: Promise<void>;
  private skipFinalBackup = false;

  constructor(options: HomeyEmberControllerOptions) {
    super();
    this.options = options;
    this.store = options.store ?? new RadioStore();
    this.adapterFactory = options.adapterFactory ?? defaultAdapterFactory;
  }

  async start() {
    if (this.started) return;
    this.destroyed = false;
    this.storedNetwork = await this.store.loadOrCreateNetwork(this.options.initialChannel);
    await this.startAdapter(this.storedNetwork);
    this.started = true;

    // Protect a newly formed or restored network immediately, then refresh after topology changes
    // and once per day while the service is healthy.
    await this.writeBackup();
    this.backupInterval = setInterval(() => {
      this.writeBackup().catch(() => undefined);
    }, PERIODIC_BACKUP_MS);
    this.backupInterval.unref?.();

    // Homey relies on group 0 for controller-directed group traffic. It is a fixed Ember group,
    // but binding explicitly keeps this invariant visible and harmlessly idempotent.
    await this.adapter?.addMulticastGroup(0).catch(() => undefined);
  }

  setNextResetChannel(channel?: number) {
    if (channel !== undefined && (!Number.isInteger(channel) || channel < 11 || channel > 26)) {
      throw new RangeError(`Invalid Zigbee channel: ${channel}`);
    }
    this.nextResetChannel = channel;
  }

  override destroy() {
    this.destroyPromise ??= super.destroy();
    return this.destroyPromise;
  }

  suppressFinalBackup() {
    this.skipFinalBackup = true;
  }

  private createAdapter(network: StoredNetwork) {
    return this.adapterFactory({
      networkOptions: {
        panID: network.panId,
        extendedPanID: extendedPanIdToBytes(network.extendedPanId),
        channelList: [network.channel],
        networkKey: networkKeyToBytes(network.networkKey),
        networkKeyDistribute: false,
      },
      serialPortOptions: {
        adapter: 'ember',
        path: this.options.device,
        baudRate: this.options.baudRate,
        rtscts: this.options.rtscts,
      },
      backupPath: this.store.backupPath,
      adapterOptions: { disableLED: false },
    });
  }

  private async startAdapter(network: StoredNetwork) {
    const adapter = this.createAdapter(network);
    this.adapter = adapter;
    this.attachAdapterEvents(adapter);
    try {
      await adapter.start();
      if (this.destroyed || this.adapter !== adapter) {
        throw new Error('Ember adapter was stopped while starting');
      }
      await this.publishState();
    } catch (error) {
      if (this.adapter === adapter) this.adapter = undefined;
      adapter.removeAllListeners();
      await withTimeout(adapter.stop(), RADIO_SHUTDOWN_TIMEOUT_MS, 'Ember adapter stop').catch(
        () => undefined,
      );
      throw error;
    }
  }

  private attachAdapterEvents(adapter: HomeyEmberAdapterLike) {
    adapter.on('zclPayload', (payload: any) => {
      this.onZclPayload(payload).catch(() => undefined);
    });
    adapter.on('deviceJoined', (payload: any) => {
      try {
        this.onDeviceJoined(payload);
      } catch {
        // Ignore malformed adapter events rather than crashing Homey's EventEmitter call stack.
      }
    });
    adapter.on('deviceLeave', (payload: any) => {
      this.onDeviceLeave(payload).catch(() => undefined);
    });
    adapter.on('homeyZdoFrame', (frame: RawZdoFrame) => {
      this.onZdoFrame(frame).catch(() => undefined);
    });
    adapter.on('homeyRadioStatus', (details: unknown) => this.emit('radioStatus', details));
    adapter.on('homeyDisconnected', (details: { status?: number; statusName?: string }) => {
      this.emit('disconnected', details);
    });
  }

  private async onZclPayload(payload: {
    address: number | string;
    endpoint: number;
    clusterID: number;
    data: Buffer;
    groupID?: number;
    destinationEndpoint?: number;
  }) {
    const ieeeAddress =
      typeof payload.address === 'string'
        ? eui64ToHomeyIeee(payload.address)
        : await this.findIeeeAddress(payload.address);
    if (!ieeeAddress) return;

    this.handleZclFrame({
      ieeeAddr: ieeeAddress,
      endpointId: payload.endpoint,
      clusterId: payload.clusterID,
      // An Array is intentional: Homey's parser ignores Buffer subclasses here.
      zclFrame: Array.from(payload.data),
      meta: {
        ...(payload.groupID ? { groupId: payload.groupID } : {}),
        dstEndpoint: payload.destinationEndpoint ?? COORDINATOR_ENDPOINT,
      },
    });
  }

  private onDeviceJoined(payload: { networkAddress: number; ieeeAddr: string }) {
    const ieeeAddress = eui64ToHomeyIeee(payload.ieeeAddr);
    this.updateNodeAddress(ieeeAddress, payload.networkAddress);
    this.emit('nodeJoined', { ieeeAddress, networkAddress: payload.networkAddress });
    this.scheduleBackup();
  }

  private async onDeviceLeave(payload: { networkAddress?: number; ieeeAddr?: string }) {
    const ieeeAddress = payload.ieeeAddr
      ? eui64ToHomeyIeee(payload.ieeeAddr)
      : payload.networkAddress === undefined
        ? undefined
        : await this.findIeeeAddress(payload.networkAddress);
    if (!ieeeAddress) return;
    this.emit('nodeLeft', { ieeeAddress });
    this.scheduleBackup();
  }

  private async onZdoFrame(frame: RawZdoFrame) {
    const [, parsed] = frame.response ?? [];
    const parsedIeee = parsed?.eui64 ? eui64ToHomeyIeee(parsed.eui64) : undefined;
    const ieeeAddress = parsedIeee ?? (await this.findIeeeAddress(frame.sender));

    if (ieeeAddress) {
      this.emit('zdoFrameReceived', {
        ieeeAddress,
        networkAddress: frame.sender,
        clusterId: frame.clusterId,
        endpointId: frame.endpoint,
        zdoFrame: Array.from(frame.payload),
      });
    }

    if (!frame.response || frame.response[0] !== Zdo.Status.SUCCESS || !parsed) return;
    switch (frame.clusterId) {
      case Zdo.ClusterId.END_DEVICE_ANNOUNCE: {
        const announcedIeee = eui64ToHomeyIeee(parsed.eui64);
        this.updateNodeAddress(announcedIeee, parsed.nwkAddress);
        this.emit('zdoEndDeviceAnnounceIndication', {
          ieeeAddress: announcedIeee,
          networkAddress: parsed.nwkAddress,
          capabilities: capabilities(parsed.capabilities),
        });
        break;
      }
      case Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE:
        this.emit('zdoNetworkAddressResponse', {
          status: frame.response[0],
          ieeeAddress: eui64ToHomeyIeee(parsed.eui64),
          networkAddress: parsed.nwkAddress,
        });
        break;
      case Zdo.ClusterId.IEEE_ADDRESS_RESPONSE:
        this.emit('zdoIEEEAddressResponse', {
          status: frame.response[0],
          ieeeAddress: eui64ToHomeyIeee(parsed.eui64),
          networkAddress: parsed.nwkAddress,
        });
        break;
    }
  }

  private scheduleBackup() {
    if (this.backupTimeout) clearTimeout(this.backupTimeout);
    this.backupTimeout = setTimeout(() => {
      this.backupTimeout = undefined;
      this.writeBackup().catch(() => undefined);
    }, BACKUP_AFTER_TOPOLOGY_CHANGE_MS);
    this.backupTimeout.unref?.();
  }

  async writeBackup() {
    if (!this.adapter || !this.storedNetwork) return;
    if (this.backupInFlight) return this.backupInFlight;
    this.backupInFlight = (async () => {
      const ieeeAddresses = [...this.getNodes().keys()].map(homeyIeeeToEui64);
      const backup: any = await this.adapter!.backup(ieeeAddresses);
      const unified: any = BackupUtils.toUnifiedBackup(backup);
      await this.store.writeBackup(unified);
      this.networkSettings = {
        ...this.networkSettings,
        networkKeySequenceNumber: unified.network_key?.sequence_number ?? 0,
        networkKeyFrameCounter: unified.network_key?.frame_counter ?? 0,
      };
      this.emit('state', this.networkSettings);
    })().finally(() => {
      this.backupInFlight = undefined;
    });
    return this.backupInFlight;
  }

  private async publishState() {
    if (!this.adapter || !this.storedNetwork) return;
    const [network, ieee, version] = await Promise.all([
      this.adapter.getNetworkParameters(),
      this.adapter.getCoordinatorIEEE(),
      this.adapter.getCoordinatorVersion(),
    ]);
    this.networkSettings = {
      IEEEAddress: eui64ToHomeyIeee(ieee),
      panId: network.panID,
      extendedPanId: eui64ToHomeyIeee(network.extendedPanID),
      networkKey: this.storedNetwork.networkKey,
      channel: network.channel,
      networkKeySequenceNumber: this.networkSettings?.networkKeySequenceNumber ?? 0,
      networkKeyFrameCounter: this.networkSettings?.networkKeyFrameCounter ?? 0,
      softwareVersion: `${version.type} ${Object.values(version.meta).join('.')}`,
    } satisfies NetworkConfiguration;
    this.emit('state', this.networkSettings);
  }

  private requireAdapter() {
    if (!this.adapter) throw new Error('Ember adapter is not ready');
    return this.adapter;
  }

  private async findIeeeAddress(networkAddress: number) {
    try {
      return await this.getIEEEAddress(networkAddress, { allowRequest: false });
    } catch {
      return undefined;
    }
  }

  private async sendZdo(
    ieeeAddress: IEEEAddress,
    clusterId: number,
    args: unknown[],
    options: RequestOptsInternal,
    networkAddress = this.getNetworkAddress(ieeeAddress),
  ) {
    const payload = Zdo.Buffalo.buildRequest(true, clusterId, ...args);
    let response: [number, any] | undefined;
    try {
      if (options.signal?.aborted) throw abortError(options.signal);
      response = await withAbort(
        this.requireAdapter().sendHomeyZdo({
          ieeeAddress: homeyIeeeToEui64(ieeeAddress),
          networkAddress,
          clusterId,
          payload,
          timeout: options.timeout ?? DEFAULT_ZDO_TIMEOUT_MS,
          signal: options.signal,
        }),
        options.signal,
      );
    } catch (error) {
      throw this.translateSendError(error, options.timeout ?? DEFAULT_ZDO_TIMEOUT_MS);
    }
    if (!response) throw new TimeoutError(options.timeout ?? DEFAULT_ZDO_TIMEOUT_MS);
    return response;
  }

  private assertZdoSuccess(response: [number, any], options: RequestOptsInternal) {
    const [status, data] = response;
    if (status === Zdo.Status.SUCCESS) return data;
    if (status === Zdo.Status.TABLE_FULL || status === Zdo.Status.DEVICE_BINDING_TABLE_FULL) {
      throw new ZigbeeBindingTableFullError(statusLabel(status));
    }
    if (status === Zdo.Status.TIMEOUT) {
      throw new TimeoutError(options.timeout ?? DEFAULT_ZDO_TIMEOUT_MS);
    }
    throw new Error(`ZDO request failed with status=${statusLabel(status)}`);
  }

  private translateSendError(error: unknown, timeout: number) {
    if (error instanceof HomeyEmberStatusError) {
      const name = String((error as any).statusName);
      const layer = String((error as any).layer ?? 'sl');
      if (
        layer === 'ezsp' &&
        (/TIMEOUT|NO_RESPONSE/.test(name) || name === 'ERROR_QUEUE_FULL')
      ) {
        return new TimeoutError(timeout, error.message);
      }
      if (
        layer === 'ezsp' &&
        /NOT_CONNECTED|HOST_FATAL|NCP_FATAL|ASH_|SERIAL/.test(name)
      ) {
        return new ZigbeeNodeUnreachableError(error.message, { cause: error });
      }
      if (UNREACHABLE_STATUSES.has(name)) {
        return new ZigbeeNodeUnreachableError(error.message, { cause: error });
      }
      if (/TIMEOUT/.test(name)) return new TimeoutError(timeout, error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    if (UNREACHABLE_STATUSES.has(message.match(/status=([A-Z0-9_]+)/)?.[1] ?? '')) {
      return new ZigbeeNodeUnreachableError(message, { cause: error });
    }
    if (/delivery failed/i.test(message)) {
      return new ZigbeeNodeUnreachableError(message, { cause: error });
    }
    if (/timeout|timed out|no response/i.test(message)) {
      return new TimeoutError(timeout, message);
    }
    return error;
  }

  protected override async _reset() {
    const channel = this.nextResetChannel ?? this.networkSettings?.channel ?? this.options.initialChannel;
    this.nextResetChannel = undefined;
    const oldAdapter = this.adapter;
    this.adapter = undefined;
    if (oldAdapter) {
      try {
        await withTimeout(
          oldAdapter.stop(),
          RADIO_SHUTDOWN_TIMEOUT_MS,
          'Ember adapter stop',
        );
      } finally {
        oldAdapter.removeAllListeners();
      }
    }
    this.storedNetwork = await this.store.resetNetwork(channel);
    await this.startAdapter(this.storedNetwork);
    await this.writeBackup();
  }

  protected override async _permitJoin({ duration, opts }: { duration: number; opts: JoinOpts }) {
    const adapter = this.requireAdapter();
    if (opts.installCode) {
      if (!/^[0-9a-f]{36}$/i.test(opts.installCode.code)) {
        throw new TypeError('Install code must be exactly 36 hexadecimal characters');
      }
      const code = Buffer.from(opts.installCode.code, 'hex');
      await adapter.addInstallCode(homeyIeeeToEui64(opts.installCode.ieeeAddress), code, false);
    }
    await adapter.permitJoin(duration);
  }

  protected override async _requestLeave({ ieeeAddress, options }: any) {
    const response = await this.sendZdo(
      ieeeAddress,
      Zdo.ClusterId.LEAVE_REQUEST,
      [SELF_LEAVE_EUI64, Zdo.LeaveRequestFlags.WITHOUT_REJOIN],
      options,
    );
    this.assertZdoSuccess(response, options);
    return true;
  }

  protected override async _bind({
    ieeeAddress,
    endpointId,
    clusterId,
    targetIeee,
    targetEndpoint,
    options,
  }: any): Promise<ZdoBindResponse> {
    const response = await this.sendZdo(
      ieeeAddress,
      Zdo.ClusterId.BIND_REQUEST,
      [
        homeyIeeeToEui64(ieeeAddress),
        endpointId,
        clusterId,
        3,
        homeyIeeeToEui64(targetIeee),
        0,
        targetEndpoint,
      ],
      options,
    );
    this.assertZdoSuccess(response, options);
    return { status: statusLabel(response[0]) };
  }

  protected override async _unbind({
    ieeeAddress,
    endpointId,
    clusterId,
    targetIeee,
    targetEndpoint,
    options,
  }: any): Promise<ZdoUnbindResponse> {
    const response = await this.sendZdo(
      ieeeAddress,
      Zdo.ClusterId.UNBIND_REQUEST,
      [
        homeyIeeeToEui64(ieeeAddress),
        endpointId,
        clusterId,
        3,
        homeyIeeeToEui64(targetIeee),
        0,
        targetEndpoint,
      ],
      options,
    );
    this.assertZdoSuccess(response, options);
    return { status: statusLabel(response[0]) };
  }

  protected override async _getBindingTable({
    ieeeAddress,
    startIndex,
    options,
  }: any): Promise<ZdoBindingTableResponse> {
    const response = await this.sendZdo(
      ieeeAddress,
      Zdo.ClusterId.BINDING_TABLE_REQUEST,
      [startIndex],
      options,
    );
    const data = this.assertZdoSuccess(response, options);
    const bindingTableList = data.entryList.map((entry: any) => ({
      srcAddress: eui64ToHomeyIeee(entry.sourceEui64),
      srcEndpoint: entry.sourceEndpoint,
      clusterId: entry.clusterId,
      dstAddrMode: entry.destAddrMode,
      ...(entry.destAddrMode === 1
        ? { dstGroupId: entry.dest }
        : {
            dstAddress: eui64ToHomeyIeee(entry.dest),
            dstEndpoint: entry.destEndpoint,
          }),
    }));
    return {
      status: statusLabel(response[0]),
      bindingTableEntries: data.bindingTableEntries,
      startIndex: data.startIndex,
      bindingTableListCount: bindingTableList.length,
      bindingTableList,
    };
  }

  protected override async _getActiveEndpoints({ ieeeAddress, options }: any) {
    const response = await this.sendZdo(
      ieeeAddress,
      Zdo.ClusterId.ACTIVE_ENDPOINTS_REQUEST,
      [this.getNetworkAddress(ieeeAddress)],
      options,
    );
    return this.assertZdoSuccess(response, options).endpointList;
  }

  protected override async _getSimpleDescriptor({ ieeeAddress, endpointId, options }: any) {
    const response = await this.sendZdo(
      ieeeAddress,
      Zdo.ClusterId.SIMPLE_DESCRIPTOR_REQUEST,
      [this.getNetworkAddress(ieeeAddress), endpointId],
      options,
    );
    const data = this.assertZdoSuccess(response, options);
    return {
      status: statusLabel(response[0]),
      nwkAddrOfInterest: data.nwkAddress,
      _reserved: data.length,
      endpointId: data.endpoint,
      applicationProfileId: data.profileId,
      applicationDeviceId: data.deviceId,
      applicationDeviceVersion: data.deviceVersion & 0x0f,
      _reserved1: data.deviceVersion >> 4,
      inputClusters: data.inClusterList,
      outputClusters: data.outClusterList,
    } satisfies ZdoSimpleDescriptorResponse;
  }

  protected override async _getMatchDescriptor({
    ieeeAddress,
    profileId,
    inputClusters,
    outputClusters,
    options,
  }: any) {
    const response = await this.sendZdo(
      ieeeAddress,
      Zdo.ClusterId.MATCH_DESCRIPTORS_REQUEST,
      [this.getNetworkAddress(ieeeAddress), profileId, inputClusters, outputClusters],
      options,
    );
    const data = this.assertZdoSuccess(response, options);
    return {
      status: statusLabel(response[0]),
      nwkAddrOfInterest: data.nwkAddress,
      matchList: data.endpointList,
    } satisfies ZdoMatchDescriptorResponse;
  }

  protected override async _getNodeCapabilities({ ieeeAddress, options }: any) {
    const response = await this.sendZdo(
      ieeeAddress,
      Zdo.ClusterId.NODE_DESCRIPTOR_REQUEST,
      [this.getNetworkAddress(ieeeAddress)],
      options,
    );
    return { capabilities: capabilities(this.assertZdoSuccess(response, options).capabilities) };
  }

  protected override async _sendZCLFrame({
    ieeeAddress,
    endpointId,
    clusterId,
    zclFrame,
    enableRouteDiscovery,
    options,
  }: any) {
    const networkAddress = this.getNetworkAddress(ieeeAddress);
    const timeout = options.timeout ?? 4_500;
    try {
      await this.requireAdapter().sendRawZclFrame({
        ieeeAddress: homeyIeeeToEui64(ieeeAddress),
        networkAddress,
        endpoint: endpointId,
        clusterId,
        data: Buffer.from(zclFrame),
        forceRouteDiscovery: enableRouteDiscovery,
        timeout,
        signal: options.signal,
      });
    } catch (error) {
      throw this.translateSendError(error, timeout);
    }
  }

  protected override async _bindGroup({ groupId, options }: any) {
    const timeout = options.timeout ?? DEFAULT_ZDO_TIMEOUT_MS;
    await withTimeout(
      withAbort(this.requireAdapter().addMulticastGroup(groupId, options.signal), options.signal),
      timeout,
      'Add Zigbee multicast group',
    );
  }

  protected override async _unbindGroup({ groupId, options }: any) {
    const timeout = options.timeout ?? DEFAULT_ZDO_TIMEOUT_MS;
    await withTimeout(
      withAbort(this.requireAdapter().removeMulticastGroup(groupId, options.signal), options.signal),
      timeout,
      'Remove Zigbee multicast group',
    );
  }

  protected override async _requestNetworkAddress({ ieeeAddress, options }: any) {
    const response = await this.sendZdo(
      ieeeAddress,
      Zdo.ClusterId.NETWORK_ADDRESS_REQUEST,
      [homeyIeeeToEui64(ieeeAddress), false, 0],
      options,
      ZSpec.BroadcastAddress.RX_ON_WHEN_IDLE,
    );
    const data = this.assertZdoSuccess(response, options);
    this.updateNodeAddress(ieeeAddress, data.nwkAddress);
    return data.nwkAddress;
  }

  protected override async _requestIEEEAddress({ networkAddress, options }: any) {
    const response = await this.sendZdo(
      ZSpec.BLANK_EUI64,
      Zdo.ClusterId.IEEE_ADDRESS_REQUEST,
      [networkAddress, false, 0],
      options,
      networkAddress,
    );
    const data = this.assertZdoSuccess(response, options);
    const ieeeAddress = eui64ToHomeyIeee(data.eui64);
    this.updateNodeAddress(ieeeAddress, data.nwkAddress);
    return ieeeAddress;
  }

  protected override async _destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.backupTimeout) clearTimeout(this.backupTimeout);
    if (this.backupInterval) clearInterval(this.backupInterval);
    this.backupTimeout = undefined;
    this.backupInterval = undefined;
    if (!this.skipFinalBackup) {
      await withTimeout(
        this.writeBackup(),
        RADIO_SHUTDOWN_TIMEOUT_MS,
        'Zigbee coordinator backup',
      ).catch(() => undefined);
    }
    const adapter = this.adapter;
    this.adapter = undefined;
    if (adapter) {
      await withTimeout(adapter.stop(), RADIO_SHUTDOWN_TIMEOUT_MS, 'Ember adapter stop').catch(
        () => undefined,
      );
      adapter.removeAllListeners();
    }
    this.started = false;
  }
}
