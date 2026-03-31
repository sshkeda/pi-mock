#!/bin/bash
# Run the test suite across multiple Node.js versions in Docker.
#
# Usage:
#   ./test/docker-matrix.sh              # test Node 20, 22, 24
#   ./test/docker-matrix.sh 22           # test only Node 22
#   ./test/docker-matrix.sh 20 22        # test Node 20 and 22
#
# Environment variables:
#   PI_VERSION  — pi version to test against (default: 0.64)

set -euo pipefail

VERSIONS=("${@:-20 22 24}")
PI_VERSION="${PI_VERSION:-0.64}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

passed=0
failed=0
skipped=0

for ver in "${VERSIONS[@]}"; do
  tag="pi-mock-test:node${ver}"
  echo ""
  echo "═══════════════════════════════════════════════════════════"
  echo " Node ${ver} (pi ${PI_VERSION})"
  echo "═══════════════════════════════════════════════════════════"

  if ! docker build \
    --build-arg "NODE_VERSION=${ver}" \
    --build-arg "PI_VERSION=${PI_VERSION}" \
    -f "${PROJECT_DIR}/Dockerfile.test" \
    -t "${tag}" \
    "${PROJECT_DIR}" 2>&1; then
    echo "SKIP: build failed for Node ${ver}"
    skipped=$((skipped + 1))
    continue
  fi

  if docker run --rm "${tag}" 2>&1; then
    echo "PASS: Node ${ver}"
    passed=$((passed + 1))
  else
    echo "FAIL: Node ${ver}"
    failed=$((failed + 1))
  fi
done

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " Results: ${passed} passed, ${failed} failed, ${skipped} skipped"
echo "═══════════════════════════════════════════════════════════"

exit "${failed}"
