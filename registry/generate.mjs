#!/usr/bin/env node
// generate.mjs - Crawl npm registry for pi-package keyword and generate registry.json
// Also generates package-lock.json for Tier B packages

import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

const CONCURRENCY = parseInt(process.env.CONCURRENCY || '4', 10);
const REGISTRY_ONLY = process.env.REGISTRY_ONLY === '1';
const LOCKS_ONLY = process.env.LOCKS_ONLY === '1';
const SEARCH_URL = 'https://registry.npmjs.org/-/v1/search';
const PAGE_SIZE = 250;
const PACKAGES_DIR = new URL('../packages', import.meta.url).pathname;
const REGISTRY_PATH = new URL('../registry/registry.json', import.meta.url).pathname;
const STATE_PATH = new URL('../registry/.generate-state.json', import.meta.url).pathname;
const TMP = '/tmp/pi-registry-gen';

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

async function getPackageMetadata(name) {
  const meta = await fetchJSON(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  const latestVersion = meta['dist-tags']?.latest;
  if (!latestVersion) return null;
  
  const versionMeta = meta.versions?.[latestVersion];
  if (!versionMeta) return null;
  
  const deps = versionMeta.dependencies || {};
  const piManifest = versionMeta.pi || {};
  const tier = Object.keys(deps).length === 0 ? 'A' : 'B';
  
  return {
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
}

// Shared npm cache across all lockfile generations
const NPM_CACHE = join(TMP, 'shared-cache');

async function runNpmLock(workDir) {
  // Step 1: package-lock-only for fast resolution
  // Step 2: npm install to populate integrity hashes
  // Step 3: delete node_modules
  
  // Step 1: Generate lockfile structure
  await new Promise((resolve, reject) => {
    const c1 = spawn('npm', [
      'install', '--package-lock-only', '--ignore-scripts',
      '--no-audit', '--no-fund', '--legacy-peer-deps',
      '--loglevel=error', `--cache=${NPM_CACHE}`
    ], { cwd: join(workDir, 'pkg'), env: { ...process.env, HOME: workDir }, stdio: 'pipe' });
    const t1 = setTimeout(() => { c1.kill(); reject(new Error('timeout-step1')); }, 120000);
    c1.on('exit', (c) => { clearTimeout(t1); c === 0 ? resolve() : reject(new Error(`npm exit code ${c}`)); });
    c1.on('error', reject);
  });
  
  // Step 2: Full install to fill integrity, prefer-offline for speed
  await new Promise((resolve, reject) => {
    const c2 = spawn('npm', [
      'install', '--ignore-scripts',
      '--no-audit', '--no-fund', '--legacy-peer-deps',
      '--prefer-offline', '--loglevel=error', `--cache=${NPM_CACHE}`
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

async function generateLockfile(name, tarballUrl, key) {
  const pkgDir = join(PACKAGES_DIR, key);
  const lockPath = join(pkgDir, 'package-lock.json');
  
  if (existsSync(lockPath)) return;
  
  const workDir = join(TMP, key);
  try {
    execSync(`rm -rf ${workDir} ; mkdir -p ${workDir}/pkg`, { stdio: 'pipe', timeout: 10000 });
    execSync(`curl -sL --max-time 30 '${tarballUrl}' -o ${workDir}/pkg.tgz`, { stdio: 'pipe', timeout: 35000 });
    execSync(`tar -xzf ${workDir}/pkg.tgz --strip-components=1 -C ${workDir}/pkg`, { stdio: 'pipe', timeout: 10000 });
    await runNpmLock(workDir);
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
  
  try {
    const meta = await getPackageMetadata(pkgName);
    if (!meta) return;
    
    const key = pkgName.replace(/@/g, '').replace(/\//g, '-');
    packages[key] = meta;
    
    if (!REGISTRY_ONLY && meta.tier === 'B') {
      await generateLockfile(pkgName, meta.tarball, key);
    }
  } catch (err) {
    process.stderr.write(`  Error ${pkgName}: ${err.message}\n`);
  }
}

async function main() {
  const existing = existsSync(REGISTRY_PATH) ? JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) : { packages: {} };
  const packages = existing.packages || {};
  
  if (LOCKS_ONLY) {
    const tierB = Object.entries(packages).filter(([_, e]) => e.tier === 'B');
    process.stderr.write(`Generating lockfiles for ${tierB.length} Tier B packages...\n`);
    let done = 0;
    for (let i = 0; i < tierB.length; i += CONCURRENCY) {
      const batch = tierB.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async ([key, entry]) => {
        done++;
        process.stderr.write(`[${done}/${tierB.length}] ${entry.name}\n`);
        await generateLockfile(entry.name, entry.tarball, key);
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
        // Lockfile-only mode: generate lockfiles for Tier B, skip metadata
        const entry = packages[key];
        if (entry && entry.tier === 'B') {
          process.stderr.write(`[${fetched}/${objects.length}] ${name} (lockfile)\n`);
          generateLockfile(name, entry.tarball, key);
        }
        return;
      }
      
      if (processed.has(key)) {
        process.stderr.write(`[${fetched}/${objects.length}] ${name} (cached)\n`);
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
  
  writeFileSync(REGISTRY_PATH, JSON.stringify({ packages }, null, 2));
  
  // Cleanup state
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
