{
  description = "Nix-native pi.dev packages — sourced from npm, no binary cache needed";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      
      forAllSystems = nixpkgs.lib.genAttrs systems;
      
      registry = builtins.fromJSON (builtins.readFile ./registry/registry.json);
      
      mkPiPackage = import ./lib/mkPiPackage.nix;
      
      packagesDir = ./packages;
      
      # Sanitize registry names for Nix attribute paths (dots are path separators)
      safeName = name: builtins.replaceStrings ["."] ["_"] name;

      # Build a single package given pkgs and a registry entry
      # `name` here is the registry KEY, which is also the packages/<dir> where
      # the generated lockfile lives. Pass it as `key` so mkPiPackage resolves the
      # lockfile path; entry.name (npm name) is still used for the output pname.
      # Previously mkPiPackage used the npm name for the lockfile path, so hasLock
      # was false for ~2370 packages, silently routing them to the slow /
      # network-dependent inline-npm build branch.
      buildOne = pkgs: name: entry:
        nixpkgs.lib.nameValuePair "pi-${safeName name}"
          ((mkPiPackage { inherit pkgs; lib = nixpkgs.lib; }) (entry // { inherit packagesDir; key = name; }));

      # A registry entry may declare npm's `os` field, which a package on a platform it
      # does not support cannot build under. Windows-only entries are dropped at crawl
      # time; macOS-only ones are kept because Nix runs there, so they must be skipped
      # on Linux (and vice versa) instead of failing evaluation.
      fitsSystem = system: entry:
        let os = entry.os or null;
            here = if nixpkgs.lib.hasInfix "darwin" system then "darwin" else "linux";
            denied = builtins.filter (o: nixpkgs.lib.hasPrefix "!" o) os;
        in if os == null then true
           else if denied != [] then
             !(builtins.elem ("!" + here) denied)
           else builtins.elem here os;

      # Build all packages for a system
      buildPackages = pkgs:
        nixpkgs.lib.mapAttrs' (name: buildOne pkgs name)
          (nixpkgs.lib.filterAttrs (_: fitsSystem pkgs.stdenv.hostPlatform.system) registry.packages);
        
      buildTierA = pkgs:
        nixpkgs.lib.mapAttrs' (name: buildOne pkgs name)
          (nixpkgs.lib.filterAttrs (_: e: e.tier == "A" && fitsSystem pkgs.stdenv.hostPlatform.system e) registry.packages);
      
      buildTierB = pkgs:
        nixpkgs.lib.mapAttrs' (name: buildOne pkgs name)
          (nixpkgs.lib.filterAttrs (_: e: e.tier == "B" && fitsSystem pkgs.stdenv.hostPlatform.system e) registry.packages);
        
    in {
      lib = {
        mkPiPackage = import ./lib/mkPiPackage.nix;
      };
      
      packages = forAllSystems (system:
        let pkgs = import nixpkgs { inherit system; };
        in buildPackages pkgs // {
          all = pkgs.symlinkJoin {
            name = "pi-packages-all";
            paths = builtins.attrValues (buildPackages pkgs);
          };
          tierA = pkgs.symlinkJoin {
            name = "pi-packages-tierA";
            paths = builtins.attrValues (buildTierA pkgs);
          };
          tierB = pkgs.symlinkJoin {
            name = "pi-packages-tierB";
            paths = builtins.attrValues (buildTierB pkgs);
          };
        }
      );
      
      nixosModules.default = import ./modules/nixos.nix;
      homeModules.default = import ./modules/home-manager.nix;
    };
}
