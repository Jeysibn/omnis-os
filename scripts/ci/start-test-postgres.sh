#!/usr/bin/env bash
set -euo pipefail

: "${OMNIS_CI_POSTGRES_CONTAINER_NAME:?disposable PostgreSQL container name is required}"
: "${OMNIS_CI_POSTGRES_ENV_FILE:?disposable PostgreSQL credential file is required}"
expected_environment_file="${RUNNER_TEMP:?RUNNER_TEMP is required}/omnis-ci-db-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}-${GITHUB_JOB:?}.env"
if [[ "$OMNIS_CI_POSTGRES_ENV_FILE" != "$expected_environment_file" || ! -f "$expected_environment_file" ]]; then
  echo 'Disposable PostgreSQL credential file is outside its expected run-scoped path.' >&2
  exit 1
fi
if [[ "$(stat -c '%a' "$expected_environment_file")" != 600 ]]; then
  echo 'Disposable PostgreSQL credential file must have mode 0600.' >&2
  exit 1
fi
source "$OMNIS_CI_POSTGRES_ENV_FILE"
: "${OMNIS_CI_POSTGRES_ADMIN_PASSWORD:?disposable PostgreSQL administrator password is required}"

image='postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94'
docker pull "$image"
export POSTGRES_PASSWORD="$OMNIS_CI_POSTGRES_ADMIN_PASSWORD"
docker run --detach \
  --name "$OMNIS_CI_POSTGRES_CONTAINER_NAME" \
  --label "omnis.ci.run=${GITHUB_RUN_ID:?}" \
  --label "omnis.ci.job=${GITHUB_JOB:?}" \
  --publish 127.0.0.1:5432:5432 \
  --health-cmd 'pg_isready -U omnis -d omnis_test' \
  --health-interval 2s \
  --health-timeout 3s \
  --health-retries 30 \
  --env POSTGRES_USER=omnis \
  --env POSTGRES_PASSWORD \
  --env POSTGRES_DB=omnis_test \
  "$image" >/dev/null

deadline=$((SECONDS + 60))
while ((SECONDS < deadline)); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' \
    "$OMNIS_CI_POSTGRES_CONTAINER_NAME" 2>/dev/null || true)"
  case "$health" in
    healthy)
      echo 'Disposable PostgreSQL is healthy on runner loopback.'
      exit 0
      ;;
    unhealthy)
      break
      ;;
  esac
  sleep 1
done

echo "Disposable PostgreSQL failed its bounded health check (health=${health:-unavailable})." >&2
docker logs "$OMNIS_CI_POSTGRES_CONTAINER_NAME" >&2 || true
exit 1
