#!/usr/bin/env bash
set -euo pipefail

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
source "$expected_environment_file"

: "${OMNIS_CI_POSTGRES_ADMIN_PASSWORD:?disposable PostgreSQL administrator password is required}"
: "${OMNIS_CI_POSTGRES_MIGRATION_PASSWORD:?disposable PostgreSQL migration password is required}"
: "${OMNIS_CI_POSTGRES_RUNTIME_PASSWORD:?disposable PostgreSQL runtime password is required}"
export OMNIS_CI_POSTGRES_ADMIN_PASSWORD
export OMNIS_CI_POSTGRES_MIGRATION_PASSWORD
export OMNIS_CI_POSTGRES_RUNTIME_PASSWORD
