#!/usr/bin/env node
// generate.mjs - Crawl npm registry for pi-package keyword and generate registry.json
//
// Output: JSON with packages array containing name, version, tarball, hash, tier, etc.
// Tier A = no dependencies (peerDeps only) → fast builds
// Tier B = has dependencies → needs buildNpmPackage

const SEARCH_URL = 'https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=250';

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
  
  // Tier A: no real dependencies (only peerDeps)
  // Tier B: has dependencies that need npm install
  const tier = Object.keys(deps).length === 0 ? 'A' : 'B';
  
  return {
    name: versionMeta.name,
    version: latestVersion,
    tarball: versionMeta.dist.tarball,
    hash: versionMeta.dist.integrity, // Already SRI format (sha512-...)
    tier,
    piManifest,
    dependencies: deps,
    peerDependencies: peerDeps,
    keywords: versionMeta.keywords || [],
    description: versionMeta.description || '',
    downloads: 0, // Will be populated from search results
  };
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
      
      // Use sanitized name as key (no @ or /)
      const key = pkgName.replace(/@/g, '').replace(/\//g, '-');
      packages[key] = meta;
      
    } catch (err) {
      console.error(`  Error: ${err.message}`);
    }
  }
  
  // Output JSON
  console.log(JSON.stringify({ packages }, null, 2));
  console.error(`\nGenerated ${Object.keys(packages).length} package entries`);
  console.error(`Tier A: ${Object.values(packages).filter(p => p.tier === 'A').length}`);
  console.error(`Tier B: ${Object.values(packages).filter(p => p.tier === 'B').length}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
