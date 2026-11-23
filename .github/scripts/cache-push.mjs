// Build every Tier B/C package that Attic is missing, push what builds, and
// leave a worklist for the ones that do not.
//
// This lives in a file rather than inline in the workflow because it was inline
// for two runs and the markdown backticks in the summary line were being eaten
// by the shell as command substitution ("+f.name+: command not found").

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';

const ENDPOINT = process.env.ATTIC_ENDPOINT;
const CACHE = process.env.ATTIC_CACHE;
const ATTIC = '/tmp/attic/bin/attic';
// Small batches on purpose: spawnSync's timeout SIGTERMs `nix build`, which
// prints "interrupted by the user" and loses the whole remaining batch. The
// step has 330 minutes; this only bounds one burst so a kill costs little.
const BATCH = Number(process.env.BATCH || 40);

const safe = n => n.replace(/\./g, '_');
const firstError = b => (b || '').toString().split('\n')
  .filter(l => /error/i.test(l)).slice(0, 4).join(' | ').slice(0, 400);

const reg = JSON.parse(readFileSync('registry/registry.json', 'utf8'));
const names = Object.entries(reg.packages)
  .filter(([, v]) => (v.tier === 'B' || v.tier === 'C') && v.npmDepsHash?.startsWith('sha256-'))
  .map(([k]) => k);
console.log(`Packages: ${names.length}`);

// One eval for every outPath. The build output path is decided here, so the
// per-package `nix build --print-out-paths` calls are not needed later.
const evaluated = spawnSync('nix', ['eval', '--json', '--apply',
  'x: builtins.mapAttrs (n: v: v.outPath) x', '.#packages.x86_64-linux'],
  { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
const allOut = JSON.parse(evaluated.stdout.toString());
const outPath = k => allOut['pi-' + safe(k)];

// Skip what Attic already has. This is also what makes a killed run resumable:
// the next run pays ~15 minutes of probing and then starts where the last died.
const toBuild = names.filter(k => {
  const p = outPath(k);
  if (!p?.startsWith('/nix/store/')) return true;
  const hash = p.split('/').pop().split('-')[0];
  const r = spawnSync('curl',
    ['-sfI', '--max-time', '5', `${ENDPOINT}/${CACHE}/${hash}.narinfo`], { timeout: 8000 });
  return r.status !== 0;
});
console.log(`Already cached: ${names.length - toBuild.length}`);
console.log(`Need building: ${toBuild.length}`);

let pushed = 0;
const failed = [];

for (let i = 0; i < toBuild.length; i += BATCH) {
  const batch = toBuild.slice(i, i + BATCH);
  console.log(`Build batch ${i / BATCH + 1}: ${batch.length} pkgs`);

  spawnSync('nix', ['build', '--no-link', '--keep-going',
    '--option', 'sandbox', 'false', '--option', 'max-jobs', '4',
    ...batch.map(k => '.#pi-' + safe(k))],
    { stdio: ['ignore', 'inherit', 'inherit'], timeout: 3 * 60 * 60 * 1000 });

  // --keep-going means some of the batch may have failed; the store tells us
  // which ones without one `nix build` spawn per package.
  const built = batch.filter(k => existsSync(outPath(k) || ''));

  if (built.length) {
    const all = spawnSync(ATTIC, ['push', CACHE, ...built.map(outPath)], { timeout: 1_800_000 });
    if (all.status === 0) {
      pushed += built.length;
    } else {
      // A single bad path fails the whole call, so retry one at a time to find
      // out which and keep the rest.
      for (const k of built) {
        const r = spawnSync(ATTIC, ['push', CACHE, outPath(k)], { timeout: 300_000 });
        if (r.status === 0) pushed++;
        else failed.push({ name: k, outPath: outPath(k), err: firstError(r.stderr) });
      }
    }
  }

  // Whatever the batch did not produce gets one more try on its own. Before
  // this checked r.status, anything that succeeded here was still recorded as a
  // failure, never pushed, and then deleted by the `nix store gc` below — which
  // is why 82 packages reported an empty error and vanished from the cache.
  for (const k of batch) {
    if (built.includes(k)) continue;
    const r = spawnSync('nix', ['build', '--no-link', '.#pi-' + safe(k)], { timeout: 300_000 });
    if (r.status !== 0) {
      failed.push({ name: k, outPath: outPath(k) || null, err: firstError(r.stderr) });
      continue;
    }
    const p = spawnSync(ATTIC, ['push', CACHE, outPath(k)], { timeout: 300_000 });
    if (p.status === 0) pushed++;
    else failed.push({ name: k, outPath: outPath(k) || null, err: firstError(p.stderr) });
  }

  console.log(`Pushed: ${pushed}`);
  spawnSync('nix', ['store', 'gc'], { stdio: 'ignore' });
}

console.log(`Done: pushed=${pushed} failed=${failed.length}`);

// A failed build is a real defect (bad lockfile, 404 tarball, native module) that
// the registry sweep cannot see, because the sweep only resolves the graph.
writeFileSync('build-failures.json', JSON.stringify(failed, null, 2) + '\n');
const md = [
  '## Build failures', '',
  `Built ${names.length} packages, pushed ${pushed}, failed ${failed.length}.`, '',
  ...failed.map(f => `- \`${f.name}\` — ${f.err}`),
];
appendFileSync(process.env.GITHUB_STEP_SUMMARY || '/dev/null', md.join('\n') + '\n');
for (const f of failed) console.log(`FAILED ${f.name} :: ${f.err}`);
