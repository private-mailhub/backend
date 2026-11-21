#!/usr/bin/env bash
# Produce only the API release and reviewed CodeDeploy hooks, never the checkout or .env.
set -euo pipefail
umask 022
[[ $# == 2 && $1 =~ ^[0-9a-f]{40}$ ]] || { echo 'usage: package-api.sh <git-sha> <new-zip-path>' >&2; exit 2; }
sha=$1
out="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
[[ ! -e "$out" && ! -L "$out" ]] || { echo 'output must be a new file' >&2; exit 1; }
cd "$(dirname "$0")/.."
[[ $(git rev-parse HEAD) == "$sha" ]] || { echo 'checkout/revision mismatch' >&2; exit 1; }
[[ -s dist/main.js && -s appspec.yml && -d deploy/codedeploy && -z $(find dist -type l -print -quit) ]] || { echo 'missing compiled API or unsafe dist' >&2; exit 1; }
stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/content/deploy" "$stage/bundle/deploy"
# Hooks and manifests come from the Git object, not untracked operator files.
git archive "$sha" .nvmrc package.json package-lock.json deploy/ecosystem.config.cjs | tar -x -C "$stage/content"
git archive "$sha" appspec.yml deploy/release.sh deploy/codedeploy | tar -x -C "$stage/bundle"
cp -R dist "$stage/content/dist"
[[ -z $(find "$stage/content" "$stage/bundle" ! -type f ! -type d -print -quit) ]] || { echo 'non-regular archive content' >&2; exit 1; }
# Normalize copied timestamps and ordering so rebuilding unchanged files yields the same payload.
export LC_ALL=C TZ=UTC COPYFILE_DISABLE=1
(cd "$stage/content"; find . -mindepth 1 -exec touch -t 200001010000.00 {} +; find . -mindepth 1 -print | sed 's@^\./@@' | sort > "$stage/names"; if tar --version | grep -q 'GNU tar'; then tar --format=ustar --owner=0 --group=0 --numeric-owner --no-recursion -cf - -T "$stage/names"; else tar --format=ustar --uid 0 --gid 0 --uname root --gname root --no-recursion -cf - -T "$stage/names"; fi) | gzip -n > "$stage/bundle/backend.tar.gz"
cd "$stage/bundle"; printf '%s\n' "$sha" > revision.txt
if command -v sha256sum >/dev/null; then sha256sum backend.tar.gz; else shasum -a 256 backend.tar.gz; fi > backend.tar.gz.sha256
find . -type f -exec touch -t 200001010000.00 {} +
find . -type f -print | sed 's@^\./@@' | sort | zip -Xq "$out" -@
