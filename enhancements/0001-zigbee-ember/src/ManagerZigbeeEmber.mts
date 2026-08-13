import {
  AVAILABILITY,
  DEVICE_FLAGS,
  ManagerZigbee as ManagerZigbeeCore,
  type TDevice,
} from '@athombv/homey-core';
import { ZigbeeLocal } from '@athombv/homey-local';
import type { EndpointDescriptors, NetworkConfiguration, Node } from '@athombv/zigbee';

import { config } from '/app/apps/homey-shs/config.mts';
import type { HomeySHS } from '/app/apps/homey-shs/lib/HomeySHS.mts';

import { HomeyEmberController } from './HomeyEmberController.mts';
import { jitterBackoffMs, nextBackoffMs, RETRY_INITIAL_MS, waitForDelay } from './backoff.mts';
import { describeAdapterError } from './device-errors.mts';

const EXTRA_REMOTE_CLUSTERS = [0x0006, 0x0008] as const;
const LIFECYCLE_SETTLE_TIMEOUT_MS = 5_000;

async function settleWithin(promise: Promise<unknown> | undefined, timeoutMs: number) {
  if (!promise) return;
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, timeoutMs);
    timeout.unref?.();
  });
  try {
    await Promise.race([promise.catch(() => undefined), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** Homey SHS Zigbee manager for a directly attached Ember/EZSP coordinator. */
export class ManagerZigbeeEmber extends ManagerZigbeeCore<
  HomeyEmberController,
  Partial<NetworkConfiguration>,
  HomeySHS
> {
  private readonly zigbeeLocal = new ZigbeeLocal<
    HomeySHS,
    HomeyEmberController,
    Partial<NetworkConfiguration>
  >(this);

  private lifecycleAbort?: AbortController;
  private startLoop?: Promise<void>;
  private recovering = false;
  private resetting = false;
  private stopping = false;

  override async onInit() {
    await super.onInit();
    await this.demoteLegacyBridgeControllerFlags();
    this.lifecycleAbort = new AbortController();
    const deferred = this.prepareControllerStartPromise();
    await this.setCurrentCommand(ManagerZigbeeCore.COMMANDS.STARTING);

    // The Homey service must remain available while the coordinator is absent or busy. The loop
    // owns retries and resolves getZigbeeReady() once a coordinator eventually starts.
    this.startLoop = this.runStartLoop(this.lifecycleAbort.signal, deferred);
    this.startLoop.catch((error) => this.error('Zigbee start loop stopped unexpectedly', error));
  }

  private prepareControllerStartPromise() {
    const deferred = Promise.withResolvers<HomeyEmberController>();
    deferred.promise.catch(() => undefined);
    this.controllerStartPromise = deferred;
    return deferred;
  }

  private createController() {
    return new HomeyEmberController({
      device: config.HOMEY_ZIGBEE_DEVICE,
      baudRate: config.HOMEY_ZIGBEE_BAUDRATE,
      rtscts: config.HOMEY_ZIGBEE_RTSCTS,
      initialChannel: config.HOMEY_ZIGBEE_CHANNEL,
    });
  }

  private async runStartLoop(
    signal: AbortSignal,
    deferred: PromiseWithResolvers<HomeyEmberController>,
  ) {
    let retryMs = RETRY_INITIAL_MS;
    while (!signal.aborted && !this.stopping) {
      const controller = this.createController();
      this.controller = controller;
      controller.on('state', (state) => {
        this.onControllerStateEvent(state).catch((error) =>
          this.error('Failed to persist Ember controller state', error),
        );
      });
      controller.on('disconnected', (details) => {
        // Startup failures belong to this loop's normal retry path. Recovering them here as well
        // would create a second concurrent supervisor before controller.start() rejects.
        if (
          this.stopping ||
          this.resetting ||
          !this.zigbee_ready ||
          this.controller !== controller
        ) {
          return;
        }
        this.recoverFromDisconnect(details).catch((error) =>
          this.error('Failed to recover the Ember coordinator', error),
        );
      });

      try {
        await this.setControllerNodes(controller);
        await controller.start();
        if (signal.aborted || this.stopping) {
          controller.suppressFinalBackup();
          await controller.destroy();
          return;
        }

        this.zigbee_error = null;
        this.controllerState = this.parseControllerState(controller.networkSettings ?? {}) ?? null;
        await this.onZigbeeReady();
        if (signal.aborted || this.stopping || this.controller !== controller) return;
        deferred.resolve(controller);
        return;
      } catch (error) {
        controller.suppressFinalBackup();
        await controller.destroy().catch(() => undefined);
        if (this.controller === controller) this.controller = null;
        if (signal.aborted || this.stopping) return;

        this.zigbee_ready = false;
        this.zigbee_error = describeAdapterError(error, config.HOMEY_ZIGBEE_DEVICE);
        this.log(`${this.zigbee_error} Retrying.`);
        await this.setCurrentCommand(ManagerZigbeeCore.COMMANDS.STARTING).catch((stateError) =>
          this.error('Failed to update Zigbee state', stateError),
        );

        try {
          await waitForDelay(jitterBackoffMs(retryMs), signal);
        } catch {
          return;
        }
        retryMs = nextBackoffMs(retryMs);
      }
    }
  }

  private async recoverFromDisconnect(details: {
    status?: number;
    statusName?: string;
    error?: unknown;
  }) {
    if (this.recovering || this.stopping || this.resetting) return;
    this.recovering = true;
    try {
      const detail = details.statusName ?? details.status ?? details.error ?? 'unknown status';
      const disconnectError = `The Ember coordinator disconnected (${String(detail)}). Retrying.`;
      // Close the public readiness window synchronously so callers cannot receive the controller
      // that just disconnected while asynchronous cleanup is beginning.
      this.zigbee_ready = false;
      this.zigbee_error = disconnectError;
      this.controllerStartPromise = null;
      const oldLoop = this.startLoop;
      this.lifecycleAbort?.abort(new Error('Ember coordinator disconnected'));
      await this.teardownZigbee({ backup: false });
      await settleWithin(oldLoop, LIFECYCLE_SETTLE_TIMEOUT_MS);
      if (this.stopping) return;

      this.zigbee_error = disconnectError;
      this.lifecycleAbort = new AbortController();
      const deferred = this.prepareControllerStartPromise();
      await this.setCurrentCommand(ManagerZigbeeCore.COMMANDS.STARTING);
      this.startLoop = this.runStartLoop(this.lifecycleAbort.signal, deferred);
      this.startLoop.catch((error) => this.error('Zigbee recovery loop stopped unexpectedly', error));
    } finally {
      this.recovering = false;
    }
  }

  private async demoteLegacyBridgeControllerFlags() {
    const managerDevices = await this.homey.getManager('devices');
    const bridges: Record<string, TDevice> = await managerDevices.getBridges();
    for (const bridge of Object.values(bridges)) {
      const flagIndex = bridge.flags.indexOf(DEVICE_FLAGS.ZIGBEE_MAIN_CONTROLLER);
      if (flagIndex === -1) continue;
      // This is intentionally process-local. Ember needs the Bridge to behave as a satellite, but
      // persisting the demotion would break a later explicit restart in Bridge mode.
      bridge.flags.splice(flagIndex, 1);
      this.log(`Using Homey Bridge ${bridge.name} as a Zigbee satellite in Ember mode`);
    }
  }

  override async onZigbeeReady() {
    await super.onZigbeeReady();
    await this.zigbeeLocal.onZigbeeReady();
  }

  override async onZigbeeDestroy() {
    return this.teardownZigbee({ backup: true });
  }

  private async teardownZigbee({ backup }: { backup: boolean }) {
    await this.zigbeeLocal.onZigbeeDestroy();
    if (!backup) this.controller?.suppressFinalBackup();
    await this.controller?.destroy().catch((error) =>
      this.error('Failed to stop Ember coordinator', error),
    );
    return super.onZigbeeDestroy();
  }

  override async onUninit() {
    const backup = this.zigbee_ready;
    this.stopping = true;
    this.lifecycleAbort?.abort(new Error('Homey is shutting down'));
    const oldLoop = this.startLoop;
    await this.teardownZigbee({ backup });
    await settleWithin(oldLoop, LIFECYCLE_SETTLE_TIMEOUT_MS);
    await super.onUninit();
  }

  protected override parseControllerState(state: Partial<NetworkConfiguration>) {
    try {
      this.assertNetworkConfiguration(state);
      if (typeof state.IEEEAddress !== 'string' || typeof state.softwareVersion !== 'string') {
        return undefined;
      }
      return {
        IEEEAddress: state.IEEEAddress,
        panId: state.panId,
        extendedPanId: state.extendedPanId,
        networkKey: state.networkKey,
        channel: state.channel,
        networkKeySequenceNumber: state.networkKeySequenceNumber,
        networkKeyFrameCounter: state.networkKeyFrameCounter,
        softwareVersion: state.softwareVersion,
      };
    } catch (error) {
      this.error('Ignored invalid Ember controller state', error);
      return undefined;
    }
  }

  override async getState() {
    const state = await super.getState();
    state.availability.zigbee = this.zigbee_ready
      ? AVAILABILITY.AVAILABLE
      : AVAILABILITY.UNAVAILABLE;
    return state;
  }

  override async getStateNodes() {
    const stateNodes = await super.getStateNodes();
    const controllerState = this.getControllerState();
    if (controllerState?.IEEEAddress) {
      stateNodes[controllerState.IEEEAddress] = {
        receiveWhenIdle: true,
        ieeeAddr: controllerState.IEEEAddress,
        nwkAddr: 0,
        modelId: 'ZBT-2 (Ember)',
        manufacturerName: 'Silicon Labs',
        type: 'coordinator',
        name: 'Homey SHS Zigbee Coordinator',
      };
    }
    await this.addStateNodesBridgeSatellites(stateNodes);
    return stateNodes;
  }

  override async resetNetwork(params?: { channel?: number }) {
    const controller = this.getZigbeeDirectly();
    controller.setNextResetChannel(params?.channel);
    this.resetting = true;
    try {
      await super.resetNetwork(params);
      const state = this.parseControllerState(controller.networkSettings ?? {});
      if (state) await this.onControllerStateEvent(state);
      await this.zigbeeLocal.forceHomeyBridgeSatellitesRejoin().catch((error) =>
        this.error('Failed to rejoin Homey Bridge satellites after network reset', error),
      );
    } catch (error) {
      this.resetting = false;
      this.recoverFromDisconnect({ error }).catch((recoveryError) =>
        this.error('Failed to recover after Zigbee network reset', recoveryError),
      );
      throw error;
    } finally {
      this.resetting = false;
    }
  }

  /** Preserve the direct-controller binding compatibility used by Homey remote controls. */
  override async createBindings({
    ieeeAddress,
    endpointDescriptors,
    ownerUri,
    driver,
  }: {
    ieeeAddress: string;
    endpointDescriptors: EndpointDescriptors;
    ownerUri: string;
    driver?: unknown;
  }) {
    await super.createBindings({ ieeeAddress, endpointDescriptors, ownerUri, driver: driver as any });

    const driverDescription = JSON.stringify(driver ?? {});
    if (
      driverDescription.includes('Trust International B.V.') &&
      driverDescription.includes('ZLL-NonColorController')
    ) {
      return;
    }

    const controller = this.getZigbeeDirectly();
    const node = controller.getNode(ieeeAddress);
    for (const endpoint of node?.endpointDescriptors ?? []) {
      for (const clusterId of EXTRA_REMOTE_CLUSTERS) {
        if (!endpoint.outputClusters.includes(clusterId)) continue;
        await controller
          .bind({ ieeeAddress, endpointId: endpoint.endpointId, clusterId })
          .catch((error) =>
            this.error(
              `Failed optional remote binding ${ieeeAddress}/${endpoint.endpointId}/${clusterId}`,
              error,
            ),
          );
      }
    }
  }

  /** Re-schedule all pings after a device repair. */
  protected override async handleNodeRepair() {
    this.zigbeeLocal.schedulePingEvents().catch((error) =>
      this.error('Failed to schedule Zigbee ping events after repair', error),
    );
  }

  override async onControllerNodeUpdate({
    node,
    updateType,
  }: {
    node: Node;
    updateType: 'lastSeen' | 'update';
  }) {
    if (await this.zigbeeLocal.onControllerNodeUpdate({ node, updateType })) return;
    return super.onControllerNodeUpdate({ node, updateType });
  }

  override async setDebug({ enabled }: { enabled: boolean }) {
    return this.zigbeeLocal.setDebug({ enabled });
  }

  // A Bridge can race with migration of its persisted main-controller flag during startup. These
  // no-ops keep that stale virtual-device call safe; Bridges are satellites in Ember mode.
  async setCoprocessor() {
    this.log('Ignored stale Homey Bridge coprocessor registration in Ember mode');
  }

  async unsetCoprocessor() {
    this.log('Ignored stale Homey Bridge coprocessor removal in Ember mode');
  }
}
