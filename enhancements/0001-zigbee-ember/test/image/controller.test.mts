import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import {
  TimeoutError,
  MissingNetworkAddressError,
  ZigbeeBindingTableFullError,
  ZigbeeNodeUnreachableError,
} from '@athombv/zigbee';

import { HomeyEmberController } from '../../src/HomeyEmberController.mts';
import { RadioStore } from '../../src/RadioStore.mts';

const require = createRequire(import.meta.url);
const { HomeyEmberStatusError, SLStatus } = require('../../src/homey-ember.cjs');

const IEEE = '00:12:4b:00:01:ab:cd:ef';
const EUI64 = '0x00124b0001abcdef';

class FakeAdapter extends EventEmitter {
  readonly options: any;
  stopped = false;
  multicastGroups: number[] = [];
  rawSends: any[] = [];
  zdoCalls: any[] = [];
  zdoResponses = new Map<number, [number, any]>();
  installCodes: any[] = [];
  permitJoins: number[] = [];
  backupCalls = 0;
  rawError?: Error;
  zdoError?: Error;
  zdoOperation?: () => Promise<[number, any]>;
  multicastOperation?: () => Promise<void>;

  constructor(options: any) {
    super();
    this.options = options;
  }

  async start() {
    return 'reset' as const;
  }

  async stop() {
    this.stopped = true;
  }

  async getCoordinatorIEEE() {
    return EUI64;
  }

  async getCoordinatorVersion() {
    return { type: 'EmberZNet', meta: { major: 8, minor: 0, patch: 2 } };
  }

  async getNetworkParameters() {
    return {
      panID: this.options.networkOptions.panID,
      extendedPanID: `0x${Buffer.from(this.options.networkOptions.extendedPanID)
        .reverse()
        .toString('hex')}`,
      channel: this.options.networkOptions.channelList[0],
      nwkUpdateID: 0,
    };
  }

  async addInstallCode(...args: any[]) {
    this.installCodes.push(args);
  }

  async permitJoin(duration: number) {
    this.permitJoins.push(duration);
  }

  async sendHomeyZdo({
    ieeeAddress,
    networkAddress,
    clusterId,
    payload,
  }: {
    ieeeAddress: string;
    networkAddress: number;
    clusterId: number;
    payload: Buffer;
  }) {
    this.zdoCalls.push({ ieeeAddress, networkAddress, clusterId, payload: Buffer.from(payload) });
    if (this.zdoError) throw this.zdoError;
    if (this.zdoOperation) return this.zdoOperation();
    return this.zdoResponses.get(clusterId) ?? [0, undefined];
  }

  async sendRawZclFrame(options: any) {
    this.rawSends.push(options);
    if (this.rawError) throw this.rawError;
  }

  async addMulticastGroup(groupId: number) {
    await this.multicastOperation?.();
    this.multicastGroups.push(groupId);
  }

  async removeMulticastGroup(groupId: number) {
    await this.multicastOperation?.();
    this.multicastGroups = this.multicastGroups.filter((id) => id !== groupId);
  }

  async backup() {
    this.backupCalls++;
    return {
      networkOptions: {
        panId: this.options.networkOptions.panID,
        extendedPanId: Buffer.from(this.options.networkOptions.extendedPanID),
        channelList: this.options.networkOptions.channelList,
        networkKey: Buffer.from(this.options.networkOptions.networkKey),
        networkKeyDistribute: false,
      },
      logicalChannel: this.options.networkOptions.channelList[0],
      networkKeyInfo: { sequenceNumber: 2, frameCounter: 42 },
      coordinatorIeeeAddress: Buffer.from('efcdab01004b1200', 'hex'),
      securityLevel: 5,
      networkUpdateId: 0,
      devices: [],
      ezsp: { version: 13, hashed_tclk: Buffer.alloc(16) },
    };
  }
}

