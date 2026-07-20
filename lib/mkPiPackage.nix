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
    
  in pkgs.buildNpmPackage {
    pname = "pi-pkg-${name}";
    inherit version src;
    
    npmDepsHash = if npmDepsHash != null then npmDepsHash
      else "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    
    dontNpmBuild = true;
    npmInstallFlags = [ "--ignore-scripts" "--no-audit" "--no-fund" ];
    makeCacheWritable = true;
    
    installPhase = ''
      mkdir -p $out
      cp -r . $out/
      rm -rf $out/node_modules/.cache 2>/dev/null || true
    '';
  }
