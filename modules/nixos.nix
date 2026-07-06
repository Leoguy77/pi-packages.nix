# NixOS module for pi-packages.nix
#
# Usage:
#   imports = [ inputs.pi-packages.nixosModules.default ];
#   programs.pi.coding-agent.packages = [ "pi-rewind" ];

{ config, lib, pkgs, ... }:

let
  cfg = config.programs.pi.coding-agent;
  registry = builtins.fromJSON (builtins.readFile ../registry/registry.json);
  mkPiPackage = import ../lib/mkPiPackage.nix { inherit pkgs; };
  
  # Resolve package names to store paths
  resolvePackages = names:
    map (name: 
      let entry = registry.packages.${name} or (throw "Unknown pi package: ${name}");
      in "${mkPiPackage entry}"
    ) names;
    
in {
  options.programs.pi.coding-agent.packages = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    default = [];
    example = [ "pi-rewind" ];
    description = "pi native packages to install (from pi-packages.nix registry)";
  };
  
  config = lib.mkIf (cfg.packages != []) {
    programs.pi.coding-agent.settings.packages = resolvePackages cfg.packages;
  };
}
