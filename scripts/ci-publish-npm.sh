#!/usr/bin/env bash
set -euo pipefail

REGISTRY="${NPM_REGISTRY:-https://registry.npmjs.org/}"
PACKAGE_NAME="$(node -p "require('./package.json').name")"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
PACKAGE_SPEC="${PACKAGE_NAME}@${PACKAGE_VERSION}"

echo "Preparing npm publish for ${PACKAGE_SPEC}"
echo "Registry: ${REGISTRY}"

NPM_USER="$(npm whoami --registry "${REGISTRY}")"
echo "npm identity: ${NPM_USER}"

if npm view "${PACKAGE_SPEC}" version --registry "${REGISTRY}" >/dev/null 2>&1; then
  echo "${PACKAGE_SPEC} already exists on npmjs.org; skipping publish."
  exit 0
fi

npm publish --access public --registry "${REGISTRY}"
