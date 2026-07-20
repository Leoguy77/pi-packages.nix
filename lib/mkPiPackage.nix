# mkPiPackage.nix - Build a pi package from registry entry
#
# Usage:
#   withPkgs = mkPiPackage pkgs;  # returns a function
#   derivation = withPkgs { ... };

pkgs: { name, tarball, hash, tier, version ? "0.0.0", dependencies ? {}, ... }:

let
  tierA = tier == "A" || dependencies == {};
  
  src = pkgs.fetchurl {
    url = tarball;
    inherit hash;
  };
  
in if tierA then
  # Tier A: Pure .ts/.js, no npm deps - just unpack
  pkgs.runCommand "pi-pkg-${name}" { nativeBuildInputs = [ pkgs.gnutar ]; } ''
    mkdir -p $out
    tar -xzf ${src} --strip-components=1 -C $out
  ''
else
  # Tier B: Has dependencies - need node_modules
  let
    # Use a placeholder npmDepsHash that user replaces on first build
    depsHash = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
  in pkgs.buildNpmPackage {
    pname = "pi-pkg-${name}";
    inherit version src;
    npmDepsHash = depsHash;
    dontNpmBuild = true;
    installPhase = ''
      mkdir -p $out
      cp -r . $out/
    '';
  }
