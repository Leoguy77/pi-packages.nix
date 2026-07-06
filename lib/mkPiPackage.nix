# mkPiPackage.nix - Build a pi package from registry entry
#
# Usage:
#   mkPiPackage pkgs { name = "foo"; tarball = "..."; hash = "sha256-..."; tier = "A"; }
#
# Tiers:
#   A - No dependencies (peerDeps only) → simple tarball unpack
#   B - Has dependencies → buildNpmPackage with node_modules

{ pkgs }:

{ name
, tarball
, hash
, tier
, version ? "0.0.0"
, piManifest ? {}
, dependencies ? {}
}:

let
  tierA = tier == "A" || dependencies == {};
  
  src = pkgs.fetchurl {
    inherit tarball hash;
  };
  
in if tierA then
  # Tier A: Pure .ts/.js, no npm deps - just unpack
  pkgs.runCommand "pi-pkg-${name}" { nativeBuildInputs = [ pkgs.gnutar ]; } ''
    mkdir -p $out
    tar -xzf ${src} --strip-components=1 -C $out
  ''
else
  # Tier B: Has dependencies - need node_modules
  pkgs.buildNpmPackage {
    pname = "pi-pkg-${name}";
    inherit version src;
    
    # Try to use importNpmLock if package ships with lockfile
    # Otherwise would need npmDepsHash (generated on first build)
    npmDepsHash = pkgs.lib.optionalString (dependencies != {}) "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    
    dontNpmBuild = true; # pi packages ship source, no build step
    
    installPhase = ''
      mkdir -p $out
      cp -r . $out/
    '';
    
    meta = {
      inherit name version;
      description = "pi package: ${name}";
      homepage = tarball;
    };
  }
