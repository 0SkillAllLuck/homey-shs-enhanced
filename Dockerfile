# syntax=docker/dockerfile:1
# Homey Self-Hosted Server, with the patches in ./patches and the enhancements in
# ./enhancements applied.
#
# Upstream is pinned by its multi-arch *index* digest, so one pin covers both
# linux/amd64 and linux/arm64. See patches/README.md for why each patch exists and
# enhancements/README.md for what the enhancements add.
#
#   docker build -t homey-shs-enhanced:13.4.1 .
#   docker build --target test .   # run the enhancement test suites inside the image

# ghcr.io/athombv/homey-shs:latest == 13.4.1, built 2026-08-18
FROM ghcr.io/athombv/homey-shs@sha256:268b146973bddce7ee14ed5a5a8225a1b58419c15941f54916f352ff8015283f AS upstream


# Runtime dependencies for the zigbee-ember enhancement. npm runs inside the upstream
# image so the prebuilt serial binding matches SHS's Node runtime, architecture and
# libc, once per target platform. The postinstall refuses any zigbee-herdsman build the
# Ember driver was not written against.
FROM upstream AS zigbee-ember-deps

WORKDIR /build

COPY enhancements/0001-zigbee-ember/package.json enhancements/0001-zigbee-ember/package-lock.json ./
COPY enhancements/0001-zigbee-ember/scripts/ ./scripts/

RUN npm ci --omit=dev \
  && npm cache clean --force


# The upstream image ships no `patch` and no `git`, so patching happens in a throwaway
# stage. It is pinned to BUILDPLATFORM so `git apply` and the enhancement scripts run
# natively when cross-building; that is sound because every changed file is
# architecture-independent .mts/.mjs source.
FROM --platform=$BUILDPLATFORM alpine:3.22 AS patcher

RUN apk add --no-cache git nodejs

COPY --from=upstream /app /app
COPY patches/ /patches/
COPY enhancements/ /enhancements/

# Apply strictly, in numeric order: patches first, then enhancements. `git apply
# --check` before `git apply`, under `set -e`: a patch that does not match aborts the
# build and no image is produced. No fuzz, no partial application, no .rej files.
# Each enhancement's apply.mjs verifies the tree against its compatibility manifest
# and fails the build on any mismatch, for the same reason.
RUN <<'SH'
set -eu

if grep -q '^+++ /dev/null' /patches/*.patch; then
  echo "ERROR: a patch deletes a file, which the /out staging below cannot express"
  exit 1
fi

cd /app
for p in /patches/*.patch; do
  echo "==> ${p##*/}"
  git apply --check -p1 --whitespace=nowarn "$p"
  git apply         -p1 --whitespace=nowarn "$p"
done

for e in /enhancements/*/; do
  echo "==> ${e#/enhancements/}"
  node "${e}apply.mjs" /
done

# Stage only the files the patches and enhancements name, so the final image gains
# exactly one small layer on top of upstream rather than a second copy of /app.
# `apply.mjs --list` is each enhancement's declaration of the files it changes.
{
  sed -n 's|^+++ b/||p' /patches/*.patch | cut -f1
  for e in /enhancements/*/; do node "${e}apply.mjs" --list; done
} | sort -u > /tmp/changed
test -s /tmp/changed || { echo "ERROR: patches changed no files"; exit 1; }

mkdir -p /out
while read -r f; do
  test -f "/app/$f" || { echo "ERROR: $f missing after patching"; exit 1; }
  mkdir -p "/out/$(dirname "$f")"
  cp -a "/app/$f" "/out/$f"
  echo "    staged $f"
done < /tmp/changed
SH


FROM upstream AS final

COPY --from=patcher /out/ /app/

# The zigbee-ember enhancement runtime: just its sources and the per-platform native
# node_modules — tests and build tooling stay out of the runtime image (the test stage
# below overlays them). Inert unless the container runs with HOMEY_ZIGBEE_BACKEND=ember.
COPY enhancements/0001-zigbee-ember/package.json /app/enhancements/0001-zigbee-ember/package.json
COPY enhancements/0001-zigbee-ember/src/ /app/enhancements/0001-zigbee-ember/src/
COPY --from=zigbee-ember-deps /build/node_modules/ /app/enhancements/0001-zigbee-ember/node_modules/

