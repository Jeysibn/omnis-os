#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
"$script_directory/set-service-socket-group.sh" authorizer
"$script_directory/set-service-socket-group.sh" authorizer-broker
