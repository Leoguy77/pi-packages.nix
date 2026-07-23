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
      buildOne = pkgs: name: entry:
        nixpkgs.lib.nameValuePair "pi-${safeName name}"
          ((mkPiPackage { inherit pkgs; lib = nixpkgs.lib; }) (entry // { inherit packagesDir; }));
      
      # Build all packages for a system
      buildPackages = pkgs:
        nixpkgs.lib.mapAttrs' (name: buildOne pkgs name) registry.packages;
        
      buildTierA = pkgs:
        nixpkgs.lib.mapAttrs' (name: buildOne pkgs name)
          (nixpkgs.lib.filterAttrs (_: e: e.tier == "A") registry.packages);
      
      buildTierB = pkgs:
        nixpkgs.lib.mapAttrs' (name: buildOne pkgs name)
          (nixpkgs.lib.filterAttrs (_: e: e.tier == "B") registry.packages);
        
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
