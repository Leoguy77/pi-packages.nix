# mkPiPackage.nix - Build a pi package from registry entry
#
# Tiers:
#   A - No npm dependencies → unpack tarball (instant)
#   B - Has dependencies → buildNpmPackage with pre-generated lockfile
#
# The registry generator (generate.mjs) pre-generates lockfiles and stores
# them at packages/<name>/package-lock.json relative to the flake root.

{ pkgs, lib }:

{ name, tarball, hash, tier, packagesDir
, version ? "0.0.0", dependencies ? {}, npmDepsHash ? null, ... }:

let
  tierA = tier == "A" || dependencies == {};
  
  tarballSrc = pkgs.fetchurl {
    url = tarball;
    inherit hash;
  };
  
in if tierA then
  
  pkgs.runCommand "pi-pkg-${name}" { nativeBuildInputs = [ pkgs.gnutar ]; } ''
    mkdir -p $out
    tar -xzf ${tarballSrc} --strip-components=1 -C $out
  ''
  
else
  
  let
    lockPath = packagesDir + "/${name}/package-lock.json";
    hasLock = builtins.pathExists lockPath;
    
    # Merge lockfile into src to avoid store path refs in npmDeps sub-derivation
    src = if hasLock then pkgs.runCommand "src-${name}" {
      nativeBuildInputs = [ pkgs.gnutar ];
    } ''
      mkdir -p $out
      tar -xzf ${tarballSrc} --strip-components=1 -C $out
      cp ${lockPath} $out/package-lock.json
    '' else tarballSrc;
    
  # Has valid lockfile → buildNpmPackage (cached via npmDepsHash)
  # No lockfile → stdenv.mkDerivation with inline npm install (uncached)
  in if hasLock then pkgs.buildNpmPackage {
    pname = "pi-pkg-${name}";
    inherit version src;
    
    npmDepsHash = if npmDepsHash != null then npmDepsHash
      else "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    
    dontNpmBuild = true;
    # Suppress scripts globally (npm rebuild in configurePhase) and skip optional
    # platform-specific deps (e.g., @biomejs/cli-win32-arm64 on x86_64-linux).
    npmFlags = [ "--ignore-scripts" "--omit=optional" "--no-audit" "--no-fund" ];
    npmInstallFlags = [ "--legacy-peer-deps" ];
    # Version 2 fetcher handles more edge cases (lockfiles with missing resolved URLs)
    npmDepsFetcherVersion = 2;
    makeCacheWritable = true;
    # npm install runs during configurePhase; unset SSL_CERT_FILE first
    preConfigure = ''
      unset SSL_CERT_FILE NIX_SSL_CERT_FILE
    '';
    # Also set at derivation level for child processes
    NODE_TLS_REJECT_UNAUTHORIZED = "0";
    installPhase = ''
      mkdir -p $out
      cp -r . $out/
      rm -rf $out/node_modules/.cache 2>/dev/null || true
    '';
  } else pkgs.stdenv.mkDerivation {
    pname = "pi-pkg-${name}";
    inherit version;
    src = tarballSrc;
    phases = [ "unpackPhase" "buildPhase" "installPhase" ];
    nativeBuildInputs = [ pkgs.gnutar pkgs.nodejs ];
    
    HOME = "/tmp";  # npm needs writable HOME
    
    # ponytail: inline npm install for packages without lockfile.
    # Requires network access — use --option sandbox false or CI with
    # magic-nix-cache-action (which disables sandbox).
    # 1663/1833 Tier B packages have valid lockfiles and use buildNpmPackage.
    buildPhase = ''
      # stdenv sets SSL_CERT_FILE=/no-cert-file.crt which breaks TLS;
      # unset + set reject to 0 for child processes that re-read env
      unset SSL_CERT_FILE NIX_SSL_CERT_FILE
      export NODE_TLS_REJECT_UNAUTHORIZED=0
      tar -xzf $src --strip-components=1
      HOME=$TMPDIR npm install --ignore-scripts --no-audit --no-fund --legacy-peer-deps --omit=optional --loglevel=error
      rm -rf node_modules/.cache 2>/dev/null || true
    '';
    
    installPhase = ''
      mkdir -p $out
      cp -r . $out/
    '';
  }
