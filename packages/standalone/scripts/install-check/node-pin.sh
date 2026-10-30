#!/usr/bin/env bash
# node-pin (docs/development/work/install.md, "Node"): the Node.js version and SHA-256s that
# install/node.json pins, and install.sh's copy of them, are the ones the Node.js releasers
# signed. SHASUMS256.txt.asc is checked with gpgv against nodejs/release-keys at a pinned commit;
# the person's machine needs no gpg, because the script checks the pinned hash.
# CI only (needs gpgv, curl and jq): bash packages/standalone/scripts/install-check/node-pin.sh
set -euo pipefail

KEYS_COMMIT=481637f813e912c4aa3622d7964ab426c97b8e8d
here=$(cd "$(dirname "$0")" && pwd)
pin="$here/../../install/node.json"
script="$here/../../install/install.sh"
version=$(jq -r .version "$pin")
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

curl -fsSL -o "$work/keys.tar.gz" \
  "https://github.com/nodejs/release-keys/archive/$KEYS_COMMIT.tar.gz"
tar -xzf "$work/keys.tar.gz" -C "$work"
curl -fsSL -o "$work/SHASUMS256.txt.asc" "https://nodejs.org/dist/v$version/SHASUMS256.txt.asc"
gpgv --keyring "$work/release-keys-$KEYS_COMMIT/gpg/pubring.kbx" \
  --output "$work/SHASUMS256.txt" "$work/SHASUMS256.txt.asc"

status=0
scripted_version=$(sed -n 's/^ *NODE_VERSION=//p' "$script")
if [[ "$scripted_version" != "$version" ]]; then
  echo "::error::install.sh pins Node.js '$scripted_version', node.json $version; node scripts/sync-versions.js writes it"
  status=1
fi
for platform in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
  file="node-v$version-$platform.tar.gz"
  signed=$(awk -v file="$file" '$2 == file { print $1 }' "$work/SHASUMS256.txt")
  pinned=$(jq -r --arg platform "$platform" '.sha256[$platform] // empty' "$pin")
  name="NODE_SHA256_$(printf '%s' "$platform" | tr 'a-z-' 'A-Z_')"
  scripted=$(sed -n "s/^ *$name=//p" "$script")
  if [[ -z "$signed" || "$pinned" != "$signed" || "$scripted" != "$signed" ]]; then
    echo "::error::$file: signed '${signed:-none}', node.json '${pinned:-none}', install.sh '${scripted:-none}'"
    status=1
  else
    echo "node-pin: $file $signed (signed, pinned, in install.sh)"
  fi
done
exit "$status"
