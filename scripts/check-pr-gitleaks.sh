#!/usr/bin/env bash
# Scan PR-changed files for secrets before or after commit creation.
#
# gitleaks protect --staged is useful before committing, but it becomes a no-op
# after the index is clean. This script scans PR commits, staged blob contents,
# and working-tree files changed against the PR base.

set -euo pipefail

BASE_REF="${MAMA_GITLEAKS_BASE_REF:-origin/main}"
REPO_ROOT="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
cd "$REPO_ROOT"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is required for PR secret scanning" >&2
  exit 1
fi

if ! git rev-parse --verify "${BASE_REF}^{commit}" >/dev/null 2>&1; then
  echo "Cannot resolve gitleaks base ref: ${BASE_REF}" >&2
  exit 1
fi

TMP_ALL_PATHS="$(mktemp)"
TMP_STAGED_PATHS="$(mktemp)"
TMP_STAGED_ROOT="$(mktemp -d)"
trap 'rm -f "$TMP_ALL_PATHS" "$TMP_STAGED_PATHS"; rm -rf "$TMP_STAGED_ROOT"' EXIT

FOUND=0
COMMIT_COUNT="$(git rev-list --count "${BASE_REF}..HEAD")"

HIGH_RISK_PRIVATE_PATTERN=$(
  printf '%s\n' \
    '/Users/[[:alnum:]_.-]+/[[:alnum:]_.-]+' \
    '/home/[[:alnum:]_.-]+/[[:alnum:]_.-]+' \
    '[A-Za-z]:\\Users\\[[:alnum:]_.-]+\\[[:alnum:]_.-]+' \
    'ghp_[[:alnum:]_]{20,}' \
    'github_pat_[[:alnum:]_]{20,}' \
    'xox[baprs]-[[:alnum:]-]{10,}' \
    'sk-[[:alnum:]_-]{20,}' \
    'hooks\.slack\.com/services/[A-Za-z0-9/_-]+' |
    paste -sd '|' -
)

scan_materialized_file() {
  local scan_path="$1"
  local display_path="$2"
  local high_risk_matches

  if ! gitleaks dir "$scan_path" --redact --verbose --no-banner; then
    FOUND=1
  fi

  high_risk_matches="$(grep -IEn "$HIGH_RISK_PRIVATE_PATTERN" "$scan_path" || true)"
  if [ -n "$high_risk_matches" ]; then
    echo "High-risk private data pattern found in PR-changed file: $display_path" >&2
    echo "$high_risk_matches" >&2
    FOUND=1
  fi
}

if [ "$COMMIT_COUNT" -gt 0 ]; then
  echo "Scanning ${COMMIT_COUNT} PR commits with gitleaks against ${BASE_REF}"
  if ! gitleaks git --log-opts "${BASE_REF}..HEAD" --redact --verbose --no-banner; then
    FOUND=1
  fi
fi

git diff -z --name-only --diff-filter=ACMRT "${BASE_REF}...HEAD" -- >> "$TMP_ALL_PATHS"
git diff -z --cached --name-only --diff-filter=ACMRT "$BASE_REF" -- \
  | tee -a "$TMP_ALL_PATHS" >> "$TMP_STAGED_PATHS"
git diff -z --name-only --diff-filter=ACMRT "$BASE_REF" -- >> "$TMP_ALL_PATHS"

readarray -d '' CHANGED_FILES < <(sort -zu "$TMP_ALL_PATHS")
readarray -d '' STAGED_FILES < <(sort -zu "$TMP_STAGED_PATHS")

if [ "${#CHANGED_FILES[@]}" -eq 0 ]; then
  echo "No PR-changed files to scan with gitleaks."
  exit "$FOUND"
fi

echo "Scanning ${#CHANGED_FILES[@]} PR-changed files with gitleaks against ${BASE_REF}"

for path in "${STAGED_FILES[@]}"; do
  if [ -z "$path" ]; then
    continue
  fi

  staged_scan_path="$TMP_STAGED_ROOT/$path"
  mkdir -p "$(dirname -- "$staged_scan_path")"
  if ! git show ":$path" > "$staged_scan_path"; then
    echo "Failed to materialize staged blob for gitleaks scan: $path" >&2
    FOUND=1
    continue
  fi

  scan_materialized_file "$staged_scan_path" "$path"
done

for path in "${CHANGED_FILES[@]}"; do
  if [ -z "$path" ]; then
    continue
  fi

  if [ -L "$path" ]; then
    symlink_scan_path="$TMP_STAGED_ROOT/worktree-symlinks/$path"
    mkdir -p "$(dirname -- "$symlink_scan_path")"
    if ! readlink -- "$path" > "$symlink_scan_path"; then
      echo "Failed to materialize symlink target for gitleaks scan: $path" >&2
      FOUND=1
      continue
    fi

    scan_materialized_file "$symlink_scan_path" "$path (symlink target)"
    continue
  fi

  if [ ! -f "$path" ]; then
    continue
  fi

  path_dir="$(dirname -- "$path")"
  path_base="$(basename -- "$path")"
  if [ ! -d "$path_dir" ]; then
    continue
  fi

  real_dir="$(cd "$path_dir" && pwd -P)"
  scan_path="$real_dir/$path_base"
  case "$scan_path" in
    "$REPO_ROOT"/* | "$REPO_ROOT") ;;
    *)
      echo "Skipping changed path outside repository root: $path" >&2
      continue
      ;;
  esac

  scan_materialized_file "$scan_path" "$path"
done

exit "$FOUND"
