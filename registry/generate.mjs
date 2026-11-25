#!/usr/bin/env node
// generate.mjs - Crawl npm registry for pi-package keyword and generate registry.json
// Also generates package-lock.json for Tier B packages

import { execSync, spawn, spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';

const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);
const REGISTRY_ONLY = process.env.REGISTRY_ONLY === '1';
const LOCKS_ONLY = process.env.LOCKS_ONLY === '1';
// Refresh existing entries instead of only adding new ones. Without this a
// package's version is frozen at whatever it was the first time the crawler saw
// it (see git history: every daily commit added new keys and bumped zero existing
// ones). Two modes, named to match the PR that diagnosed this (Leoguy77/pi-packages.nix#2):
//   REFRESH_KEYS="a,b"  re-crawl just these registry keys and exit, no search crawl.
//   REFRESH_STALE=1     during a normal crawl, re-crawl any entry whose stored
//                       version differs from the one the search index just
//                       returned -- free, since search results carry it.
const REFRESH_STALE = process.env.REFRESH_STALE === '1' || process.env.REFRESH === '1';
// Drop registry entries whose tarball is gone from npm. Unpublished packages stay in
// the registry forever otherwise, because the crawler only ever adds and updates, and
// they fail every cache build with `curl: (22) Requested URL returned error: 404`
// (71 packages in run 45196913983). Opt-in: a run without PRUNE does not delete.
const PRUNE = process.env.PRUNE === '1';
// PRUNE_ONLY=1 prunes and exits, skipping the search crawl entirely.
const PRUNE_ONLY = process.env.PRUNE_ONLY === '1';
const REFRESH_KEYS = (process.env.REFRESH_KEYS || '')
  .split(/[ ,]+/).map(s => s.trim()).filter(Boolean);
// PACKAGES=a,b,c limits a LOCKS_ONLY run to the named registry keys.
const ONLY = (process.env.PACKAGES || '').split(',').filter(Boolean);
// Packages provided by the pi host at runtime, never installed from npm.
const HOST_DEPS = ["typebox","@earendil-works/pi-ai","@earendil-works/pi-agent-core","@earendil-works/pi-coding-agent","@earendil-works/pi-tui"];
const SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';
const PAGE_SIZE = 250;
const PACKAGES_DIR = new URL('../packages', import.meta.url).pathname;
const REGISTRY_PATH = new URL('../registry/registry.json', import.meta.url).pathname;
const STATE_PATH = new URL('../registry/.generate-state.json', import.meta.url).pathname;
// Written by PRUNE=1: what was dropped and why, so a bad prune is reviewable
// rather than a silent 200-line diff in registry.json.
const PRUNE_LOG = new URL('../registry/.pruned.json', import.meta.url).pathname;
// Scratch space lives on real disk, not the system tmpdir: /tmp is often tmpfs
// (RAM), and an 8GiB npm cache there will exhaust RAM and fail every install with
// ENOSPC (npm exit 228). Override with PI_REGISTRY_TMPDIR if needed.
const TMP = process.env.PI_REGISTRY_TMPDIR
  ? join(process.env.PI_REGISTRY_TMPDIR, 'pi-registry-gen')
  : join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'pi-registry-gen');

// Token-bucket rate limiter: 1 request per 250ms globally
let lastRequest = 0;
async function rateLimit() {
  const now = Date.now();
  const elapsed = now - lastRequest;
  const minGap = 250;
  if (elapsed < minGap) {
    await new Promise(r => setTimeout(r, minGap - elapsed));
  }
  lastRequest = Date.now();
}