async function createController() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'homey-ember-controller-'));
  const adapters: FakeAdapter[] = [];
  const controller = new HomeyEmberController({
    device: '/dev/zigbee-test',
    baudRate: 460800,
    rtscts: true,
    initialChannel: 11,
    store: new RadioStore(directory),
    adapterFactory: (options) => {
      const adapter = new FakeAdapter(options);
      adapters.push(adapter);
      return adapter as any;
    },
  });
  controller.setNodes(new Map([[IEEE, { ieeeAddress: IEEE, networkAddress: 0x1234 }]]));
  return { controller, adapters, directory };
}

test('starts, persists a unified backup, and preserves raw ZCL bytes in both directions', async () => {
  const { controller, adapters, directory } = await createController();
  try {
    await controller.start();
    assert.equal(adapters.length, 1);
    assert.deepEqual(adapters[0].multicastGroups, [0]);
    assert.equal(Object.hasOwn(adapters[0].options.networkOptions, 'extendedPANID'), false);
    assert.equal(adapters[0].options.networkOptions.extendedPanID.length, 8);
    const storedNetwork = JSON.parse(await fs.readFile(path.join(directory, 'network.json'), 'utf8'));
    assert.equal(controller.networkSettings?.extendedPanId, storedNetwork.extendedPanId);
    assert.equal(controller.networkSettings?.channel, 11);
    assert.equal(controller.networkSettings?.networkKeyFrameCounter, 42);

    const backup = JSON.parse(
      await fs.readFile(path.join(directory, 'coordinator-backup.json'), 'utf8'),
    );
    assert.equal(backup.metadata.format, 'zigpy/open-coordinator-backup');
    assert.equal(backup.network_key.frame_counter, 42);

    const incoming = once(controller, 'zclFrame');
    adapters[0].emit('zclPayload', {
      address: 0x1234,
      endpoint: 2,
      clusterID: 6,
      data: Buffer.from([0x1c, 0x34, 0x12, 0x2a, 0x01, 0xaa]),
      groupID: 0,
      destinationEndpoint: 1,
    });
    const [frame] = await incoming;
    assert.deepEqual(frame.zclFrame, [0x1c, 0x34, 0x12, 0x2a, 0x01, 0xaa]);
    assert.equal(Buffer.isBuffer(frame.zclFrame), false);

    await controller.sendZCLFrame({
      ieeeAddress: IEEE,
      endpointId: 2,
      clusterId: 6,
      zclFrame: [0x1c, 0x34, 0x12, 0x2b, 0x00, 0xbb],
    });
    assert.deepEqual(
      [...adapters[0].rawSends[0].data],
      [0x1c, 0x34, 0x12, 0x2b, 0x00, 0xbb],
    );
    assert.equal(adapters[0].rawSends[0].networkAddress, 0x1234);
  } finally {
    await controller.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('refreshes backups after topology changes, periodically, and on shutdown', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { controller, adapters, directory } = await createController();
  try {
    await controller.start();
    const adapter = adapters[0];
    assert.equal(adapter.backupCalls, 1);

    adapter.emit('deviceJoined', { networkAddress: 0x1234, ieeeAddr: EUI64 });
    t.mock.timers.tick(29_999);
    assert.equal(adapter.backupCalls, 1);
    t.mock.timers.tick(1);
    assert.equal(adapter.backupCalls, 2);
    while ((controller as any).backupInFlight) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    t.mock.timers.tick(24 * 60 * 60 * 1_000);
    assert.equal(adapter.backupCalls, 3);
    while ((controller as any).backupInFlight) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    await controller.destroy();
    assert.equal(adapter.backupCalls, 4);
  } finally {
    await controller.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('translates joins, ZDO announcements, descriptors, and reset channel changes', async () => {
  const { controller, adapters, directory } = await createController();
  try {
    await controller.start();

    const joined = once(controller, 'nodeJoined');
    adapters[0].emit('deviceJoined', { ieeeAddr: EUI64, networkAddress: 0x4321 });
    assert.deepEqual((await joined)[0], { ieeeAddress: IEEE, networkAddress: 0x4321 });

    const announced = once(controller, 'zdoEndDeviceAnnounceIndication');
    adapters[0].emit('homeyZdoFrame', {
      sender: 0x4321,
      endpoint: 0,
      sequence: 9,
      clusterId: 19,
      payload: Buffer.from([0x21, 0x43]),
      response: [
        0,
        {
          eui64: EUI64,
          nwkAddress: 0x4321,
          capabilities: {
            alternatePANCoordinator: 0,
            deviceType: 0,
            powerSource: 1,
            rxOnWhenIdle: 1,
            securityCapability: 1,
            allocateAddress: 0,
          },
        },
      ],
    });
    const [announce] = await announced;
    assert.equal(announce.ieeeAddress, IEEE);
    assert.equal(announce.capabilities.powerSourceMains, true);

    adapters[0].zdoResponses.set(5, [0, { nwkAddress: 0x4321, endpointList: [1, 2] }]);
    assert.deepEqual(await controller.getActiveEndpoints({ ieeeAddress: IEEE }), [1, 2]);

    controller.setNextResetChannel(15);
    await controller.reset();
    assert.equal(adapters.length, 2);
    assert.equal(adapters[0].stopped, true);
    assert.equal(controller.networkSettings?.channel, 15);
    assert.deepEqual(adapters[1].options.networkOptions.channelList, [15]);
  } finally {
    await controller.destroy();
    await controller.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('maps every Homey ZDO primitive and install-code joining', async () => {
  const { controller, adapters, directory } = await createController();
  try {
    await controller.start();
    const adapter = adapters[0];

    await controller.permitJoin({
      duration: 120,
      opts: { installCode: { ieeeAddress: IEEE, code: '00112233445566778899aabbccddeeffaabb' } },
    });
    assert.equal(adapter.installCodes[0][0], EUI64);
    assert.equal(adapter.installCodes[0][1].toString('hex'), '00112233445566778899aabbccddeeffaabb');
    assert.equal(adapter.installCodes[0][2], false);
    assert.deepEqual(adapter.permitJoins, [120]);
    await assert.rejects(
      controller.permitJoin({
        duration: 1,
        opts: { installCode: { ieeeAddress: IEEE, code: 'z'.repeat(36) } },
      }),
      /36 hexadecimal characters/,
    );

    adapter.zdoResponses.set(33, [0, undefined]);
    assert.deepEqual(
      await controller.bind({
        ieeeAddress: IEEE,
        endpointId: 1,
        clusterId: 6,
        targetIeee: IEEE,
        targetEndpoint: 2,
      }),
      { status: 'SUCCESS' },
    );
    assert.equal(
      adapter.zdoCalls.find((call) => call.clusterId === 33).payload.toString('hex'),
      '00efcdab01004b120001060003efcdab01004b120002',
    );
    adapter.zdoResponses.set(34, [0, undefined]);
    assert.deepEqual(
      await controller.unbind({
        ieeeAddress: IEEE,
        endpointId: 1,
        clusterId: 6,
        targetIeee: IEEE,
        targetEndpoint: 2,
      }),
      { status: 'SUCCESS' },
    );

    adapter.zdoResponses.set(51, [
      0,
      {
        bindingTableEntries: 2,
        startIndex: 0,
        entryList: [
          {
            sourceEui64: EUI64,
            sourceEndpoint: 1,
            clusterId: 6,
            destAddrMode: 3,
            dest: EUI64,
            destEndpoint: 2,
          },
          {
            sourceEui64: EUI64,
            sourceEndpoint: 1,
            clusterId: 8,
            destAddrMode: 1,
            dest: 901,
          },
        ],
      },
    ]);
    const bindings = await controller.getBindingTable({ ieeeAddress: IEEE });
    assert.equal(bindings.bindingTableList[0].dstAddress, IEEE);
    assert.equal(bindings.bindingTableList[1].dstGroupId, 901);

    adapter.zdoResponses.set(4, [
      0,
      {
        nwkAddress: 0x1234,
        length: 12,
        endpoint: 2,
        profileId: 0x0104,
        deviceId: 0x0100,
        deviceVersion: 0xa3,
        inClusterList: [0, 6],
        outClusterList: [8],
      },
    ]);
    const descriptor = await controller.getSimpleDescriptor({ ieeeAddress: IEEE, endpointId: 2 });
    assert.equal(descriptor.endpointId, 2);
    assert.equal(descriptor._reserved, 12);
    assert.equal(descriptor.applicationDeviceVersion, 3);
    assert.equal(descriptor._reserved1, 10);
    assert.deepEqual(descriptor.inputClusters, [0, 6]);

    adapter.zdoResponses.set(6, [0, { nwkAddress: 0x1234, endpointList: [2] }]);
    assert.deepEqual(
      await controller.getMatchDescriptor({ ieeeAddress: IEEE, inputClusters: [6] }),
      { status: 'SUCCESS', nwkAddrOfInterest: 0x1234, matchList: [2] },
    );

    adapter.zdoResponses.set(2, [
      0,
      {
        capabilities: {
          alternatePANCoordinator: 0,
          deviceType: 1,
          powerSource: 1,
          rxOnWhenIdle: 1,
          securityCapability: 1,
          allocateAddress: 1,
        },
      },
    ]);
    const nodeCapabilities = await controller.getNodeCapabilities({ ieeeAddress: IEEE });
    assert.equal(nodeCapabilities.capabilities.deviceType, true);
    assert.equal(nodeCapabilities.capabilities.powerSourceMains, true);

    adapter.zdoResponses.set(0, [0, { eui64: EUI64, nwkAddress: 0x2345 }]);
    assert.equal(await controller.requestNetworkAddress({ ieeeAddress: IEEE }), 0x2345);
    assert.equal(adapter.zdoCalls.at(-1).networkAddress, 0xfffd);
    assert.equal(adapter.zdoCalls.at(-1).payload.toString('hex'), '00efcdab01004b12000000');

    const OTHER_IEEE = '00:0d:6f:00:00:11:22:33';
    adapter.zdoResponses.set(1, [
      0,
      { eui64: '0x000d6f0000112233', nwkAddress: 0x3456 },
    ]);
    assert.equal(await controller.requestIEEEAddress({ networkAddress: 0x3456 }), OTHER_IEEE);

    await controller.bindGroup({ groupId: 123 });
    assert.equal(adapter.multicastGroups.includes(123), true);
    await controller.unbindGroup({ groupId: 123 });
    assert.equal(adapter.multicastGroups.includes(123), false);

    // Leave last: Homey's base controller intentionally removes the node after the request.
    adapter.zdoResponses.set(52, [0, undefined]);
    assert.equal(await controller.requestLeave({ ieeeAddress: IEEE }), true);
    assert.equal(adapter.zdoCalls.at(-1).payload.toString('hex'), '00000000000000000000');
    assert.equal(controller.getNode(IEEE), null);
  } finally {
    await controller.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('maps delivery, timeout, and binding-table statuses to Homey errors', async () => {
  const { controller, adapters, directory } = await createController();
  try {
    await controller.start();
    const adapter = adapters[0];
    const send = (controller as any)._sendZCLFrame.bind(controller);

    adapter.rawError = new HomeyEmberStatusError(
      'Raw ZCL delivery',
      SLStatus.ZIGBEE_DELIVERY_FAILED,
    );
    await assert.rejects(
      send({
        ieeeAddress: IEEE,
        endpointId: 1,
        clusterId: 6,
        zclFrame: [0x18, 1, 0],
        enableRouteDiscovery: false,
        options: { timeout: 100, ctx: { reqId: '001', op: 'test' } },
      }),
      ZigbeeNodeUnreachableError,
    );

    adapter.rawError = new HomeyEmberStatusError('Raw ZCL delivery', SLStatus.TIMEOUT);
    await assert.rejects(
      send({
        ieeeAddress: IEEE,
        endpointId: 1,
        clusterId: 6,
        zclFrame: [0x18, 1, 0],
        enableRouteDiscovery: false,
        options: { timeout: 100, ctx: { reqId: '002', op: 'test' } },
      }),
      TimeoutError,
    );

    adapter.zdoResponses.set(33, [140, undefined]);
    await assert.rejects(
      (controller as any)._bind({
        ieeeAddress: IEEE,
        endpointId: 1,
        clusterId: 6,
        targetIeee: IEEE,
        targetEndpoint: 1,
        options: { ctx: { reqId: '003', op: 'test' } },
      }),
      ZigbeeBindingTableFullError,
    );

    adapter.zdoResponses.delete(33);
    adapter.zdoError = new Error('Failed to send request with status=ZIGBEE_NO_APS_ACK');
    await assert.rejects(
      (controller as any)._bind({
        ieeeAddress: IEEE,
        endpointId: 1,
        clusterId: 6,
        targetIeee: IEEE,
        targetEndpoint: 1,
        options: { ctx: { reqId: '004', op: 'test' } },
      }),
      ZigbeeNodeUnreachableError,
    );

    adapter.zdoError = new Error('ZDO request timed out waiting for response');
    await assert.rejects(
      (controller as any)._getActiveEndpoints({
        ieeeAddress: IEEE,
        options: { timeout: 250, ctx: { reqId: '005', op: 'test' } },
      }),
      TimeoutError,
    );

    adapter.zdoError = undefined;
    controller.updateNodeAddress(IEEE, 0xffff);
    await assert.rejects(
      send({
        ieeeAddress: IEEE,
        endpointId: 1,
        clusterId: 6,
        zclFrame: [0x18, 1, 0],
        enableRouteDiscovery: false,
        options: { ctx: { reqId: '006', op: 'test' } },
      }),
      MissingNetworkAddressError,
    );
  } finally {
    await controller.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('group operations honor Homey request timeouts', async () => {
  const { controller, adapters, directory } = await createController();
  try {
    await controller.start();
    adapters[0].multicastOperation = () => new Promise(() => undefined);
    await assert.rejects(
      (controller as any)._bindGroup({ groupId: 123, options: { timeout: 10 } }),
      TimeoutError,
    );
    await assert.rejects(
      (controller as any)._unbindGroup({ groupId: 123, options: { timeout: 10 } }),
      TimeoutError,
    );
  } finally {
    await controller.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('ZDO cancellation is exact before dispatch and best-effort in flight', async () => {
  const { controller, adapters, directory } = await createController();
  try {
    await controller.start();
    const adapter = adapters[0];
    const getEndpoints = (signal: AbortSignal) =>
      (controller as any)._getActiveEndpoints({
        ieeeAddress: IEEE,
        options: { signal, ctx: { reqId: '007', op: 'test' } },
      });

    const before = new AbortController();
    const beforeReason = new Error('cancel ZDO before dispatch');
    before.abort(beforeReason);
    const callsBefore = adapter.zdoCalls.length;
    await assert.rejects(getEndpoints(before.signal), beforeReason);
    assert.equal(adapter.zdoCalls.length, callsBefore);

    let resolveZdo!: (value: [number, any]) => void;
    adapter.zdoOperation = () =>
      new Promise((resolve) => {
        resolveZdo = resolve;
      });
    const during = new AbortController();
    const duringReason = new Error('cancel ZDO in flight');
    const request = getEndpoints(during.signal);
    await Promise.resolve();
    during.abort(duringReason);
    resolveZdo([0, { nwkAddress: 0x1234, endpointList: [1] }]);
    await assert.rejects(request, duringReason);
  } finally {
    await controller.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
