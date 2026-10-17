#!/usr/bin/env bash
# Run-all verification for the ATC simulator. Does three things, failing fast:
#   1. `node --check` on every .js file under src/ and test/ (syntax check).
#   2. `node --test` over the unit-test suite.
#   3. `node scripts/smoke.mjs` headless simulation smoke test.
#
# Usage: bash scripts/verify.sh  (or: npm run verify)
set -euo pipefail

# Resolve the project root as the parent of this script's directory so the
# script works regardless of the current working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

echo "==> 1/3  node --check on all JS under src/ and test/"
check_count=0
while IFS= read -r -d '' file; do
  node --check "$file"
  check_count=$((check_count + 1))
done < <(find src test -name '*.js' -print0)
echo "    checked $check_count file(s): OK"

echo "==> 2/3  node --test (unit suite)"
node --test 'test/**/*.test.js'

echo "==> 3/3  node scripts/smoke.mjs (headless simulation)"
node scripts/smoke.mjs

echo ""
echo "ALL VERIFICATION PASSED."
