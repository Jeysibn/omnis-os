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
add_allowlisted_path() {
  local path="$1"
  case "$path" in
    scripts/mission9d/stage2a-simulated/*) return 0 ;;
  esac
  name="${path##*/}"
  lower_name="${name,,}"
  case "$lower_name" in
    .env*|.npmrc|*.pem|*.key|*.p12|*.pfx|*.jks|*.keystore|*.token|*.credential|*.credentials|*.secret|*credential*.json|*credentials*.json|secrets.json|id_rsa*|id_ed25519*)
      return 0
      ;;
  esac
  case "/$path/" in
    */.ssh/*|*/.aws/*|*/.gnupg/*|*/credentials/*|*/secrets/*)
      return 0
      ;;
  esac
  printf '%s\0' "$path" >> "$allowlist"
}
while IFS= read -r -d '' path; do add_allowlisted_path "$path"; done < "$manifest"

# Frozen pnpm installs create the workspace links and dependency files used by
# the systemd services. Include only those explicit dependency roots, and apply
# the same sensitive-file policy to every nested dependency path.
dependency_roots=("$source_root/node_modules" "$source_root/apps"/*/node_modules "$source_root/packages"/*/node_modules)
for dependency_root in "${dependency_roots[@]}"; do
  [[ -d "$dependency_root" ]] || continue
  while IFS= read -r -d '' absolute_path; do
    add_allowlisted_path "${absolute_path#"$source_root"/}"
  done < <(find "$dependency_root" \( -type f -o -type l \) -print0)
done

if [[ ! -s "$allowlist" ]]; then
  echo "No tracked application files remain after sensitive-file exclusions." >&2
  exit 1
fi

tar -C "$source_root" --null --files-from="$allowlist" -cf - | tar -C "$stage" -xf -
if [[ -e "$stage/scripts/mission9d/stage2a-simulated" ]]; then
  echo "Deployment contains the prohibited Stage 2A synthetic module tree." >&2
  exit 1
fi