async function fetchJSON(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    await rateLimit();
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        const wait = Math.min(5000 * Math.pow(2, i), 60000);
        process.stderr.write(`  429, waiting ${wait}ms...\n`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
      return res.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      const wait = Math.min(2000 * Math.pow(2, i), 15000);
      process.stderr.write(`  Retry ${i + 1}/${retries}: ${e.message}\n`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// npm's `os` field is a whitelist, and a leading `!` makes it a blacklist.
// Supports Linux and macOS, not Windows: Nix and NixOS run on the former two only, so
// a package that permits either one is buildable by someone. A `"win32"`-only package
// is not, and keeping it means a guaranteed EBADPLATFORM failure on every build run.
function supportsPosix(os) {
  if (!Array.isArray(os) || os.length === 0) return true;
  const denied = os.filter(o => o.startsWith('!')).map(o => o.slice(1));
  if (denied.length) return !denied.includes('linux') || !denied.includes('darwin');
  return os.includes('linux') || os.includes('darwin');
}

// Second look for processPackage: null metadata can mean "unpublished" as well as
// "Windows-only", and only the latter should evict an existing entry.
async function supportsPosixOnNpm(name) {
  try {
    const meta = await fetchJSON(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
    const latest = meta['dist-tags']?.latest;
    return supportsPosix(meta.versions?.[latest]?.os);
  } catch {
    return true; // cannot tell -> keep
  }
}

async function getPackageMetadata(name) {
  const meta = await fetchJSON(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  const latestVersion = meta['dist-tags']?.latest;
  if (!latestVersion) return null;
  
  const versionMeta = meta.versions?.[latestVersion];
  if (!versionMeta) return null;
  
  const deps = versionMeta.dependencies || {};
  const piManifest = versionMeta.pi || {};
  const tier = Object.keys(deps).length === 0 ? 'A' : 'B';

  // Nix does not run on Windows, so a `"win32"`-only package can never be consumed
  // here and would fail every build run with EBADPLATFORM. macOS-only packages are
  // kept: Nix runs there, and the per-system flake output skips what does not apply.
  // Omitted rather than set to null so the registry does not grow an `"os": null`
  // line on ~13k entries.
  if (!supportsPosix(versionMeta.os)) return null;

  const entry = {
    name: versionMeta.name,
    version: latestVersion,
    tarball: versionMeta.dist.tarball,
    hash: versionMeta.dist.integrity,
    tier,
    piManifest,
    dependencies: deps,
    peerDependencies: versionMeta.peerDependencies || {},
    keywords: versionMeta.keywords || [],
    description: versionMeta.description || '',
    downloads: 0,
  };
  if (versionMeta.os) entry.os = versionMeta.os;
  return entry;
}

// Shared npm cache across all lockfile generations
const NPM_CACHE = join(TMP, 'shared-cache');

// Resolve npm once, absolutely. spawn() without a shell inherits PATH, so launching
// this script under a bare `node` (no npm on PATH) made every one of ~900 lockfile
// generations fail with `spawn npm ENOENT` -- and a failed generation leaves the
// package Tier B with no lockfile and no npmDepsHash, silently uncached forever.
// Prefer the npm next to the running node binary.
// process.execPath resolves symlinks, so it cannot be used to find npm next to the
// node that was invoked (NixOS nodejs' bin/node is a symlink into nodejs-slim, which
// has no npm). PATH lookup is the only reliable resolution; validate it up front.
const NPM = process.env.NPM_BIN || 'npm';
// Refuse to start a sweep without npm. The failure otherwise surfaces once per
// package as a logged "Lockfile failed" and leaves Tier B packages with no lockfile
// and no hash -- buildable, never cacheable, and easy to miss entirely (840 of them
// went unnoticed). nodejs-slim ships without npm, which is the usual trap.
if (spawnSync(NPM, ['--version']).status !== 0 && !REGISTRY_ONLY) {
  process.stderr.write(
    'error: npm not found. Run with a node whose bin also has npm, or set NPM_BIN.\n' +
    '       e.g. PATH=<nix-store>/bin:$PATH where that dir contains both node and npm.\n' +
    '       (nodejs-slim has no npm; nodejs-slim-*-npm provides it separately.)\n'
  );
  process.exit(1);
}

async function runNpmLock(workDir) {
  // Step 1: package-lock-only for fast resolution
  // Step 2: npm install to populate integrity hashes
  // Step 3: delete node_modules
  
  // Step 1: Generate lockfile structure
  await new Promise((resolve, reject) => {
    const c1 = spawn(NPM, [
      'install', '--package-lock-only', '--ignore-scripts',
      '--no-audit', '--no-fund', '--legacy-peer-deps',
      '--engine-strict=false', '--ignore-platform',
      '--loglevel=error', `--cache=${NPM_CACHE}`
    ], { cwd: join(workDir, 'pkg'), env: { ...process.env, HOME: workDir }, stdio: 'pipe' });
    const t1 = setTimeout(() => { c1.kill(); reject(new Error('timeout-step1')); }, 120000);
    c1.on('exit', (c) => { clearTimeout(t1); c === 0 ? resolve() : reject(new Error(`npm exit code ${c}`)); });
    c1.on('error', reject);
  });
  
  // Step 2: Full install to fill integrity, prefer-offline for speed
  await new Promise((resolve, reject) => {
    // npm chokes on a lockfile that step 1 produced with --package-lock-only when a
    // dependency resolves to an alias or a nested tree: "Cannot destructure property
    // 'package' of 'node.target' as it is null". A fresh install of the same
    // package.json succeeds, so drop the step-1 lockfile and let this step resolve from
    // scratch. The lockfile is written from this result anyway.
    try { execSync('rm -f package-lock.json', { cwd: join(workDir, 'pkg'), timeout: 10000 }); } catch {}
    const c2 = spawn(NPM, [
      'install', '--ignore-scripts',
      '--no-audit', '--no-fund', '--legacy-peer-deps',
      '--engine-strict=false', '--ignore-platform',
      '--loglevel=error', `--cache=${NPM_CACHE}`
    ], { cwd: join(workDir, 'pkg'), env: { ...process.env, HOME: workDir }, stdio: 'pipe' });
    const t2 = setTimeout(() => { c2.kill(); reject(new Error('timeout-step2')); }, 180000);
    c2.on('exit', (c) => {
      clearTimeout(t2);
      if (c === 0) {
        try { execSync('rm -rf node_modules', { cwd: join(workDir, 'pkg'), timeout: 10000 }); } catch {}
        resolve();
      } else reject(new Error(`npm exit code ${c} (step2)`));
    });
    c2.on('error', reject);
  });
}

// Version recorded in an existing lockfile, or null when it has none.
function lockfileVersion(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

// True when the lockfile declares a dependency it cannot resolve. npm ci stops with
// "Missing: <name>@ from lock file" instead of installing, so such a lockfile is
// unusable offline. Platform-specific optional deps are the common cause: only the
// binary for the generating platform resolves, the rest stay as bare names.
function lockfileHasDanglingRefs(lockPath) {
  let lock;
  try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { return false; }
  const pk = lock.packages || {};
  // npm resolves by walking up the tree, so a name is satisfied by any ancestor.
  const resolve = (from, n) => {
    for (let base = from; ; ) {
      const k = `${base ? base + '/' : ''}node_modules/${n}`;
      if (pk[k]?.version) return k;
      if (!base) return null;
      // Strip one level. Workspace/link keys ("extensions/foo") contain no node_modules
      // segment, so the replace is a no-op; their parent in npm's walk is the root, which
      // must still be tried or a resolvable dep gets pruned. Terminates because base
      // becomes "" and the loop returns at the top on the next pass.
      const next = base.replace(/\/?node_modules\/(?:@[^/]+\/)?[^/]+$/, '');
      base = next === base ? '' : next;
    }
  };
  for (const [k, e] of Object.entries(pk)) {
    // A link entry points at a path ("../pi-libtui") that the published tarball does not
    // contain, so npm ci cannot restore it and prefetch-npm-deps cannot cache it. Such a
    // lockfile may have no dangling declaration at all and still install nothing.
    if (e?.link) return true;
    for (const f of ['dependencies', 'optionalDependencies']) {
      if (!e[f]) continue;
      for (const n of Object.keys(e[f])) if (!resolve(k, n)) return true;
    }
  }
  return false;
}

async function generateLockfile(name, tarballUrl, key, targetVersion) {
  const pkgDir = join(PACKAGES_DIR, key);
  const lockPath = join(pkgDir, 'package-lock.json');
  
  // The lockfile exists and describes the version we are being asked for: nothing to
  // do. A full REFRESH_STALE sweep used to regenerate every Tier B lockfile (~8 min each
  // batch, hours total) even when the version had not moved, which made the nightly
  // job far too slow to run often. Compare versions instead of trusting a flag.
  if (existsSync(lockPath)) {
    const have = lockfileVersion(lockPath);
    if (!targetVersion || have === targetVersion) {
      // A same-version lockfile can still be unusable if it was generated before the
      // dangling-ref prune existed, so check it rather than trusting the version.
      if (!lockfileHasDanglingRefs(lockPath)) return;
      process.stderr.write(`  lockfile ${key} has unresolvable dependencies — regenerating\n`);
    } else {
      process.stderr.write(`  lockfile ${key} is ${have ?? 'unversioned'}, want ${targetVersion} — regenerating\n`);
    }
  }
  
  const workDir = join(TMP, key);
  try {
    execSync(`rm -rf ${workDir} ; mkdir -p ${workDir}/pkg`, { stdio: 'pipe', timeout: 10000 });
    execSync(`curl -sL --max-time 30 '${tarballUrl}' -o ${workDir}/pkg.tgz`, { stdio: 'pipe', timeout: 35000 });
    execSync(`tar -xzf ${workDir}/pkg.tgz --strip-components=1 -C ${workDir}/pkg`, { stdio: 'pipe', timeout: 10000 });
    // Packages that ship a vendored node_modules (npm "bundleDependencies") make npm
    // record those deps as inBundle with no resolved/integrity. prefetch-npm-deps then
    // skips them ("7 out of 19 packages are missing 'resolved' URLs") and npm ci
    // --offline fails with ENOTCACHED. Removing the tree makes npm resolve them from the
    // registry like any other dependency, which is what the offline cache needs.
    execSync(`rm -rf ${workDir}/pkg/node_modules`, { stdio: 'pipe', timeout: 10000 });
    // Strip workspace:* deps — unresolvable by standalone npm
    const pjPath = join(workDir, 'pkg', 'package.json');
    if (existsSync(pjPath)) {
      const pj = JSON.parse(readFileSync(pjPath, 'utf8'));
      const wsDeps = (deps) => deps ? Object.entries(deps).filter(([, v]) => typeof v === 'string' && v.startsWith('workspace:')) : [];
      const toRemove = [...wsDeps(pj.dependencies), ...wsDeps(pj.devDependencies), ...wsDeps(pj.peerDependencies)];
      if (toRemove.length) {
        for (const [n] of toRemove) {
          if (pj.dependencies?.[n]) delete pj.dependencies[n];
          if (pj.devDependencies?.[n]) delete pj.devDependencies[n];
          if (pj.peerDependencies?.[n]) delete pj.peerDependencies[n];
        }
      }
      // Local path specs come in two kinds and they need opposite handling.
      //
      // Inside the tarball ("file:./vendor/pi-diff-review"): keep the spec, npm can use
      // it. Its own devDependencies still have to go, because npm resolves them too and
      // they are neither needed at runtime nor published -- omni-pi vendors a sub-package
      // asking for @types/node@^24.5.2 while the lockfile pins 26.6.6, which does not
      // satisfy it, so npm ci goes to the network for the manifest and fails ENOTCACHED.
      //
      // Outside the tarball ("file:../pi-libtui", "../runtime", "link:../x"): the path
      // does not exist here at all, so "*" makes npm resolve the published version where
      // one exists -- pi-side declares @luan.sh/pi-libactions as file:../pi-libactions and
      // the published package pulls in 240 real dependencies the lockfile otherwise
      // misses. Where no such package exists npm fails and the uncached fallback applies.
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
        if (!pj[field]) continue;
        for (const [n, v] of Object.entries(pj[field])) {
          if (typeof v !== 'string') continue;
          if (!/^(file|link):|^\.\.?\//.test(v)) continue;
          // link: specs are always external symlinks, never a directory in the tarball.
          const rel = v.replace(/^(file|link):/, '');
          // A vendored tarball (file:./vendor/fumadb-0.3.0-382dcd65.tgz) is recorded with
          // that same file: URL as its resolved location, and prefetch-npm-deps rejects it
          // outright ("couldn't fetch node_modules/fumadb at file:///vendor/...: invalid
          // format"). "fumadb" is published on npm, so "*" makes npm take the registry
          // copy and the cache can be built. An unpublished one still fails here and
          // falls back to the inline install, which is the same as before this change.
          if (!v.startsWith('file:') || /\.tgz$|\.tar\.gz$/i.test(rel)) { pj[field][n] = '*'; continue; }
          const subPkg = v.startsWith('file:') ? join(workDir, 'pkg', rel, 'package.json') : null;
          if (subPkg && existsSync(subPkg)) {
            try {
              const sj = JSON.parse(readFileSync(subPkg, 'utf8'));
              delete sj.devDependencies;
              delete sj.devEngines;
              delete sj.workspaces;
              writeFileSync(subPkg, JSON.stringify(sj, null, 2) + '\n');
            } catch {}
            continue; // vendored: npm can install it, keep the spec
          }
          pj[field][n] = '*';
        }
      }
      // Strip devEngines — npm's --engine-strict=false doesn't handle pnpm packageManager
      if (pj.devEngines) {
        delete pj.devEngines;
      }
      // Remove devDependencies — not needed for production lockfiles, often cause E404 for private packages
      if (pj.devDependencies) {
        delete pj.devDependencies;
      }
      // Drop bundleDependencies/bundledDependencies. npm marks those packages
      // "inBundle": true, which writes the entry without a resolved URL even when the
      // tree is gone and the package is on npm. prefetch-npm-deps skips any entry with
      // no resolved URL, so npmDeps cannot be built at all:
      //   "No cacheable dependencies were found"
      // (e.g. @ayulab/oh-my-pi bundling @ayulab/pi-rewind). Pinning the bundle as a
      // normal dependency resolves it from the registry like anything else.
      if (pj.bundleDependencies || pj.bundledDependencies) {
        delete pj.bundleDependencies;
        delete pj.bundledDependencies;
      }
      if (toRemove.length || JSON.stringify(pj) !== readFileSync(pjPath, 'utf8')) {
        writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n');
      }
    }
    await runNpmLock(workDir);
    
    // Pi packages declare the host (pi itself) as peerDependencies. When they are not
    // marked optional, `npm ci` inside buildNpmPackage demands them in the fixed-output
    // derivation and fails with ENOTCACHED (@earendil-works/pi-ai). Mark every host peer
    // optional in the lockfile so the build treats them as provided by the runtime.
    const lockFile = join(workDir, 'pkg', 'package-lock.json');
    if (existsSync(lockFile)) {
      const lock = JSON.parse(readFileSync(lockFile, 'utf8'));
      const pk = lock.packages || {};
      // Drop workspace link entries. npm records them as `"link": true` with a relative
      // `resolved` such as "../runtime", which does not exist inside the published
      // tarball, so prefetch-npm-deps skips the entry and npm ci cannot restore it.
      // The strip is safe because a link target is either another workspace (already
      // removed with `workspaces`) or a path outside the tarball.
      let droppedLinks = 0;
      for (const [k, e] of Object.entries(pk)) {
        if (!e || !e.link) continue;
        delete pk[k];
        droppedLinks++;
      }
      // A nested copy of a workspace package keeps a `version` but loses its `resolved`
      // URL, so prefetch-npm-deps skips it and npm ci then reaches for the network
      // (@xterm/headless in pi-copy-mode). Drop such a copy only when the same
      // name@version is also present with a resolved URL, which npm uses instead;
      // dropping an only copy would just turn into "Missing: <name>@ from lock file".
      const nameOf = k => k.slice(k.lastIndexOf('node_modules/') + 'node_modules/'.length);
      for (const [k, e] of Object.entries(pk)) {
        if (!k || !e || e.link || !e.version || e.resolved) continue;
        const twin = Object.entries(pk).some(([k2, e2]) =>
          k2 !== k && e2?.resolved && e2.version === e.version && nameOf(k2) === nameOf(k));
        if (!twin) continue;
        delete pk[k];
        droppedLinks++;
      }
      if (droppedLinks) {
        for (const e of Object.values(pk)) {
          for (const f of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
            if (!e[f]) continue;
            for (const [n, t] of Object.entries(e[f])) {
              if (typeof t === 'string' && (t.startsWith('file:') || t.startsWith('link:'))) delete e[f][n];
            }
            if (Object.keys(e[f]).length === 0) delete e[f];
          }
        }
      }
      // Declarations whose target has no version cannot be installed offline: npm ci
      // reports "Missing: <name>@ from lock file" and stops. This happens at every
      // level, not just the root -- @edxeth/fff-node lists eight platform binaries as
      // optional deps but only the Linux x64 one resolved on this platform, so the
      // other seven sit in the lockfile as bare names. --omit=optional does not stop
      // the sync check, so prune them here, where the hash still covers the result.
      let prunedDecls = 0;
      // npm resolves a dependency by walking up the tree, so a declaration is only
      // unresolvable when no ancestor has it either. Checking just the nested path
      // would prune hoisted entries, which are the normal case.
      const resolve = (from, n) => {
        for (let base = from; ; ) {
          const k = `${base ? base + '/' : ''}node_modules/${n}`;
          if (pk[k]?.version) return k;
          if (!base) return null;
          // Workspace/link keys ("extensions/foo") have no node_modules segment, so the
          // strip below cannot shorten them. Their parent in npm's walk is the root, which
          // must still be tried -- returning null here would prune a resolvable dep.
          const next = base.replace(/\/?node_modules\/(?:@[^/]+\/)?[^/]+$/, '');
          base = next === base ? '' : next;
        }
      };
      for (const [k, e] of Object.entries(pk)) {
        for (const f of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
          if (!e[f]) continue;
          for (const n of Object.keys(e[f])) {
            if (!resolve(k, n)) { delete e[f][n]; prunedDecls++; }
          }
          if (Object.keys(e[f]).length === 0) delete e[f];
        }
      }
      // The host packages (pi itself) are provided by the runtime, never installed, and
      // mkPiPackage.nix deletes every declaration of them from package.json before npm
      // runs. Entries for them in the lockfile are therefore dead weight -- and when one
      // arrives nested (a plugin that shipped the host as a devDependency) npm records it
      // with a resolved URL but no integrity, so prefetch-npm-deps refuses the whole
      // lockfile: "non-git dependencies should have associated integrity". Drop them at
      // every depth, plus any declaration pointing at them, so the lockfile matches the
      // manifest the build actually uses.
      let droppedHost = 0;
      const hostNames = new Set(HOST_DEPS);
      const nameOfEntry = (k) => k.slice(k.lastIndexOf('node_modules/') + 'node_modules/'.length);
      // Anything nested under a host package goes too: it is part of the host's own
      // dependency tree (@earendil-works/pi-client, pi-protocol, pi-telemetry), which
      // the runtime supplies, and npm records those copies without integrity.
      const underHost = (k) => HOST_DEPS.some((h) => k.includes('node_modules/' + h + '/node_modules/'));
      for (const [k, e] of Object.entries(pk)) {
        if (!k || !e) continue;
        if (hostNames.has(nameOfEntry(k)) || underHost(k)) { delete pk[k]; droppedHost++; }
      }
      if (droppedHost) {
        for (const e of Object.values(pk)) {
          if (!e) continue;
          for (const f of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
            if (!e[f]) continue;
            for (const n of Object.keys(e[f])) if (hostNames.has(n)) delete e[f][n];
            if (Object.keys(e[f]).length === 0) delete e[f];
          }
        }
      }
      // Pi packages declare the host (pi itself) as peerDependencies. When they are not
      // marked optional, `npm ci` inside buildNpmPackage demands them in the fixed-output
      // derivation and fails with ENOTCACHED (@earendil-works/pi-ai). Mark every host peer
      // optional in the lockfile so the build treats them as provided by the runtime.
      const rootPkg = lock.packages?.[''];
      if (rootPkg?.peerDependencies) {
        const hostPeers = HOST_DEPS.filter((d) => d in rootPkg.peerDependencies);
        if (hostPeers.length) {
          rootPkg.peerDependenciesMeta = rootPkg.peerDependenciesMeta || {};
          for (const d of hostPeers) {
            rootPkg.peerDependenciesMeta[d] = { ...(rootPkg.peerDependenciesMeta[d] || {}), optional: true };
          }
          writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
          process.stderr.write(`  marked host peers optional: ${hostPeers.join(', ')}\n`);
        }
      }
      if (prunedDecls || droppedLinks || droppedHost) {
        writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
        if (prunedDecls) process.stderr.write(`  pruned ${prunedDecls} unresolvable declaration(s)\n`);
        if (droppedLinks) process.stderr.write(`  dropped ${droppedLinks} workspace link(s)\n`);
        if (droppedHost) process.stderr.write(`  dropped ${droppedHost} host package entr(ies)\n`);
      }
    }
    
    if (existsSync(join(workDir, 'pkg', 'package-lock.json'))) {
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(lockPath, readFileSync(join(workDir, 'pkg', 'package-lock.json')));
    }
  } catch (err) {
    process.stderr.write(`  Lockfile failed for ${key}: ${err.message}\n`);
  } finally {
    try { execSync(`rm -rf ${workDir}`, { timeout: 5000 }); } catch {}
  }
}

// Delete registry entries whose tarball npm no longer serves. Two independent
// checks before anything is dropped: the packument must be missing or mark the
// version unpublished, AND the tarball URL must 404. A single 404 is not enough --
// a CDN hiccup or a rate-limit page must never cost a package.
async function pruneDead(packages) {
  const keys = Object.keys(packages);
  process.stderr.write(`Pruning: checking ${keys.length} tarballs...\n`);
  const removed = [];
  let checked = 0;

  for (let i = 0; i < keys.length; i += CONCURRENCY) {
    await Promise.all(keys.slice(i, i + CONCURRENCY).map(async (key) => {
      const entry = packages[key];
      checked++;
      if (checked % 500 === 0) process.stderr.write(`  ${checked}/${keys.length}, removed ${removed.length}\n`);
      if (!entry?.tarball) return;
      try {
        await rateLimit();
        const res = await fetch(entry.tarball, { method: 'HEAD' });
        if (res.status !== 404) return;
        // Second signal: a live package must also look gone in its packument.
        let gone = false;
        try {
          const meta = await fetchJSON(`https://registry.npmjs.org/${entry.name.replace('/', '%2F')}`, 1);
          gone = !meta?.versions?.[entry.version];
        } catch (e) {
          // A 404 on the packument is itself proof; anything else is inconclusive.
          if (/HTTP 404/.test(e.message)) gone = true;
        }
        if (!gone) {
          process.stderr.write(`  keep ${key}: tarball 404 but npm still lists ${entry.version}\n`);
          return;
        }
        removed.push({ key, name: entry.name, version: entry.version });
        delete packages[key];
        // Its lockfile would otherwise sit in packages/ forever, one orphan per
        // pruned package, with nothing in the registry pointing at it.
        try { execSync(`rm -rf '${join(PACKAGES_DIR, key)}'`, { timeout: 10000 }); } catch {}
      } catch { /* network noise: keep the entry */ }
    }));
  }

  if (removed.length) {
    writeFileSync(PRUNE_LOG, JSON.stringify(removed, null, 2) + '\n');
    process.stderr.write(`Pruned ${removed.length} packages (log: ${PRUNE_LOG})\n`);
  } else {
    process.stderr.write('Pruned 0 packages\n');
  }
  return removed;
}

async function searchAllPages() {
  let allObjects = [];
  let from = 0;
  let total = 0;
  
  // Resume from saved state
  const saved = existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : null;
  if (saved) {
    allObjects = saved.objects || [];
    from = saved.from || 0;
    total = saved.total || 0;
    process.stderr.write(`Resuming from offset ${from} (${allObjects.length} objects loaded)\n`);
  }
  
  let emptyPages = 0;
  while (from < total || total === 0) {
    if (emptyPages > 3) break;
    
    const url = `${SEARCH_URL}?text=keywords:pi-package&size=${PAGE_SIZE}&from=${from}`;
    process.stderr.write(`Search page ${Math.floor(from / PAGE_SIZE) + 1} (from=${from})...\n`);
    
    try {
      const search = await fetchJSON(url);
      total = search.total || total;
      const objects = search.objects || [];
      
      if (objects.length === 0) { emptyPages++; from += PAGE_SIZE; continue; }
      emptyPages = 0;
      
      allObjects = allObjects.concat(objects);
      from += PAGE_SIZE;
      
      process.stderr.write(`  ${allObjects.length}/${total}\n`);
      
      // Save state every page
      writeFileSync(STATE_PATH, JSON.stringify({ objects: allObjects, from, total }));
      
      // Rate limit between page requests
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      process.stderr.write(`  Page failed: ${err.message}, will retry on next run\n`);
      break;
    }
  }
  
  process.stderr.write(`\nTotal: ${total}, loaded: ${allObjects.length}\n`);
  return allObjects;
}

async function processPackage(obj, packages) {
  const pkgName = obj.package?.name;
  if (!pkgName) return;

  const key = pkgName.replace(/@/g, '').replace(/\//g, '-');
  try {
    const meta = await getPackageMetadata(pkgName);
    if (!meta) {
      // getPackageMetadata returns null for packages that exclude Linux. The entry is
      // unreachable here (Nix does not run on Windows), so drop it rather than leaving
      // a permanent build failure in the registry.
      if (packages[key] && !(await supportsPosixOnNpm(pkgName))) {
        delete packages[key];
        try { execSync(`rm -rf '${join(PACKAGES_DIR, key)}'`, { timeout: 5000 }); } catch {}
        process.stderr.write(`  dropped ${pkgName}: no Linux support\n`);
      }
      return;
    }

    const prev = packages[key];
    const bumped = prev && prev.version !== meta.version;
    
    // Carry over the previous npmDepsHash only if the version did not move; a bumped
    // version has a different dependency tree, so the hash is invalid and must be
    // recomputed by the workflow's "Compute npmDepsHash" step.
    if (bumped) {
      meta.npmDepsHash = null;
      try { execSync(`rm -f '${join(PACKAGES_DIR, key, 'package-lock.json')}'`, { timeout: 5000 }); } catch {}
      process.stderr.write(`  bumped ${pkgName} ${prev.version} -> ${meta.version}\n`);
    }
    
    packages[key] = meta;
    
    if (!REGISTRY_ONLY && meta.tier === 'B') {
      await generateLockfile(pkgName, meta.tarball, key, meta.version);
    }
  } catch (err) {
    process.stderr.write(`  Error ${pkgName}: ${err.message}\n`);
  }
}

async function main() {
  const existing = existsSync(REGISTRY_PATH) ? JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) : { packages: {} };
  const packages = existing.packages || {};
  
  // Refresh specific keys and exit, without paying for a full search crawl. Useful
  // when you know a package moved and do not want to wait for the nightly run.
  // (Ported from Leoguy77/pi-packages.nix#2 by @twstagg, who diagnosed the frozen
  // registry.)
  if (REFRESH_KEYS.length > 0) {
    let updated = 0;
    for (const key of REFRESH_KEYS) {
      const entry = packages[key];
      if (!entry) {
        process.stderr.write(`  skip ${key}: not in registry\n`);
        continue;
      }
      try {
        const meta = await getPackageMetadata(entry.name);
        if (!meta) {
          // Drops the entry when npm says it excludes Linux; otherwise leaves it alone.
          await processPackage({ package: { name: entry.name } }, packages);
          continue;
        }
        if (meta.version === entry.version) {
          process.stderr.write(`  ${key}: already at ${entry.version}\n`);
          continue;
        }
        process.stderr.write(`  ${key}: ${entry.version} -> ${meta.version}\n`);
        // A bump invalidates both the lockfile and the hash: the dependency tree
        // may have moved even when the direct dependency set looks identical, and
        // only regenerating both makes the fixed-output check pass. processPackage
        // owns that, so reuse it rather than duplicating the carry-over logic.
        await processPackage(
          { package: { name: entry.name, version: meta.version } }, packages
        );
        updated++;
      } catch (err) {
        process.stderr.write(`  error ${key}: ${err.message}\n`);
      }
    }
    writeFileSync(REGISTRY_PATH, JSON.stringify({ packages }, null, 2) + '\n');
    process.stderr.write(`Refreshed ${updated} of ${REFRESH_KEYS.length} key(s)\n`);
    return;
  }
  
  // Prune-only run: check the registry without paying for a full search crawl.
  if (PRUNE_ONLY) {
    await pruneDead(packages);
    writeFileSync(REGISTRY_PATH, JSON.stringify({ packages }, null, 2) + '\n');
    return;
  }

  if (LOCKS_ONLY) {
    const tierB = Object.entries(packages)
      .filter(([k, e]) => e.tier === 'B' && (!ONLY.length || ONLY.includes(k)));
    process.stderr.write(`Generating lockfiles for ${tierB.length} Tier B packages...\n`);
    let done = 0;
    for (let i = 0; i < tierB.length; i += CONCURRENCY) {
      const batch = tierB.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async ([key, entry]) => {
        done++;
        process.stderr.write(`[${done}/${tierB.length}] ${entry.name}\n`);
        await generateLockfile(entry.name, entry.tarball, key, entry.version);
      }));
    }
    console.error('Lockfiles done');
    return;
  }
  
  const objects = await searchAllPages();
  
  const processed = new Set(Object.keys(packages));
  
  let fetched = 0;
  let idx = 0;
  let lastSave = 0;
  
  while (idx < objects.length) {
    const batch = objects.slice(idx, idx + CONCURRENCY);
    idx += CONCURRENCY;
    
    await Promise.all(batch.map(async (obj) => {
      const name = obj.package?.name;
      if (!name) return;
      fetched++;
      
      const key = name.replace(/@/g, '').replace(/\//g, '-');
      
      if (LOCKS_ONLY) {
        // Unreachable: the top-level LOCKS_ONLY branch runs before the crawl and
        // returns. Kept only so the key-filter logic below reads coherently.
        // Lockfile-only mode: generate lockfiles for Tier B, skip metadata.
        // generateLockfile is async -- it MUST be awaited, otherwise this returns
        // immediately and the process exits while npm is still resolving.
        const entry = packages[key];
        if (entry && entry.tier === 'B' && !existsSync(join(PACKAGES_DIR, key, 'package-lock.json'))) {
          process.stderr.write(`[${fetched}/${objects.length}] ${name} (lockfile)\n`);
          await generateLockfile(name, entry.tarball, key, entry.version);
        }
        return;
      }
      
      if (processed.has(key) && !REFRESH_STALE) {
        process.stderr.write(`[${fetched}/${objects.length}] ${name} (cached)\n`);
        return;
      }
      
      // Refresh mode: the search hit already carries the published version, so a
      // package whose version did not move needs no metadata fetch at all. This is
      // what keeps a full refresh at minutes instead of an hour of 250ms waits.
      if (ONLY.length && !ONLY.includes(key)) return;
      
      const cachedVersion = packages[key]?.version;
      if (REFRESH_STALE && cachedVersion && obj.package?.version === cachedVersion) {
        process.stderr.write(`[${fetched}/${objects.length}] ${name} (up to date)\n`);
        return;
      }
      
      process.stderr.write(`[${fetched}/${objects.length}] ${name}\n`);
      await processPackage(obj, packages);
      processed.add(key);
    }));
    
    // Save checkpoint every 250 packages
    if (idx - lastSave >= 250 || idx >= objects.length) {
      writeFileSync(REGISTRY_PATH, JSON.stringify({ packages }, null, 2));
      lastSave = idx;
      process.stderr.write(`  Checkpoint: ${Object.keys(packages).length} packages\n`);
    }
  }
  
  // After the crawl, so packages added this run are checked too. Runs before the
  // final write so a prune lands in the same commit as the rest of the run.
  if (PRUNE) await pruneDead(packages);

  writeFileSync(REGISTRY_PATH, JSON.stringify({ packages }, null, 2));
  if (existsSync(STATE_PATH)) execSync(`rm ${STATE_PATH}`);
  
  console.error(`\nRegistry: ${Object.keys(packages).length} packages`);
  console.error(`Tier A: ${Object.values(packages).filter(p => p.tier === 'A').length}`);
  console.error(`Tier B: ${Object.values(packages).filter(p => p.tier === 'B').length}`);
  
  // Output the registry JSON to stdout for piping
  console.log(JSON.stringify({ packages }));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
