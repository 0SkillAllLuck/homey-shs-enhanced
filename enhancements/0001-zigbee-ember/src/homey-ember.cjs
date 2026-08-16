'use strict';

const { EmberAdapter, DEFAULT_APS_OPTIONS } = require('zigbee-herdsman/dist/adapter/ember/adapter/emberAdapter.js');
const { FIXED_ENDPOINTS } = require('zigbee-herdsman/dist/adapter/ember/adapter/endpoints.js');
const {
  EmberApsOption,
  EmberJoinDecision,
  EmberOutgoingMessageType,
  EzspStatus,
  SLStatus,
} = require('zigbee-herdsman/dist/adapter/ember/enums.js');
const ZSpec = require('zigbee-herdsman/dist/zspec/index.js');
const Zdo = require('zigbee-herdsman/dist/zspec/zdo/index.js');
const { BackupUtils } = require('zigbee-herdsman/dist/utils/index.js');

const DEFAULT_SEND_TIMEOUT = 15_000;
const ZDO_REQUEST_RADIUS = 0xff;
const EMPTY_MULTICAST_ENTRY = Object.freeze({ multicastId: 0xffff, endpoint: 0, networkIndex: 0 });
const PROTECTED_MULTICAST_GROUPS = new Set(
  FIXED_ENDPOINTS.flatMap((endpoint) => endpoint.multicastIds),
);

function statusName(status) {
  return SLStatus[status] ?? String(status);
}

function ezspStatusName(status) {
  return EzspStatus[status] ?? String(status);
}

function createAbortError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error('The Zigbee request was aborted');
  error.name = 'AbortError';
  return error;
}

function normalizeDispatchError(operation, error) {
  return typeof error?.code === 'number'
    ? new HomeyEmberStatusError(operation, error.code, { layer: 'ezsp', cause: error })
    : error;
}

class HomeyEmberStatusError extends Error {
  constructor(operation, status, options = {}) {
    const layer = options.layer ?? 'sl';
    const name = layer === 'ezsp' ? ezspStatusName(status) : statusName(status);
    super(`${operation} failed with status=${name}`, { cause: options.cause });
    this.name = 'HomeyEmberStatusError';
    this.operation = operation;
    this.status = status;
    this.statusName = name;
    this.layer = layer;
  }
}

class HomeyEmberAdapter extends EmberAdapter {
  constructor(networkOptions, serialPortOptions, backupPath, adapterOptions) {
    super(networkOptions, serialPortOptions, backupPath, adapterOptions);
    this.homeyPendingSends = new Map();
    this.homeyMulticastTail = Promise.resolve();
  }

  // Mirrors EmberAdapter.permitJoin, minus the ezspClearTransientLinkKeys() call on close.
  // Homey closes permit-join as soon as it sees the new device, while some Zigbee 3.0
  // devices (e.g. Sonoff) are still finishing trust-center key establishment. Clearing
  // the transient key at that point aborts the exchange; the NCP expires it on its own
  // after TRANSIENT_KEY_TIMEOUT_S anyway.
  async permitJoin(seconds, networkAddress) {
    if (seconds !== 0) return super.permitJoin(seconds, networkAddress);

    await this.queue.execute(async () => {
      this.checkInterpanLock();
      const status = await this.emberSetJoinPolicy(EmberJoinDecision.ALLOW_REJOINS_ONLY);
      if (status !== SLStatus.OK) {
        throw new HomeyEmberStatusError('Close joining policy', status);
      }
    });

    const clusterId = Zdo.ClusterId.PERMIT_JOINING_REQUEST;
    const payload = Zdo.Buffalo.buildRequest(this.hasZdoMessageOverhead, clusterId, 0, 1, []);

    if (networkAddress) {
      const result = await this.sendZdo(ZSpec.BLANK_EUI64, networkAddress, clusterId, payload, false);
      if (!Zdo.Buffalo.checkStatus(result)) {
        throw new Error(`Close permit-join failed with ZDO status=${result[0]}`);
      }
      return;
    }

    const status = await this.ezsp.ezspPermitJoining(0);
    if (status !== SLStatus.OK) {
      throw new HomeyEmberStatusError('Close coordinator permit-join', status);
    }
    // networkAddress 0 means coordinator only; undefined means the whole network.
    if (networkAddress === undefined) {
      await this.sendZdo(ZSpec.BLANK_EUI64, ZSpec.BroadcastAddress.DEFAULT, clusterId, payload, true);
    }
  }

