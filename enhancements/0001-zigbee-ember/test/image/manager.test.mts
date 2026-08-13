import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { ManagerZigbeeEmber } from '../../src/ManagerZigbeeEmber.mts';

const NETWORK_SETTINGS = {
  IEEEAddress: '00:12:4b:00:01:ab:cd:ef',
  panId: 0x1234,
  extendedPanId: '00:11:22:33:44:55:66:77',
  networkKey: '00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff',
  channel: 11,
  networkKeySequenceNumber: 2,
  networkKeyFrameCounter: 42,
  softwareVersion: 'EmberZNet 8.0.2',
};

type StartBehavior = 'success' | Error | PromiseWithResolvers<void>;

class FakeController extends EventEmitter {
  readonly name: string;
  readonly startBehavior: StartBehavior;
  networkSettings = { ...NETWORK_SETTINGS };
  nodes = new Map<string, unknown>();
  startCalls = 0;
  destroyCalls = 0;
  removeNodesCalls = 0;
  resetCalls = 0;
  nextResetChannel?: number;
  resetError?: Error;

  constructor(name: string, startBehavior: StartBehavior = 'success') {
    super();
    this.name = name;
    this.startBehavior = startBehavior;
  }

  async start() {
    this.startCalls++;
    if (this.startBehavior instanceof Error) throw this.startBehavior;
    if (this.startBehavior !== 'success') await this.startBehavior.promise;
    return 'reset' as const;
  }

  async destroy() {
    this.destroyCalls++;
  }

  suppressFinalBackup() {}

  setNodes(nodes: Map<string, unknown>) {
    this.nodes = new Map(nodes);
  }

  removeNodes() {
    this.removeNodesCalls++;
    this.nodes.clear();
  }

  getNode(ieeeAddress: string) {
    return this.nodes.get(ieeeAddress);
  }

  async reset() {
    this.resetCalls++;
    if (this.resetError) throw this.resetError;
    if (this.nextResetChannel !== undefined) this.networkSettings.channel = this.nextResetChannel;
  }

  setNextResetChannel(channel?: number) {
    this.nextResetChannel = channel;
  }
}

async function flushMicrotasks(iterations = 40) {
  for (let index = 0; index < iterations; index++) await Promise.resolve();
}

async function waitFor(predicate: () => boolean, message: string) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await flushMicrotasks(2);
  }
  assert.fail(message);
}

function createHarness(controllers: FakeController[]) {
  const state = {
    nodes: {} as Record<string, unknown>,
    controller: {} as Record<string, unknown>,
    unsetNodesCalls: 0,
  };
  const devicesManager = {
    async getBridges() {
      return {};
    },
    async getDevices() {
      return {};
    },
  };
  const virtualDeviceManager = {
    async getVirtualDeviceHomeyBridge() {
      return null;
    },
  };
  const homey = {
    logger: {
      _logWithContext() {},
    },
    __(key: string) {
      return key;
    },
    async getManager(id: string) {
      if (id === 'devices') return devicesManager;
      if (id === 'vdevice') return virtualDeviceManager;
      throw new Error(`Unexpected manager: ${id}`);
    },
  };

  const manager = new ManagerZigbeeEmber({ homey: homey as any });

  Object.assign(manager as any, {
    createController() {
      const controller = controllers.shift();
      if (!controller) throw new Error('Test exhausted its fake controllers');
      return controller;
    },
    async getOptionNodesTokensMap() {
      return state.nodes;
    },
    async setOptionNodesTokensMap(value: Record<string, unknown>) {
      state.nodes = value;
      return value;
    },
    async unsetOptionNodesTokensMap() {
      state.unsetNodesCalls++;
      state.nodes = {};
      return state.nodes;
    },
    async getOptionControllerState() {
      return state.controller;
    },
    async setOptionControllerState(value: Record<string, unknown>) {
      state.controller = value;
      return value;
    },
    async unsetOptionControllerState() {
      state.controller = {};
      return state.controller;
    },
    async setState(value: object = {}) {
      return value;
    },
  });

  return { manager, state };
}

