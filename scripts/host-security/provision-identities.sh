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

for group in omnis-api omnis-authorizer omnis-worker omnis-launcher omnis-authorizer-socket omnis-launcher-socket; do
  getent group "$group" >/dev/null || groupadd --system "$group"
done
for user in omnis-api omnis-authorizer omnis-worker omnis-launcher; do
  id "$user" >/dev/null 2>&1 || useradd --system --no-user-group --no-create-home --shell /usr/sbin/nologin "$user"
done
usermod --gid omnis-api omnis-api
usermod --gid omnis-authorizer omnis-authorizer
usermod --gid omnis-worker omnis-worker
usermod --gid omnis-launcher omnis-launcher
usermod --groups omnis-authorizer-socket omnis-api
usermod --groups omnis-authorizer-socket omnis-authorizer
usermod --groups omnis-launcher-socket omnis-worker
usermod --groups omnis-launcher-socket,docker omnis-launcher

install -d -o root -g root -m 0755 /etc/omnis
install -d -o omnis-authorizer -g omnis-authorizer-socket -m 0750 /run/omnis-authorizer
install -d -o omnis-launcher -g omnis-launcher-socket -m 0750 /run/omnis-sandbox
install -d -o omnis-launcher -g omnis-launcher -m 0700 /var/lib/omnis-sandbox/workspaces
echo "Created Omnis service identities. Worker and launcher share only omnis-launcher-socket; only launcher is in docker."
echo "Install reviewed service-specific environment files and systemd units separately; this script does not enable or start services."
