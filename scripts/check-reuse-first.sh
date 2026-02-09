#!/bin/bash
# MAMA Reuse-First Checker
# Usage: ./scripts/check-reuse-first.sh "feature_name"

set -e

FEATURE="${1}"

if [ -z "$FEATURE" ]; then
  echo "Usage: $0 <feature_name>"
  echo "Example: $0 'saveDecision'"
  exit 1
fi

echo "🔍 Checking if '$FEATURE' already exists in MAMA codebase..."
echo ""

# Check mcp-server/src/mama/ (CRITICAL)
echo "=== Checking packages/mcp-server/src/mama/ (70% of features exist here) ==="
if grep -r "$FEATURE" packages/mcp-server/src/mama/ 2>/dev/null; then
  echo ""
  echo "⚠️  FOUND in mcp-server/src/mama/"
  echo "✅  ACTION: Extract and reuse existing code instead of rewriting"
  echo ""
  FOUND=1
else
  echo "Not found in mcp-server/src/mama/"
  echo ""
fi

# Check mama-core modules
echo "=== Checking packages/mama-core/src/ ==="
if grep -r "$FEATURE" packages/mama-core/src/ 2>/dev/null; then
  echo ""
  echo "⚠️  FOUND in mama-core/src/"
  echo "✅  ACTION: Reuse existing mama-core module"
  echo ""
  FOUND=1
else
  echo "Not found in mama-core/src/"
  echo ""
fi

# Check plugin
echo "=== Checking packages/claude-code-plugin/ ==="
if grep -r "$FEATURE" packages/claude-code-plugin/ 2>/dev/null; then
  echo ""
  echo "ℹ️  FOUND in claude-code-plugin/"
  echo "Note: Plugin may have duplicated code from mama-core"
  echo ""
  FOUND=1
else
  echo "Not found in claude-code-plugin/"
  echo ""
fi

if [ -z "$FOUND" ]; then
  echo "✅ Feature '$FEATURE' not found in existing codebase"
  echo "✅ Safe to implement as new feature"
else
  echo "⚠️  Feature '$FEATURE' already exists"
  echo "⚠️  CRITICAL: Reuse existing code instead of rewriting"
  echo ""
  echo "📖 See: .claude/WORKFLOW.md → Reuse-First Verification"
fi

echo ""
echo "---"
echo "📚 For detailed search, use: rg '$FEATURE' packages/"
