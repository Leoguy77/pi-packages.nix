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

**5,311 packages** from the [npm `pi-package` keyword catalog](https://www.npmjs.com/search?q=keywords:pi-package) (3,461 Tier A + 1,850 Tier B).

See [`registry/registry.json`](./registry/registry.json) for the full list.

**Tiers:**
- **Tier A** (3,461) — No npm dependencies (peerDeps only) → instant unpack from tarball
- **Tier B with lockfile** (1,815) — Has dependencies, builds via `buildNpmPackage` with pre-generated lockfile (cached)
- **Tier B fallback** (35) — Has dependencies but no valid lockfile (broken npm dep trees, private packages, git deps), builds via inline `npm install` (needs `--option sandbox false`)

## How It Works

1. **Registry generation** — `registry/generate.mjs` crawls npm for `keywords:pi-package`, extracting tarball URLs and SRI hashes. Runs nightly via CI cron.
2. **Lockfile generation** — For Tier B packages, lockfiles are pre-generated with 2-step npm install (metadata → full install for integrity → delete `node_modules`). Stored in `packages/<name>/package-lock.json`.
3. **Package building** — `lib.mkPiPackage`:
   - Tier A: `fetchurl` + `tar` (fixed-output, instant)
   - Tier B with lockfile: `buildNpmPackage` with lockfile merged into `src` (cached via `npmDepsHash`)
   - Tier B fallback: `stdenv.mkDerivation` + inline `npm install` (uncached, needs `--option sandbox false`)
4. **Module integration** — NixOS/HM modules resolve package names to store paths and write to `settings.packages`
5. **No binary cache needed** — Tier A is always cached (fixed-output). Tier B lockfile packages build once per `npmDepsHash` per machine.

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

## Stats

| Metric | Count |
|--------|-------|
| Total packages | 5,311 |
| Tier A (zero deps, direct unpack) | 3,461 |
| Tier B (has npm deps) | 1,850 |
| With lockfile (`buildNpmPackage`, cached) | 1,815 |
| Fallback (`stdenv.mkDerivation`, needs network) | 35 |

Broken lockfile cleanup removes entries with unfixable integrity (git deps, yanked packages, private scoped packages). The 35 fallback packages have genuinely unresolvable npm dep trees.

## Development

```bash
# Test registry generation (metadata only, fast)
REGISTRY_ONLY=1 node registry/generate.mjs

# Generate lockfiles for Tier B packages
LOCKS_ONLY=1 node registry/generate.mjs

# Build a specific package
nix build .#packages.x86_64-linux.pi-pi-rewind

# Build all Tier A packages
nix build .#packages.x86_64-linux.tierA

# Build all Tier B packages with lockfiles
nix build .#packages.x86_64-linux.tierB
```

## Automatic Updates

Registry + lockfiles update nightly via GitHub Actions:

1. **`check` job** (every push/PR) — runs `nix flake check`
2. **`update-registry` job** (nightly cron + manual trigger):
   - Update package metadata from npm → `registry.json`
   - Generate lockfiles for new Tier B packages → `packages/<name>/package-lock.json`
   - Fix missing integrity hashes via registry API
   - Delete broken lockfiles (git deps, private packages)
   - Push changes directly to `main` (no PR — automated metadata needs no review)

Trigger manually:
```bash
gh workflow run -R Leoguy77/pi-packages.nix update.yml --ref main
```

## License

MIT
