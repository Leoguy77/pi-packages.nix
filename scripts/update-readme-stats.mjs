// Keep the package count in README.md and the repo description from going stale.
//
// Both used to be updated by a crawler that also carried a tier table and hash
// statistics. Those numbers no longer exist, so this only tracks the count of
// packages, and fails loudly if the wording it expects is gone rather than
// silently leaving a stale number in place.

import { readFileSync, writeFileSync } from 'fs';

const reg = JSON.parse(readFileSync('registry/registry.json', 'utf8'));
const total = Object.keys(reg.packages).length;
const fmt = n => n.toLocaleString('en-US');

const edits = [
  // "**13,829 packages** — no binary cache needed"
  [/\*\*[\d,]+ packages\*\*/g, `**${fmt(total)} packages**`],
];

let r = readFileSync('README.md', 'utf8');
const before = r;
const missed = [];
for (const [re, replacement] of edits) {
  if (!re.test(r)) missed.push(re.source);
  r = r.replace(re, replacement);
}

if (r !== before) writeFileSync('README.md', r);
console.log(r === before ? 'README count unchanged' : `README count updated: ${fmt(total)}`);

if (missed.length) {
  console.error(`error: ${missed.length} pattern(s) did not match README.md:`);
  for (const m of missed) console.error(`  ${m}`);
  process.exit(1);
}
