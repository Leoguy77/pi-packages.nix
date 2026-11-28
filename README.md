# pi-packages.nix

Every [pi.dev](https://pi.dev/packages) package on npm, as Nix derivations.

**13,929 packages** — no binary cache needed, no npm at build time.

## Usage

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

```nix
# NixOS:   imports = [ inputs.pi-packages.nixosModules.default ];
# Home Manager: see modules/home-manager.nix
{ inputs, ... }:
{
  imports = [ inputs.pi-packages.nixosModules.default ];

  programs.pi.coding-agent = {
    enable = true;
    packages = [ "pi-rewind" "ponytail" ];  # keys from registry/registry.json
  };
}
```

```bash
sudo nixos-rebuild switch --flake .
```

Or build one directly: `nix build github:Leoguy77/pi-packages.nix#pi-pi-lens`

## How it works

`registry/generate.mjs` crawls npm for the `pi-package` keyword and records each
package's tarball URL and SRI hash. A nightly workflow keeps it current, and
pre-generates a `package-lock.json` for every package that has dependencies.

`lib/mkPiPackage.nix` then builds a package in one of two ways:

- **No dependencies** — fetch the tarball, unpack it. Nothing else.
- **Has dependencies** — each lockfile entry becomes a `fetchurl` pinned by its own
  `integrity` hash, and `lib/assemble-node-modules.cjs` lays them out as
  `node_modules`. Copies, not symlinks: Node resolves realpath before loading, so a
  symlinked dependency cannot see its siblings.

No `buildNpmPackage`, no `npmDeps`, no hash-to-discover step. Two packages needing
the same `name@version` share one store path, and `nix build --option substituters ''`
works, so nothing depends on a cache being up.

Registry entry:

```json
{
  "name": "@ayulab/pi-rewind",
  "version": "0.4.2",
  "tarball": "https://registry.npmjs.org/@ayulab/pi-rewind/-/pi-rewind-0.4.2.tgz",
  "hash": "sha512-...",
  "piManifest": { "extensions": ["./index.js"] },
  "dependencies": {},
  "peerDependencies": {},
  "keywords": [],
  "description": ""
}
```

## Binary cache

None. Every dependency is fetched from npm by its own hash, so a build needs no
substituter and no pre-populated cache. The project used to run an Attic cache at
`nix-cache.lsinfra.de/pi-packages`; that is no longer needed or maintained, and the
workflow that filled it has been removed.

## Development

```bash
REGISTRY_ONLY=1 node registry/generate.mjs    # refresh metadata only
LOCKS_ONLY=1 node registry/generate.mjs       # regenerate lockfiles
REFRESH_STALE=1 node registry/generate.mjs    # refetch versions that moved upstream
PRUNE_ONLY=1 node registry/generate.mjs       # drop packages npm no longer serves
PACKAGES=pi-lens node registry/generate.mjs   # limit to named keys

nix build .#pi-pi-lens          # one package
nix build .#tierA               # everything without dependencies
nix build .#tierB               # everything with dependencies
nix build .#all
```

Requires a `node` on PATH whose directory also has `npm` (`nodejs-slim` has neither
npm nor the dependencies of a full install).

## Known limitations

- Packages whose dependencies npm does not serve (deleted tarballs, unpublished
  versions, private scoped names, `workspace:` members) cannot be built. 46 of
  13,829 currently fail this way, all upstream defects.
- Native modules are not compiled. Packages needing `node-gyp` at install time will
  not work; a compiled `.node` file cannot be a fixed-output derivation.
- Windows-only packages are skipped — Nix does not run there.

## License

MIT
