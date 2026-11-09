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
: "${OMNIS_CI_POSTGRES_AUTHORIZER_PASSWORD:?disposable PostgreSQL authorizer password is required}"
: "${OMNIS_CI_POSTGRES_LAUNCHER_PASSWORD:?disposable PostgreSQL launcher password is required}"

export OMNIS_ADMIN_DATABASE_URL="postgresql://omnis:${OMNIS_CI_POSTGRES_ADMIN_PASSWORD}@127.0.0.1:5432/omnis_test"
export OMNIS_MIGRATION_DB_PASSWORD="$OMNIS_CI_POSTGRES_MIGRATION_PASSWORD"
export OMNIS_RUNTIME_DB_PASSWORD="$OMNIS_CI_POSTGRES_RUNTIME_PASSWORD"
export OMNIS_AUTHORIZER_DB_PASSWORD="$OMNIS_CI_POSTGRES_AUTHORIZER_PASSWORD"
export OMNIS_LAUNCHER_DB_PASSWORD="$OMNIS_CI_POSTGRES_LAUNCHER_PASSWORD"

export OMNIS_TEST_ADMIN_DATABASE_URL="$OMNIS_ADMIN_DATABASE_URL"
export OMNIS_TEST_MIGRATION_DATABASE_URL="postgresql://omnis_migrator:${OMNIS_CI_POSTGRES_MIGRATION_PASSWORD}@127.0.0.1:5432/omnis_test"
export OMNIS_TEST_DATABASE_URL="postgresql://omnis_runtime:${OMNIS_CI_POSTGRES_RUNTIME_PASSWORD}@127.0.0.1:5432/omnis_test"
export OMNIS_TEST_AUTHORIZER_DATABASE_URL="postgresql://omnis_authorizer:${OMNIS_CI_POSTGRES_AUTHORIZER_PASSWORD}@127.0.0.1:5432/omnis_test"
export OMNIS_TEST_LAUNCHER_DATABASE_URL="postgresql://omnis_launcher:${OMNIS_CI_POSTGRES_LAUNCHER_PASSWORD}@127.0.0.1:5432/omnis_test"
