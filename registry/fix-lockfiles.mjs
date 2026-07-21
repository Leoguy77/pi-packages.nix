#!/usr/bin/env node
// fix-lockfiles.mjs - Fix missing integrity hashes via npm registry API
// For each lockfile entry without integrity, fetch it from registry.npmjs.org

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { readdirSync } from 'fs';
import { join } from 'path';

const PACKAGES_DIR = new URL('../packages', import.meta.url).pathname;
const CONCURRENCY = 8;
const RATE_LIMIT_MS = 50;

const dirs = readdirSync(PACKAGES_DIR).filter(d => d !== '.gitkeep');
let fixed = 0;
let failed = 0;

for (const dir of dirs) {
  const lockPath = join(PACKAGES_DIR, dir, 'package-lock.json');
  if (!existsSync(lockPath)) continue;
  
  const content = readFileSync(lockPath, 'utf8');
  const lock = JSON.parse(content);
  
  const missing = Object.entries(lock.packages || {})
    .filter(([pkg, info]) => info.version && !info.integrity && pkg !== '');
  
  if (missing.length === 0) continue;
  
  process.stderr.write(`[${dir}] fixing ${missing.length} missing integrity...\n`);
  
  // Fetch integrity in batches
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const batch = missing.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async ([pkgPath, info]) => {
      const pkgName = (pkgPath.match(/@[^/]+\/[^/]+$/) || pkgPath.match(/[^/]+$/))[0];
      const ver = info.version;
      // Build npm-compatible package URL
      const encodedName = pkgName.startsWith('@')
        ? '@' + encodeURIComponent(pkgName.slice(1).split('/')[0]) + '%2F' + encodeURIComponent(pkgName.split('/')[1])
        : encodeURIComponent(pkgName);
      const url = `https://registry.npmjs.org/${encodedName}/${ver}`;
      
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.dist?.integrity) {
          lock.packages[pkgPath].integrity = data.dist.integrity;
        }
        await new Promise(r => setTimeout(r, Math.random() * 50));
      } catch (err) {
        if (err.name === 'AbortError') process.stderr.write(`  ✗ ${pkgName}@${ver}: timeout\n`);
        else process.stderr.write(`  ✗ ${pkgName}@${ver}: ${err.message}\n`);
      }
    }));
  }
  
  // Write back
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  
  // Verify
  const verify = JSON.parse(readFileSync(lockPath, 'utf8'));
  const stillMissing = Object.entries(verify.packages || {})
    .filter(([pkg, info]) => info.version && !info.integrity && pkg !== '');
  
  if (stillMissing.length === 0) {
    process.stderr.write(`  ✓ ${dir}: all fixed\n`);
    fixed++;
  } else {
    process.stderr.write(`  ⚠ ${dir}: ${stillMissing.length} still broken\n`);
    failed++;
  }
}

process.stderr.write(`\nDone. Fixed: ${fixed}, Failed: ${failed}\n`);
