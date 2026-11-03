#!/usr/bin/env bash
set -euo pipefail

if [[ "${CI:-}" != "true" || "$(id -u)" -ne 0 ]]; then
  echo "This test is limited to an ephemeral CI runner and must run as root." >&2
  exit 1
fi

suffix="$(od -An -N5 -tx1 /dev/urandom | tr -d ' \n')"
worker="omnisw_${suffix}"
authorizer="omnisa_${suffix}"
api="omnisa_api_${suffix}"
launcher="omnissl_${suffix}"
worker_group="omniswg_${suffix}"
authorizer_group="omnisag_${suffix}"
socket_group="omnissg_${suffix}"
temp_root="$(mktemp -d /tmp/omnis-host-isolation.XXXXXX)"
chmod 0755 "$temp_root"
process_pids=()
helper_pids=()
users=()
groups=()

cleanup() {
  for pid in "${process_pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in "${helper_pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  done
  for user in "${users[@]}"; do userdel "$user" 2>/dev/null || true; done
  for group in "${groups[@]}"; do groupdel "$group" 2>/dev/null || true; done
  rm -rf -- "$temp_root"
}
trap cleanup EXIT

for group in "$worker_group" "$authorizer_group" "$socket_group"; do
  groupadd --system "$group"
  groups+=("$group")
done
useradd --system --no-create-home --shell /usr/sbin/nologin --gid "$worker_group" "$worker"
users+=("$worker")
useradd --system --no-create-home --shell /usr/sbin/nologin --gid "$authorizer_group" "$authorizer"
users+=("$authorizer")
useradd --system --no-create-home --shell /usr/sbin/nologin --gid "$authorizer_group" "$api"
users+=("$api")
useradd --system --no-create-home --shell /usr/sbin/nologin --gid "$socket_group" "$launcher"
users+=("$launcher")
usermod --append --groups "$socket_group" "$worker"
if getent group docker >/dev/null && [[ -S /var/run/docker.sock ]]; then
  usermod --append --groups docker "$launcher"
  if ! id -nG "$launcher" | tr ' ' '\n' | grep -qx docker; then
    echo "Disposable launcher did not receive the Docker group required by its sandbox role." >&2
    exit 1
  fi
fi

secret_root="$temp_root/etc/omnis"
install -d -o root -g root -m 0755 "$secret_root"
for item in "authorizer:$authorizer:$authorizer_group" "api:$api:$authorizer_group" "launcher:$launcher:$socket_group"; do
  IFS=: read -r name owner group <<< "$item"
  install -o "$owner" -g "$group" -m 0600 /dev/null "$secret_root/$name.env"
done

root_owned_app="$temp_root/opt/omnis/apps/authorizer"
install -d -o root -g root -m 0755 "$root_owned_app"
authorizer_dir="$temp_root/run/omnis-authorizer"
launcher_dir="$temp_root/run/omnis-launcher"
install -d -o "$authorizer" -g "$authorizer_group" -m 0750 "$authorizer_dir"
install -d -o "$launcher" -g "$socket_group" -m 0750 "$launcher_dir"

start_socket_server() {
  local service_user="$1" service_group="$2" socket_path="$3" pid_path="$4"
  install -o "$service_user" -g "$service_group" -m 0600 /dev/null "$pid_path"
  runuser -u "$service_user" -- env \
    OMNIS_TEST_SOCKET="$socket_path" \
    OMNIS_TEST_PID_FILE="$pid_path" \
    node --input-type=module -e '
      import { writeFileSync } from "node:fs";
      import { createServer } from "node:net";
      const server = createServer((socket) => socket.end("ok"));
      server.listen(process.env.OMNIS_TEST_SOCKET, () => {
        writeFileSync(process.env.OMNIS_TEST_PID_FILE, String(process.pid));
      });
      setInterval(() => {}, 1000);
      process.on("SIGTERM", () => server.close(() => process.exit(0)));
    ' >/dev/null 2>&1 &
  local runner_pid=$!
  helper_pids+=("$runner_pid")
  for _ in {1..50}; do
    if [[ -S "$socket_path" && -s "$pid_path" ]]; then
      process_pids+=("$(cat "$pid_path")")
      chgrp "$service_group" "$socket_path"
      chmod 0660 "$socket_path"
      return 0
    fi
    if ! kill -0 "$runner_pid" 2>/dev/null; then
      echo "Disposable $service_user socket listener failed to start." >&2
      return 1
    fi
    sleep 0.1
  done
  echo "Timed out starting disposable $service_user socket listener." >&2
  return 1
}

authorizer_socket="$authorizer_dir/authorizer.sock"
launcher_socket="$launcher_dir/launcher.sock"
start_socket_server "$authorizer" "$authorizer_group" "$authorizer_socket" "$temp_root/authorizer.pid"
start_socket_server "$launcher" "$socket_group" "$launcher_socket" "$temp_root/launcher.pid"

api_pid_file="$temp_root/api.pid"
install -o "$api" -g "$authorizer_group" -m 0600 /dev/null "$api_pid_file"
runuser -u "$api" -- env OMNIS_TEST_PID_FILE="$api_pid_file" \
  bash -c 'printf "%s" "$$" > "$OMNIS_TEST_PID_FILE"; exec sleep 60' >/dev/null 2>&1 &
helper_pids+=("$!")
for _ in {1..50}; do
  [[ -s "$api_pid_file" ]] && break
  sleep 0.1
done
[[ -s "$api_pid_file" ]] || { echo "Disposable API identity failed to start." >&2; exit 1; }
process_pids+=("$(cat "$api_pid_file")")

if id -nG "$worker" | tr ' ' '\n' | grep -qx docker; then
  echo "Disposable worker unexpectedly has Docker group membership." >&2
  exit 1
fi
if id -nG "$worker" | tr ' ' '\n' | grep -qx "$authorizer_group"; then
  echo "Disposable worker unexpectedly has authorizer group membership." >&2
  exit 1
fi

runuser -u "$worker" -- env \
  TEST_SECRET_ROOT="$secret_root" \
  TEST_AUTHOR_APP="$root_owned_app" \
  TEST_AUTHORIZER_SOCKET="$authorizer_socket" \
  TEST_LAUNCHER_SOCKET="$launcher_socket" \
  TEST_AUTHORIZER_PID="$(cat "$temp_root/authorizer.pid")" \
  TEST_API_PID="$(cat "$api_pid_file")" \
  TEST_LAUNCHER_PID="$(cat "$temp_root/launcher.pid")" \
  TEST_DOCKER_SOCKET=/var/run/docker.sock \
  bash -s <<'WORKER_PROBES'
set -euo pipefail
fail() { echo "Disposable worker identity probe failed: $1" >&2; exit 1; }
for secret in "$TEST_SECRET_ROOT/authorizer.env" "$TEST_SECRET_ROOT/api.env" "$TEST_SECRET_ROOT/launcher.env"; do
  [[ ! -r "$secret" ]] || fail "worker can read $secret"
done
[[ ! -w "$TEST_AUTHOR_APP" ]] || fail "worker can modify trusted executable files"
for pid in "$TEST_API_PID" "$TEST_AUTHORIZER_PID" "$TEST_LAUNCHER_PID"; do
  [[ ! -r "/proc/$pid/environ" ]] || fail "worker can inspect service process environment"
done

expect_socket_denied() {
  SOCKET_PATH="$1" node --input-type=module -e '
    import { createConnection } from "node:net";
    const socket = createConnection(process.env.SOCKET_PATH);
    socket.once("connect", () => { socket.destroy(); process.exitCode = 1; });
    socket.once("error", (error) => {
      if (error.code === "EACCES") process.exit(0);
      process.stderr.write("Unexpected socket denial result.\n");
      process.exit(2);
    });
    setTimeout(() => { socket.destroy(); process.exit(2); }, 2000).unref();
  ' || fail "worker connected to protected authorizer socket"
}
expect_socket_denied "$TEST_AUTHORIZER_SOCKET"
SOCKET_PATH="$TEST_LAUNCHER_SOCKET" node --input-type=module -e '
  import { createConnection } from "node:net";
  const socket = createConnection(process.env.SOCKET_PATH);
  let response = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => { response += chunk; });
  socket.once("end", () => { if (response !== "ok") process.exitCode = 1; });
  socket.once("error", () => { process.exitCode = 1; });
  setTimeout(() => { socket.destroy(); process.exitCode = 1; }, 2000).unref();
' || fail "worker could not use its restricted launcher socket"

if [[ -S "$TEST_DOCKER_SOCKET" ]]; then
  [[ ! -r "$TEST_DOCKER_SOCKET" && ! -w "$TEST_DOCKER_SOCKET" ]] || fail "worker can access Docker socket"
  expect_socket_denied "$TEST_DOCKER_SOCKET"
else
  fail "CI Docker socket is missing; Docker access was not tested"
fi
WORKER_PROBES

echo "Disposable Linux identities passed: worker denied authorizer/API/launcher secrets, trusted process environments, authorizer socket and Docker socket; restricted launcher socket remained available."
