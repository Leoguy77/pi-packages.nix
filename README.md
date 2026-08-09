# pi-packages.nix

Nix-native [pi.dev](https://pi.dev/packages) packages — sourced from npm tarballs with SRI integrity hashes, backed by an Attic binary cache.

## What is this?

This flake provides **5,755 pi native packages** (from the [npm `pi-package` keyword catalog](https://www.npmjs.com/search?q=keywords:pi-package)) as pure Nix derivations:

| Feature | Description |
| --------- | ------------- |
| ✅ **Reproducible** | Pinned versions, SRI hashes from npm registry, deterministic builds |
| ✅ **Pure** | No runtime `npm install` — packages loaded directly from the Nix store |
| ✅ **Fixed-output** | `fetchurl` + integrity hash for Tier A; `buildNpmPackage` with lockfile for Tier B |
| ✅ **Declarative** | Install packages via `programs.pi.coding-agent.packages` (NixOS / Home Manager) |
| ✅ **Attic binary cache** | Tier B builds cached at `nix-cache.lsinfra.de/pi-packages` — public key below |

---

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
    packages = [ "pi-rewind" "ponytail" ];   # Package keys from registry
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

### 4. Use the Attic binary cache (recommended)

Tier B packages with dependencies build via `buildNpmPackage`. The project runs a public [Attic](https://attic.rs/) cache so you rarely need to build them yourself:

```nix
# In your Nix configuration
nix.settings = {
  extra-substituters = [ "https://nix-cache.lsinfra.de/pi-packages" ];
  extra-trusted-public-keys = [ "pi-packages:OF+SNU2ALJB8M+cQP/RfFOuKIOMN0w4WiV8k01pvUC4=" ];
};
```

Without the cache, Tier B packages build from source (deterministic, but takes a few minutes each).

---

## Available Packages

**6,509 packages** — see [`registry/registry.json`](./registry/registry.json) for the full list.

### Tiers

| Tier | Count | Description |
| ------ | ------- | ------------- |
| **Tier A** | 3,763 | No npm dependencies (peerDeps only) → instant `fetchurl` + `tar` unpack |
| **Tier B with lockfile** | 1,969 | Has dependencies, builds via `buildNpmPackage` with pre-generated lockfile (cached) |
| **Tier B fallback** | 23 | Has dependencies but no valid lockfile (broken npm dep trees, private packages, git deps) → inline `npm install` (needs `--option sandbox false`) |

### Registry structure

Each entry in `registry.json` contains:

```json
{
  "packages": {
    "pi-rewind": {
      "name": "@ayulab/pi-rewind",
      "version": "0.4.2",
      "tarball": "https://registry.npmjs.org/.../pi-rewind-0.4.2.tgz",
      "hash": "sha256-...",
      "tier": "A",
      "piManifest": { "extensions": ["./index.js"] },
      "dependencies": {},
      "peerDependencies": {},      # Optional — peer deps from the npm package
      "keywords": [],              # Optional — npm keywords
      "description": "",           # Optional — npm description
      "downloads": 0,              # Placeholder for future stats
      "npmDepsHash": "sha256-..." # Tier B only — SRI hash for buildNpmPackage's npmDeps
    }
  }
}
```

---

## Architecture

```
npm registry (keywords:pi-package)
       ↓
registry/generate.mjs → registry.json (names + hashes)
       ↓
  ┌──── Tier A ──── fetchurl + tar (instant, always cached)
  │
  ├──── Tier B ──── buildNpmPackage with lockfile (cached via npmDepsHash)
  │
  └──── Tier B ──── stdenv.mkDerivation + inline npm install (fallback, needs network)
       ↓
lib.mkPiPackage → /nix/store/...-pi-pkg-foo
       ↓
programs.pi.coding-agent.packages = [ "foo" ]
       ↓
settings.packages = [ "/nix/store/...-pi-pkg-foo" ]
       ↓
pi loads directly from store (no npm install)
```

---

## How It Works

1. **Registry generation** — `registry/generate.mjs` crawls the npm registry for packages tagged with `keywords:pi-package`, extracting tarball URLs and SRI integrity hashes. Runs nightly via CI cron.

2. **Lockfile generation** — For Tier B packages, lockfiles are pre-generated with a 2-step npm process (package-lock-only for resolution → full install for integrity hashes → delete `node_modules`). Stored in `packages/<name>/package-lock.json`.

3. **Package building** — `lib/mkPiPackage.nix`:
   - **Tier A**: `fetchurl` + `tar` (fixed-output derivation, instant, always cached)
   - **Tier B with lockfile**: `buildNpmPackage` with lockfile merged into `src`. Cached via `npmDepsHash`. Uses `--ignore-scripts`, `--omit=optional`, `--legacy-peer-deps`.
   - **Tier B fallback**: `stdenv.mkDerivation` + inline `npm install` (uncached, requires `--option sandbox false`)

4. **Module integration** — NixOS / Home Manager modules resolve package names to store paths and write to `pi settings.packages`. Module source: [`modules/`](./modules/).

5. **Attic binary cache** — CI builds all Tier B packages and pushes them to an Attic cache. Configure your Nix daemon to use it (see Quick Start above) for instant Tier B installs.

---

## Development

### Prerequisites

- [Nix](https://nixos.org) with flakes enabled (`nix.settings.experimental-features = ["nix-command" "flakes"]`)
- Node.js 22+ (for registry generation scripts)

### Commands

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

# Build everything
nix build .#packages.x86_64-linux.all

# Run flake checks
nix flake check

# Update README stats from current registry.json
node scripts/update-readme-stats.mjs
```

### Scripts

| Script | Purpose |
| -------- | --------- |
| `registry/generate.mjs` | Crawl npm for `pi-package` keyword, generate registry + lockfiles |
| `scripts/tofu-build.sh` | Discover `npmDepsHash` for Tier B packages via TOFU builds (fake hash → capture "got:" → verify) |
| `scripts/regenerate-broken-lockfiles.sh` | Regenerate lockfiles for packages missing them |
| `scripts/build-all.sh` | Batch-build Tier B packages to discover hashes |
| `scripts/update-readme-stats.mjs` | Update statistics in the README from `registry.json` |

### Building Tier A packages

```bash
nix build .#packages.x86_64-linux.tierA
nix build .#packages.x86_64-linux.pi-pi-rewind    # single package
```

### Building Tier B packages (TOFU hash discovery)

Tier B packages need an `npmDepsHash` in `registry.json`. The CI computes this automatically, but for local development:

```bash
# Single package — set a fake hash, build, capture the "got:" hash
nix build .#packages.x86_64-linux.pi-my-tool 2>&1 | grep "got:"

# Batch — run the TOFU script (uses buildNpmPackage's hash mismatch output)
./scripts/tofu-build.sh --parallel 2

# Or regenerate lockfiles for missing packages
./scripts/regenerate-broken-lockfiles.sh
```

### 🚨 Known issues

- **Tier B fallback packages** need `--option sandbox false` because inline `npm install` needs network access.
- **NODE_TLS_REJECT_UNAUTHORIZED=0** is set at derivation level for Tier B builds because some npm packages bundle their own TLS certs that break inside the Nix sandbox.
- **Workspace dependencies** (`workspace:*`) in package.json are stripped before lockfile generation since they're unresolvable by standalone npm.
- **devDependencies** are stripped before lockfile generation — they'd cause E404 for private scoped packages and aren't needed for production installs.

---

## CI / Automated Updates

Two GitHub Actions workflows keep everything fresh:

### `update.yml` — Registry + lockfile refresh

Runs **nightly** (02:00 UTC) and on push/PR:

1. **`check` job** — `nix flake check` on every push/PR
2. **`update-registry` job** (nightly + manual only):
   - Crawl npm for new `pi-package` entries → update `registry.json`
   - Generate lockfiles for new Tier B packages
   - Clean broken lockfiles (git deps, private packages, integrity failures)
   - Compute `npmDepsHash` for new Tier B packages
   - Update README stats
   - Push changes directly to `main` (automated metadata — no review needed)

Trigger manually:

```bash
gh workflow run -R Leoguy77/pi-packages.nix update.yml --ref main
```

### `cache.yml` — Attic binary cache push

Runs **daily** (06:00 UTC) and after every successful update run:

1. Installs Nix with the Attic substituter pre-configured
2. Evaluates which Tier B packages are missing from the Attic cache (`curl`-based narinfo check)
3. Builds missing packages in batches of 200, pushing each to `https://nix-cache.lsinfra.de/pi-packages`
4. Runs garbage collection between batches to avoid disk-full conditions

Key optimizations:

- Single `nix eval --json` call for ALL store paths (1 eval, not 1,800)
- `--keep-going` for batch builds (one failure doesn't stop the batch)
- Concurrency group prevents overlapping pushes

---

## Stats

| Metric | Count |
| -------- | ------- |
| Total packages | 6,509 |
| Tier A (zero deps, direct unpack) | 4,280 |
| Tier B (has npm deps) | 2,229 |
| With lockfile (`buildNpmPackage`, cached) | 2,190 |
| Fallback (`stdenv.mkDerivation`, needs network) | 39 |
| Tier B with `npmDepsHash` computed | 1,867 |

The 39 fallback packages have genuinely unresolvable npm dep trees (private scoped packages, git dependencies, yanked packages on npm).

---

## Module Reference

Both modules expose the same option:

```nix
programs.pi.coding-agent.packages = lib.mkOption {
  type = lib.types.listOf lib.types.str;
  default = [];
  example = [ "pi-rewind" ];
  description = "pi native packages to install (from pi-packages.nix registry)";
};
```

**Note:** Module package resolution currently supports Tier A packages directly. For Tier B packages, ensure the packages directory is accessible at build time.

---

## Changelog

- **2025-07-28**: `--ignore-scripts --omit=optional` for Tier B builds; single `nix eval` optimization in Attic CI
- **2025-07-27**: Pre-computed lockfiles for 1,969 Tier B packages; `buildNpmPackage` path
- **2025-07-26**: Attic binary cache at `nix-cache.lsinfra.de/pi-packages`; push-on-build CI
- **2025-07-25**: TOFU hash discovery; `npmDepsHash` tracking in registry; `buildNpmPackage` support
- **2025-07-24**: Generate lockfiles for Tier B packages via npm; fallback to inline `stdenv.mkDerivation`
- **2025-07-06**: Initial release — Tier A only (fetchurl + tar)

---

## License

MIT
