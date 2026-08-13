const HOMEY_HEX_SEPARATOR = ':';

function normalizeHex(value: string, bytes: number, label: string): string {
  const normalized = value.replace(/^0x/i, '').replaceAll(HOMEY_HEX_SEPARATOR, '').toLowerCase();
  if (!new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new TypeError(`Invalid ${label}: ${value}`);
  }
  return normalized;
}

export function formatHomeyHex(value: string | Uint8Array, bytes: number, label = 'hex value') {
  const hex =
    typeof value === 'string'
      ? normalizeHex(value, bytes, label)
      : normalizeHex(Buffer.from(value).toString('hex'), bytes, label);
  return hex.match(/../g)!.join(HOMEY_HEX_SEPARATOR);
}

export function homeyHexToBuffer(value: string, bytes: number, label = 'hex value') {
  return Buffer.from(normalizeHex(value, bytes, label), 'hex');
}

export function homeyIeeeToEui64(value: string) {
  return `0x${normalizeHex(value, 8, 'IEEE address')}`;
}

export function eui64ToHomeyIeee(value: string) {
  return formatHomeyHex(value, 8, 'EUI64');
}

export function networkKeyToBytes(value: string) {
  return [...homeyHexToBuffer(value, 16, 'network key')];
}

export function extendedPanIdToBytes(value: string) {
  return [...homeyHexToBuffer(value, 8, 'extended PAN ID').reverse()];
}
