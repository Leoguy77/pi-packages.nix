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
      nativeBuildInputs = [ pkgs.gnutar pkgs.nodejs ];
    } ''
      mkdir -p $out
      tar -xzf ${tarballSrc} --strip-components=1 -C $out
      cp ${lockPath} $out/package-lock.json
      # npm ci fails offline when package.json declares anything the lockfile does not
      # contain. registry/generate.mjs strips these before generating the lockfile, but the
      # tarball's package.json still carries them at build time, so mirror every strip here:
      #   devDependencies    -> ENOTCACHED when they name the host @earendil-works/* packages
      #   devEngines         -> EBADDEVENGINES (npm refuses before installing anything)
      #   workspaces         -> EUSAGE, "Missing: <member> from lock file"
      #   workspace:* deps   -> EUNSUPPORTEDPROTOCOL, "Unsupported URL Type workspace:"
      # Additionally: host packages are removed from peerDependencies outright (marking them
      # optional is not enough once `npm ci` is asked to omit peers -- it still demanded
      # them), any declaration the lockfile has no version for is dropped (a package
      # aliasing to `npm:null@...` resolves to nothing), and host entries in `overrides`
      # are dropped because npm reports EOVERRIDE when an override pins a version the
      # declared range does not match.
      ${pkgs.nodejs}/bin/node --input-type=commonjs -e '
        const fs = require("fs");
        const host = ${builtins.toJSON hostProvidedDeps};
        const p = process.argv[1];
        const j = JSON.parse(fs.readFileSync(p));
        const lockPath = p.replace(/package\.json$/, "package-lock.json");
        const lock = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, "utf8")) : { packages: {} };
        delete j.devDependencies;
        delete j.devEngines;
        delete j.workspaces;
        // The registry generator rewrites a local path spec to "*" when the path is
        // outside the tarball, so the lockfile records the published package. npm ci
        // compares that lockfile against this manifest and refuses to run when the two
        // disagree ("Missing: @luan.sh/pi-libactions@ from lock file"), so the same
        // rewrite has to happen here. A vendored path (inside the tarball) keeps its
        // spec, matching what the generator did for it.
        for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
          if (!j[field]) continue;
          for (const [n, v] of Object.entries(j[field])) {
            if (typeof v !== "string" || !/^(file|link):|^\.\.?\//.test(v)) continue;
            const e = lock.packages && lock.packages["node_modules/" + n];
            if (e && e.version) j[field][n] = "*";
          }
        }
        for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
          if (!j[field]) continue;
          for (const [n, v] of Object.entries(j[field])) {
            if (typeof v === "string" && v.startsWith("workspace:")) { delete j[field][n]; continue; }
            if (host.includes(n)) { delete j[field][n]; continue; }
            const e = lock.packages && lock.packages["node_modules/" + n];
            if (!e || !e.version) delete j[field][n];
          }
          if (Object.keys(j[field]).length === 0) delete j[field];
        }
        if (j.overrides) {
          // Override keys may carry a version suffix, e.g.
          // "@earendil-works/pi-coding-agent@1.4.0", which an exact-name match misses.
          for (const k of Object.keys(j.overrides)) {
            if (host.some(d => k === d || k.startsWith(d + "@"))) delete j.overrides[k];
          }
          // npm requires an override to equal the declared spec exactly, not merely to be
          // compatible: override "1.2.0" against a declared "~1.2.0" is EOVERRIDE, not a
          // no-op. This applies to peerDependencies too (pi-switch-pi-codex-app-server
          // declares chord as ~1.2.0 in peers and 1.2.0 in overrides). Drop the override
          // and let the declaration win.
          const declared = {
            ...(j.dependencies || {}), ...(j.devDependencies || {}),
            ...(j.optionalDependencies || {}), ...(j.peerDependencies || {}),
          };
          for (const k of Object.keys(j.overrides)) {
            const base = k.replace(/@[^@/]+$/, "");
            const want = j.overrides[k];
            if (declared[base] && typeof want === "string" && want !== declared[base]) delete j.overrides[k];
          }
          if (Object.keys(j.overrides).length === 0) delete j.overrides;
        }
        j.peerDependenciesMeta = j.peerDependenciesMeta || {};
        for (const d of host) {
          if (j.peerDependencies && j.peerDependencies[d]) {
            j.peerDependenciesMeta[d] = { ...(j.peerDependenciesMeta[d] || {}), optional: true };
          }
        }
        fs.writeFileSync(p, JSON.stringify(j, null, 2));
      ' $out/package.json
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
    # --omit=peer: host-provided peers (@earendil-works/*, typebox) are not in the
    # offline npm cache and are stripped from $out afterwards anyway, so npm ci must
    # not try to resolve them (ENOTCACHED otherwise).
    npmFlags = [ "--ignore-scripts" "--omit=optional" "--omit=peer" "--no-audit" "--no-fund" ];
    npmInstallFlags = [ "--legacy-peer-deps" ];
    makeCacheWritable = true;
    # Some packages depend on a git dependency (baileys, register-scheme) that ships
    # install scripts without its own lockfile. prefetch-npm-deps refuses those by
    # default. The scripts never run here -- npmFlags carries --ignore-scripts -- so
    # allowing the fetch only affects what gets cached, not what gets executed.
    forceGitDeps = true;
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
    # Requires network access, so the sandbox must be off:
    #   nix build --option sandbox false .#packages.<system>.pi-<key>
    # Verified: inside the sandbox curl cannot resolve registry.npmjs.org
    # (exit 6); with sandbox=false it gets HTTP 200. This is the only reason
    # these packages are uncacheable elsewhere -- once CI pushes one to Attic,
    # consumers get it as a normal substituter fetch with no flags.
    # (The stale numbers that used to be here -- 1663/1833 -- are gone; the
    # split is in README.md and scripts/update-readme-stats.mjs keeps it right.)
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
