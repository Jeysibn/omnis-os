#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Specify only the fixed service name: authorizer, authorizer-broker, broker, or launcher." >&2
  exit 2
fi

case "$1" in
  authorizer)
    expected_user=omnis-authorizer
    expected_group=omnis-authorizer-socket
    socket=/run/omnis-authorizer/authorizer.sock
    ;;
  authorizer-broker)
    if [[ -z "${OMNIS_BROKER_AUTHORIZER_SOCKET:-}" ]]; then
      exit 0
    fi
    if [[ "$OMNIS_BROKER_AUTHORIZER_SOCKET" != /run/omnis-broker-authorizer/broker.sock ]]; then
      echo "The broker authorizer socket path is outside the reviewed platform contract." >&2
      exit 1
    fi
    expected_user=omnis-authorizer
    expected_group=omnis-broker-gateway-socket
    socket=/run/omnis-broker-authorizer/broker.sock
    ;;
  broker)
    expected_user=omnis-synthetic-broker
    expected_group=omnis-broker-ingress-socket
    socket=/run/omnis-synthetic-broker/broker.sock
    ;;
  launcher)
    expected_user=omnis-launcher
    expected_group=omnis-launcher-socket
    socket=/run/omnis-sandbox/launcher.sock
    ;;
  *)
    echo "Unknown service; only the fixed authorizer, authorizer-broker, broker, and launcher sockets are supported." >&2
    exit 2
    ;;
esac

if [[ "$(id -un)" != "$expected_user" ]]; then
  echo "Socket group setup must run as $expected_user." >&2
  exit 1
fi

socket_dir="$(dirname "$socket")"
[[ -d "$socket_dir" && ! -L "$socket_dir" ]] || {
  echo "Refusing to change a missing or symlinked service socket directory." >&2
  exit 1
}
[[ "$(stat -c '%U' "$socket_dir")" == "$expected_user" ]] || {
  echo "Refusing to change a socket directory not owned by $expected_user." >&2
  exit 1
}
chgrp "$expected_group" "$socket_dir"
chmod 0750 "$socket_dir"
[[ "$(stat -c '%U:%G:%a' "$socket_dir")" == "$expected_user:$expected_group:750" ]] || {
  echo "Socket directory did not reach the expected owner, group, and mode." >&2
  exit 1
}

for _ in {1..100}; do
  if [[ -S "$socket" ]]; then
    [[ "$(stat -c '%U' "$socket")" == "$expected_user" ]] || {
      echo "Refusing to change ownership on a socket not owned by $expected_user." >&2
      exit 1
    }
    chgrp "$expected_group" "$socket"
    chmod 0660 "$socket"
    [[ "$(stat -c '%U:%G:%a' "$socket")" == "$expected_user:$expected_group:660" ]] || {
      echo "Socket did not reach the expected owner, group, and mode." >&2
      exit 1
    }
    exit 0
  fi
  sleep 0.05
done

echo "Service did not create its expected Unix socket before the startup deadline." >&2
exit 1
