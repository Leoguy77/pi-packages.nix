import { readFileSync, writeFileSync, existsSync } from 'fs';

const reg = JSON.parse(readFileSync('registry/registry.json', 'utf8'));
const pkgs = reg.packages;
const names = Object.keys(pkgs);

const tierA = names.filter(n => pkgs[n].tier === 'A').length;
const tierB = names.filter(n => pkgs[n].tier === 'B').length;
// Registry keys are the package directory names verbatim (scoped names are already
// flattened at crawl time: `@scope/pkg` -> `scope-pkg`). Substituting here would
// silently count zero, which is how "With lockfile" sat at 1,969 while the real
// number was 4,433.
const withLock = names.filter(n => pkgs[n].tier === 'B' && existsSync(`packages/${n}/package-lock.json`)).length;
const fallback = tierB - withLock;
const withHash = names.filter(n => pkgs[n].tier === 'B' && pkgs[n].npmDepsHash).length;

const fmt = n => n.toLocaleString('en-US');

// The README describes the package count twice, in different wording: a headline
// sentence near the top and the Stats table at the bottom. Both are updated here.
// The `### Tiers` table is deliberately NOT rewritten from these counts -- it lists
// the advertised tiers with their own rounding conventions.
const edits = [
  // headline: "This flake provides **N pi native packages**"
  [/\*\*[\d,]+ pi native packages\*\*/g, `**${fmt(tierA + tierB)} pi native packages**`],
  // "**N packages** — see registry.json"
  [/\*\*[\d,]+ packages\*\* — see/g, `**${fmt(tierA + tierB)} packages** — see`],

  // Stats table
  [/\| Total packages \| [\d,]+ \|/g, `| Total packages | ${fmt(tierA + tierB)} |`],
  [/\| Tier A \(zero deps, direct unpack\) \| [\d,]+ \|/g, `| Tier A (zero deps, direct unpack) | ${fmt(tierA)} |`],
  [/\| Tier B \(has npm deps\) \| [\d,]+ \|/g, `| Tier B (has npm deps) | ${fmt(tierB)} |`],
  [/\| With lockfile \(`buildNpmPackage`, cached\) \| [\d,]+ \|/g, `| With lockfile (\`buildNpmPackage\`, cached) | ${fmt(withLock)} |`],
  [/\| Fallback \(`stdenv.mkDerivation`, needs network\) \| [\d,]+ \|/g, `| Fallback (\`stdenv.mkDerivation\`, needs network) | ${fmt(fallback)} |`],
  [/\| Tier B with `npmDepsHash` computed \| [\d,]+ \|/g, `| Tier B with \`npmDepsHash\` computed | ${fmt(withHash)} |`],

  // prose sentences that quote a count
  [/(The )[\d,]+( fallback packages have genuinely unresolvable)/, `$1${fmt(fallback)}$2`],

  // Tiers table -- keep the description text, replace only the count column
  [/(\| \*\*Tier A\*\* \| )[\d,]+( \|)/, `$1${fmt(tierA)}$2`],
  [/(\| \*\*Tier B with lockfile\*\* \| )[\d,]+( \|)/, `$1${fmt(withLock)}$2`],
  [/(\| \*\*Tier B fallback\*\* \| )[\d,]+( \|)/, `$1${fmt(fallback)}$2`],
];

let r = readFileSync('README.md', 'utf8');
const before = r;
const missed = [];
for (const [re, replacement] of edits) {
  if (!re.test(r)) missed.push(re.source);
  re.lastIndex = 0;
  r = r.replace(re, replacement);
}
if (r === before && missed.length === 0) {
  console.log('README stats unchanged');
} else {
  writeFileSync('README.md', r);
  console.log(`README stats updated: ${fmt(tierA + tierB)} total, ${fmt(tierA)} A, ${fmt(tierB)} B, ${fmt(withLock)} lockfile, ${fmt(fallback)} fallback, ${fmt(withHash)} hashed`);
}
// A missed pattern means the README wording changed and that number is now stale.
// Fail loudly instead of printing "updated" over a stale table (which is how the
// Tiers table drifted by ~5,000).
if (missed.length) {
  console.error(`error: ${missed.length} pattern(s) did not match README.md:`);
  for (const m of missed) console.error(`  ${m}`);
  process.exit(1);
}
