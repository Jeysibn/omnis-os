#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this opt-in installer as root; it installs a protected copy and never changes the checkout." >&2
  exit 1
fi

source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
destination="${1:-/opt/omnis-os}"
if [[ "$destination" != /opt/omnis-os ]]; then
  echo "Only the reviewed deployment path /opt/omnis-os is supported." >&2
  exit 1
fi
if [[ -e "$destination" || -L "$destination" ]]; then
  echo "$destination already exists; refusing to replace an existing deployment." >&2
  exit 1
fi
if [[ ! -d /opt ]]; then
  echo "/opt must exist and must not be writable by the service identities." >&2
  exit 1
fi
if [[ "$(stat -c '%U' /opt)" != root ]]; then
  echo "/opt must be root-owned before installing the protected application tree." >&2
  exit 1
fi
opt_mode="$(stat -c '%a' /opt)"
if (( (8#$opt_mode & 0022) != 0 )); then
  echo "/opt has group or world write permissions." >&2
  exit 1
fi

stage="$(mktemp -d /opt/.omnis-os.install.XXXXXX)"
cleanup() {
  if [[ -n "${stage:-}" && -d "$stage" ]]; then rm -rf -- "$stage"; fi
}
trap cleanup EXIT

tar -C "$source_root" \
  --exclude='./.git' \
  --exclude='./.env' --exclude='./.env.*' \
  --exclude='./.env-*' \
  -cf - . | tar -C "$stage" -xf -

if find "$stage" ! -type d ! -type f ! -type l -print -quit | grep -q .; then
  echo "Deployment contains a special file; only directories, regular files, and confined symlinks are allowed." >&2
  exit 1
fi

while IFS= read -r -d '' link; do
  resolved="$(realpath -e -- "$link")" || {
    echo "Deployment contains a broken symlink: ${link#"$stage"/}" >&2
    exit 1
  }
  case "$resolved" in
    "$stage"|"$stage"/*) ;;
    *) echo "Deployment symlink escapes the protected application tree: ${link#"$stage"/}" >&2; exit 1 ;;
  esac
done < <(find "$stage" -type l -print0)

chown -hR root:root "$stage"
find "$stage" -type d -exec chmod 0755 {} +
find "$stage" -type f -exec chmod u=rwX,go=rX {} +
if find "$stage" -type f -perm /022 -print -quit | grep -q .; then
  echo "Deployment contains group- or world-writable files." >&2
  exit 1
fi
mv -- "$stage" "$destination"
stage=""
echo "Installed root-owned, non-service-writable application tree at $destination."
