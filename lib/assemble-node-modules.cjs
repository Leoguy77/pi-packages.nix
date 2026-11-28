// assemble-node-modules.cjs — lay out a node_modules tree from store paths.
//
// Every dependency was fetched into its own store path by fetchurl, pinned by the
// `integrity` hash the lockfile already carries. This script only places them.
// No npm, no network, no lockfile-equality check.
//
// argv[2] = $out                      package root, tarball already unpacked
// argv[3] = JSON {lockfilePath: storePath}
//
// Copy, not symlink: Node resolves realpath before loading, so a symlinked dep
// would resolve inside its own store path, where its own dependencies are absent.
// Measured: a symlinked vfile fails with ERR_MODULE_NOT_FOUND on vfile-message.
// Copy keeps every realpath inside the tree.
//
// Existing files are kept where the lockfile has nothing to say. Some tarballs
// ship a node_modules of their own (bundled deps), including packages the lockfile
// never declares; npm leaves those in place and so must this, or the package loses
// modules it needs. Where both exist the fetched copy wins, matching npm's rule
// that the lockfile decides the version.
const fs = require('fs');
const path = require('path');

const out = process.argv[2];
const deps = JSON.parse(process.argv[3]);
const paths = Object.keys(deps);

if (paths.length > 0) {
  // Two passes. A single pass fails with EACCES: copying preserves the store's
  // read-only mode, so creating a nested dep (node_modules/a/node_modules/b)
  // underneath an already-copied read-only parent is denied.
  for (const p of paths) fs.mkdirSync(path.join(out, p), { recursive: true });
  for (const p of paths) {
    fs.cpSync(deps[p], path.join(out, p), { recursive: true, force: true, dereference: false });
  }

  // The store is read-only; lifecycle scripts and later steps expect to be able to
  // write inside the package root.
  const makeWritable = (dir) => {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory()) return;
    fs.chmodSync(dir, 0o755);
    for (const f of fs.readdirSync(dir)) makeWritable(path.join(dir, f));
  };
  makeWritable(out);

  // npm normally populates these from each package's `bin` field, which is either
  // a string or {name: path}. Nothing else creates them, and a missing .bin breaks
  // any dependency that shells out to a sibling's CLI.
  const binDir = path.join(out, 'node_modules', '.bin');
  const links = [];
  for (const p of paths) {
    const dir = path.join(out, p);
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
    if (!pkg.bin) continue;
    const pairs = typeof pkg.bin === 'string'
      ? [[(pkg.name || p).split('/').pop(), pkg.bin]]
      : Object.entries(pkg.bin);
    for (const [n, rel] of pairs) {
      const target = path.join(dir, rel);
      if (fs.existsSync(target)) links.push([n, target]);
    }
  }
  if (links.length) {
    fs.mkdirSync(binDir, { recursive: true });
    for (const [n, target] of links) {
      const link = path.join(binDir, n);
      try { fs.unlinkSync(link); } catch {}
      fs.symlinkSync(target, link);
    }
  }
}
