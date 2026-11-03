#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 SOURCE_ROOT EMPTY_STAGE_DIRECTORY" >&2
  exit 2
fi

source_root="$(cd "$1" && pwd -P)"
stage="$(cd "$2" && pwd -P)"
if [[ "$source_root" == "$stage" || "$stage" == "$source_root"/* ]]; then
  echo "The deployment stage must be outside the source checkout." >&2
  exit 1
fi
if find "$stage" -mindepth 1 -print -quit | grep -q .; then
  echo "The deployment stage must be empty." >&2
  exit 1
fi

manifest="$(mktemp)"
cleanup() { rm -f -- "$manifest"; }
trap cleanup EXIT
git -C "$source_root" ls-files -z --cached > "$manifest"

allowlist="$(mktemp)"
cleanup_allowlist() { rm -f -- "$allowlist"; }
trap 'cleanup_allowlist; cleanup' EXIT
while IFS= read -r -d '' path; do
  name="${path##*/}"
  lower_name="${name,,}"
  case "$lower_name" in
    .env*|.npmrc|*.pem|*.key|*.p12|*.pfx|*.jks|*.keystore|*.token|*.credential|*.credentials|*.secret|credentials.json|secrets.json|id_rsa*|id_ed25519*)
      continue
      ;;
  esac
  case "/$path/" in
    */.ssh/*|*/.aws/*|*/.gnupg/*|*/credentials/*|*/secrets/*)
      continue
      ;;
  esac
  printf '%s\0' "$path" >> "$allowlist"
done < "$manifest"

if [[ ! -s "$allowlist" ]]; then
  echo "No tracked application files remain after sensitive-file exclusions." >&2
  exit 1
fi

tar -C "$source_root" --null --files-from="$allowlist" -cf - | tar -C "$stage" -xf -