# Everything below is upstream hygiene that the original Dockerfile omits entirely.
# No VOLUME: an anonymous volume on /homey/user would silently
# swallow activation state, and it cannot be removed downstream once declared.

# 4859 HTTP UI/API · 4860 HTTPS · 4861 Homey Bridge · 4862 Energy Dongle
# 8555 go2rtc WebRTC · 5353 mDNS.  go2rtc's API (1984) and RTSP (8554) stay on loopback.
EXPOSE 4859/tcp 4860/tcp 4861/tcp 4862/tcp 8555/tcp 8555/udp 5353/udp

# Upstream enables 22 debug namespaces, several dead on SHS (BluFi*, Bluez, GPIO,
# zigbee:*). This keeps the startup banner, setup, mDNS, the OTA check and all five
# daemon supervisors. Override at runtime to get the rest back.
ENV DEBUG="Server,Setup,Avahi*,Service:*,OTA"

# The image has no curl, wget, busybox or nc — only node. GET / returns 302 both before
# and after activation, so it works in either state; /api/manager/system/ping is 503
# until activated and is unusable here.
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD ["node", "-e", "const p=process.env.PORT_SERVER_HTTP||4859;fetch(`http://127.0.0.1:${p}/`,{redirect:'manual',signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.status<400?0:1)).catch(()=>process.exit(1))"]

LABEL org.opencontainers.image.base.name="ghcr.io/athombv/homey-shs" \
      org.opencontainers.image.base.digest="sha256:268b146973bddce7ee14ed5a5a8225a1b58419c15941f54916f352ff8015283f" \
      org.opencontainers.image.description="Homey Self-Hosted Server 13.4.1 with local patches and enhancements"


# `docker build --target test .` — runs the enhancement test suites inside the built
# image: unit tests, the compatibility-guard contract, image-level controller/manager
# tests, a native serial-binding load check, and both backend-selection paths.
FROM final AS test

# The full enhancement directory (tests, apply script, fixtures) exists only in this
# stage; node_modules persists from the final image underneath.
COPY enhancements/0001-zigbee-ember/ /app/enhancements/0001-zigbee-ember/

WORKDIR /app/enhancements/0001-zigbee-ember

RUN npm run test:unit \
  && npm run test:compatibility \
  && npm run test:image \
  && node -e \
    "const binding = require('@serialport/bindings-cpp').autoDetect(); if (!binding || typeof binding.open !== 'function') throw new Error('Native serial binding did not load')" \
  && node --conditions=typescript --input-type=module -e \
    "const m = await import('/app/apps/homey-shs/lib/ManagerZigbee.mts'); const b = await import('/app/apps/homey-shs/lib/ManagerZigbeeBridge.mts'); const s = await import('/app/apps/homey-shs/lib/System.mts'); if (m.ManagerZigbee !== b.ManagerZigbee) throw new Error('Original Bridge backend not selected by default'); if (s.System.prototype.hasZigbee.call({}) !== false) throw new Error('Bridge mode reported native Zigbee')" \
  && HOMEY_ZIGBEE_BACKEND=ember node --conditions=typescript --input-type=module -e \
    "const m = await import('/app/apps/homey-shs/lib/ManagerZigbee.mts'); const e = await import('/app/enhancements/0001-zigbee-ember/src/ManagerZigbeeEmber.mts'); const s = await import('/app/apps/homey-shs/lib/System.mts'); if (m.ManagerZigbee !== e.ManagerZigbeeEmber) throw new Error('Ember backend not selected'); if (s.System.prototype.hasZigbee.call({}) !== true) throw new Error('Ember mode did not report native Zigbee')"


# Default build target: the runnable image, so a plain `docker build .` never runs the
# test stage.
FROM final
