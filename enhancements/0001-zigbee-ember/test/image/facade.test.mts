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
