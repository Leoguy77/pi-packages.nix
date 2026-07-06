{
  description = "Nix-native pi.dev packages with free Garnix caching";

  nixConfig = {
    extra-substituters = [
      "https://cache.garnix.io"
    ];
    extra-trusted-public-keys = [
      "cache.garnix.io:CTFPyKSLcx5RMJKfLo5EEPUObbA78b0YQ2DTCJXqr9g="
    ];
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      
      forAllSystems = nixpkgs.lib.genAttrs systems;
      
      # Load registry
      registry = builtins.fromJSON (builtins.readFile ./registry/registry.json);
      
      # Import mkPiPackage helper
      mkPiPackage = import ./lib/mkPiPackage.nix;
      
      # Build all packages for a system
      buildPackages = pkgs:
        nixpkgs.lib.mapAttrs' (name: entry:
          nixpkgs.lib.nameValuePair "pi-${name}" (mkPiPackage pkgs entry)
        ) registry.packages;
        
      # Tier A only (no npm deps - fast builds)
      buildTierA = pkgs:
        nixpkgs.lib.mapAttrs' (name: entry:
          nixpkgs.lib.nameValuePair "pi-${name}" (mkPiPackage pkgs entry)
        ) (nixpkgs.lib.filterAttrs (_: e: e.tier == "A") registry.packages);
        
    in {
      lib = {
        inherit mkPiPackage;
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
        }
      );
      
      nixosModules.default = import ./modules/nixos.nix;
      homeModules.default = import ./modules/home-manager.nix;
    };
}
