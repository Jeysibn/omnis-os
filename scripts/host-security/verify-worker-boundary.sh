#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this verification as root; probes execute as omnis-worker." >&2
  exit 1
fi

for identity in omnis-worker omnis-authorizer omnis-api omnis-launcher; do
  id "$identity" >/dev/null 2>&1 || {
    echo "Missing service identity: $identity. Run the reviewed identity setup first." >&2
    exit 1
  }
done

if id -nG omnis-worker | tr ' ' '\n' | grep -qx docker; then
  echo "omnis-worker is a member of the rootful docker group." >&2
  exit 1
fi
if id -nG omnis-worker | tr ' ' '\n' | grep -qx omnis-authorizer-socket; then
  echo "omnis-worker is a member of the authorizer socket group." >&2
  exit 1
fi

authorizer_pid="$(systemctl show --property MainPID --value omnis-authorizer.service)"
api_pid="$(systemctl show --property MainPID --value omnis-api.service)"
launcher_pid="$(systemctl show --property MainPID --value omnis-sandbox-launcher.service)"
for service_pid in "$authorizer_pid" "$api_pid" "$launcher_pid"; do
  if [[ ! "$service_pid" =~ ^[1-9][0-9]*$ ]]; then
    echo "A trusted service is not running; process-environment isolation cannot be checked." >&2
    exit 1
  fi
done
if [[ ! -S /run/omnis-authorizer/authorizer.sock ]]; then
  echo "The protected authorizer socket is missing." >&2
  exit 1
fi

runuser -u omnis-worker -- env \
  OMNIS_AUTHORITATIVE_PID="$authorizer_pid" \
  OMNIS_API_PID="$api_pid" \
  OMNIS_LAUNCHER_PID="$launcher_pid" \
  bash -s <<'WORKER_CHECKS'
set -euo pipefail
fail() { echo "Worker boundary verification failed: $1" >&2; exit 1; }

for secret in /etc/omnis/authorizer.env /etc/omnis/api.env /etc/omnis/sandbox-launcher.env; do
  [[ ! -r "$secret" ]] || fail "worker can read $secret"
done
[[ ! -x /run/omnis-authorizer ]] || fail "worker can traverse /run/omnis-authorizer"
[[ ! -r "/proc/$OMNIS_AUTHORITATIVE_PID/environ" ]] || fail "worker can read authorizer process environment"
[[ ! -r "/proc/$OMNIS_API_PID/environ" ]] || fail "worker can read API process environment"
[[ ! -r "/proc/$OMNIS_LAUNCHER_PID/environ" ]] || fail "worker can read launcher process environment"
for application in api authorizer sandbox-launcher; do
  [[ ! -w "/opt/omnis-os/apps/$application" ]] || fail "worker can modify $application application files"
done
[[ ! -r /var/run/docker.sock && ! -w /var/run/docker.sock ]] || fail "worker can access the Docker socket"

node --input-type=module -e '
  import { createConnection } from "node:net";
  const socketPath = "/run/omnis-authorizer/authorizer.sock";
  const socket = createConnection(socketPath);
  socket.once("connect", () => { socket.destroy(); process.exitCode = 1; });
  socket.once("error", (error) => {
    if (error.code === "EACCES" || error.code === "ENOENT") process.exit(0);
    process.stderr.write("Unexpected authorizer socket probe error.\n");
    process.exit(2);
  });
  setTimeout(() => { socket.destroy(); process.exit(2); }, 2000).unref();
' || fail "worker connected to the authorizer socket"

echo "Worker secret, process, executable, authorizer-socket, and Docker-socket probes were denied."
WORKER_CHECKS
