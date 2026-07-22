/**
 * compute-hashes-raw.mjs — Compute npmDepsHash for ALL Tier B packages.
 *
 * Direct approach: download tarballs via nix store prefetch-file,
 * extract, npm install with lockfile, nix hash path node_modules.
 *
 * Much faster than per-package nix build because:
 * - No Nix evaluation overhead per package
 * - npm cache shared across all installs
 * - Parallel workers
 *
 * Usage: nix shell nixpkgs#nodejs nixpkgs#gnutar -c node scripts/compute-hashes-raw.mjs
 *        (Use --parallel=N to set concurrency, default: 4)
 *        (Use --resume to skip already-hashed packages)
 *        (Use --start=N to skip first N packages)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'fs';
import { spawnSync } from 'child_process';
import { cpus } from 'os';
import path from 'path';

const registryPath = path.resolve('registry/registry.json');
const packagesDir = path.resolve('packages');
const workDir = '/tmp/hash-batch';

const parallel = parseInt(process.argv.find(a => a.startsWith('--parallel='))?.split('=')[1] || '4', 10);
const startIdx = parseInt(process.argv.find(a => a.startsWith('--start='))?.split('=')[1] || '0', 10);

const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
const entries = Object.entries(registry.packages);

const queue = entries.filter(([key, val]) =>
  (val.tier === 'B' || val.tier === 'C') &&
  !val.npmDepsHash &&
  existsSync(path.join(packagesDir, key, 'package-lock.json'))
);

const skipCount = Math.min(startIdx, queue.length);
const toProcess = queue.slice(skipCount);

console.log(`Total needing hash: ${queue.length}`);
console.log(`Skipping first ${skipCount}, processing ${toProcess.length}`);
console.log(`Parallel: ${parallel}`);
console.log('');

let completed = 0;
let failed = 0;
const errors = [];
let batchNum = 0;

function processPackage([key, val]) {
  const dir = path.join(workDir, key);
  
  try {
    // Clean and create directory
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    // 1. Download tarball via nix store prefetch-file
    const dl = spawnSync('nix', ['store', 'prefetch-file', '--json', val.tarball], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    });
    if (dl.status !== 0) {
      return { status: 'dl-fail', error: dl.stderr.toString().slice(0, 200) };
    }
    const dlInfo = JSON.parse(dl.stdout.toString());
    const tgzPath = dlInfo.storePath;
    if (!tgzPath) {
      return { status: 'dl-fail', error: 'no storePath in output: ' + dl.stdout.toString().slice(0, 100) };
    }

    // 2. Extract tarball
    const tar = spawnSync('tar', ['-xzf', tgzPath, '--strip-components=1', '-C', dir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
    if (tar.status !== 0) {
      return { status: 'extract-fail', error: tar.stderr.toString().slice(0, 200) };
    }

    // 3. Copy lockfile
    copyFileSync(path.join(packagesDir, key, 'package-lock.json'), path.join(dir, 'package-lock.json'));

    // 4. npm install
    const npm = spawnSync('npm', [
      'install', '--ignore-scripts', '--no-audit', '--no-fund',
      '--legacy-peer-deps', '--loglevel=error'
    ], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
    if (npm.status !== 0) {
      const errMsg = (npm.stderr.toString() || npm.stdout.toString()).slice(0, 200);
      return { status: 'npm-fail', error: errMsg };
    }

    // 5. Compute hash of node_modules
    const hash = spawnSync('nix', ['hash', 'path', path.join(dir, 'node_modules')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
    if (hash.status !== 0) {
      return { status: 'hash-fail', error: hash.stderr.toString().slice(0, 200) };
    }

    const realHash = hash.stdout.toString().trim();
    if (!realHash.startsWith('sha256-')) {
      return { status: 'hash-fail', error: 'Unexpected hash format: ' + realHash };
    }

    return { status: 'ok', hash: realHash };

  } catch (e) {
    return { status: 'exception', error: e.message };
  } finally {
    // Cleanup
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

async function processBatch(batch) {
  batchNum++;
  const results = batch.map(([key, val]) => {
    const r = processPackage([key, val]);
    if (r.status === 'ok') {
      registry.packages[key].npmDepsHash = r.hash;
      completed++;
      return { key, ok: true, hash: r.hash };
    }
    failed++;
    errors.push(`${key}: ${r.status} — ${r.error}`);
    return { key, ok: false };
  });

  // Write progress
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
  const done = completed + failed;
  const pct = (done / toProcess.length * 100).toFixed(1);
  const rate = (completed / done * 100).toFixed(0);
  console.log(`  [${batchNum}] ${done}/${toProcess.length} (${pct}%) — ${completed} hashes (${rate}% success), ${failed} failed`);
}

async function main() {
  console.time('total');
  const startTime = Date.now();
  
  // Create work dir
  mkdirSync(workDir, { recursive: true });

  for (let i = 0; i < toProcess.length; i += parallel) {
    const batch = toProcess.slice(i, i + parallel);
    await processBatch(batch);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  const elapsedMin = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n=== Done in ${elapsed}s (${elapsedMin}min) ===`);
  console.log(`Total: ${queue.length}, Hashes: ${completed}, Failed: ${failed}`);
  
  if (errors.length > 0) {
    console.log(`\nErrors (first 30 of ${errors.length}):`);
    for (const e of errors.slice(0, 30)) {
      console.log(`  ${e}`);
    }
  }

  registry.registryVersion = (registry.registryVersion || 0) + 1;
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
  console.log(`\nRegistry version now ${registry.registryVersion}`);
}

main().catch(console.error);
