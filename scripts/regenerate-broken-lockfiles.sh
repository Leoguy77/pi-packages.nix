#!/usr/bin/env nix shell nixpkgs#bash nixpkgs#nodejs_22 nixpkgs#curl -c bash
# regenerate-broken-lockfiles.sh - Regenerate lockfiles for packages missing them

set -euo pipefail
FLAKE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REGISTRY="$FLAKE_DIR/registry/registry.json"
PACKAGES_DIR="$FLAKE_DIR/packages"
TMP="/tmp/pi-regen-locks"
NPM_CACHE="$TMP/shared-cache"
CONCURRENCY=${CONCURRENCY:-2}

rm -rf "$TMP" && mkdir -p "$TMP" "$NPM_CACHE"

# Find packages in registry that are Tier B but have no lockfile
mapfile -t MISSING < <(node -e "
const r=JSON.parse(require('fs').readFileSync('$REGISTRY','utf8'));
const {existsSync}=require('fs');
const keys=Object.keys(r.packages||{}).filter(k=>{
  const e=r.packages[k];
  return e.tier==='B'&&!existsSync('$PACKAGES_DIR/'+k+'/package-lock.json');
});
console.log(keys.join('\n'));
")

echo "Missing lockfiles: ${#MISSING[@]}"
[[ ${#MISSING[@]} -eq 0 ]] && exit 0

regenerate_one() {
  local KEY="$1" TOTAL="$2" IDX="$3"
  local ENTRY
  ENTRY=$(node -e "const r=JSON.parse(require('fs').readFileSync('$REGISTRY','utf8'));console.log(JSON.stringify(r.packages['$KEY']))")
  local NAME TARBALL
  NAME=$(node -e "console.log(JSON.parse(process.argv[1]).name)" "$ENTRY")
  TARBALL=$(node -e "console.log(JSON.parse(process.argv[1]).tarball)" "$ENTRY")
  
  local LOCKFILE="$PACKAGES_DIR/$KEY/package-lock.json"
  mkdir -p "$PACKAGES_DIR/$KEY"
  
  local WORKDIR="$TMP/$KEY"
  rm -rf "$WORKDIR" && mkdir -p "$WORKDIR/pkg"
  
  echo "[$IDX/$TOTAL] $NAME"
  
  # Download tarball
  curl -sL --max-time 60 "$TARBALL" -o "$WORKDIR/pkg.tgz" 2>/dev/null
  tar -xzf "$WORKDIR/pkg.tgz" --strip-components=1 -C "$WORKDIR/pkg"
  
  # Step 1: package-lock-only (fast)
  if HOME="$WORKDIR" npm --prefix="$WORKDIR/pkg" install --package-lock-only --ignore-scripts --no-audit --no-fund --legacy-peer-deps --loglevel=error --cache="$NPM_CACHE" 2>/dev/null; then
    # Step 2: full install to fill integrity (slower but reliable)
    if HOME="$WORKDIR" npm --prefix="$WORKDIR/pkg" install --ignore-scripts --no-audit --no-fund --legacy-peer-deps --prefer-offline --loglevel=error --cache="$NPM_CACHE" 2>/dev/null; then
      rm -rf "$WORKDIR/pkg"/node_modules
      cp "$WORKDIR/pkg"/package-lock.json "$LOCKFILE"
      return 0
    fi
  fi
  
  # Fallback: try just the lockfile we got
  if [ -f "$WORKDIR/pkg"/package-lock.json ]; then
    rm -rf "$WORKDIR/pkg"/node_modules 2>/dev/null
    cp "$WORKDIR/pkg"/package-lock.json "$LOCKFILE"
    echo "  ⚠ partial lockfile (full npm install failed)"
    return 0
  fi
  
  echo "  ✗ failed"
  return 1
}

TOTAL=${#MISSING[@]}
SUCCESS=0
FAIL=0

for ((i=0; i<TOTAL; i+=CONCURRENCY)); do
  BATCH=()
  for ((j=0; j<CONCURRENCY && i+j<TOTAL; j++)); do
    regenerate_one "${MISSING[$((i+j))]}" "$TOTAL" "$((i+j+1))" &
    BATCH+=($!)
  done
  for pid in "${BATCH[@]}"; do
    wait "$pid" && SUCCESS=$((SUCCESS+1)) || FAIL=$((FAIL+1))
  done
done

echo ""
echo "Done: $SUCCESS success, $FAIL failed"
