#!/usr/bin/env bash
# PII check: scan staged files, or a branch diff, for personal/project information.
#
# Patterns are loaded from .pii-patterns (gitignored).
# If .pii-patterns doesn't exist, only generic checks run.
#
# Exit code 1 = PII found, commit blocked.

set -e

RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

PATTERNS_FILE=".pii-patterns"
MODE="staged"
DIFF_RANGE=("--cached")

if [ "${1:-}" = "--base" ]; then
  MODE="diff"
  BASE_REF="${2:-origin/main}"
  if ! git rev-parse --verify -q "${BASE_REF}^{commit}" >/dev/null 2>&1; then
    echo -e "${RED}✗ Base ref does not resolve to a commit: ${BASE_REF}${NC}" >&2
    exit 2
  fi
  DIFF_RANGE=("${BASE_REF}...HEAD")
  if [ -n "$(git status --porcelain)" ]; then
    echo -e "${YELLOW}⚠ Working tree has uncommitted changes; --base scans committed branch diff only.${NC}" >&2
  fi
elif [ -n "${1:-}" ]; then
  echo "Usage: $0 [--base <ref>]" >&2
  exit 2
fi

if ! DIFF_FILE_LIST=$(git diff "${DIFF_RANGE[@]}" --name-only --diff-filter=ACM); then
  echo -e "${RED}✗ git diff failed. Ensure the base ref is valid and fetched.${NC}" >&2
  exit 1
fi

set +e
FILTERED_FILE_LIST=$(printf '%s\n' "$DIFF_FILE_LIST" | grep -E '\.(ts|js|md|json)$')
FILTERED_FILE_STATUS=$?
set -e
if [ "$FILTERED_FILE_STATUS" -ne 0 ] && [ "$FILTERED_FILE_STATUS" -ne 1 ]; then
  echo -e "${RED}✗ file filter failed while selecting files to scan.${NC}" >&2
  exit 1
fi

SCAN_FILES=()
while IFS= read -r file; do
  [ -n "$file" ] && SCAN_FILES+=("$file")
done < <(printf '%s\n' "$FILTERED_FILE_LIST")

if [ "${#SCAN_FILES[@]}" -eq 0 ]; then
  exit 0
fi

FOUND=0

