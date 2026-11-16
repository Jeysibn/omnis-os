#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' 'Docker target preflight failed; no Compose command was run.' >&2
  exit 2
}

[[ $# -eq 2 ]] || fail
expected_context=$1
expected_endpoint=$2

[[ "$expected_context" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || fail
[[ "$expected_endpoint" =~ ^unix:///[^[:space:]]+$ ]] || fail
[[ "$expected_endpoint" != *'/../'* && "$expected_endpoint" != *'/./'* ]] || fail

# These variables override or compete with context selection. The caller must
# clear them and pass the owner-verified context explicitly.
[[ -z "${DOCKER_HOST:-}" && -z "${DOCKER_CONTEXT:-}" ]] || fail

actual_endpoint=$(docker context inspect \
  --format '{{.Endpoints.docker.Host}}' "$expected_context" 2>/dev/null) || fail
[[ "$actual_endpoint" == "$expected_endpoint" ]] || fail
