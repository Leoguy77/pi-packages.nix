#!/usr/bin/env nix shell nixpkgs#bash nixpkgs#gnused nixpkgs#findutils -c bash
# tofu-build.sh - Discover npmDepsHash for Tier B packages via TOFU builds
#
# For each Tier B package without a known npmDepsHash:
#   1. Set a fake hash
#   2. Build (fails with hash mismatch)
#   3. Capture the "got:" hash
#   4. Update registry.json
#   5. Rebuild to verify
#
# Usage: ./scripts/tofu-build.sh [--parallel N] [--resume] [--packages KEY,KEY,...]

set -euo pipefail
cd "$(dirname "$0")/.."

PARALLEL=1
RESUME=false
FILTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --parallel) PARALLEL="$2"; shift 2;;
    --resume) RESUME=true; shift;;
    --packages) FILTER="$2"; shift 2;;
    *) echo "Unknown: $1"; exit 1;;
  esac
done

REGISTRY="registry/registry.json"
FAKE_HASH="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

# Get Tier B packages without known hash
if [[ -n "$FILTER" ]]; then
  mapfile -t PKGS < <(echo "$FILTER" | tr ',' '\n')
else
  mapfile -t PKGS < <(jq -r '.packages | to_entries[] | select(.value.tier == "B" and (.value.npmDepsHash == null or .value.npmDepsHash == "" or .value.npmDepsHash == "'"$FAKE_HASH"'")) | .key' "$REGISTRY")
fi

TOTAL=${#PKGS[@]}
echo "Found $TOTAL Tier B packages needing hash discovery"
[[ $TOTAL -eq 0 ]] && exit 0

BATCHES=$(( (TOTAL + PARALLEL - 1) / PARALLEL ))
SUCCESS=0
FAIL=0

process_one() {
  local KEY="$1" BATCH="$2"
  local CURRENT
  CURRENT=$(jq -r ".packages[\"$KEY\"].npmDepsHash // \"\"" "$REGISTRY")
  
  # Skip if already has a real hash
  if [[ -n "$CURRENT" && "$CURRENT" != "$FAKE_HASH" ]]; then
    echo "[$BATCH/$TOTAL] $KEY — hash known (${CURRENT:0:20}...), skipping"
    return 0
  fi
  
  echo "[$BATCH/$TOTAL] $KEY — building to discover hash..."
  
  # Set fake hash
  jq ".packages[\"$KEY\"].npmDepsHash = \"$FAKE_HASH\"" "$REGISTRY" > "${REGISTRY}.tmp"
  cp "${REGISTRY}.tmp" "$REGISTRY"
  
  # Build and capture output
  local OUTPUT
  OUTPUT=$(nix build ".#packages.x86_64-linux.pi-${KEY}" 2>&1 || true)
  local GOT
  GOT=$(echo "$OUTPUT" | grep "got:" | tail -1 | sed 's/.*got:[[:space:]]*//')
  
  if [[ -z "$GOT" ]]; then
    # Check if build succeeded (wasn't a hash mismatch)
    if echo "$OUTPUT" | grep -q "hash mismatch"; then
      echo "  Failed to extract hash from: $OUTPUT" | tail -3
    elif ls result 2>/dev/null; then
      echo "  No hash needed (build succeeded with fake hash)"
      return 0
    else
      echo "  Build failed, no hash found"
      echo "$OUTPUT" | tail -5
    fi
    return 1
  fi
  
  echo "  → $GOT"
  
  # Update registry
  jq ".packages[\"$KEY\"].npmDepsHash = \"$GOT\"" "$REGISTRY" > "${REGISTRY}.tmp"
  cp "${REGISTRY}.tmp" "$REGISTRY"
  
  # Verify
  rm -f result
  if nix build ".#packages.x86_64-linux.pi-${KEY}" 2>/dev/null; then
    echo "  ✓ Verified: $KEY builds with $GOT"
    return 0
  else
    echo "  ✗ Verify failed for $KEY"
    return 1
  fi
}

BATCH=0
for ((i=0; i<TOTAL; i+=PARALLEL)); do
  BATCH=$((BATCH + 1))
  
  # Build this batch in parallel
  for ((j=0; j<PARALLEL && i+j<TOTAL; j++)); do
    KEY="${PKGS[$((i+j))]}"
    if process_one "$KEY" "$((i+j+1))"; then
      SUCCESS=$((SUCCESS + 1))
    else
      FAIL=$((FAIL + 1))
    fi &
  done
  
  # Wait for this batch
  wait
done

rm -f "${REGISTRY}.tmp"
echo ""
echo "=== Results ==="
echo "Success: $SUCCESS"
echo "Failed:  $FAIL"
echo "Total:   $TOTAL"
