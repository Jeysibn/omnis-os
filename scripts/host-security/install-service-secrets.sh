#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this opt-in secret installation as root." >&2
  exit 1
fi
for item in "api:.env:omnis-api:omnis-api" \
  "worker:.env.worker:omnis-worker:omnis-worker" \
  "authorizer:.env.authorizer:omnis-authorizer:omnis-authorizer" \
  "sandbox-launcher:.env.sandbox-launcher:omnis-launcher:omnis-launcher"; do
  IFS=: read -r name source user group <<<"$item"
  if [[ ! -s "$source" ]]; then
    echo "Missing non-empty $source; no service secrets were installed." >&2
    exit 1
  fi
done
if grep -Eq '^OMNIS_(AUTHORIZER_DB_PASSWORD|AUTHORIZER_DATABASE_URL|AUTHORIZER_SOCKET|API_AUTHORIZER_TOKEN|LAUNCHER_DB_PASSWORD|LAUNCHER_DATABASE_URL)=' .env.worker; then
  echo "The worker environment contains a control-plane or launcher secret." >&2
  exit 1
fi
if grep -Eq '^OMNIS_AGENT_IDEMPOTENCY_KEY(_VERSION)?=' .env .env.worker .env.sandbox-launcher; then
  echo 'Agent idempotency signing material must remain authorizer-only.' >&2
  exit 1
fi
if [[ "$(grep -Ec '^OMNIS_AGENT_IDEMPOTENCY_KEY=' .env.authorizer || true)" != 1 ]] || \
  ! grep -Eq '^OMNIS_AGENT_IDEMPOTENCY_KEY=[0-9a-fA-F]{64}$' .env.authorizer || \
  [[ "$(grep -Ec '^OMNIS_AGENT_IDEMPOTENCY_KEY_VERSION=[1-9][0-9]*$' .env.authorizer || true)" != 1 ]]; then
  echo 'Authorizer agent idempotency key configuration is missing or invalid.' >&2
  exit 1
fi
if grep -Eq '^OMNIS_(AUTHORIZER_DB_PASSWORD|AUTHORIZER_DATABASE_URL|LAUNCHER_DB_PASSWORD|LAUNCHER_DATABASE_URL)=' .env; then
  echo "The API environment contains a database service credential." >&2
  exit 1
fi
if grep -Eq '^OMNIS_(RUNTIME_DB_PASSWORD|DATABASE_URL|LAUNCHER_DB_PASSWORD|LAUNCHER_DATABASE_URL)=' .env.authorizer; then
  echo "The authorizer environment contains a runtime or launcher database credential." >&2
  exit 1
fi
if grep -Eq '^OMNIS_(RUNTIME_DB_PASSWORD|DATABASE_URL|AUTHORIZER_DB_PASSWORD|AUTHORIZER_DATABASE_URL|API_AUTHORIZER_TOKEN|INTERNAL_TOKEN)=' .env.sandbox-launcher; then
  echo "The sandbox launcher environment contains an API, worker, or authorizer secret." >&2
  exit 1
fi
if [[ "$(grep -c '^OMNIS_AUTHORIZER_SOCKET=' .env || true)" != 1 || \
  "$(grep -c '^OMNIS_AUTHORIZER_SOCKET=' .env.authorizer || true)" != 1 || \
  "$(grep -c '^OMNIS_SANDBOX_LAUNCHER_SOCKET=' .env.worker || true)" != 1 || \
  "$(grep -c '^OMNIS_SANDBOX_LAUNCHER_SOCKET=' .env.sandbox-launcher || true)" != 1 ]]; then
  echo "Service configuration must contain exactly one authorizer and launcher socket endpoint per caller." >&2
  exit 1
