#!/usr/bin/env bash
set -euo pipefail

if [[ "${CI:-}" != true || "${OMNIS_HOST_ISOLATION_TEST:-}" != true || "$(id -u)" -ne 0 ]]; then
  echo "Refusing host provisioning: this probe requires an explicitly enabled ephemeral CI runner and root." >&2
  exit 1
fi
systemd_state="$(systemctl is-system-running 2>/dev/null || true)"
if [[ "$(ps -p 1 -o comm= | tr -d ' ')" != systemd ]] || [[ "$systemd_state" != active && "$systemd_state" != degraded ]]; then
  echo "SKIP: the CI environment does not provide a running systemd PID 1. No identities or services were changed."
  exit 0
fi
if [[ ! -S /var/run/docker.sock ]] || ! systemctl is-active --quiet docker.service; then
  echo "SKIP: the disposable runner Docker daemon is not available as an active systemd service."
  exit 0
fi
for user in omnis-api omnis-authorizer omnis-worker omnis-launcher; do
  if id "$user" >/dev/null 2>&1; then echo "Refusing to replace existing identity $user." >&2; exit 1; fi
done
for group in omnis-api omnis-authorizer omnis-worker omnis-launcher omnis-authorizer-socket omnis-launcher-socket; do
  if getent group "$group" >/dev/null; then echo "Refusing to reuse existing group $group." >&2; exit 1; fi
done
for path in /opt/omnis-os /etc/omnis /var/lib/omnis-sandbox /run/omnis-authorizer /run/omnis-sandbox; do
  if [[ -e "$path" || -L "$path" ]]; then echo "Refusing to replace existing host path $path." >&2; exit 1; fi
done
for unit in omnis-api.service omnis-authorizer.service omnis-worker.service omnis-sandbox-launcher.service; do
  if systemctl list-unit-files "$unit" --no-legend | grep -q . || systemctl is-active --quiet "$unit"; then
    echo "Refusing to replace existing systemd unit $unit." >&2
    exit 1
  fi
done
if [[ ! -d /opt || -L /opt || "$(stat -c '%U' /opt)" != root ]]; then
  echo "The disposable runner /opt must be a real root-owned directory." >&2
  exit 1
fi
original_opt_mode="$(stat -c '%a' /opt)"
created_node_runtime=0

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
unit_dir=/etc/systemd/system
units=(omnis-api.service omnis-authorizer.service omnis-worker.service omnis-sandbox-launcher.service)
created_envs=(.env .env.worker .env.authorizer .env.sandbox-launcher)
cleanup() {
  local cleanup_failed=0
  systemctl stop "${units[@]}" >/dev/null 2>&1 || true
  for unit in "${units[@]}"; do
    if systemctl is-active --quiet "$unit"; then
      systemctl kill --kill-who=all --signal=KILL "$unit" >/dev/null 2>&1 || true
      systemctl stop "$unit" >/dev/null 2>&1 || cleanup_failed=1
    fi
  done
  rm -f -- "${units[@]/#/$unit_dir/}"
  systemctl daemon-reload >/dev/null 2>&1 || true
  rm -rf -- /opt/omnis-os /etc/omnis /var/lib/omnis-sandbox /run/omnis-authorizer /run/omnis-sandbox
  rm -f -- "${created_envs[@]/#/$repo_root/}"
  for user in omnis-api omnis-authorizer omnis-worker omnis-launcher; do
    if id "$user" >/dev/null 2>&1; then
      pkill -KILL -u "$user" >/dev/null 2>&1 || true
      userdel "$user" >/dev/null 2>&1 || cleanup_failed=1
    fi
  done
  for group in omnis-api omnis-authorizer omnis-worker omnis-launcher omnis-authorizer-socket omnis-launcher-socket; do
    if getent group "$group" >/dev/null 2>&1; then
      groupdel "$group" >/dev/null 2>&1 || cleanup_failed=1
    fi
  done
  chmod "$original_opt_mode" /opt || cleanup_failed=1
  if (( created_node_runtime != 0 )); then
    rm -f /usr/bin/node || cleanup_failed=1
  fi
  if (( cleanup_failed != 0 )); then
    echo "Disposable systemd cleanup could not remove every created service resource." >&2
    exit 1
  fi
}
trap cleanup EXIT

# GitHub's setup-node installs Node under the runner tool cache, while the
# reviewed production units intentionally use the standard OS runtime path.
# On this explicitly disposable runner only, provide that standard path when
# it is absent. Never replace an existing host Node installation.
if [[ ! -e /usr/bin/node && ! -L /usr/bin/node ]]; then
  node_source="${OMNIS_TEST_NODE_EXECUTABLE:-}"
  if [[ -z "$node_source" || ! -x "$node_source" || "$("$node_source" --version)" != v24.* ]]; then
    echo "The disposable runner requires the repository's supported Node 24 runtime." >&2
    exit 1
  fi
  node_source="$(realpath -e "$node_source")"
  install -o root -g root -m 0755 "$node_source" /usr/bin/node
  created_node_runtime=1
