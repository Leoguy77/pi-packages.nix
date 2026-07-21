#!/usr/bin/env nix shell nixpkgs#bash nixpkgs#gnused -c bash
# build-all.sh - Batch build all Tier B packages to discover npmDepsHash values
# Runs TOFU: builds with fake hash, captures the "got:" hash, updates registry
#
# Usage: ./build-all.sh [--verify] [--parallel N]

set -euo pipefail
cd "$(dirname "$0")/.."

PARALLEL=2
VERIFY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --parallel) PARALLEL="$2"; shift 2;;
    --verify) VERIFY=true; shift;;
    *) echo "Unknown: $1"; exit 1;;
  esac
done

REGISTRY="registry/registry.json"
FAKE_HASH="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

# Get all Tier B package keys
KEYS=$(jq -r '.packages | to_entries[] | select(.value.tier == "B") | .key' "$REGISTRY")
TOTAL=$(echo "$KEYS" | wc -l)
echo "Found $TOTAL Tier B packages"

# Batch build with fake hash, capture real hash
BATCH=0
for KEY in $KEYS; do
  BATCH=$((BATCH + 1))
  
  # Skip if npmDepsHash already set and --verify not requested
  CURRENT=$(jq -r ".packages[\"$KEY\"].npmDepsHash // \"\"" "$REGISTRY")
  if [[ -n "$CURRENT" && "$CURRENT" != "$FAKE_HASH" && "$VERIFY" != "true" ]]; then
    echo "[$BATCH/$TOTAL] $KEY — hash known, skipping"
    continue
  fi
  
  echo "[$BATCH/$TOTAL] Building $KEY (TOFU)..."
  
  # Temporarily set fake hash in registry
  jq ".packages[\"$KEY\"].npmDepsHash = \"$FAKE_HASH\"" "$REGISTRY" > "$TMPDIR/reg.json"
  cp "$TMPDIR/reg.json" "$REGISTRY"
  
  # Build and capture hash mismatch
  OUTPUT=$(nix build ".#packages.x86_64-linux.pi-${KEY}" 2>&1 || true)
  GOT=$(echo "$OUTPUT" | grep "got:" | tail -1 | sed 's/.*got:[[:space:]]*//')
  
  if [[ -z "$GOT" ]]; then
    echo "  No hash mismatch — check if build succeeded"
    echo "$OUTPUT" | tail -5
    continue
  fi
  
  echo "  Hash: $GOT"
  
  # Update registry with real hash
  jq ".packages[\"$KEY\"].npmDepsHash = \"$GOT\"" "$REGISTRY" > "$TMPDIR/reg.json"
  cp "$TMPDIR/reg.json" "$REGISTRY"
  
  # Verify build with real hash
  if nix build ".#packages.x86_64-linux.pi-${KEY}" 2>/dev/null; then
    echo "  ✓ Builds with $GOT"
  else
    echo "  ✗ Build failed with real hash"
  fi
done

echo ""
echo "Done. $BATCH packages processed."
echo "Tier A: $(jq '[.packages[] | select(.tier == "A")] | length' "$REGISTRY")"
echo "Tier B: $(jq '[.packages[] | select(.tier == "B")] | length' "$REGISTRY")"
echo "Tier B with hash: $(jq '[.packages[] | select(.tier == "B" and .npmDepsHash != null and .npmDepsHash != "'"$FAKE_HASH"'")] | length' "$REGISTRY")"