fi
umask 0077
temporary_env_dir="$(mktemp -d)"
trap 'rm -rf -- "$temporary_env_dir"' EXIT
record_created_file() {
  if [[ -n "${OMNIS_RESOURCE_MANIFEST:-}" ]]; then
    printf 'file\t%s\n' "$1" >> "$OMNIS_RESOURCE_MANIFEST"
  fi
}
sed 's|^OMNIS_AUTHORIZER_SOCKET=.*$|OMNIS_AUTHORIZER_SOCKET=/run/omnis-authorizer/authorizer.sock|' .env > "$temporary_env_dir/api.env"
sed 's|^OMNIS_AUTHORIZER_SOCKET=.*$|OMNIS_AUTHORIZER_SOCKET=/run/omnis-authorizer/authorizer.sock|' .env.authorizer > "$temporary_env_dir/authorizer.env"
sed 's|^OMNIS_SANDBOX_LAUNCHER_SOCKET=.*$|OMNIS_SANDBOX_LAUNCHER_SOCKET=/run/omnis-sandbox/launcher.sock|' .env.worker > "$temporary_env_dir/worker.env"
sed 's|^OMNIS_SANDBOX_LAUNCHER_SOCKET=.*$|OMNIS_SANDBOX_LAUNCHER_SOCKET=/run/omnis-sandbox/launcher.sock|' .env.sandbox-launcher > "$temporary_env_dir/sandbox-launcher.env"
install -o omnis-api -g omnis-api -m 0600 "$temporary_env_dir/api.env" /etc/omnis/api.env
record_created_file /etc/omnis/api.env
install -o omnis-worker -g omnis-worker -m 0600 "$temporary_env_dir/worker.env" /etc/omnis/worker.env
record_created_file /etc/omnis/worker.env
install -o omnis-authorizer -g omnis-authorizer -m 0600 "$temporary_env_dir/authorizer.env" /etc/omnis/authorizer.env
record_created_file /etc/omnis/authorizer.env
install -o omnis-launcher -g omnis-launcher -m 0600 "$temporary_env_dir/sandbox-launcher.env" /etc/omnis/sandbox-launcher.env
record_created_file /etc/omnis/sandbox-launcher.env
if [[ -s .env.synthetic-broker ]]; then
  broker_caller_token="$(sed -n 's/^OMNIS_BROKER_CALLER_TOKEN=//p' .env.synthetic-broker)"
  broker_authorizer_token="$(sed -n 's/^OMNIS_BROKER_AUTHORIZER_TOKEN=//p' .env.synthetic-broker)"
  provider_token="$(sed -n 's/^OMNIS_FAKE_PROVIDER_TOKEN=//p' .env.synthetic-broker)"
  trust_anchors="$(sed -n 's/^OMNIS_BROKER_TRUST_ANCHORS=//p' .env.synthetic-broker)"
  authorizer_broker_token="$(sed -n 's/^OMNIS_BROKER_AUTHORIZER_TOKEN=//p' .env.authorizer)"
  authorizer_broker_socket="$(sed -n 's/^OMNIS_BROKER_AUTHORIZER_SOCKET=//p' .env.authorizer)"
  [[ "$broker_caller_token" =~ ^[a-fA-F0-9]{64,128}$ && "$broker_authorizer_token" =~ ^[a-fA-F0-9]{64,128}$ && "$provider_token" =~ ^[A-Za-z0-9._-]{32,128}$ && -n "$trust_anchors" ]] || {
    echo "Synthetic broker environment is incomplete or contains malformed synthetic-only values." >&2
    exit 1
  }
  [[ "$broker_caller_token" != "$broker_authorizer_token" && "$broker_caller_token" != "$(sed -n 's/^OMNIS_API_AUTHORIZER_TOKEN=//p' .env.authorizer)" && "$authorizer_broker_token" == "$broker_authorizer_token" && "$authorizer_broker_socket" == /run/omnis-broker-authorizer/broker.sock ]] || {
    echo "Synthetic broker tokens must be unique, match the authorizer broker token, and use the reviewed IPC path." >&2
    exit 1
  }
  printf '%s\n' "$broker_caller_token" > "$temporary_env_dir/broker-caller.token"
  printf '%s\n' "$broker_authorizer_token" > "$temporary_env_dir/broker-authorizer.token"
  printf '%s\n' "$provider_token" > "$temporary_env_dir/synthetic-provider.token"
  install -o root -g omnis-synthetic-broker -m 0640 "$temporary_env_dir/broker-caller.token" /etc/omnis/broker-caller.token
  install -o root -g omnis-synthetic-broker -m 0640 "$temporary_env_dir/broker-authorizer.token" /etc/omnis/broker-authorizer.token
  install -o root -g omnis-synthetic-broker -m 0640 "$temporary_env_dir/synthetic-provider.token" /etc/omnis/synthetic-provider.token
  record_created_file /etc/omnis/broker-caller.token
  record_created_file /etc/omnis/broker-authorizer.token
  record_created_file /etc/omnis/synthetic-provider.token
  printf 'OMNIS_BROKER_CALLER_TOKEN_FILE=/etc/omnis/broker-caller.token\nOMNIS_BROKER_AUTHORIZER_TOKEN_FILE=/etc/omnis/broker-authorizer.token\nOMNIS_BROKER_TRUST_ANCHORS=%s\nOMNIS_FAKE_PROVIDER_TOKEN_FILE=/etc/omnis/synthetic-provider.token\n' "$trust_anchors" > "$temporary_env_dir/synthetic-broker.env"
  install -o root -g omnis-synthetic-broker -m 0640 "$temporary_env_dir/synthetic-broker.env" /etc/omnis/synthetic-broker.env
  record_created_file /etc/omnis/synthetic-broker.env
  install -o root -g omnis-broker-gateway-token -m 0640 "$temporary_env_dir/broker-caller.token" /etc/omnis/broker-gateway.token
  record_created_file /etc/omnis/broker-gateway.token
  unset broker_caller_token broker_authorizer_token provider_token trust_anchors authorizer_broker_token authorizer_broker_socket
fi
echo "Installed service-specific environment files with restricted ownership and modes."
