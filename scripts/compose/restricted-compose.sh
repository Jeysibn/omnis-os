#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' 'Restricted Compose command rejected; use the approved exact project, files, and command.' >&2
  exit 2
}

[[ $# -ge 5 ]] || fail
compose_env_file=$1
api_env_file=$2
worker_env_file=$3
shift 3
[[ -f "$compose_env_file" && -f "$api_env_file" && -f "$worker_env_file" ]] || fail

case "$*" in
  'config --quiet'|'up --no-build --pull never -d postgres'|'build api worker web'|\
    'up --no-build --pull never -d api worker web'|'ps --all'|'stop api worker web postgres') ;;
  *) fail ;;
esac

node scripts/compose/verify-restricted-env.mjs \
  --compose-env "$compose_env_file" \
  --api-env "$api_env_file" \
  --worker-env "$worker_env_file"

# Exported shell variables override --env-file interpolation. Remove all
# Omnis and Compose controls so the validated file and fixed CLI options win.
while IFS= read -r name; do
  case "$name" in
    OMNIS_* | COMPOSE_*) unset "$name" || fail ;;
  esac
done < <(compgen -e)

exec docker compose --project-name omnis-os-restricted-dev \
  --env-file "$compose_env_file" \
  -f infra/compose/docker-compose.yml \
  -f infra/compose/docker-compose.app.yml \
  -f infra/compose/docker-compose.restricted-dev.yml \
  "$@"
