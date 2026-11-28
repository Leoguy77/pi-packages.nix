# mkPiPackage.nix - Build a pi package from registry entry
#
# Tiers:
#   A - No npm dependencies → unpack tarball (instant)
#   B - Has dependencies → one fetchurl per dependency, laid out by hand
#
# The registry generator (generate.mjs) pre-generates lockfiles and stores
# them at packages/<name>/package-lock.json relative to the flake root.
#
# Tier B used to run `buildNpmPackage`. Dropped for these reasons:
#   - It pinned a fixed-output `npmDeps` cache, so the package was unbuildable
#     anywhere that cache was missing (which is every user without the Attic
#     substitution, and every CI runner on a cold cache: ENOTCACHED).
#   - It required npmDepsHash to match, so any manifest edit needed a rehash.
#   - It ran npm, which then had to be lied to about devDependencies,
#     workspaces, devEngines and overrides, because npm compares the lockfile
#     against the tarball's package.json and refuses on any disagreement.
# None of that is needed. Every lockfile entry already carries `integrity` (the
# tarball's own sha512) and `resolved` (its URL), so each dependency becomes an
# ordinary content-addressed store path. `nix build` then works with no cache,
# no npm and no hash step, and two packages needing the same name@version share
# one store path.

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
  # The blank line above is load bearing: an indented string eats the newline right
  # after its opening quotes, so without it this comment gets glued to the previous
  # line as `|| true#`, and bash reads `true#` as a command name. That killed every
  # package with no node_modules directory, because the `find` before it fails and
  # hands over to the `||` branch.
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
    
    
  # Has lockfile → unpack the tarball, then place one store path per dependency.
  # No lockfile → stdenv.mkDerivation with inline npm install (uncached)
  in if hasLock then
    let
      lock = builtins.fromJSON (builtins.readFile lockPath);
      entries = lock.packages or { };

      # Last path segment of a lockfile key, e.g. "node_modules/@scope/pkg" ->
      # "@scope/pkg". Used to recognise host-provided packages, which pi supplies
      # from its own tree and which must therefore not be fetched or shipped.
      pkgNameOf = k:
        # Nix's regex engine has no non-capturing groups, so the scope is a plain
        # group and the full name is match group 1.
        let m = builtins.match ".*node_modules/((@[^/]+/)?[^/]+)" k;
        in if m == null then k else builtins.head m;

      # Which lockfile entries become their own store path. Skipped on purpose:
      #   ""         the package itself, already unpacked from the tarball
      #   inBundle   files shipped inside a parent's tarball, with no integrity of
      #              their own; unpacking the parent brings them along
      #   link       workspace symlink pointing at a sibling inside the tree
      #   no http    vendored file:/link: tarballs, which the generator pins to "*"
      depKeys = lib.filter (k:
        k != ""
        && !(entries.${k}.inBundle or false)
        && !(entries.${k}.link or false)
        && (entries.${k}.integrity or null) != null
        && (entries.${k}.resolved or null) != null
        && builtins.match "https?://.*" entries.${k}.resolved != null
        && !(builtins.elem (pkgNameOf k) hostProvidedDeps)
      ) (builtins.attrNames entries);

      # "sha512-<base64>" -> the attribute fetchurl expects.
      splitHash = i:
        let m = builtins.match "(sha[0-9]+)-(.+)" i;
        in if m == null then null else { algo = builtins.head m; b64 = builtins.elemAt m 1; };

      # One derivation per dependency, named by lockfile path and version so two
      # packages needing the same name@version share it, and a package needing a
      # different version gets a different one.
      mkDep = k:
        let
          e = entries.${k};
          h = splitHash e.integrity;
          safe = builtins.replaceStrings [ "/" "@" "." ] [ "-" "-" "-" ] k;
        in pkgs.runCommand "npm-${safe}-${e.version}" {
          src = pkgs.fetchurl ({ url = e.resolved; } // { ${h.algo} = h.b64; });
          nativeBuildInputs = [ pkgs.gnutar pkgs.gzip ];
        } ''
          mkdir -p $out
          # --delay-directory-restore applies each directory's mode only after its
          # contents are written. Without it a tarball whose directories are stored
          # mode 0666 (pngjs@5.0.0 does this) cannot be traversed while extracting,
          # so every file under them fails with EACCES.
          tar -xzf $src --strip-components=1 -C $out --delay-directory-restore
          # Store files are read-only by design, but a package's build step may need to
          # write next to its own sources.
          chmod -R u+rwX $out
        '';

      # Lockfile key -> store path, handed to the assembler as JSON so the layout
      # matches the lockfile exactly (node_modules/a/node_modules/b and so on).
      depMap = pkgs.writeText "deps-${name}.json" (builtins.toJSON
        (builtins.listToAttrs (map (k: { name = k; value = "${mkDep k}"; }) depKeys)));
    in
    pkgs.runCommand "pi-pkg-${name}" {
      nativeBuildInputs = [ pkgs.gnutar pkgs.gzip pkgs.nodejs ];
    } ''
      mkdir -p $out
      tar -xzf ${tarballSrc} --strip-components=1 -C $out
      # Nothing is deleted first: some tarballs ship a node_modules of their own,
      # including packages the lockfile never declares (measured: 56 of 4,598
      # packages bundle, and pi-copy-mode depends on 5 such undeclared modules).
      # The assembler copies over them, and the lockfile's version wins, which is
      # what npm does.
      ${pkgs.nodejs}/bin/node ${./assemble-node-modules.cjs} "$out" "$(cat ${depMap})"
      # Move host-provided deps to peerDependencies + strip their copies so pi
      # resolves its own (no duplicate-module warnings).
      ${fixPkgJson}
      ${stripScript}
    ''
  else pkgs.stdenv.mkDerivation {
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
