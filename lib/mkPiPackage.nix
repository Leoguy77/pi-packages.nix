# mkPiPackage.nix - Build a pi package from registry entry
#
# Tiers:
#   A - No npm dependencies → unpack tarball (instant)
#   B - Has dependencies → buildNpmPackage with pre-generated lockfile
#
# The registry generator (generate.mjs) pre-generates lockfiles and stores
# them at packages/<name>/package-lock.json relative to the flake root.

{ pkgs, lib }:

# `name` = registry entry's npm name (used for the output pname).
# `key`  = the sanitized registry KEY, which is also the directory name under
#          packages/ where the generated package-lock.json lives.
{ name, key, tarball, hash, tier, packagesDir
, version ? "0.0.0", dependencies ? {}, npmDepsHash ? null, ... }:

let
  tierA = tier == "A" || dependencies == {};

  tarballSrc = pkgs.fetchurl {
    url = tarball;
    inherit hash;
  };

  # Host-provided packages that pi itself supplies to every extension. A PHYSICAL
  # copy baked into a package's node_modules makes pi warn ("duplicate runtime
  # modules") because it can bypass the extension loader's module mapping. On a
  # normal `pi install`, npm hoists these to pi's shared tree so they resolve to
  # pi's copies; here we strip the bundled copies so the same resolution happens.
  # Ref: pi docs packages.md "Pi supplies these packages to extensions and skills".
  hostProvidedDeps = [
    "typebox"
    "@earendil-works/pi-ai"
    "@earendil-works/pi-agent-core"
    "@earendil-works/pi-coding-agent"
    "@earendil-works/pi-tui"
  ];
  # Rewrite package.json so host-provided deps are declared in peerDependencies
  # ("*") instead of dependencies. pi checks the MANIFEST and warns if these are
  # in `dependencies` ("Installed copies can bypass the extension loader and
  # create duplicate runtime modules"). Moving them to peerDependencies tells pi
  # they are resolved from pi's own shared copies. Uses a small node script.
  fixPkgJson = ''
    PKG="$out/package.json"
    ${pkgs.nodejs}/bin/node \
      --input-type=commonjs -e 'const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p));const host=["typebox","@earendil-works/pi-ai","@earendil-works/pi-agent-core","@earendil-works/pi-coding-agent","@earendil-works/pi-tui"];let changed=false;for(const d of host){if(j.dependencies&&j.dependencies[d]){j.peerDependencies=j.peerDependencies||{};j.peerDependencies[d]="*";delete j.dependencies[d];changed=true;}}if(j.dependencies&&Object.keys(j.dependencies).length===0)delete j.dependencies;if(changed)fs.writeFileSync(p,JSON.stringify(j,null,2));' "$PKG"
  '';
  # Emit `rm -rf $out/<rel-path>` for each host-provided dir (both the top-level
  # copy and any nested copy under a real dependency's node_modules, where npm may
  # also place a duplicate).
  stripScript = builtins.concatStringsSep "\n" (builtins.concatLists (map (d: [
    "rm -rf $out/node_modules/${d} 2>/dev/null || true"
    "find $out/node_modules -type d -path '*/node_modules/${d}' -prune -exec rm -rf {} + 2>/dev/null || true"
  ]) hostProvidedDeps)) + ''
  # Remove .bin symlinks whose target was stripped, so `noBrokenSymlinks` passes.
  for b in $out/node_modules/.bin/*; do
    [ -e "$b" ] || rm -f "$b" 2>/dev/null || true
  done
'';

in if tierA then
  
  pkgs.runCommand "pi-pkg-${name}" { nativeBuildInputs = [ pkgs.gnutar ]; } ''
    mkdir -p $out
    tar -xzf ${tarballSrc} --strip-components=1 -C $out
  ''
  
else
  
  let
    lockPath = packagesDir + "/${key}/package-lock.json";
    hasLock = builtins.pathExists lockPath;
    
    # Merge lockfile into src to avoid store path refs in npmDeps sub-derivation
    src = if hasLock then pkgs.runCommand "src-${name}" {
      nativeBuildInputs = [ pkgs.gnutar ];
    } ''
      mkdir -p $out
      tar -xzf ${tarballSrc} --strip-components=1 -C $out
      cp ${lockPath} $out/package-lock.json
    '' else tarballSrc;
    
  # Has valid lockfile → buildNpmPackage (cached via npmDepsHash)
  # No lockfile → stdenv.mkDerivation with inline npm install (uncached)
  in if hasLock then pkgs.buildNpmPackage {
    pname = "pi-pkg-${name}";
    inherit version src;
    
    npmDepsHash = if npmDepsHash != null then npmDepsHash
      else "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    
    dontNpmBuild = true;
    # Suppress scripts globally (npm rebuild in configurePhase) and skip optional
    # platform-specific deps (e.g., @biomejs/cli-win32-arm64 on x86_64-linux).
    npmFlags = [ "--ignore-scripts" "--omit=optional" "--no-audit" "--no-fund" ];
    npmInstallFlags = [ "--legacy-peer-deps" ];
    makeCacheWritable = true;
    # npm install runs during configurePhase; unset SSL_CERT_FILE first
    preConfigure = ''
      unset SSL_CERT_FILE NIX_SSL_CERT_FILE
    '';
    # Also set at derivation level for child processes
    NODE_TLS_REJECT_UNAUTHORIZED = "0";
    installPhase = ''
      mkdir -p $out
      cp -r . $out/
      rm -rf $out/node_modules/.cache 2>/dev/null || true
      # Move host-provided deps to peerDependencies + strip their copies so pi
      # resolves its own (no duplicate-module warnings).
      ${fixPkgJson}
      ${stripScript}
    '';
  } else pkgs.stdenv.mkDerivation {
    pname = "pi-pkg-${name}";
    inherit version;
    src = tarballSrc;
    phases = [ "unpackPhase" "buildPhase" "installPhase" ];
    nativeBuildInputs = [ pkgs.gnutar pkgs.nodejs ];
    
    HOME = "/tmp";  # npm needs writable HOME
    
    # ponytail: inline npm install for packages without lockfile.
    # Requires network access — use --option sandbox false or CI with
    # magic-nix-cache-action (which disables sandbox).
    # 1663/1833 Tier B packages have valid lockfiles and use buildNpmPackage.
    buildPhase = ''
      # stdenv sets SSL_CERT_FILE=/no-cert-file.crt which breaks TLS;
      # unset + set reject to 0 for child processes that re-read env
      unset SSL_CERT_FILE NIX_SSL_CERT_FILE
      export NODE_TLS_REJECT_UNAUTHORIZED=0
      tar -xzf $src --strip-components=1
      HOME=$TMPDIR npm install --ignore-scripts --no-audit --no-fund --legacy-peer-deps --omit=optional --loglevel=error
      rm -rf node_modules/.cache 2>/dev/null || true
    '';
    
    installPhase = ''
      mkdir -p $out
      cp -r . $out/
      # Move host-provided deps to peerDependencies + strip their copies so pi
      # resolves its own (no duplicate-module warnings).
      ${fixPkgJson}
      ${stripScript}
    '';
  }
