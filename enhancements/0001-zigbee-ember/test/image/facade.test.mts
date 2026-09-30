import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { HomeyEmberAdapter, HomeyEmberStatusError, SLStatus } = require(
  '../../src/homey-ember.cjs',
);
const { EmberApsOption, EmberOutgoingMessageType, EzspStatus } = require(
  'zigbee-herdsman/dist/adapter/ember/enums.js',
);

function createFacadeHarness() {
  const adapter = Object.create(HomeyEmberAdapter.prototype);
  adapter.homeyPendingSends = new Map();
  adapter.homeyMulticastTail = Promise.resolve();
  adapter.multicastTable = [];
  adapter.queue = { execute: async (operation: () => unknown) => operation() };
  adapter.checkInterpanLock = () => undefined;
  return adapter;
}

test('closing permit-join does not clear the in-flight transient key', async () => {
  const adapter = createFacadeHarness();
  const calls: string[] = [];
  adapter.ezsp = {
    ezspPermitJoining: async () => SLStatus.OK,
    ezspClearTransientLinkKeys: async () => {
      calls.push('clear');
    },
  };
  adapter.emberSetJoinPolicy = async () => {
    calls.push('policy');
    return SLStatus.OK;
  };
  adapter.sendZdo = async () => [0];

  await adapter.permitJoin(0);
  assert.deepEqual(calls, ['policy']);
});

test('the facade sends the caller-provided ZCL bytes unchanged', async () => {
  const adapter = createFacadeHarness();
  let captured: Buffer | undefined;
  let capturedOptions = 0;
  adapter.ezsp = {
    nextSendSequence: () => 7,
    ezspSendUnicast: async (type: number, destination: number, frame: any, tag: number, data: Buffer) => {
      captured = Buffer.from(data);
      capturedOptions = frame.options;
      queueMicrotask(() => adapter.onMessageSent(SLStatus.OK, type, destination, frame, tag));
      return [SLStatus.OK, 9];
    },
  };

  await adapter.sendRawZclFrame({
    ieeeAddress: '0x00124b0001abcdef',
    networkAddress: 0x1234,
    endpoint: 2,
    clusterId: 6,
    data: Buffer.from([0x18, 0x42, 0x01, 0xaa]),
    forceRouteDiscovery: true,
  });

  assert.deepEqual([...captured!], [0x18, 0x42, 0x01, 0xaa]);
  assert.notEqual(capturedOptions & EmberApsOption.FORCE_ROUTE_DISCOVERY, 0);
});

test('pre-dispatch abort is exact and an in-flight abort never dispatches twice', async () => {
  const adapter = createFacadeHarness();
  let dispatches = 0;
  let releaseDispatch!: (value: [number, number]) => void;
  adapter.ezsp = {
    nextSendSequence: () => 8,
    ezspSendUnicast: () => {
      dispatches += 1;
      return new Promise<[number, number]>((resolve) => {
        releaseDispatch = resolve;
      });
    },
  };

  const before = new AbortController();
  const beforeReason = new Error('cancel before queue dispatch');
  before.abort(beforeReason);
  await assert.rejects(
    adapter.sendRawZclFrame({
      networkAddress: 1,
      endpoint: 1,
      clusterId: 6,
      data: Buffer.from([1]),
      signal: before.signal,
    }),
    beforeReason,
  );
  assert.equal(dispatches, 0);

  const during = new AbortController();
  const duringReason = new Error('cancel in flight');
  const sending = adapter.sendRawZclFrame({
    networkAddress: 1,
    endpoint: 1,
    clusterId: 6,
    data: Buffer.from([2]),
    signal: during.signal,
  });
  await Promise.resolve();
  during.abort(duringReason);
  releaseDispatch([SLStatus.OK, 1]);
  await assert.rejects(sending, duringReason);
  assert.equal(dispatches, 1);
});

test('unknown future ZDO frames are emitted raw without invoking the upstream parser', async () => {
  const adapter = createFacadeHarness();
  adapter.hasZdoMessageOverhead = true;
  const received = new Promise<any>((resolve) => adapter.once('homeyZdoFrame', resolve));
  adapter.onZDOResponse(
    { clusterId: 0x9999, sourceEndpoint: 0 },
    0x1234,
    Buffer.from([7, 1, 2, 3]),
  );
  const frame = await received;
  assert.equal(frame.sender, 0x1234);
  assert.equal(frame.endpoint, 0);
  assert.equal(frame.sequence, 7);
  assert.equal(frame.clusterId, 0x9999);
  assert.deepEqual([...frame.payload], [1, 2, 3]);
  assert.ok(frame.parseError);
});

