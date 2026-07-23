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
    npmInstallFlags = [ "--ignore-scripts" "--no-audit" "--no-fund" "--legacy-peer-deps" ];
    makeCacheWritable = true;
    # npm install runs during configurePhase; unset SSL_CERT_FILE first
    preConfigure = ''
      unset SSL_CERT_FILE NIX_SSL_CERT_FILE
    '';
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
      # unset so Node.js uses its embedded CA store
      unset SSL_CERT_FILE NIX_SSL_CERT_FILE
      tar -xzf $src --strip-components=1
      HOME=$TMPDIR npm install --ignore-scripts --no-audit --no-fund --legacy-peer-deps --loglevel=error
      rm -rf node_modules/.cache 2>/dev/null || true
    '';
    
    installPhase = ''
      mkdir -p $out
      cp -r . $out/
    '';
  }