# 1. Load project-specific patterns from .pii-patterns (gitignored)
if [ -f "$PATTERNS_FILE" ]; then
  echo "Checking for PII patterns..."
  while IFS= read -r pattern; do
    # Skip comments and empty lines
    [[ "$pattern" =~ ^#.*$ || -z "$pattern" ]] && continue

    # Search changed file contents (not filenames).
    MATCHES=$(
      for f in "${SCAN_FILES[@]}"; do
        if grep -l "$pattern" "$f" 2>/dev/null; then
          continue
        fi
        status=$?
        if [ "$status" -ne 1 ]; then
          exit "$status"
        fi
      done
    ) || {
      echo -e "${RED}✗ PII pattern search failed: ${pattern}${NC}" >&2
      exit 1
    }
    if [ -n "$MATCHES" ]; then
      echo -e "${RED}✗ PII pattern found: ${pattern}${NC}"
      echo "$MATCHES" | while read -r f; do
        echo "  → $f"
      done
      FOUND=1
    fi
  done < "$PATTERNS_FILE"
fi

# 2. Generic checks (always run, no project-specific data needed)
# Check for Discord snowflake IDs (17-20 digit numbers in non-test source)
for f in "${SCAN_FILES[@]}"; do
  # Skip test files and config files
  [[ "$f" == *.test.* || "$f" == *.spec.* || "$f" == */tests/* ]] && continue
  [[ "$f" == *.json ]] && continue

  # Discord/Slack/Telegram IDs: 17-20 digit numbers that aren't timestamps
  if grep -Pn '\b[0-9]{17,20}\b' "$f" 2>/dev/null | grep -v 'Date.now\|timestamp\|created_at\|updated_at\|getTime\|setTimeout\|setInterval\|9999999999999\|1234567890' > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠ Possible platform ID in: $f${NC}"
    grep -Pn '\b[0-9]{17,20}\b' "$f" 2>/dev/null | grep -v 'Date.now\|timestamp\|created_at\|updated_at\|getTime\|setTimeout\|setInterval\|9999999999999\|1234567890' | head -3
    echo -e "  ${YELLOW}Review: is this a hardcoded Discord/Slack ID?${NC}"
    # Warning only, don't block (too many false positives)
  fi
done

# 3. Added-line checks for local paths and credential-like prefixes.
BLOCKING_ADDED_LINE_PATTERN=$(
  printf '%s\n' \
    '/'"Users/[[:alnum:]_.-]+/[[:alnum:]_.-]+" \
    '/'"home/[[:alnum:]_.-]+/[[:alnum:]_.-]+" \
    'gh'"p_[[:alnum:]_]{8,}" \
    'xo'"x[baprs]-[[:alnum:]-]{10,}" \
    's'"k-[[:alnum:]_-]{20,}" |
    paste -sd '|' -
)

REVIEW_ADDED_LINE_PATTERN=$(
  printf '%s\n' \
    'tok'"en" \
    'sec'"ret" \
    'pass'"word" \
    'web'"hook" \
    'disc'"ord" \
    'sla'"ck" \
    'tele'"gram" \
    'gm'"ail" \
    'no'"tion" |
    paste -sd '|' -
)

if ! ADDED_LINE_DIFF=$(git diff "${DIFF_RANGE[@]}" --unified=0 -- "${SCAN_FILES[@]}"); then
  echo -e "${RED}✗ git diff failed while scanning added lines.${NC}" >&2
  exit 1
fi

set +e
BLOCKING_ADDED_LINE_MATCHES=$(
  printf '%s\n' "$ADDED_LINE_DIFF" |
    grep -Ein "^[+]([^+]|$).*(${BLOCKING_ADDED_LINE_PATTERN})"
)
BLOCKING_ADDED_LINE_STATUS=$?
set -e
if [ "$BLOCKING_ADDED_LINE_STATUS" -ne 0 ] && [ "$BLOCKING_ADDED_LINE_STATUS" -ne 1 ]; then
  echo -e "${RED}✗ blocking added-line scan failed.${NC}" >&2
  exit 1
fi

if [ -n "$BLOCKING_ADDED_LINE_MATCHES" ]; then
  echo -e "${RED}✗ High-risk private data pattern found in ${MODE} added lines${NC}"
  echo "$BLOCKING_ADDED_LINE_MATCHES"
  FOUND=1
fi

set +e
REVIEW_ADDED_LINE_MATCHES=$(
  printf '%s\n' "$ADDED_LINE_DIFF" |
    grep -Ein "^[+]([^+]|$).*(${REVIEW_ADDED_LINE_PATTERN})"
)
REVIEW_ADDED_LINE_STATUS=$?
set -e
if [ "$REVIEW_ADDED_LINE_STATUS" -ne 0 ] && [ "$REVIEW_ADDED_LINE_STATUS" -ne 1 ]; then
  echo -e "${RED}✗ review added-line scan failed.${NC}" >&2
  exit 1
fi

if [ -n "$REVIEW_ADDED_LINE_MATCHES" ]; then
  echo -e "${YELLOW}⚠ Review ${MODE} added lines for possible private data:${NC}"
  echo "$REVIEW_ADDED_LINE_MATCHES"
  echo -e "  ${YELLOW}Review-only warning: confirm matches are synthetic, generic, or public-safe.${NC}"
fi

if [ "$FOUND" -eq 1 ]; then
  echo ""
  echo -e "${RED}╔══════════════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║  COMMIT BLOCKED: PII detected in changed files      ║${NC}"
  echo -e "${RED}║  Remove personal/project info before committing.    ║${NC}"
  echo -e "${RED}╚══════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo "Patterns file: $PATTERNS_FILE"
  exit 1
fi
