# Helm chart

Runs the image you build from this repo on Kubernetes. There is no default image and
never will be: the chart refuses to install without `image.repository`, because the only
image it may run is the one *you* built and pushed to a registry you control — see the
licensing note in the [repo README](../../README.md).

```sh
docker build -t registry.example.com/homey-shs-enhanced:13.4.1 ..   # from the repo root
docker push registry.example.com/homey-shs-enhanced:13.4.1

kubectl create namespace homey
kubectl -n homey create secret docker-registry regcred \
  --docker-server=registry.example.com --docker-username=... --docker-password=...

helm install homey ./charts/homey-shs-enhanced -n homey \
  --set image.repository=registry.example.com/homey-shs-enhanced \
  --set imagePullSecrets[0].name=regcred
```

[`values.yaml`](values.yaml) documents every knob; what follows is the reasoning behind
the defaults.

## Secure by default

The container runs with **every capability dropped except five, no privilege
escalation, a read-only root filesystem** (`/run` and `/tmp` become emptyDirs), the
runtime seccomp profile, no ServiceAccount token and no service-link env vars. The five
retained capabilities were bisected empirically against the real image, each proven
necessary: `SETUID`/`SETGID` (dbus and avahi shed privileges to their service users),
`SYS_CHROOT` and `CHOWN` (avahi's chroot jail and its runtime directory), and `KILL` —
without it the supervisor cannot signal the de-privileged daemons, so every shutdown
hangs into the SIGKILL timeout instead of stopping cleanly in about a second.

Two workloads legitimately need more:

- **Python-runtime apps** assemble a bind-mount jail and need `SYS_ADMIN` in
  `securityContext.capabilities.add`. Patch 0007 turns the missing capability into an
  actionable `crashedMessage` naming the exact flag, so nothing fails silently.
- **Thread** needs three IPv6 sysctls that no unprivileged container may write. Set
  them on the node and ignore the startup warning — patch 0002 prints the exact
  `net.ipv6.conf.*` list instead of failing silently.

Two patch-provided behaviours are on by default because Kubernetes is exactly what they
were built for: `HOMEY_EXIT_ON_SERVICE_FAILURE=1` (patch 0003 — a daemon that exhausts
its restart budget takes the pod down so Kubernetes restarts it, instead of idling
behind green probes) and a 2Gi memory limit (patch 0004 — the server sees the cgroup
limit and sheds apps before the kernel OOM-kills the whole pod; keep at least 1Gi).

## Networking

The default keeps the pod in the cluster network. The web UI, API, WebRTC and Homey
Bridge satellites all work through the Service; set `service.type=LoadBalancer` and
point `homey.localAddress` at the LB address — patch 0006 makes the server advertise it
to the mobile app, the Bridges and WebRTC, which is what makes a NATed pod addressable.

What the cluster network cannot give you is link-local traffic: mDNS/SSDP/ARP discovery
and Matter. For those set `hostNetwork=true` on a LAN-attached node (and see the
`homey.exitOnServiceFailure` note in values.yaml if that node already runs an mDNS
daemon). An `ingress` covers browser access to the UI only — the app and Bridges keep
talking to the Service ports.

## Zigbee (enhancement 0001)

`zigbee.enabled=true` plus a `zigbee.device` in one of three forms, ordered by how much
privilege they cost:

| Form | Privileges |
|---|---|
| `tcp://host:9998` — ser2net/socat wherever the stick is | none |
| device-plugin resource via `zigbee.deviceResource` | none, needs a plugin (e.g. [generic-device-plugin](https://github.com/squat/generic-device-plugin)) |
| `/dev/serial/by-id/...` hostPath on the node | the container turns `privileged` |

With the hostPath form, pin the pod to the stick's node via `nodeSelector`. Baudrate,
flow control and channel keep the enhancement's defaults unless set.

## State

`/homey/user` — database, activation, apps, Matter and Zigbee networks — lives in one
PVC. Patch 0001 makes the server exit rather than run without a volume, the chart has
no emptyDir escape hatch for the same reason, the Deployment uses `Recreate` so two
pods can never share the database, and the PVC carries `helm.sh/resource-policy: keep`
so `helm uninstall` leaves your Homey's state behind. Back it up like the irreplaceable
thing it is.