test('failed startup stays alive and a successful generation resets readiness and backoff', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = new FakeController('first', new Error('serial port busy'));
  const second = new FakeController('second');
  const recoveryFailure = new FakeController('recovery-failure', new Error('serial port busy'));
  const recovered = new FakeController('recovered');
  const { manager } = createHarness([first, second, recoveryFailure, recovered]);
  t.after(() => manager.onUninit());

  await manager.onInit();
  const ready = manager.getZigbeeReady();
  let readinessSettled = false;
  ready.then(
    () => {
      readinessSettled = true;
    },
    () => {
      readinessSettled = true;
    },
  );

  await waitFor(() => first.destroyCalls > 0, 'failed controller was not cleaned up');
  assert.equal(readinessSettled, false);
  assert.equal((manager as any).zigbee_ready, false);
  assert.equal(manager.getCurrentCommand(), 'STARTING');
  assert.match((manager as any).zigbee_error, /busy/i);

  // Covers the full +/-20% jitter window around the initial two-second delay.
  await flushMicrotasks();
  t.mock.timers.tick(2_400);
  await waitFor(() => second.startCalls === 1, 'manager did not retry controller startup');

  assert.equal(await ready, second);
  assert.equal((manager as any).zigbee_ready, true);
  assert.equal((manager as any).zigbee_error, null);
  assert.equal(manager.getCurrentCommand(), 'IDLE');

  second.emit('disconnected', { statusName: 'ZIGBEE_NCP_RESET' });
  await waitFor(
    () => recoveryFailure.destroyCalls > 0,
    'recovery startup failure was not cleaned up',
  );
  const recoveryReady = manager.getZigbeeReady();
  await flushMicrotasks();

  // The previous generation had already advanced its backoff to four seconds. A new generation
  // must begin again at two seconds, so 2.4 seconds covers its complete jitter window.
  t.mock.timers.tick(2_400);
  await waitFor(() => recovered.startCalls === 1, 'recovery did not reset its retry backoff');
  assert.equal(await recoveryReady, recovered);
  assert.equal((manager as any).zigbee_ready, true);
});

test('a stale disconnected controller cannot resolve or disrupt the new generation', async (t) => {
  const first = new FakeController('first');
  const secondStart = Promise.withResolvers<void>();
  const second = new FakeController('second', secondStart);
  const { manager } = createHarness([first, second]);
  t.after(() => manager.onUninit());

  await manager.onInit();
  assert.equal(await manager.getZigbeeReady(), first);

  first.emit('disconnected', { statusName: 'ZIGBEE_NCP_RESET' });
  await waitFor(() => second.startCalls === 1, 'recovery generation did not start');
  const recovered = manager.getZigbeeReady();

  // A late event from the destroyed instance must not replace or reject the active generation.
  first.emit('disconnected', { statusName: 'ZIGBEE_NCP_RESET' });
  secondStart.resolve();
  await flushMicrotasks();

  assert.equal(await recovered, second);
  assert.equal((manager as any).controller, second);
  assert.equal((manager as any).zigbee_ready, true);
});

test('a successful reset clears persisted and in-memory Homey nodes', async (t) => {
  const controller = new FakeController('controller');
  const { manager, state } = createHarness([controller]);
  t.after(() => manager.onUninit());

  await manager.onInit();
  await manager.getZigbeeReady();
  state.nodes = {
    token: {
      ieeeAddress: '00:12:4b:00:01:ab:cd:ef',
      networkAddress: 0x1234,
    },
  };
  controller.nodes.set('00:12:4b:00:01:ab:cd:ef', {});

  await manager.resetNetwork({ channel: 15 });

  assert.equal(controller.resetCalls, 1);
  assert.equal(controller.removeNodesCalls, 1);
  assert.deepEqual([...controller.nodes], []);
  assert.equal(state.unsetNodesCalls, 1);
  assert.deepEqual(state.nodes, {});
  assert.equal(manager.getCurrentCommand(), 'IDLE');
});

test('a failed reset rejects to its caller and starts a fresh recovery generation', async (t) => {
  const first = new FakeController('first');
  first.resetError = new Error('NCP reset failed');
  const second = new FakeController('second');
  const { manager } = createHarness([first, second]);
  t.after(() => manager.onUninit());

  await manager.onInit();
  assert.equal(await manager.getZigbeeReady(), first);

  await assert.rejects(manager.resetNetwork(), /NCP reset failed/);
  await waitFor(() => second.startCalls === 1, 'reset failure did not enter recovery');

  assert.equal(await manager.getZigbeeReady(), second);
  assert.equal((manager as any).controller, second);
  assert.equal((manager as any).zigbee_ready, true);
});
