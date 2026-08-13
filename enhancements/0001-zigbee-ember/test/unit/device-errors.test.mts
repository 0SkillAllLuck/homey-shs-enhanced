import assert from 'node:assert/strict';
import test from 'node:test';

import { describeAdapterError } from '../../src/device-errors.mts';

function errorWithCode(code: string, message = code) {
  return Object.assign(new Error(message), { code });
}

test('describes a missing device with stable-path guidance', () => {
  assert.match(
    describeAdapterError(errorWithCode('ENOENT'), '/dev/zigbee'),
    /does not exist.*\/dev\/serial\/by-id\/.*\/dev\/zigbee/,
  );
});

test('recognizes serialport missing-device messages without an errno property', () => {
  assert.match(
    describeAdapterError(new Error('No such file or directory, cannot open /dev/zigbee'), '/dev/zigbee'),
    /does not exist/,
  );
});

test('describes device permission failures', () => {
  for (const code of ['EACCES', 'EPERM']) {
    assert.match(describeAdapterError(errorWithCode(code), '/dev/zigbee'),
      /not accessible.*device mapping.*host permissions/);
  }
});

test('describes device ownership conflicts', () => {
  assert.match(
    describeAdapterError(errorWithCode('EBUSY'), '/dev/serial/by-id/coordinator'),
    /is busy.*other Zigbee or Thread service.*coordinator/,
  );
  assert.match(
    describeAdapterError(new Error('Cannot lock serial port'), '/dev/zigbee'),
    /is busy/,
  );
});

test('distinguishes likely Thread firmware from a generic startup error', () => {
  assert.match(
    describeAdapterError(new Error('EZSP unsupported version'), '/dev/zigbee'),
    /Zigbee NCP firmware \(not Thread\/OpenThread firmware\).*EZSP unsupported version/,
  );
  assert.equal(
    describeAdapterError('handshake failed', '/dev/zigbee'),
    'Unable to initialize the Zigbee coordinator at /dev/zigbee: handshake failed',
  );
});
