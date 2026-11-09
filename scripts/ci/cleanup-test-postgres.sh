#!/usr/bin/env bash
set -euo pipefail

container_name="${OMNIS_CI_POSTGRES_CONTAINER_NAME:-}"
environment_file="${OMNIS_CI_POSTGRES_ENV_FILE:-}"
cleanup_status=0
if [[ -z "$container_name" ]]; then
  echo 'No disposable PostgreSQL container was created.'
else
  if docker container inspect "$container_name" >/dev/null 2>&1; then
    if docker rm --force --volumes "$container_name" >/dev/null; then
      echo 'Removed the run-scoped disposable PostgreSQL container and its anonymous data volume.'
    else
      echo 'Failed to remove the run-scoped disposable PostgreSQL container.' >&2
      cleanup_status=1
    fi
  else
    echo 'Disposable PostgreSQL container was already absent.'
  fi
fi

if [[ -n "$environment_file" ]]; then
  : "${RUNNER_TEMP:?RUNNER_TEMP is required to validate the disposable credential file path}"
  expected_environment_file="$RUNNER_TEMP/omnis-ci-db-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}-${GITHUB_JOB:?}.env"
  if [[ "$environment_file" != "$expected_environment_file" ]]; then
    echo 'Refusing to remove a credential file outside the run-scoped temporary path.' >&2
    cleanup_status=1
  elif ! rm -f -- "$environment_file"; then
    echo 'Failed to remove the run-scoped disposable PostgreSQL credential file.' >&2
    cleanup_status=1
  else
    echo 'Removed the run-scoped disposable PostgreSQL credential file.'
  fi
else
  echo 'No disposable PostgreSQL credential file was registered.'
fi

exit "$cleanup_status"
