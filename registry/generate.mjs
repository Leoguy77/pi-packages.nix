#!/usr/bin/env node
// generate.mjs - Crawl npm registry for pi-package keyword and generate registry.json
// Also generates package-lock.json for Tier B packages at packages/<key>/package-lock.json

import { execSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

const SEARCH_URL = 'https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=250';
const PACKAGES_DIR = new URL('../packages', import.meta.url).pathname;
const TMP = '/tmp/pi-registry-gen';

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

async function getPackageMetadata(name) {
  const meta = await fetchJSON(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  const latestVersion = meta['dist-tags']?.latest;
  if (!latestVersion) return null;
  
  const versionMeta = meta.versions?.[latestVersion];
  if (!versionMeta) return null;
  
  const deps = versionMeta.dependencies || {};
  const peerDeps = versionMeta.peerDependencies || {};
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
    peerDependencies: peerDeps,
    keywords: versionMeta.keywords || [],
    description: versionMeta.description || '',
    downloads: 0,
  };
}

function generateLockfile(name, tarballUrl, key) {
  const pkgDir = join(PACKAGES_DIR, key);
  const lockPath = join(pkgDir, 'package-lock.json');
  
  // Skip if lockfile already exists
  if (existsSync(lockPath)) {
    console.error(`  Lockfile exists, skipping`);
    return;
  }
  
  const workDir = join(TMP, key);
  
  try {
    execSync(`rm -rf ${workDir}`);
    mkdirSync(workDir, { recursive: true });
    
    // Download tarball
    execSync(`curl -sL '${tarballUrl}' -o ${workDir}/pkg.tgz`, { stdio: 'pipe' });
    
    // Extract
    execSync(`tar -xzf ${workDir}/pkg.tgz --strip-components=1 -C ${workDir}/pkg`, { stdio: 'pipe' });
    
    // Generate lockfile
    execSync(`cd ${workDir}/pkg && HOME=${workDir} npm install --package-lock-only --ignore-scripts --no-audit --no-fund --loglevel=error`, {
      stdio: 'pipe',
      timeout: 30000,
    });
    
    // Copy lockfile to packages/<key>/
    if (existsSync(join(workDir, 'pkg', 'package-lock.json'))) {
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(lockPath, readFileSync(join(workDir, 'pkg', 'package-lock.json')));
      console.error(`  Generated lockfile (${Math.round(readFileSync(lockPath).length / 1024)}KB)`);
    } else {
      console.error(`  No lockfile generated`);
    }
    
  } catch (err) {
    console.error(`  Lockfile generation failed: ${err.message}`);
  } finally {
    execSync(`rm -rf ${workDir}`);
  }
}

async function main() {
  console.error('Fetching pi-package search results...');
  const search = await fetchJSON(SEARCH_URL);
  console.error(`Found ${search.total} packages`);
  
  const packages = {};
  let fetched = 0;
  
  for (const obj of search.objects || []) {
    const pkgName = obj.package?.name;
    if (!pkgName) continue;
    
    try {
      console.error(`[${++fetched}/${search.objects.length}] Fetching ${pkgName}...`);
      const meta = await getPackageMetadata(pkgName);
      if (!meta) continue;
      
      const key = pkgName.replace(/@/g, '').replace(/\//g, '-');
      packages[key] = meta;
      
      // Generate lockfile for Tier B packages
      if (meta.tier === 'B') {
        generateLockfile(pkgName, meta.tarball, key);
      }
      
    } catch (err) {
      console.error(`  Error: ${err.message}`);
    }
  }
  
  // Output registry.json
  writeFileSync(
    new URL('../registry/registry.json', import.meta.url).pathname,
    JSON.stringify({ packages }, null, 2)
  );
  
  console.error(`\nGenerated ${Object.keys(packages).length} package entries`);
  console.error(`Tier A: ${Object.values(packages).filter(p => p.tier === 'A').length}`);
  console.error(`Tier B: ${Object.values(packages).filter(p => p.tier === 'B').length}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
