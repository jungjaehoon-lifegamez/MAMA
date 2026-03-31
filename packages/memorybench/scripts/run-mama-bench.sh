#!/bin/bash
# Run MAMA memory benchmark using memorybench framework
set -e
cd "$(dirname "$0")/.."

# Check dataset
DATASET="data/benchmarks/longmemeval/datasets/longmemeval_s_cleaned.json"
if [ ! -f "$DATASET" ]; then
  echo "Dataset not found. Running download script..."
  ./scripts/download-dataset.sh
fi

# Check MAMA daemon
if ! curl -s http://localhost:3847/health > /dev/null 2>&1; then
  echo "MAMA not running. Start with: mama start"
  exit 1
fi

# Install deps if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  bun install
fi

LIMIT=${1:-12}
JUDGE=${JUDGE:-claude-haiku-4-5-20251001}
ANSWER=${ANSWER:-claude-haiku-4-5-20251001}

echo "Running MAMA benchmark (${LIMIT} questions, judge: $JUDGE)..."
bun run src/cli/index.ts run \
  --provider mama \
  --benchmark longmemeval \
  --limit "$LIMIT" \
  --judge "$JUDGE" \
  --answering-model "$ANSWER" \
  --run-id "mama-bench-$(date +%Y%m%d-%H%M%S)"