test('APS fragments are acknowledged per block and delivered once, reassembled', async () => {
  const adapter = createFacadeHarness();
  adapter.oneWaitress = { resolveZCL: () => undefined };
  const acks: number[] = [];
  adapter.ezsp = {
    ezspSendReply: async (sender: number, frame: any, contents: Buffer) => {
      assert.equal(sender, 0x8522);
      assert.equal(contents.length, 0);
      acks.push(frame.groupId);
      return SLStatus.OK;
    },
  };
  const delivered: any[] = [];
  adapter.on('zclPayload', (payload: any) => delivered.push(payload));
  // Aqara FP400 three-target FC0C report captured on Ember (Koenkk/zigbee-herdsman#1886):
  // block 0 is the 80 bytes that previously reached ZCL alone; block 1 completes target 3.
  const block0 = Buffer.from(
    '1c5f110a8b00004c030009002001297500292c0029000029000021f00a300030fe20000900200029e2ff2902' +
      '0029090029170021a00f300030fe20000900200429e8ff29020029000029170021d00730',
    'hex',
  );
  const block1 = Buffer.from('0030fe2000', 'hex');
  const frame = (groupId: number) => ({
    profileId: 260,
    clusterId: 0xfc0c,
    sourceEndpoint: 1,
    destinationEndpoint: 1,
    options: 0x8140,
    groupId,
    sequence: 29,
  });
  const receive = (groupId: number, data: Buffer) =>
    adapter.onIncomingMessage(0, frame(groupId), 200, 0x8522, data);

  receive(0x0200, block0);
  receive(0x0200, block0); // retransmission after a lost ACK
  receive(0x0003, block1); // outside the window: no block 3 exists
  assert.equal(delivered.length, 0);
  receive(0x0001, block1);
  receive(0x0001, block1); // final block retransmitted after completion
  await Promise.resolve();

  assert.deepEqual(acks, [0xff00, 0xff00, 0xff01, 0xff01]);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].data.length, 85);
  assert.deepEqual(delivered[0].data, Buffer.concat([block0, block1]));
  assert.equal(delivered[0].groupID, 0);
  assert.equal(delivered[0].clusterID, 0xfc0c);
});

test('unfragmented messages pass through and stray fragments are ignored unacknowledged', async () => {
  const adapter = createFacadeHarness();
  adapter.oneWaitress = { resolveZCL: () => undefined };
  let acks = 0;
  adapter.ezsp = { ezspSendReply: async () => (acks += 1, SLStatus.OK) };
  const delivered: any[] = [];
  adapter.on('zclPayload', (payload: any) => delivered.push(payload));
  const data = Buffer.from('18010a0000100001', 'hex');
  const frame = { profileId: 260, clusterId: 6, sourceEndpoint: 1, destinationEndpoint: 1, groupId: 0, sequence: 3 };

  adapter.onIncomingMessage(0, { ...frame, options: 0x0140 }, 200, 0x1234, data);
  // A continuation block without its block 0 cannot be reassembled.
  adapter.onIncomingMessage(0, { ...frame, options: 0x8140, groupId: 0x0001 }, 200, 0x1234, data);

  assert.equal(acks, 0);
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].data, data);
});

test('multicast mutations are serialized and reject broadcast/sentinel IDs', async () => {
  const adapter = createFacadeHarness();
  const indices: number[] = [];
  adapter.ezsp = {
    ezspSetMulticastTableEntry: async (index: number) => {
      indices.push(index);
      await Promise.resolve();
      return SLStatus.OK;
    },
  };

  await Promise.all([adapter.addMulticastGroup(100), adapter.addMulticastGroup(200)]);
  assert.deepEqual(indices, [0, 1]);
  assert.deepEqual(adapter.multicastTable, [100, 200]);
  await assert.rejects(adapter.addMulticastGroup(0xfff8), RangeError);
  await assert.rejects(adapter.addMulticastGroup(0xffff), RangeError);

  await adapter.removeMulticastGroup(100);
  assert.deepEqual(adapter.multicastTable, [200]);
});

test('raw-send correlation ignores a ZDO callback that reuses the same message tag', async () => {
  const adapter = createFacadeHarness();
  const expected = {
    type: EmberOutgoingMessageType.DIRECT,
    destination: 0x1234,
    profileId: 0x0104,
    clusterId: 6,
    sourceEndpoint: 1,
    destinationEndpoint: 2,
  };
  const pending = adapter.waitForMessageSent(7, 1_000, undefined, expected);

  await adapter.onMessageSent(
    SLStatus.OK,
    EmberOutgoingMessageType.DIRECT,
    0x1234,
    {
      profileId: 0,
      clusterId: 0x0005,
      sourceEndpoint: 0,
      destinationEndpoint: 0,
      sequence: 1,
    },
    7,
  );
  assert.equal(adapter.homeyPendingSends.has(7), true);

  await adapter.onMessageSent(
    SLStatus.OK,
    expected.type,
    expected.destination,
    { ...expected, sequence: 2 },
    7,
  );
  await pending;
  assert.equal(adapter.homeyPendingSends.size, 0);
});

