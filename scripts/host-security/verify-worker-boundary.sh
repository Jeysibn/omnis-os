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

worker_groups="$(id -nG omnis-worker | tr ' ' '\n')"
for forbidden_group in docker omnis-authorizer-socket omnis-api omnis-authorizer omnis-launcher; do
  if grep -qx "$forbidden_group" <<<"$worker_groups"; then
    echo "omnis-worker must not belong to $forbidden_group." >&2
    exit 1
  fi
done
grep -qx omnis-launcher-socket <<<"$worker_groups" || {
  echo "omnis-worker is missing the narrow launcher socket group." >&2
  exit 1
}
expected_worker_groups="$(printf '%s\n' omnis-worker omnis-launcher-socket | sort)"
actual_worker_groups="$(printf '%s\n' "$worker_groups" | sort)"
[[ "$actual_worker_groups" == "$expected_worker_groups" ]] || {
  echo "omnis-worker has unexpected supplementary group membership." >&2
  exit 1
}
[[ "$(id -gn omnis-launcher)" == omnis-launcher ]] || {
  echo "omnis-launcher must use its private primary group." >&2
  exit 1
}
id -nG omnis-launcher | tr ' ' '\n' | grep -qx omnis-launcher-socket || {
  echo "omnis-launcher is missing its narrow socket supplementary group." >&2
  exit 1
}
expected_launcher_groups="$(printf '%s\n' omnis-launcher docker omnis-launcher-socket | sort)"
actual_launcher_groups="$(id -nG omnis-launcher | tr ' ' '\n' | sort)"
[[ "$actual_launcher_groups" == "$expected_launcher_groups" ]] || {
  echo "omnis-launcher has unexpected supplementary group membership." >&2
  exit 1
}
for identity in omnis-api omnis-authorizer; do
  [[ "$(id -gn "$identity")" == "$identity" ]] || {
    echo "$identity must use its private primary group." >&2
    exit 1
  }
  expected_groups="$(printf '%s\n' "$identity" omnis-authorizer-socket | sort)"
  actual_groups="$(id -nG "$identity" | tr ' ' '\n' | sort)"
  [[ "$actual_groups" == "$expected_groups" ]] || {
    echo "$identity has unexpected supplementary group membership." >&2
    exit 1
  }
done

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
if [[ ! -S /run/omnis-sandbox/launcher.sock ]]; then
  echo "The restricted launcher socket is missing." >&2
  exit 1
fi
[[ "$(stat -c '%U:%G:%a' /run/omnis-sandbox/launcher.sock)" == "omnis-launcher:omnis-launcher-socket:660" ]] || {
  echo "Launcher socket owner, group, or mode differs from the approved policy." >&2
  exit 1
}
[[ "$(stat -c '%U:%G:%a' /run/omnis-authorizer/authorizer.sock)" == "omnis-authorizer:omnis-authorizer-socket:660" ]] || {
  echo "Authorizer socket owner, group, or mode differs from the approved policy." >&2
  exit 1
}

