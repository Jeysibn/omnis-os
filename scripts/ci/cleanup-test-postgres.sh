#!/usr/bin/env bash
set -euo pipefail

container_name="${OMNIS_CI_POSTGRES_CONTAINER_NAME:-}"
if [[ -z "$container_name" ]]; then
  echo 'No disposable PostgreSQL container was created.'
  exit 0
fi

if docker container inspect "$container_name" >/dev/null 2>&1; then
  docker rm --force --volumes "$container_name" >/dev/null
  echo 'Removed the run-scoped disposable PostgreSQL container and its anonymous data volume.'
else
  echo 'Disposable PostgreSQL container was already absent.'
fi
