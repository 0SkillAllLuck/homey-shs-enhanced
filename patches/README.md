# The patch series

**Applied in numeric order, and the order matters.** Four of them touch
`apps/homey-shs/index.mts` and three touch `apps/homey-shs/config.mts`; each patch's
context lines assume its predecessors are already in. A patch that does not apply exactly
fails the build.

## 0001: Restore the missing volume guard

Touches `apps/homey-shs/stdio-log.mts` and `apps/homey-shs/index.mts`.

`/homey/user` must be a mounted volume — the database, activation state, installed apps
and Matter data all live there. `index.mts` checks for it and exits 1, but that check is
dead code: by the time it runs, two things have already created the directory, so it can
never fail. A container started without a volume runs happily and writes all of its state
to the ephemeral container layer, losing everything when the container is replaced.

The patch removes both creators from the window before the check. The `stdio-log.mts`
preload (loaded via `--import`, so it runs before `index.mts` at all) no longer creates
the default log directory when `/homey/user` is absent — an explicit `HOMEY_LOG_PATH` or
`HOMEY_LOG_DIR` is left alone, and stdout/stderr are untouched either way, so the error
message still reaches the console. And the guard itself moves to the top of `index.mts`,
because the five daemons start before the old check location and `MatterDaemon.start()`
alone recursively creates two directories under `/homey/user`. The message gains two lines
saying what would be lost and how to mount the volume.

Behaviour change against the shipped image: volume-less throwaway runs now exit 1 instead
of appearing to work — which is upstream's own documented intent.

## 0002: Make the Matter sysctl writes loud and scoped

Touches `packages/homey-local/lib/MatterDaemon.mts`.