for trusted_parent in / /opt /opt/omnis-os; do
  [[ "$(stat -c '%U' "$trusted_parent")" == root ]] || {
    echo "Trusted code parent is not root-owned: $trusted_parent" >&2
    exit 1
  }
  parent_mode="$(stat -c '%a' "$trusted_parent")"
  if (( (8#$parent_mode & 0022) != 0 )); then
    echo "Trusted code parent has group/world write permissions: $trusted_parent" >&2
    exit 1
  fi
done
for trusted_parent in /usr /usr/bin /etc/omnis /etc/systemd /etc/systemd/system; do
  [[ "$(stat -c '%U' "$trusted_parent")" == root ]] || {
    echo "Trusted executable or secret parent is not root-owned: $trusted_parent" >&2
    exit 1
  }
  parent_mode="$(stat -c '%a' "$trusted_parent")"
  if (( (8#$parent_mode & 0022) != 0 )); then
    echo "Trusted executable or secret parent has group/world write permissions: $trusted_parent" >&2
    exit 1
  fi
done
for unit in omnis-api.service omnis-authorizer.service omnis-worker.service omnis-sandbox-launcher.service; do
  unit_path="/etc/systemd/system/$unit"
  [[ -f "$unit_path" && "$(stat -c '%U:%G:%a' "$unit_path")" == root:root:644 ]] || {
    echo "Missing or incorrectly permissioned systemd unit: $unit_path" >&2
    exit 1
  }
done
[[ "$(stat -c '%U:%G:%a' /run/omnis-authorizer)" == "omnis-authorizer:omnis-authorizer-socket:750" ]] || {
  echo "Authorizer socket directory owner, group, or mode differs from the approved policy." >&2
  exit 1
}
[[ "$(stat -c '%U:%G:%a' /run/omnis-sandbox)" == "omnis-launcher:omnis-launcher-socket:750" ]] || {
  echo "Launcher socket directory owner, group, or mode differs from the approved policy." >&2
  exit 1
}
if find /opt/omnis-os -xdev \( ! -user root -o \( ! -type l -a -perm /022 \) \) -print -quit | grep -q .; then
  echo "Application tree contains a non-root-owned or group/world-writable entry." >&2
  exit 1
fi
while IFS= read -r -d '' link; do
  resolved="$(realpath -e -- "$link")" || {
    echo "Application tree contains a broken symlink: $link" >&2
    exit 1
  }
  case "$resolved" in
    /opt/omnis-os|/opt/omnis-os/*) ;;
    *) echo "Application symlink escapes protected tree: $link" >&2; exit 1 ;;
  esac
done < <(find /opt/omnis-os -xdev -type l -print0)
node_path="$(realpath -e /usr/bin/node)"
[[ "$(stat -c '%U' "$node_path")" == root ]] || {
  echo "Node executable is writable by the worker or not root-owned." >&2
  exit 1
}
node_mode="$(stat -c '%a' "$node_path")"
if (( (8#$node_mode & 0022) != 0 )); then
  echo "Node executable has group/world write permissions." >&2
  exit 1
fi
for item in "api:omnis-api" "authorizer:omnis-authorizer" "worker:omnis-worker" "sandbox-launcher:omnis-launcher"; do
  IFS=: read -r name owner <<<"$item"
  secret="/etc/omnis/$name.env"
  [[ -f "$secret" && "$(stat -c '%U:%G:%a' "$secret")" == "$owner:$owner:600" ]] || {
    echo "Missing or incorrectly owned/permissioned service secret: $secret" >&2
    exit 1
  }
done
[[ "$(stat -c '%U:%G:%a' /var/lib/omnis-sandbox/workspaces)" == "omnis-launcher:omnis-launcher:700" ]] || {
  echo "Launcher workspace root owner or mode differs from the private policy." >&2
  exit 1
}

runuser -u omnis-worker -- env \
  OMNIS_AUTHORITATIVE_PID="$authorizer_pid" \
  OMNIS_API_PID="$api_pid" \
  OMNIS_LAUNCHER_PID="$launcher_pid" \
  bash -s <<'WORKER_CHECKS'
set -euo pipefail
fail() { echo "Worker boundary verification failed: $1" >&2; exit 1; }

for parent in / /opt /opt/omnis-os; do
  [[ ! -w "$parent" ]] || fail "worker can modify trusted code parent $parent"
done
for parent in /usr /usr/bin /etc/omnis /etc/systemd /etc/systemd/system; do
  [[ ! -w "$parent" ]] || fail "worker can modify trusted executable or secret parent $parent"
done
[[ ! -w /usr/bin/node ]] || fail "worker can modify the Node executable"

for secret in /etc/omnis/authorizer.env /etc/omnis/api.env /etc/omnis/sandbox-launcher.env; do
  [[ ! -r "$secret" ]] || fail "worker can read $secret"
done
[[ ! -x /run/omnis-authorizer ]] || fail "worker can traverse /run/omnis-authorizer"
[[ ! -r "/proc/$OMNIS_AUTHORITATIVE_PID/environ" ]] || fail "worker can read authorizer process environment"
[[ ! -r "/proc/$OMNIS_API_PID/environ" ]] || fail "worker can read API process environment"
[[ ! -r "/proc/$OMNIS_LAUNCHER_PID/environ" ]] || fail "worker can read launcher process environment"
while IFS= read -r -d '' protected_path; do
  [[ ! -w "$protected_path" ]] || fail "worker can modify protected application path $protected_path"
done < <(find /opt/omnis-os -xdev -print0)
[[ ! -r /var/run/docker.sock && ! -w /var/run/docker.sock ]] || fail "worker can access the Docker socket"
[[ ! -r /var/lib/omnis-sandbox/workspaces && ! -x /var/lib/omnis-sandbox/workspaces ]] || fail "worker can access launcher workspaces"

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

echo "Worker cannot read service secrets or trusted environments/code, enter authorizer/workspace paths, use Docker, or access authorizer socket; launcher socket permissions are restricted to the worker-launcher group."
WORKER_CHECKS
