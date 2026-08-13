# Homey SHS - Enhanced Edition

Patches and Enhancements for [Homey Self-Hosted Server](https://homey.app), applied to the official image
at build time.

**This repo distributes patches and a Dockerfile — never an image.** Athom's first-party
code carries no license grant anywhere in the image (no LICENSE, no `license` field in any
first-party `package.json`, source repo private), so default copyright applies. You pull
the original image from ghcr yourself and build locally. Pushing the result — or even the
unmodified upstream image — to a public registry would be unauthorized redistribution.

## Build

```sh
docker build -t homey-shs-enhanced:13.4.0 .
docker build --target test .   # run the enhancement test suites inside the image
```

### Run

The image still needs `--network host` — mDNS, SSDP, ARP-based discovery and Matter are
all link-local and no port mapping substitutes for being on the LAN. It does **not** need
`--privileged`.

```sh
docker run -d --name homey-shs \
  --network host \
  --cap-add NET_ADMIN \
  --security-opt systempaths=unconfined \
  -v ./data:/homey/user \
  homey-shs-enhanced:13.4.0
```

### Kubernetes

[`charts/homey-shs-enhanced`](charts/homey-shs-enhanced) deploys the image you built on
Kubernetes, secure by default: all capabilities dropped except five bisected-minimal
ones, no privilege escalation, read-only root filesystem, mandatory PVC on
`/homey/user`, and the patches' Kubernetes affordances (exit-on-daemon-failure, cgroup
memory limit, `HOMEY_LOCAL_ADDRESS`) pre-wired. Zigbee is an opt-in — serial-over-TCP
costs no privileges at all. The [chart README](charts/homey-shs-enhanced/README.md)
explains the defaults.

```sh
helm install homey ./charts/homey-shs-enhanced -n homey --create-namespace \
  --set image.repository=registry.example.com/homey-shs-enhanced
```

## The patches

| Patch | Description |
|---|---|
| [`restore-missing-volume-guard`](patches/README.md#0001-restore-the-missing-volume-guard) | Without a volume, all state silently goes to the ephemeral layer |
| [`matter-sysctls-loud-and-scoped`](patches/README.md#0002-make-the-matter-sysctl-writes-loud-and-scoped) | Thread routing silently never works, and the sysctl loop rewrites the host's IPv6 config |
| [`surface-failed-daemons`](patches/README.md#0003-surface-failed-daemons) | A dead avahi/matter/go2rtc leaves every health probe green |
| [`cgroup-aware-memory-guard`](patches/README.md#0004-cgroup-aware-memory-guard) | A memory limit causes an OOM kill instead of graceful degradation |
| [`go2rtc-loopback-and-configurable-ports`](patches/README.md#0005-keep-go2rtc-on-loopback-and-make-its-ports-configurable) | A logging flag exposes an unauthenticated API to the LAN |
| [`honour-homey-local-address`](patches/README.md#0006-honour-homey_local_address-everywhere) | The self-reported IP is wrong behind bridge/NAT networking |
| [`python-app-sys-admin-preflight`](patches/README.md#0007-cap_sys_admin-pre-flight-for-python-apps) | Python apps crash-loop forever with no actionable message |
| [`honour-ota-api-baseurl`](patches/README.md#0008-honour-athom_ota_api_baseurl) | A declared env var is never read |

In addition the `Dockerfile` also adds what upstream's omits: `EXPOSE`, a `HEALTHCHECK`
and a trimmed `DEBUG` that drops namespaces dead on SHS (`BluFi*`, `Bluez`, `GPIO`, `zigbee:*`)
while keeping the startup banner, setup, mDNS and all five daemon supervisors.
Deliberately **no** `VOLUME` — an anonymous volume on `/homey/user` would silently swallow 
activation state, and it can't be removed downstream once declared.

## The enhancements

Where patches fix upstream defects, enhancements add new capability on top of the patched
image. They are applied after the patches, in numeric order, and are inert unless
explicitly enabled at runtime — [`enhancements/README.md`](enhancements/README.md)
describes each one and how it is guarded against upstream changes.

| Enhancement | Description |
|---|---|
| [`zigbee-ember`](enhancements/README.md#0001-native-usb-zigbee-with-an-ember-coordinator) | Bridgeless Zigbee: drive a USB Ember/EZSP coordinator (ZBT-2) directly, no Homey Bridge required |

## Repo layout

```
Dockerfile          multi-stage build: upstream (sha-pinned) → patcher → enhanced
patches/            NNNN-<slug>.patch, applied in numeric order
enhancements/       NNNN-<slug>/, Enhancements applied in numeric order
charts/             Helm chart for the image you built
```

## Legal

Homey, Homey Pro, Homey Bridge and all related names, logos and brands are trademarks or
registered trademarks of [Athom B.V.](https://homey.app) and remain its property. This is
an independent community project — not affiliated with, endorsed by or supported by Athom,
and images built from it are not an Athom product. Athom's code remains under Athom's
terms: this repository distributes only patches and build instructions, per the licensing
note at the top.

This repository's own original content — the patches as authored works, the enhancements,
the Helm chart, the Dockerfile and the documentation — is licensed under the
[MIT License](LICENSE). That grant covers only what this project's authors hold copyright
on; it does not and cannot extend to Athom's code, including the upstream lines that
patch files necessarily quote as context.
