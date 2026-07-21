import { readFileSync, writeFileSync, existsSync } from 'fs';

const reg = JSON.parse(readFileSync('registry/registry.json', 'utf8'));
const pkgs = reg.packages;
const names = Object.keys(pkgs);

const tierA = names.filter(n => pkgs[n].tier === 'A').length;
const tierB = names.filter(n => pkgs[n].tier === 'B').length;

// Count lockfiles by checking directory names matching the key pattern in registry
const withLock = names.filter(n => pkgs[n].tier === 'B' && existsSync(`packages/${n.replace(/@/g, '').replace(/\//g, '-')}/package-lock.json`)).length;
const fallback = tierB - withLock;

const fmt = n => n.toLocaleString('en-US');

let r = readFileSync('README.md', 'utf8');
r = r.replace(/\*\*[\d,]+ packages\*\*/g, `**${fmt(tierA + tierB)} packages**`);
r = r.replace(/\([\d,]+ Tier A \+ [\d,]+ Tier B\)/g, `(${fmt(tierA)} Tier A + ${fmt(tierB)} Tier B)`);
r = r.replace(/- \*\*Tier A\*\* \([\d,]+\) —.*/, `- **Tier A** (${fmt(tierA)}) — No npm dependencies (peerDeps only) → instant unpack from tarball`);
r = r.replace(/- \*\*Tier B with lockfile\*\* \([\d,]+\) —.*/, `- **Tier B with lockfile** (${fmt(withLock)}) — Has dependencies, builds via \`buildNpmPackage\` with pre-generated lockfile (cached)`);
r = r.replace(/- \*\*Tier B fallback\*\* \([\d,]+\) —.*/, `- **Tier B fallback** (${fmt(fallback)}) — Has dependencies but no valid lockfile (broken npm dep trees, private packages, git deps), builds via inline \`npm install\` (needs \`--option sandbox false\`)`);
r = r.replace(/\| Total packages \| [\d,]+ \|/g, `| Total packages | ${fmt(tierA + tierB)} |`);
r = r.replace(/\| Tier A \(zero deps, direct unpack\) \| [\d,]+ \|/g, `| Tier A (zero deps, direct unpack) | ${fmt(tierA)} |`);
r = r.replace(/\| Tier B \(has npm deps\) \| [\d,]+ \|/g, `| Tier B (has npm deps) | ${fmt(tierB)} |`);
r = r.replace(/\| With lockfile \(`buildNpmPackage`, cached\) \| [\d,]+ \|/g, `| With lockfile (\`buildNpmPackage\`, cached) | ${fmt(withLock)} |`);
r = r.replace(/\| Fallback \(`stdenv.mkDerivation`, needs network\) \| [\d,]+ \|/g, `| Fallback (\`stdenv.mkDerivation\`, needs network) | ${fmt(fallback)} |`);
r = r.replace(/(The )[\d,]+( fallback packages have genuinely unresolvable)/, `$1${fmt(fallback)}$2`);

writeFileSync('README.md', r);
console.log(`README stats updated: ${fmt(tierA + tierB)} total, ${fmt(tierA)} A, ${fmt(tierB)} B, ${fmt(withLock)} lockfile, ${fmt(fallback)} fallback`);
