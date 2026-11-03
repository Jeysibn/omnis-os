#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this opt-in secret installation as root." >&2
  exit 1
fi
for item in "api:.env:omnis-api:omnis-api" \
  "worker:.env.worker:omnis-worker:omnis-worker-socket" \
  "authorizer:.env.authorizer:omnis-authorizer:omnis-authorizer-socket" \
  "sandbox-launcher:.env.sandbox-launcher:omnis-launcher:omnis-worker-socket"; do
  IFS=: read -r name source user group <<<"$item"
  if [[ ! -s "$source" ]]; then
    echo "Missing non-empty $source; no service secrets were installed." >&2
    exit 1
  fi
done
if grep -Eq '^OMNIS_(AUTHORIZER_DB_PASSWORD|AUTHORIZER_DATABASE_URL|API_AUTHORIZER_TOKEN|LAUNCHER_DB_PASSWORD|LAUNCHER_DATABASE_URL)=' .env.worker; then
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
install -o omnis-api -g omnis-api -m 0600 .env /etc/omnis/api.env
install -o omnis-worker -g omnis-worker-socket -m 0600 .env.worker /etc/omnis/worker.env
install -o omnis-authorizer -g omnis-authorizer-socket -m 0600 .env.authorizer /etc/omnis/authorizer.env
install -o omnis-launcher -g omnis-worker-socket -m 0600 .env.sandbox-launcher /etc/omnis/sandbox-launcher.env
echo "Installed service-specific environment files with restricted ownership and modes."