The Matter daemon writes three IPv6 sysctls per interface at startup; without them the
kernel installs no routes from router advertisements and Thread devices are unreachable.
`setSysctl()` resolves with `{ success, error, value }` and never rejects, so the
`.catch()` in the daemon's wrapper was dead code and every failure was silently discarded.
Under any runtime that mounts `/proc/sys` read-only — which is every unprivileged
container — Thread routing simply never works, with no error anywhere in the logs. The
patch makes the wrapper report whether the value ended up correct, and a failure now
produces one actionable `console.error` (deliberately not gated behind `DEBUG` namespaces,
and bounded by the daemon's restart limit) naming both remedies: grant `CAP_NET_ADMIN`
with `--security-opt systempaths=unconfined`, or set the three sysctls on the host.

The second problem is scope. `HOMEY_ETHERNET_INTERFACE` and `HOMEY_WIRELESS_INTERFACE`
are never configured on SHS, so the enumerate-every-interface fallback is what always
runs — and under the mandatory host networking that rewrites the host's IPv6
configuration on `docker0` and on the veth of every unrelated container, observed
directly during the analysis. Interface selection becomes: configured ethernet/wireless
(Homey Pro), else the `MATTER_MDNS_INTERFACES` allowlist, else all external interfaces
minus `docker*`, `veth*` and `br-*`. Repurposing `MATTER_MDNS_INTERFACES` is safe: it
previously reached the daemon only as `HOMEY_LISTEN_MDNS_IFACES`, a string neither
shipped daemon binary contains, so it was a complete no-op on SHS. The deny list does not
cover `virbr0`, `cni0`, `flannel.1` or `tap*`; the allowlist is the escape hatch for
those.

## 0003: Surface failed daemons

Touches `apps/homey-shs/config.mts` and `apps/homey-shs/index.mts`.

When avahi, the Matter daemon, rrdcached or go2rtc exhausts its restart budget,
`ChildProcessService` logs one line under a debug namespace and calls
`globalHooks.onStartFailure()` — which is registered nowhere in the image. The HTTP
server stays up, so every liveness and readiness probe stays green with a permanently
dead daemon, and nothing surfaces to the user.

The patch registers the hook upstream already built: a `console.error` naming the failed
service, independent of which `DEBUG` namespaces happen to be enabled. Setting
`HOMEY_EXIT_ON_SERVICE_FAILURE=1` additionally exits 1 so a container restart policy or
Kubernetes can recover the whole stack. That is off by default deliberately: a host that
already has UDP 5353 bound would otherwise crash-loop the server rather than run without
mDNS, which is worse.

## 0004: Cgroup-aware memory guard

Touches `packages/homey-local/lib/HomeyUtilLocal.mjs` and
`packages/homey-local/lib/ManagerSystemLocal.mjs`.

`/proc/meminfo` is not namespaced. Inside a container with a memory limit, the app memory
guard reads the *host's* free memory, keeps starting apps, and never engages its own
degradation path — until the kernel OOM-kills the container and the whole server dies
instead of one app being shed. Measured during the analysis: `MemTotal` 16 GiB against a
1 GiB `memory.max`.

Everything funnels through `HomeyUtilLocal.getMemoryInfo()`, the only `/proc/meminfo`
reader in the tree, so one clamp covers app-start gating, the 15-second low-memory
app-killer watchdog and both `/memory` API reports. `MemTotal` is clamped to the cgroup
limit and `MemAvailable` to `limit − current + inactive_file` — the same reclaimable
page-cache credit the kubelet uses for its working-set calculation, because counting that
memory as used would cause false app kills. Swap is clamped from `memory.swap.*` because
the app-start gate tests `MemAvailable + SwapFree`. cgroup v1 is handled as a fallback,
and everything fails open: `max`, v1's no-limit sentinel, disabled swap accounting or any
read error leaves the host values untouched, so Homey Pro on bare metal — which shares
this package — is unaffected. The cgroup directory is resolved from `/proc/self/cgroup`
rather than assumed to be the mount root: in a private cgroup namespace that file reads
`0::/` and `/sys/fs/cgroup` is already the container's own cgroup, but without cgroupns
isolation (observed on Talos/containerd) the container sees the host hierarchy, where the
root has no `memory.max` at all and the limit lives under the full
`/sys/fs/cgroup/kubepods/.../<container-id>` path. `ManagerSystemLocal.getInfo()` needs a second small edit
because it reported `os.totalmem()`/`os.freemem()`, which are node-wide too.

With this in place a memory limit becomes safe, and preferable, at roughly 1–2 GiB or
more; below ~1 GiB the 150 MB warning threshold would engage constantly.

## 0005: Keep go2rtc on loopback and make its ports configurable

Touches `packages/homey-local/lib/Go2rtcDaemon.mts`, `apps/homey-shs/config.mts` and
`apps/homey-shs/index.mts`.

The generated go2rtc config binds the API and RTSP listeners to `""` — every interface —
whenever `logToStdio` is set. So `GO2RTC_LOG_STDIO=1`, a *logging* flag, exposes go2rtc's
unauthenticated API (with `origin: "*"`) and its RTSP server to the entire LAN, given
that host networking is mandatory for this product. Nothing about logging requires a
different bind address, and the internal client only ever talks to
`http://127.0.0.1:<apiPort>`, so the patch pins both listeners to loopback
unconditionally. The flag still controls the go2rtc log level and stdio inheritance,
which is all it was meant to do.

Separately, `index.mts` hardcodes ports 1984 and 8554 while every other port in the image
is env-configurable. Those are also Frigate's defaults, so on a host-network node running
both, go2rtc fails to bind. The patch adds `PORT_GO2RTC_API` and `PORT_GO2RTC_RTSP` using
the existing zod preprocess idiom; the defaults are unchanged.

## 0006: Honour `HOMEY_LOCAL_ADDRESS` everywhere

Touches `packages/homey-local/lib/HomeyTypedUtilLocal.mts`,
`packages/homey-local/lib/Go2rtcDaemon.mts` and `apps/homey-shs/index.mts`.

`getOutboundIp()` opens a UDP socket toward 8.8.8.8 and reports whichever local address
the kernel picked. Under bridge or NAT networking that is the container's private IP,
which then appears in four user-visible places: the setup banner printed at startup,
`ManagerSystem.getInfo()`'s address and MAC, the `ipInternal` pushed to Athom's cloud —
which the mobile app and Homey Bridges use for direct local connections — and the ARP
sweep's subnet. `HOMEY_LOCAL_ADDRESS` exists as an override but is applied in only one of
those four places.

The patch moves the override into `getOutboundIp()`, fixing all four at once. When the
host genuinely owns the address, the real interface is returned so the netmask and MAC
stay correct — the useful case for pinning a NIC under host networking, or for macvlan.
Otherwise an interface entry is synthesized with a /24 and a MAC built from Docker's
locally-administered `02:42:` prefix; nothing in the product derives identity from the
MAC, as `homeyId` and serial come from cloud activation. An unset or malformed value
falls through to the original probe, so default behaviour is unchanged. go2rtc
additionally gets the address as an explicit WebRTC ICE candidate ahead of the `stun`
entry — go2rtc's own documented workaround for running behind NAT — gated on `net.isIPv4`
in the daemon, because a broken candidates list would fail go2rtc and turn an env-var
typo into a whole-server boot failure.

Scope, honestly: this makes a bridged deployment *addressable*. It does not restore mDNS,
SSDP, ARP discovery or Matter commissioning, which are link-local and still require host
networking or macvlan.

## 0007: `CAP_SYS_ADMIN` pre-flight for Python apps

Adds `packages/homey-local/lib/HomeyErrorMissingSysAdminCapability.mts`; touches
`packages/homey-local/lib/HomeyUtilLocal.mjs` and `packages/homey-local/lib/AppLocal.mts`.

Apps with `runtime: python` get a chroot jail assembled from ~9 real bind mounts, and
`mount(2)` needs `CAP_SYS_ADMIN`, which is not in Docker's default capability set. Today
that produces an infinite 10–120 second crash-restart loop whose only symptom is
`crashedMessage: "Error: Could not mount /python : 32"` — an errno, with the mount
command's stderr discarded.

The patch adds a start-time capability pre-flight: `hasCapSysAdmin()` parses `CapEff`
from `/proc/self/status` (a 64-bit mask, hence BigInt) and fails open on any read or
parse problem, so a working setup can never be blocked by it. When the capability is
missing, app start throws a named error carrying the exact Docker and Kubernetes flags,
which is surfaced as `crashedMessage` instead of a stack trace, and `restart: false`
stops the pointless restart loop. Mount errors also now append mount's own stderr when
there is any — the only useful clue in the other failure mode, where the capability is
present but an AppArmor profile denies the mount anyway.

Deliberately **not** done: an install-time pre-flight. App updates delete-then-reinstall,
and `install()`'s error path runs a recursive `rmdir` of the app directory *including*
`userdata/` — an install-time throw would destroy the user's app data, where today the
app merely crash-loops and is fully recoverable by adding the capability. The same hazard
exists on the boot-time "App Missing, redownloading" path after a backup restore.
Start-time is enough anyway, since every freshly installed app is started immediately.
Also not done: an `onCreateNotification` call — there is no translation key for it, and
adding one would surface a raw key in the UI; `crashedMessage` already carries the text.

## 0008: Honour `ATHOM_OTA_API_BASEURL`

Touches `apps/homey-shs/lib/ManagerUpdates.mts`.

`config.mts` declares `ATHOM_OTA_API_BASEURL` (default `https://ota-api.homeyshs.net`)
but `ManagerUpdates.getUpdate()` hardcodes the URL, so the variable is read nowhere in
the image — every other `ATHOM_*_BASEURL` is honoured. The patch builds the URL from
config; default behaviour is byte-identical. Matters for egress-filtered networks that
want to proxy or stub the daily update check.

## New environment variables

| Variable | Default | Patch |
|---|---|---|
| `HOMEY_EXIT_ON_SERVICE_FAILURE` | `0` | [0003](#0003-surface-failed-daemons) — exit(1) when a daemon gives up, so the restart policy recovers the stack |
| `PORT_GO2RTC_API` | `1984` | [0005](#0005-keep-go2rtc-on-loopback-and-make-its-ports-configurable) |
| `PORT_GO2RTC_RTSP` | `8554` | [0005](#0005-keep-go2rtc-on-loopback-and-make-its-ports-configurable) |

`MATTER_MDNS_INTERFACES` also gains a meaning:
[0002](#0002-make-the-matter-sysctl-writes-loud-and-scoped) repurposes it as the
allowlist for the sysctl loop. It was a complete no-op on SHS before.
