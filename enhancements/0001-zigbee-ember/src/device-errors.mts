import path from 'node:path';

export function describeAdapterError(error: unknown, device: string) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;

  if (code === 'ENOENT' || /no such file|does not exist/i.test(message)) {
    return `Zigbee device ${device} does not exist. Map a stable /dev/serial/by-id/... path to /dev/zigbee.`;
  }
  if (code === 'EACCES' || code === 'EPERM' || /permission denied|access denied/i.test(message)) {
    return `Zigbee device ${device} is not accessible. Check the container device mapping and host permissions.`;
  }
  if (code === 'EBUSY' || /resource busy|cannot lock|already open/i.test(message)) {
    return `Zigbee device ${device} is busy. Stop the other Zigbee or Thread service using ${path.basename(device)}.`;
  }
  if (/ash|ezsp|ncp|unsupported.*version|invalid.*frame|reset code/i.test(message)) {
    return `Unable to initialize Ember/EZSP on ${device}. Confirm the coordinator has Zigbee NCP firmware (not Thread/OpenThread firmware). Automatic flashing is intentionally disabled. Cause: ${message}`;
  }
  return `Unable to initialize the Zigbee coordinator at ${device}: ${message}`;
}