fi
if [[ ! -x /usr/bin/node || "$(/usr/bin/node --version)" != v24.* || "$(stat -c '%U' "$(realpath -e /usr/bin/node)")" != root ]]; then
  echo "The disposable systemd probe requires a root-owned Node 24 executable at /usr/bin/node; existing host runtime was left untouched." >&2
  exit 1
fi

# Hosted runners may ship /opt as root-owned but group-writable. Narrow only
# this disposable CI parent for the duration of the probe; restore its mode on
# every exit. Production installation continues to reject unsafe /opt paths.
chmod 0755 /opt

for port in 4100 4101; do
  if ss -ltn "sport = :$port" | tail -n +2 | grep -q .; then
    echo "Refusing to start Omnis services because TCP port $port is already in use." >&2
    exit 1
  fi
done
for env_file in .env .env.worker .env.authorizer .env.sandbox-launcher; do
  if [[ -e "$repo_root/$env_file" || -L "$repo_root/$env_file" ]]; then
    echo "Refusing to overwrite pre-existing local secret file $env_file." >&2
    exit 1
  fi
done

bash "$repo_root/scripts/host-security/provision-identities.sh"
bash "$repo_root/scripts/host-security/install-application-tree.sh"
OMNIS_MIGRATION_DATABASE_URL="$OMNIS_TEST_MIGRATION_DATABASE_URL" \
  node --experimental-strip-types "$repo_root/apps/worker/src/migrate.ts"

owner_password='synthetic-host-isolation-owner-2026'
owner_hash="$(node --input-type=module -e 'import { randomBytes, scryptSync } from "node:crypto"; const salt = randomBytes(16); process.stdout.write(`${salt.toString("hex")}:${scryptSync(process.argv[1], salt, 64).toString("hex")}`);' "$owner_password")"
session_secret="$(od -An -N48 -tx1 /dev/urandom | tr -d ' \n')"
worker_token="$(od -An -N48 -tx1 /dev/urandom | tr -d ' \n')"
authorizer_token="$(od -An -N48 -tx1 /dev/urandom | tr -d ' \n')"

cat > "$repo_root/.env" <<EOF
OMNIS_OWNER_PASSWORD_HASH=$owner_hash
OMNIS_SESSION_SECRET=$session_secret
OMNIS_INTERNAL_TOKEN=$worker_token
OMNIS_API_AUTHORIZER_TOKEN=$authorizer_token
OMNIS_API_HOST=127.0.0.1
OMNIS_API_PORT=4100
OMNIS_AUTHORIZER_SOCKET=/run/omnis-authorizer/authorizer.sock
OMNIS_ALLOWED_ORIGIN=http://127.0.0.1:5173
OMNIS_SECURE_COOKIES=false
EOF
cat > "$repo_root/.env.worker" <<EOF
OMNIS_INTERNAL_TOKEN=$worker_token
OMNIS_RUNTIME_DB_PASSWORD=$OMNIS_RUNTIME_DB_PASSWORD
OMNIS_DATABASE_URL=$OMNIS_TEST_DATABASE_URL
OMNIS_WORKER_HOST=127.0.0.1
OMNIS_WORKER_PORT=4101
OMNIS_SANDBOX_LAUNCHER_SOCKET=/run/omnis-sandbox/launcher.sock
OMNIS_QUEUE_NAME=omnis-mock-run
EOF
cat > "$repo_root/.env.authorizer" <<EOF
OMNIS_API_AUTHORIZER_TOKEN=$authorizer_token
OMNIS_AUTHORIZER_DB_PASSWORD=$OMNIS_AUTHORIZER_DB_PASSWORD
OMNIS_AUTHORIZER_DATABASE_URL=$OMNIS_TEST_AUTHORIZER_DATABASE_URL
OMNIS_AUTHORIZER_SOCKET=/run/omnis-authorizer/authorizer.sock
OMNIS_AUTHORIZER_SOCKET_MODE=660
EOF
cat > "$repo_root/.env.sandbox-launcher" <<EOF
OMNIS_LAUNCHER_DB_PASSWORD=$OMNIS_LAUNCHER_DB_PASSWORD
OMNIS_LAUNCHER_DATABASE_URL=$OMNIS_TEST_LAUNCHER_DATABASE_URL
OMNIS_SANDBOX_LAUNCHER_SOCKET=/run/omnis-sandbox/launcher.sock
OMNIS_SANDBOX_LAUNCHER_SOCKET_MODE=660
OMNIS_SANDBOX_WORKSPACE_ROOT=/var/lib/omnis-sandbox/workspaces
EOF
chmod 0600 "${created_envs[@]/#/$repo_root/}"
bash "$repo_root/scripts/host-security/install-service-secrets.sh"