test('queued ZDO cancellation is rechecked before EZSP dispatch', async () => {
  const adapter = createFacadeHarness();
  let releaseQueue!: () => void;
  let dispatches = 0;
  adapter.queue = {
    execute: async (operation: () => unknown) => {
      await new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
      return operation();
    },
  };
  adapter.ezsp = {
    ezspSendUnicast: async () => {
      dispatches += 1;
      return [SLStatus.OK, 1];
    },
  };
  adapter.nextZDORequestSequence = () => 1;
  const abort = new AbortController();
  const reason = new Error('cancel while queued');
  const request = adapter.sendHomeyZdo({
    ieeeAddress: '0x00124b0001abcdef',
    networkAddress: 0x1234,
    clusterId: 5,
    payload: Buffer.alloc(4),
    signal: abort.signal,
  });
  abort.abort(reason);
  releaseQueue();
  await assert.rejects(request, reason);
  assert.equal(dispatches, 0);
});

test('ZDO EZSP dispatch failures retain their status layer', async () => {
  const adapter = createFacadeHarness();
  adapter.ezsp = {
    ezspSendUnicast: async () => {
      const error: any = new Error('NOT_CONNECTED');
      error.code = EzspStatus.NOT_CONNECTED;
      throw error;
    },
  };
  adapter.nextZDORequestSequence = () => 1;

  await assert.rejects(
    adapter.sendHomeyZdo({
      ieeeAddress: '0x00124b0001abcdef',
      networkAddress: 0x1234,
      clusterId: 5,
      payload: Buffer.alloc(4),
    }),
    (error: any) => {
      assert.ok(error instanceof HomeyEmberStatusError);
      assert.equal(error.operation, 'ZDO dispatch');
      assert.equal(error.layer, 'ezsp');
      assert.equal(error.statusName, 'NOT_CONNECTED');
      return true;
    },
  );
});

test('NCP reset emits disconnect details and settles pending raw sends', async () => {
  const adapter = createFacadeHarness();
  const pending = adapter.waitForMessageSent(1, 60_000);
  pending.catch(() => undefined);
  const disconnected = new Promise<any>((resolve) => adapter.once('homeyDisconnected', resolve));
  adapter.onNcpNeedsResetAndInit(EzspStatus.NOT_CONNECTED);

  await assert.rejects(pending, (error: any) => {
    assert.equal(error.layer, 'ezsp');
    assert.equal(error.statusName, 'NOT_CONNECTED');
    return true;
  });
  assert.deepEqual(await disconnected, {
    status: EzspStatus.NOT_CONNECTED,
    statusName: 'NOT_CONNECTED',
  });
  assert.equal(adapter.homeyPendingSends.size, 0);
});

test('herdsman debug follows Homey Zigbee debug logging, info and above always print', async (t) => {
  // setDebug arms a one-hour auto-disable timer that would otherwise keep the file running.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await import('../../src/herdsman.mts');
  const { ZigbeeLocal } = await import('@athombv/homey-local');
  const { logger } = require('zigbee-herdsman/dist/utils/logger.js');
  const zigbeeLocal = new ZigbeeLocal({ setBasicDeviceDebugEnabled() {}, log() {} } as any);
  const stderr = t.mock.method(process.stderr, 'write', () => true);
  const info = t.mock.method(console, 'info', () => undefined);
  let built = 0;
  const frame = () => `frame ${++built}`;

  logger.debug(frame, 'zh:ember:uart:ash');
  assert.equal(built, 0);
  assert.equal(stderr.mock.callCount(), 0);

  await zigbeeLocal.setDebug({ enabled: true });
  logger.debug(frame, 'zh:ember:uart:ash');
  assert.equal(built, 1);
  assert.match(String(stderr.mock.calls.at(-1)?.arguments[0]), /zigbee:zh:ember:uart:ash.*frame 1/);

  await zigbeeLocal.setDebug({ enabled: false });
  logger.debug(frame, 'zh:ember:uart:ash');
  assert.equal(built, 1);

  logger.info('[NCP COUNTERS] 1,2,3', 'zh:ember');
  assert.deepEqual(info.mock.calls.at(-1)?.arguments, ['zh:ember: [NCP COUNTERS] 1,2,3']);
});
