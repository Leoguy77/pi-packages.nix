# pi-packages.nix

Nix-native pi.dev packages — sourced from npm tarballs with integrity hashes. No binary cache needed.

## What is this?

This flake provides **pi native packages** (from the [pi.dev catalog](https://pi.dev/packages)) as Nix derivations with:

- ✅ **Reproducible** - pinned versions, SRI hashes from npm registry
- ✅ **Pure** - no runtime `npm install`, packages loaded directly from Nix store
- ✅ **Fixed-output** — fetchurl + integrity hash, always reproducible
- ✅ **Declarative** - install packages via NixOS/Home Manager options

## Quick Start

### 1. Add as flake input

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    pi-packages = {
      url = "github:Leoguy77/pi-packages.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };
}
```

### 2. Configure NixOS or Home Manager

```nix
# NixOS (configuration.nix or dedicated module)
{ inputs, ... }:
{
  imports = [ inputs.pi-packages.nixosModules.default ];
  
  programs.pi.coding-agent = {
    enable = true;
    packages = [ "pi-rewind" ];  # Package names from registry
  };
}
```

```nix
# Home Manager
{ inputs, ... }:
{
  imports = [ inputs.pi-packages.homeModules.default ];
  
  programs.pi.coding-agent = {
    enable = true;
    packages = [ "pi-rewind" ];
  };
}
```

### 3. Rebuild

```bash
sudo nixos-rebuild switch --flake .
# or
home-manager switch --flake .
```

## Available Packages

See [`registry/registry.json`](./registry/registry.json) for the full list.

| Package | Description | Tier |
|---------|-------------|------|
| `pi-rewind` | Conversation history navigation | A |

**Tiers:**
- **Tier A** - No npm dependencies (peerDeps only) → instant builds, always cached
- **Tier B** - Has npm dependencies → built on demand

## How It Works

1. **Registry generation** - `registry/generate.mjs` crawls npm for `keywords:pi-package`, extracting tarball URLs and SRI hashes
2. **Package building** - `lib.mkPiPackage` fetches and unpacks (Tier A) or builds with `buildNpmPackage` (Tier B)
3. **Module integration** - NixOS/HM modules resolve package names to store paths and write to `settings.packages`
4. **No binary cache needed** — all derivations are fixed-output (fetchurl + integrity hash). Tier A is instant, Tier B builds once per `npmDepsHash` per machine.

## Architecture

```
npm registry (keywords:pi-package)
       ↓
registry/generate.mjs → registry.json (names + hashes)
       ↓
lib.mkPiPackage → /nix/store/...-pi-pkg-foo
       ↓
programs.pi.coding-agent.packages = [ "foo" ]
       ↓
settings.packages = [ "/nix/store/...-pi-pkg-foo" ]
       ↓
pi loads directly from store (no npm install)
```

## Phase 0 Validation

Tested that pi loads local-path packages **without** running `npm install`:

```bash
$ env PI_PROJECT_TRUSTED=1 pi list
Project packages:
  /nix/store/...-pi-pkg-rewind
    /nix/store/...-pi-pkg-rewind

$ env PI_PROJECT_TRUSTED=1 pi "test"
I'm ready to help! What would you like me to work on?
```

✅ Confirmed: Tier A packages load instantly with zero dependencies.

## Roadmap

- [x] Phase 0: Validate purity assumption (local-path loading)
- [x] Phase 1: Basic flake structure + Tier A support
- [ ] Phase 2: Tier B support (buildNpmPackage + importNpmLock)
- [ ] Phase 3: Full registry (all ~4,893 packages)
- [ ] Phase 4: Publish

## Development

```bash
# Test registry generation
node registry/generate.mjs

# Build a specific package
nix build .#packages.x86_64-linux.pi-pi-rewind

# Build all Tier A packages
nix build .#packages.x86_64-linux.tierA
```

## License

MIT
