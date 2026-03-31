#!/bin/bash
# Download LongMemEval dataset for MAMA memory benchmark
set -e

DATASET_DIR="$(cd "$(dirname "$0")/.." && pwd)/data/benchmarks/longmemeval/datasets"
DATASET_FILE="$DATASET_DIR/longmemeval_s_cleaned.json"

if [ -f "$DATASET_FILE" ]; then
  echo "Dataset already exists: $DATASET_FILE"
  exit 0
fi

LOCAL="$HOME/.mama/workspace/memorybench/data/benchmarks/longmemeval/datasets/longmemeval_s_cleaned.json"
if [ -f "$LOCAL" ]; then
  echo "Copying from local memorybench..."
  mkdir -p "$DATASET_DIR"
  cp "$LOCAL" "$DATASET_FILE"
  echo "Done: $DATASET_FILE ($(du -h "$DATASET_FILE" | cut -f1))"
  exit 0
fi

echo "Dataset not found. Please download LongMemEval dataset:"
echo "  1. Clone: git clone https://github.com/xiaowu0162/LongMemEval"
echo "  2. Copy: cp LongMemEval/data/longmemeval_s_cleaned.json $DATASET_FILE"
exit 1
