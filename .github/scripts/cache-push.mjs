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
// Nix echoes the whole /nix/store/...drv path in its first error line, which ate
// the 400-char budget and left nothing but "npm e". Keep the store basename so
// the actual cause survives the slice.
const firstError = b => (b || '').toString().split('\n')
  .filter(l => /error/i.test(l)).slice(0, 4).join(' | ')
  .replace(/\/nix\/store\/[a-z0-9]+-/g, '')
  .slice(0, 400);

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

// Which of these output paths will attic accept? Only paths nix has registered as
// valid, which `nix path-info` answers and the filesystem does not: a failed build
// leaves its output directory behind, so `existsSync` says yes for a path that was
// never produced. Trusting it pushed 183 such paths in run 45811788056 and attic
// rejected every one with "path ... is not valid".
//
// path-info is not trusted blindly either: it once answered null for paths that were
// fine, which reported 180 successful builds as garbage-collected in run 45442807069.
// So a path-info failure (non-zero exit, unparseable output) falls back to the
// filesystem, and only a clean answer with a null value rules a path out.
const pushablePaths = paths => {
  const present = paths.filter(p => p && existsSync(p));
  if (!present.length) return [];
  const r = spawnSync('nix', ['path-info', '--json-format', '1', '--json', ...present],
    { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return present;
  let info;
  try {
    info = JSON.parse(r.stdout.toString());
  } catch { return present; }
  if (!info || typeof info !== 'object' || !Object.keys(info).length) return present;
  return present.filter(p => info[p]);
};

for (let i = 0; i < toBuild.length; i += BATCH) {
  const batch = toBuild.slice(i, i + BATCH);
  console.log(`Build batch ${i / BATCH + 1}: ${batch.length} pkgs`);

  spawnSync('nix', ['build', '--no-link', '--keep-going',
    '--option', 'sandbox', 'false', '--option', 'max-jobs', '4',
    ...batch.map(k => '.#pi-' + safe(k))],
    { stdio: ['ignore', 'inherit', 'inherit'], timeout: 3 * 60 * 60 * 1000 });

  // --keep-going means some of the batch may have failed; the store tells us
  // which ones without one `nix build` spawn per package.
  // Candidates only: a failed build leaves its output directory behind, so a path
  // that exists on disk has not necessarily been produced. pushablePaths asks nix.
  const candidates = batch.filter(k => existsSync(outPath(k) || ''));
  const pushable = pushablePaths(candidates.map(outPath));
  const shipped = new Set(candidates.filter(k => pushable.includes(outPath(k))).map(k => k));

  if (pushable.length) {
    const all = spawnSync(ATTIC, ['push', CACHE, ...pushable], { timeout: 1_800_000 });
    if (all.status === 0) {
      pushed += pushable.length;
    } else {
      // stderr used to be swallowed here, so a whole-batch rejection left no trace
      // in the log and every package in it looked like a silent failure.
      console.log(`batch push failed (exit ${all.status}): ${(all.stderr || '').toString().slice(0, 500)}`);
      // One bad path fails the whole call, so retry one at a time to keep the rest.
      shipped.clear();
      for (const p of pushable) {
        const r = spawnSync(ATTIC, ['push', CACHE, p], { timeout: 300_000 });
        if (r.status === 0) {
          pushed++;
          for (const k of candidates) if (outPath(k) === p) shipped.add(k);
        }
      }
    }
  }

  // Everything this batch did not get into the cache gets one more try on its own,
  // which is also the only place the real npm error is visible (the batch build's
  // stderr is interleaved across 40 packages). Before this skipped anything whose
  // outPath merely existed, so failed builds never got their true cause recorded --
  // 183 of them were labelled "garbage-collected" in run 45811788056 while the log
  // showed `error: Cannot build ...drv` for the same names.
  for (const k of batch) {
    if (shipped.has(k)) continue;
    const r = spawnSync('nix', ['build', '--no-link', '.#pi-' + safe(k)], { timeout: 300_000 });
    if (r.status !== 0) {
      failed.push({ name: k, outPath: outPath(k) || null, err: firstError(r.stderr) || `nix build exit ${r.status}` });
      continue;
    }
    const ok = pushablePaths([outPath(k)]);
    if (!ok.length) {
      failed.push({ name: k, outPath: outPath(k) || null, err: 'nix reports the output path is not valid after a successful build' });
      continue;
    }
    const p = spawnSync(ATTIC, ['push', CACHE, ok[0]], { timeout: 300_000 });
    if (p.status === 0) pushed++;
    else failed.push({ name: k, outPath: outPath(k) || null, err: firstError(p.stderr) || `attic exit ${p.status}` });
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