  async withMulticastLock(operation) {
    let release;
    const previous = this.homeyMulticastTail;
    this.homeyMulticastTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  rejectPendingSends(error) {
    for (const [messageTag, pending] of this.homeyPendingSends) {
      this.homeyPendingSends.delete(messageTag);
      pending.cleanup();
      pending.reject(error);
    }
  }

  onZDOResponse(apsFrame, sender, messageContents) {
    const rawPayload = Buffer.from(messageContents);
    let response;
    let parseError;
    try {
      response = Zdo.Buffalo.readResponse(
        this.hasZdoMessageOverhead,
        apsFrame.clusterId,
        rawPayload,
      );
    } catch (error) {
      parseError = error;
    }

    this.emit('homeyZdoFrame', {
      sender,
      endpoint: apsFrame.sourceEndpoint,
      sequence: rawPayload[0],
      clusterId: apsFrame.clusterId,
      payload: rawPayload.subarray(1),
      response,
      parseError,
    });

    // Unknown or future ZDO clusters are intentionally delivered raw instead of crashing the
    // adapter in herdsman's parser.
    if (parseError) return;
    return super.onZDOResponse(apsFrame, sender, messageContents);
  }

  async onMessageSent(status, type, indexOrDestination, apsFrame, messageTag) {
    const pending = this.homeyPendingSends.get(messageTag);
    const matchesPending =
      pending &&
      (!pending.expected ||
        (type === pending.expected.type &&
          indexOrDestination === pending.expected.destination &&
          apsFrame.profileId === pending.expected.profileId &&
          apsFrame.clusterId === pending.expected.clusterId &&
          apsFrame.sourceEndpoint === pending.expected.sourceEndpoint &&
          apsFrame.destinationEndpoint === pending.expected.destinationEndpoint));
    if (matchesPending) {
      this.homeyPendingSends.delete(messageTag);
      pending.cleanup();
      if (status === SLStatus.OK) {
        pending.resolve({ status, apsSequence: apsFrame.sequence });
      } else {
        pending.reject(new HomeyEmberStatusError('Raw ZCL delivery', status));
      }
    }
    this.emit('homeyRadioStatus', {
      kind: 'messageSent',
      status,
      statusName: statusName(status),
      type,
      destination: indexOrDestination,
      messageTag,
    });
    return this.withMulticastLock(() =>
      super.onMessageSent(status, type, indexOrDestination, apsFrame, messageTag),
    );
  }

  async onStackStatus(status) {
    this.emit('homeyRadioStatus', {
      kind: 'stack',
      status,
      statusName: statusName(status),
    });
    return super.onStackStatus(status);
  }

  onNcpNeedsResetAndInit(status) {
    this.rejectPendingSends(
      new HomeyEmberStatusError('Raw ZCL delivery', status, { layer: 'ezsp' }),
    );
    this.emit('homeyDisconnected', {
      status,
      statusName: ezspStatusName(status),
    });
    return super.onNcpNeedsResetAndInit(status);
  }

  async stop() {
    this.rejectPendingSends(
      new HomeyEmberStatusError('Raw ZCL delivery', EzspStatus.NOT_CONNECTED, {
        layer: 'ezsp',
      }),
    );
    return super.stop();
  }

  waitForMessageSent(messageTag, timeout, signal, expected) {
    let timeoutHandle;
    let onAbort;
    const promise = new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeoutHandle);
        if (onAbort) signal?.removeEventListener('abort', onAbort);
      };
      timeoutHandle = setTimeout(() => {
        this.homeyPendingSends.delete(messageTag);
        cleanup();
        reject(new HomeyEmberStatusError('Raw ZCL delivery', SLStatus.TIMEOUT));
      }, timeout);
      onAbort = () => {
        this.homeyPendingSends.delete(messageTag);
        cleanup();
        reject(createAbortError(signal.reason));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.homeyPendingSends.set(messageTag, { resolve, reject, cleanup, expected });
      if (signal?.aborted) onAbort();
    });
    return promise;
  }

  async sendRawZclFrame({
    ieeeAddress,
    networkAddress,
    endpoint,
    clusterId,
    data,
    forceRouteDiscovery = false,
    sourceEndpoint = FIXED_ENDPOINTS[0].endpoint,
    profileId = FIXED_ENDPOINTS[0].profileId,
    timeout = DEFAULT_SEND_TIMEOUT,
    signal,
  }) {
    if (!Buffer.isBuffer(data)) throw new TypeError('Raw ZCL data must be a Buffer');
    if (signal?.aborted) throw createAbortError(signal.reason);

    const apsFrame = {
      profileId,
      clusterId,
      sourceEndpoint,
      destinationEndpoint: endpoint,
      options:
        DEFAULT_APS_OPTIONS |
        (forceRouteDiscovery
          ? EmberApsOption.FORCE_ROUTE_DISCOVERY | EmberApsOption.RETRY
          : 0),
      groupId: 0,
      sequence: 0,
    };

    return this.queue.execute(async () => {
      this.checkInterpanLock();
      if (signal?.aborted) throw createAbortError(signal.reason);

      const messageTag = this.ezsp.nextSendSequence();
      const sent = this.waitForMessageSent(messageTag, timeout, signal, {
        type: EmberOutgoingMessageType.DIRECT,
        destination: networkAddress,
        profileId,
        clusterId,
        sourceEndpoint,
        destinationEndpoint: endpoint,
      });
      // The dispatch call below may still be in flight when abort/timeout rejects this promise.
      // Mark it handled immediately; the original promise is still returned after dispatch.
      sent.catch(() => undefined);
      let status;
      try {
        [status, apsFrame.sequence] = await this.ezsp.ezspSendUnicast(
          EmberOutgoingMessageType.DIRECT,
          networkAddress,
          apsFrame,
          messageTag,
          data,
        );
      } catch (error) {
        const pending = this.homeyPendingSends.get(messageTag);
        this.homeyPendingSends.delete(messageTag);
        const dispatchError = normalizeDispatchError('Raw ZCL dispatch', error);
        pending?.cleanup();
        pending?.reject(dispatchError);
        throw dispatchError;
      }
      if (status !== SLStatus.OK) {
        const pending = this.homeyPendingSends.get(messageTag);
        this.homeyPendingSends.delete(messageTag);
        const dispatchError = new HomeyEmberStatusError('Raw ZCL dispatch', status);
        pending?.cleanup();
        pending?.reject(dispatchError);
        throw dispatchError;
      }
      return sent;
    }, networkAddress);
  }

  async sendHomeyZdo({
    ieeeAddress,
    networkAddress,
    clusterId,
    payload,
    disableResponse = false,
    timeout = DEFAULT_SEND_TIMEOUT,
    signal,
  }) {
    if (!Buffer.isBuffer(payload)) throw new TypeError('ZDO payload must be a Buffer');
    if (signal?.aborted) throw createAbortError(signal.reason);

    return this.queue.execute(async () => {
      this.checkInterpanLock();
      // The queue may have been occupied when the caller cancelled. Rechecking here guarantees a
      // request cancelled before dispatch never reaches EZSP later.
      if (signal?.aborted) throw createAbortError(signal.reason);

      const messageTag = this.nextZDORequestSequence();
      payload[0] = messageTag;
      const apsFrame = {
        profileId: Zdo.ZDO_PROFILE_ID,
        clusterId,
        sourceEndpoint: Zdo.ZDO_ENDPOINT,
        destinationEndpoint: Zdo.ZDO_ENDPOINT,
        options: DEFAULT_APS_OPTIONS,
        groupId: 0,
        sequence: 0,
      };

      let status;
      try {
        if (ZSpec.Utils.isBroadcastAddress(networkAddress)) {
          [status, apsFrame.sequence] = await this.ezsp.ezspSendBroadcast(
            ZSpec.NULL_NODE_ID,
            networkAddress,
            0,
            apsFrame,
            ZDO_REQUEST_RADIUS,
            messageTag,
            payload,
          );
        } else {
          [status, apsFrame.sequence] = await this.ezsp.ezspSendUnicast(
            EmberOutgoingMessageType.DIRECT,
            networkAddress,
            apsFrame,
            messageTag,
            payload,
          );
        }
      } catch (error) {
        throw normalizeDispatchError('ZDO dispatch', error);
      }
      if (status !== SLStatus.OK) {
        throw new HomeyEmberStatusError('ZDO dispatch', status);
      }

      if (disableResponse) return;
      const responseClusterId = Zdo.Utils.getResponseClusterId(clusterId);
      if (!responseClusterId) return;
      return this.oneWaitress.startWaitingFor(
        {
          target:
            responseClusterId === Zdo.ClusterId.NETWORK_ADDRESS_RESPONSE
              ? ieeeAddress
              : networkAddress,
          apsFrame,
          zdoResponseClusterId: responseClusterId,
        },
        timeout,
      );
    }, networkAddress);
  }

  async addMulticastGroup(groupId, signal) {
    if (!Number.isInteger(groupId) || groupId < 0 || groupId >= 0xfff8) {
      throw new RangeError(`Invalid multicast group: ${groupId}`);
    }
    if (signal?.aborted) throw createAbortError(signal.reason);
    if (this.multicastTable.includes(groupId)) return;
    return this.withMulticastLock(() =>
      this.queue.execute(async () => {
        if (signal?.aborted) throw createAbortError(signal.reason);
        if (this.multicastTable.includes(groupId)) return;
        const index = this.multicastTable.length;
        const entry = {
          multicastId: groupId,
          endpoint: FIXED_ENDPOINTS[0].endpoint,
          networkIndex: FIXED_ENDPOINTS[0].networkIndex,
        };
        const status = await this.ezsp.ezspSetMulticastTableEntry(index, entry);
        if (status !== SLStatus.OK) {
          throw new HomeyEmberStatusError('Add multicast group', status);
        }
        this.multicastTable.push(groupId);
      }),
    );
  }

  async removeMulticastGroup(groupId, signal) {
    if (signal?.aborted) throw createAbortError(signal.reason);
    if (PROTECTED_MULTICAST_GROUPS.has(groupId)) return;
    return this.withMulticastLock(() =>
      this.queue.execute(async () => {
        if (signal?.aborted) throw createAbortError(signal.reason);
        const index = this.multicastTable.indexOf(groupId);
        if (index === -1) return;
        const lastIndex = this.multicastTable.length - 1;
        const lastGroup = this.multicastTable[lastIndex];
        if (index !== lastIndex) {
          const moveStatus = await this.ezsp.ezspSetMulticastTableEntry(index, {
            multicastId: lastGroup,
            endpoint: FIXED_ENDPOINTS[0].endpoint,
            networkIndex: FIXED_ENDPOINTS[0].networkIndex,
          });
          if (moveStatus !== SLStatus.OK) {
            throw new HomeyEmberStatusError('Compact multicast table', moveStatus);
          }
        }
        const clearStatus = await this.ezsp.ezspSetMulticastTableEntry(
          lastIndex,
          EMPTY_MULTICAST_ENTRY,
        );
        if (clearStatus !== SLStatus.OK) {
          if (index !== lastIndex) {
            await this.ezsp.ezspSetMulticastTableEntry(index, {
              multicastId: groupId,
              endpoint: FIXED_ENDPOINTS[0].endpoint,
              networkIndex: FIXED_ENDPOINTS[0].networkIndex,
            });
          }
          throw new HomeyEmberStatusError('Remove multicast group', clearStatus);
        }
        if (index !== lastIndex) this.multicastTable[index] = lastGroup;
        this.multicastTable.pop();
      }),
    );
  }
}

module.exports = {
  BackupUtils,
  HomeyEmberAdapter,
  HomeyEmberStatusError,
  SLStatus,
  ZSpec,
  Zdo,
  statusName,
};