for unit in "${units[@]}"; do
  install -o root -g root -m 0644 "$repo_root/infra/systemd/$unit" "$unit_dir/$unit"
done
systemctl daemon-reload
if ! systemctl start omnis-sandbox-launcher.service omnis-authorizer.service omnis-api.service omnis-worker.service; then
  systemctl --no-pager --full status "${units[@]}" >&2 || true
  journalctl -u omnis-api -u omnis-authorizer -u omnis-worker -u omnis-sandbox-launcher --no-pager -n 120 >&2 || true
  echo "Disposable Omnis systemd services failed during startup." >&2
  exit 1
fi

for _ in {1..50}; do
  if curl --silent --fail http://127.0.0.1:4100/api/v1/health >/dev/null &&
    [[ -S /run/omnis-authorizer/authorizer.sock && -S /run/omnis-sandbox/launcher.sock ]]; then
    break
  fi
  sleep 0.2
done
curl --silent --fail http://127.0.0.1:4100/api/v1/health >/dev/null || {
  systemctl --no-pager --full status "${units[@]}" >&2 || true
  journalctl -u omnis-api -u omnis-authorizer -u omnis-worker -u omnis-sandbox-launcher --no-pager -n 120 >&2 || true
  echo "Systemd Omnis services did not become healthy." >&2
  exit 1
}

bash "$repo_root/scripts/host-security/verify-worker-boundary.sh"

OMNIS_TEST_API_URL=http://127.0.0.1:4100 \
OMNIS_TEST_OWNER_PASSWORD="$owner_password" \
/usr/bin/node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = process.env.OMNIS_TEST_API_URL;
const origin = 'http://127.0.0.1:5173';
async function expectStatus(response, expected) {
  if (response.status === expected) return;
  const body = await response.text().catch(() => '<response body unavailable>');
  throw new Error(`Expected HTTP ${expected}, got ${response.status}: ${body}`);
}

const csrfResponse = await fetch(`${base}/api/v1/auth/csrf`);
const csrfCookie = csrfResponse.headers.get('set-cookie')?.split(';', 1)[0];
assert.ok(csrfCookie, 'API did not issue the anonymous CSRF session cookie');
const csrf = (await csrfResponse.json()).csrfToken;
const login = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST', headers: { cookie: csrfCookie, origin, 'x-omnis-csrf': csrf, 'content-type': 'application/json' },
  body: JSON.stringify({ password: process.env.OMNIS_TEST_OWNER_PASSWORD }),
});
await expectStatus(login, 200);
const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
assert.ok(cookie, 'API did not issue the owner session cookie');
const ownerCsrfResponse = await fetch(`${base}/api/v1/auth/csrf`, { headers: { cookie } });
const ownerCsrf = (await ownerCsrfResponse.json()).csrfToken;
const mutationHeaders = { cookie, origin, 'x-omnis-csrf': ownerCsrf, 'content-type': 'application/json' };
const taskResponse = await fetch(`${base}/api/v1/tasks`, {
  method: 'POST', headers: mutationHeaders,
  body: JSON.stringify({ title: `Host isolation synthetic ${randomUUID()}`, detail: 'CI disposable systemd verification.' }),
});
await expectStatus(taskResponse, 201);
const task = await taskResponse.json();
const idempotencyKey = randomUUID();
const request = await fetch(`${base}/api/v1/authorizations`, {
  method: 'POST', headers: { ...mutationHeaders, 'idempotency-key': idempotencyKey },
  body: JSON.stringify({ taskId: task.id }),
});
await expectStatus(request, 201);
const authorization = await request.json();
const approval = await fetch(`${base}/api/v1/authorizations/${authorization.id}/decision`, {
  method: 'POST', headers: mutationHeaders, body: JSON.stringify({ decision: 'approve' }),
});
await expectStatus(approval, 200);
const approved = await approval.json();
const runResponse = await fetch(`${base}/api/v1/runs`, {
  method: 'POST', headers: { ...mutationHeaders, 'idempotency-key': randomUUID() },
  body: JSON.stringify({ taskId: task.id, authorizationId: approved.id }),
});
await expectStatus(runResponse, 201);
const run = await runResponse.json();
const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  const response = await fetch(`${base}/api/v1/runs/${run.id}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const current = await response.json();
  if (current.status === 'completed') break;
  if (['failed', 'interrupted', 'cancelled'].includes(current.status)) assert.fail(`Synthetic run ended in ${current.status}`);
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const finalResponse = await fetch(`${base}/api/v1/runs/${run.id}`, { headers: { cookie } });
assert.equal((await finalResponse.json()).status, 'completed', 'Authorized synthetic run did not complete through worker and launcher');
console.log('Disposable systemd deployment passed: owner approval, restricted launcher communication, synthetic execution, and completion.');
NODE

echo "Disposable systemd deployment and worker-boundary probes passed. Services, identities, secrets, and installed application tree will be removed by cleanup."
