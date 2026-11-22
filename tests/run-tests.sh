#!/bin/bash
# Full local test for this entry. Run from the repository root with the kit
# unpacked at ../kit/sokoban-solver-01-run-20261121-kit (the path used during
# development; adjust KIT if yours is elsewhere).
#   1. solves the kit's practice set and verifies every solution against the
#      practice manifest's P* values (expects 1,000,000),
#   2. solves the four hand-written edge levels and verifies them,
#   3. checks determinism: two runs on the practice set must be byte-identical.
set -e
cd "$(dirname "$0")/.."
KIT="${KIT:-../kit/sokoban-solver-01-run-20261121-kit}"

rm -rf /tmp/sokoban-test-out /tmp/sokoban-test-out2 /tmp/sokoban-edge-out
mkdir -p /tmp/sokoban-test-out /tmp/sokoban-test-out2 /tmp/sokoban-edge-out

echo "== practice set =="
MAKEFUN_INPUT_DIR="$KIT/practice/input" MAKEFUN_OUTPUT_DIR=/tmp/sokoban-test-out node main.ts
node tests/verify.mjs "$KIT/practice/input" /tmp/sokoban-test-out "$KIT/practice/reference/manifest.json"

echo "== edge levels =="
MAKEFUN_INPUT_DIR=tests/edge-input MAKEFUN_OUTPUT_DIR=/tmp/sokoban-edge-out node main.ts
node tests/verify.mjs tests/edge-input /tmp/sokoban-edge-out

echo "== determinism =="
MAKEFUN_INPUT_DIR="$KIT/practice/input" MAKEFUN_OUTPUT_DIR=/tmp/sokoban-test-out2 node main.ts
diff -r /tmp/sokoban-test-out /tmp/sokoban-test-out2 && echo "identical outputs"
