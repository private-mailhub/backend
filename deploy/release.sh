#!/usr/bin/env bash

set -euo pipefail

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ $# -ne 2 ]]; then
  die "usage: $0 <40-hex-sha> <backend-archive>"
fi

release_sha=$1
archive_path=$2
deploy_root=${MAILHUB_DEPLOY_ROOT:-/var/www/mailhub-backend}
lock_path=${MAILHUB_DEPLOY_LOCK:-/var/lock/mailhub-deploy.lock}

[[ "$release_sha" =~ ^[0-9a-fA-F]{40}$ ]] || die 'release SHA must be exactly 40 hexadecimal characters'
[[ -f "$archive_path" && ! -L "$archive_path" ]] || die 'backend archive must be a regular file'
[[ "$deploy_root" == /* && "$deploy_root" != '/' ]] || die 'MAILHUB_DEPLOY_ROOT must be an absolute non-root path'
[[ "$lock_path" == /* ]] || die 'MAILHUB_DEPLOY_LOCK must be an absolute path'

releases_dir="$deploy_root/releases"
shared_env="$deploy_root/shared/.env"
release_dir="$releases_dir/$release_sha"
stage_dir=''
archive_listing_file=''
archive_metadata_file=''

cleanup() {
  if [[ -n "$stage_dir" && -d "$stage_dir" ]]; then
    rm -rf -- "$stage_dir"
  fi

  if [[ -n "$archive_listing_file" ]]; then
    rm -f -- "$archive_listing_file"
  fi

  if [[ -n "$archive_metadata_file" ]]; then
    rm -f -- "$archive_metadata_file"
  fi
}

trap cleanup EXIT

validate_archive() {
  archive_listing_file=$(mktemp)
  archive_metadata_file=$(mktemp)
  tar -tzf "$archive_path" > "$archive_listing_file" || die 'unable to read backend archive'
  tar -tvzf "$archive_path" > "$archive_metadata_file" || die 'unable to inspect backend archive'

  while IFS= read -r entry || [[ -n "$entry" ]]; do
    while [[ "$entry" == ./* ]]; do
      entry=${entry#./}
    done

    [[ -z "$entry" ]] && continue
    [[ "$entry" != /* ]] || die "absolute archive path is not allowed: $entry"

    case "/$entry/" in
      */../*) die "parent archive path is not allowed: $entry" ;;
    esac

    case "$entry" in
      dist|dist/*|deploy|deploy/|deploy/ecosystem.config.cjs|package.json|package-lock.json|.nvmrc)
        ;;
      *)
        die "archive entry is not allowlisted: $entry"
        ;;
    esac
  done < "$archive_listing_file"

  while IFS= read -r metadata || [[ -n "$metadata" ]]; do
    case ${metadata:0:1} in
      -|d)
        ;;
      *)
        die 'archive may contain only regular files and directories'
        ;;
    esac
  done < "$archive_metadata_file"
}

mkdir -p "$releases_dir"
mkdir -p "$(dirname "$lock_path")"
exec 9>"$lock_path"
command -v flock >/dev/null 2>&1 || die 'flock is required for backend deployment locking'
flock -x 9

[[ -f "$shared_env" && ! -L "$shared_env" ]] || die "shared environment file is missing: $shared_env"
[[ ! -e "$release_dir" && ! -L "$release_dir" ]] || die "release already exists: $release_dir"

validate_archive
stage_dir=$(mktemp -d "$releases_dir/.${release_sha}.tmp.XXXXXX")
tar -xzf "$archive_path" -C "$stage_dir"

extracted_symlink=$(find "$stage_dir" -type l -print -quit)
if [[ -n "$extracted_symlink" ]]; then
  die 'archive extraction produced a symbolic link'
fi

[[ -f "$stage_dir/dist/main.js" ]] || die 'dist/main.js is required in the backend archive'
[[ -f "$stage_dir/package.json" ]] || die 'package.json is required in the backend archive'
[[ -f "$stage_dir/package-lock.json" ]] || die 'package-lock.json is required in the backend archive'
[[ -f "$stage_dir/.nvmrc" ]] || die '.nvmrc is required in the backend archive'
[[ -f "$stage_dir/deploy/ecosystem.config.cjs" ]] || die 'ecosystem config is required in the backend archive'

expected_node_version=$(tr -d '[:space:]' < "$stage_dir/.nvmrc")
[[ "$expected_node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die '.nvmrc must contain a semantic Node.js version'
actual_node_version=$(node --version) || die 'node is required for backend dependency installation'
[[ "$actual_node_version" == "v$expected_node_version" ]] || {
  die "Node.js $expected_node_version is required; found $actual_node_version"
}

(
  cd "$stage_dir"
  npm ci --omit=dev --engine-strict --ignore-scripts
)

[[ -f "$stage_dir/dist/main.js" ]] || die 'dist/main.js is missing after dependency installation'
ln -s "$shared_env" "$stage_dir/.env"
mv "$stage_dir" "$release_dir"
stage_dir=''

printf 'Prepared backend release: %s\n' "$release_dir"
