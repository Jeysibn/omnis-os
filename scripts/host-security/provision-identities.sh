#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this opt-in host setup as root after reviewing the service identity plan." >&2
  exit 1
fi
if ! getent group docker >/dev/null; then
  echo "The rootful Docker group is unavailable; configure a reviewed launcher runtime first." >&2
  exit 1
fi

record_created() {
  local kind="$1" value="$2"
  if [[ -n "${OMNIS_RESOURCE_MANIFEST:-}" ]]; then
    printf '%s\t%s\n' "$kind" "$value" >> "$OMNIS_RESOURCE_MANIFEST"
  fi
}

for group in omnis-api omnis-authorizer omnis-worker omnis-launcher omnis-authorizer-socket omnis-launcher-socket omnis-broker-gateway omnis-broker-ingress-gateway omnis-broker-gateway-socket omnis-broker-ingress-socket omnis-broker-ingress-callers omnis-broker-gateway-token omnis-synthetic-broker; do
  if ! getent group "$group" >/dev/null; then
    groupadd --system "$group"
    record_created group "$group"
  fi
done
for user in omnis-api omnis-authorizer omnis-worker omnis-launcher omnis-broker-gateway omnis-broker-ingress-gateway omnis-synthetic-broker; do
  if ! id "$user" >/dev/null 2>&1; then
    useradd --system --no-user-group --no-create-home --shell /usr/sbin/nologin "$user"
    record_created user "$user"
  fi
done
usermod --gid omnis-api omnis-api
usermod --gid omnis-authorizer omnis-authorizer
usermod --gid omnis-worker omnis-worker
usermod --gid omnis-launcher omnis-launcher
usermod --gid omnis-broker-gateway omnis-broker-gateway
usermod --gid omnis-broker-ingress-gateway omnis-broker-ingress-gateway
usermod --gid omnis-synthetic-broker omnis-synthetic-broker
usermod --groups omnis-authorizer-socket omnis-api
usermod --groups omnis-authorizer-socket,omnis-broker-gateway-socket omnis-authorizer
usermod --groups omnis-launcher-socket omnis-worker
usermod --groups omnis-launcher-socket,docker omnis-launcher
usermod --groups omnis-launcher-socket,omnis-broker-ingress-callers omnis-worker
usermod --groups omnis-broker-gateway-socket omnis-broker-gateway
usermod --groups omnis-broker-ingress-socket,omnis-broker-gateway-token omnis-broker-ingress-gateway
usermod --groups omnis-broker-ingress-socket omnis-synthetic-broker

install -d -o root -g root -m 0755 /etc/omnis
record_created directory /etc/omnis
install -d -o omnis-authorizer -g omnis-authorizer-socket -m 0750 /run/omnis-authorizer
record_created directory /run/omnis-authorizer
install -d -o omnis-authorizer -g omnis-broker-gateway-socket -m 0750 /run/omnis-broker-authorizer
record_created directory /run/omnis-broker-authorizer
install -d -o omnis-launcher -g omnis-launcher-socket -m 0750 /run/omnis-sandbox
record_created directory /run/omnis-sandbox
install -d -o omnis-launcher -g omnis-launcher -m 0700 /var/lib/omnis-sandbox/workspaces
record_created directory /var/lib/omnis-sandbox
record_created directory /var/lib/omnis-sandbox/workspaces
echo "Created Omnis service identities. Broker gateway has no Docker group; only launcher is in docker."
echo "Install reviewed service-specific environment files and systemd units separately; this script does not enable or start services."
