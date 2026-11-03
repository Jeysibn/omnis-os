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
echo "Installed service-specific environment files with restricted ownership and modes."
