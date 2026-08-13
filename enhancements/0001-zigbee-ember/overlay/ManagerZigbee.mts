import { config } from '../config.mts';

/**
 * Select the Zigbee backend once, while the Homey manager registry is loaded.
 * Backends are never switched in a running process.
 */
export const ManagerZigbee =
  config.HOMEY_ZIGBEE_BACKEND === 'ember'
    ? (await import('../../../enhancements/0001-zigbee-ember/src/ManagerZigbeeEmber.mts'))
        .ManagerZigbeeEmber
    : (await import('./ManagerZigbeeBridge.mts')).ManagerZigbee;
