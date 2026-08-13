import assert from 'node:assert/strict';
import test from 'node:test';

import {
  eui64ToHomeyIeee,
  extendedPanIdToBytes,
  formatHomeyHex,
  homeyHexToBuffer,
  homeyIeeeToEui64,
  networkKeyToBytes,
} from '../../src/address.mts';

test('formats Homey hexadecimal values consistently', () => {
  assert.equal(formatHomeyHex('0x00124B0001ABCDEF', 8), '00:12:4b:00:01:ab:cd:ef');
  assert.equal(
    formatHomeyHex(Uint8Array.from([0, 18, 75, 0, 1, 171, 205, 239]), 8),
    '00:12:4b:00:01:ab:cd:ef',
  );
  assert.deepEqual(homeyHexToBuffer('00:12:4b:00:01:ab:cd:ef', 8),
    Buffer.from('00124b0001abcdef', 'hex'));
});

test('converts between Homey IEEE addresses and herdsman EUI64 values', () => {
  const homeyAddress = '00:12:4b:00:01:ab:cd:ef';
  const eui64 = '0x00124b0001abcdef';

  assert.equal(homeyIeeeToEui64(homeyAddress), eui64);
  assert.equal(eui64ToHomeyIeee(eui64), homeyAddress);
});

test('converts radio credentials to the byte order expected by herdsman', () => {
  assert.deepEqual(
    networkKeyToBytes('00:01:02:03:04:05:06:07:08:09:0a:0b:0c:0d:0e:0f'),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  );
  assert.deepEqual(extendedPanIdToBytes('00:12:4b:00:01:ab:cd:ef'),
    [239, 205, 171, 1, 0, 75, 18, 0]);
});

test('rejects malformed hexadecimal values', () => {
  assert.throws(() => formatHomeyHex('00:12:4b', 8), /Invalid hex value/);
  assert.throws(() => homeyIeeeToEui64('00:12:4b:00:01:ab:cd:gg'), /Invalid IEEE address/);
  assert.throws(() => networkKeyToBytes('0011'), /Invalid network key/);
});
