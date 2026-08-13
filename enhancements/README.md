# The enhancements

Where the patches in [`patches/`](../patches) fix defects in upstream files, enhancements
add new capability. Each is a self-contained directory `NNNN-<slug>/`, applied to `/app`
after the patches in numeric order, and inert by default: the image behaves exactly like
the patched upstream until the enhancement is enabled at runtime.

Each directory contains `apply.mjs`, which verifies the tree against `compatibility.json`
(a sha256 per guarded upstream file, plus version pins) before editing the few upstream
files that wire the enhancement in — unknown upstream contents fail the build. `apply.mjs
--list` declares the files it changes, and the Dockerfile stages exactly those plus the
enhancement's runtime tree (`src/` and its pinned `node_modules/`) under
`/app/enhancements/<name>/`. `docker build --target test .`
runs every enhancement's test suites inside the built image.

## 0001: Native USB Zigbee with an Ember coordinator

Upstream SHS has no native Zigbee radio: `System.hasZigbee()` is hardcoded `false` and
Zigbee requires a Homey Bridge as the antenna. This enhancement adds a second backend
that drives a Silicon Labs Ember/EZSP USB coordinator directly. The reference device is
the [Home Assistant Connect ZBT-2](https://www.home-assistant.io/connect/zbt-2/): Ember
at 460800 baud with RTS/CTS, dedicated to Zigbee, with Zigbee NCP firmware already
installed — an incompatible stick is reported, never flashed.

`HOMEY_ZIGBEE_BACKEND` selects `bridge` (the default, unchanged upstream behaviour) or
`ember` once at startup. There is no automatic switching, so a missing stick can never
silently become a new Bridge network. In Ember mode `hasZigbee()` is `true` and paired
Homey Bridges act as Zigbee satellites.

### How it works

`apply.mjs` adds the `HOMEY_ZIGBEE_*` config keys, makes `hasZigbee()` reflect the
backend, keeps upstream's manager as `ManagerZigbeeBridge.mts`, and installs a small
selector in its place:

```
ManagerZigbeeEmber (lifecycle, retries)
  → HomeyEmberController (@athombv/zigbee Controller contract)
    → src/homey-ember.cjs (subclasses zigbee-herdsman's Ember adapter)
      → /dev/zigbee
```

The driver adds what Homey needs and herdsman does not expose: raw ZCL passthrough, raw
ZDO indications, multicast-group management, forced route discovery, and disconnect
surfacing. zigbee-herdsman is pinned to 10.6.2 — the npm postinstall refuses any other
version or Ember-adapter build — and the native serial binding is installed inside the
upstream image per target platform, so it always matches SHS's Node runtime and libc.

Homey stays up when the radio is missing, busy or incompatible: the manager retries
indefinitely (2 s doubling to 60 s) with an actionable error, and replugging the
coordinator recovers without a restart. Radio state lives in `/homey/user/zigbee-ember/`
— `network.json` (mode 0600) and `coordinator-backup.json`, written atomically and
refreshed after formation/reset, after join/leave, daily, and on shutdown. The directory
is created at runtime; creating it in the image would defeat patch 0001's missing-volume
guard.

### Running it

| Variable | Default | Purpose |
|---|---|---|
| `HOMEY_ZIGBEE_BACKEND` | `bridge` | `ember` enables direct USB Zigbee |
| `HOMEY_ZIGBEE_DEVICE` | `/dev/zigbee` | Coordinator path inside the container |
| `HOMEY_ZIGBEE_BAUDRATE` | `460800` | Ember NCP serial speed |
| `HOMEY_ZIGBEE_RTSCTS` | `true` | Hardware flow control (`true`/`false`/`1`/`0`) |
| `HOMEY_ZIGBEE_CHANNEL` | `11` | Initial channel 11–26; ignored once a network exists |

Map the coordinator by its stable `/dev/serial/by-id/` path — `/dev/ttyUSB0`-style names
change across replugs. Add to the `docker run` from the main README:

```sh
--device /dev/serial/by-id/usb-Nabu_Casa_Connect_ZBT-2_...:/dev/zigbee \
-e HOMEY_ZIGBEE_BACKEND=ember \
```

or use [`0001-zigbee-ember/compose.yaml`](0001-zigbee-ember/compose.yaml). The first
Ember start forms a fresh network; changing `HOMEY_ZIGBEE_CHANNEL` afterwards does
nothing — use Homey's Zigbee reset flow, which re-pairs all devices.

Version 1 forms new networks only. Migrating an existing Homey or Bridge network,
restoring a backup onto a different coordinator, automatic firmware updates, and Homey
Pro's private CPC/zigbeed topology are out of scope.
