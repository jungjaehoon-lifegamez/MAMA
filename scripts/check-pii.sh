#!/usr/bin/env bash
# Pre-commit PII check: scan staged files for personal/project information.
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
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|js|md|json)$' || true)

if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

FOUND=0

# 1. Load project-specific patterns from .pii-patterns (gitignored)
if [ -f "$PATTERNS_FILE" ]; then
  echo "Checking for PII patterns..."
  while IFS= read -r pattern; do
    # Skip comments and empty lines
    [[ "$pattern" =~ ^#.*$ || -z "$pattern" ]] && continue

    # Search staged file contents (not filenames)
    MATCHES=$(echo "$STAGED_FILES" | xargs grep -ln "$pattern" 2>/dev/null || true)
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
for f in $STAGED_FILES; do
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

# 3. Staged added-line checks for local paths and credential-like prefixes.
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

BLOCKING_ADDED_LINE_MATCHES=$(
  git diff --cached --unified=0 -- $STAGED_FILES |
    grep -Ein "^[+]([^+]|$).*(${BLOCKING_ADDED_LINE_PATTERN})" || true
)

if [ -n "$BLOCKING_ADDED_LINE_MATCHES" ]; then
  echo -e "${RED}✗ High-risk private data pattern found in staged added lines${NC}"
  echo "$BLOCKING_ADDED_LINE_MATCHES"
  FOUND=1
fi

REVIEW_ADDED_LINE_MATCHES=$(
  git diff --cached --unified=0 -- $STAGED_FILES |
    grep -Ein "^[+]([^+]|$).*(${REVIEW_ADDED_LINE_PATTERN})" || true
)

if [ -n "$REVIEW_ADDED_LINE_MATCHES" ]; then
  echo -e "${YELLOW}⚠ Review staged added lines for possible private data:${NC}"
  echo "$REVIEW_ADDED_LINE_MATCHES"
  echo -e "  ${YELLOW}Review-only warning: confirm matches are synthetic, generic, or public-safe.${NC}"
fi

if [ "$FOUND" -eq 1 ]; then
  echo ""
  echo -e "${RED}╔══════════════════════════════════════════════════════╗${NC}"
  echo -e "${RED}║  COMMIT BLOCKED: PII detected in staged files       ║${NC}"
  echo -e "${RED}║  Remove personal/project info before committing.    ║${NC}"
  echo -e "${RED}╚══════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo "Patterns file: $PATTERNS_FILE"
  exit 1
fi
