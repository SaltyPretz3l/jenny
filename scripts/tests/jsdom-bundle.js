'use strict';

// A single-file build of jsdom for test processes. Requiring jsdom loads ~940
// modules from node_modules, and on Windows that file-system work costs about
// 0.3 s in each of the ~650 test processes that touch jsdom (2026-10-04:
// require 550 ms -> 250 ms). The safe runner builds the bundle once per
// jsdom/lockfile version into node_modules/.cache and preloads
// jsdom-bundle-preload.js, which points require('jsdom') at it. It is the same
// jsdom code; when the bundle cannot be built the tests use node_modules as
// before. JENNY_TEST_JSDOM_BUNDLE=0 turns it off.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PRELOAD_PATH = path.join(__dirname, 'jsdom-bundle-preload.js');
const BUNDLE_ENV_VAR = 'JENNY_JSDOM_BUNDLE';
// jsdom reads its default stylesheet from ../../../browser relative to the
// module that needs it, so the bundle sits three directories below the key.
const BUNDLE_SUBPATH = path.join('lib', 'living', 'css', 'jsdom-bundle.js');

function bundleKey(root) {
  const read = (file) => fs.readFileSync(path.join(root, file));
  const hash = crypto.createHash('sha1');
  hash.update(read('package-lock.json'));
  hash.update(fs.readFileSync(__filename));
  const version = (name) => JSON.parse(read(path.join('node_modules', name, 'package.json'))).version;
  const nodeMajor = process.versions.node.split('.')[0];
  return `jsdom-${version('jsdom')}-esbuild-${version('esbuild')}-node${nodeMajor}-${hash.digest('hex').slice(0, 12)}`;
}

function buildBundle(root, targetDir) {
  const esbuild = require(path.join(root, 'node_modules', 'esbuild'));
  const jsdomLib = path.join(root, 'node_modules', 'jsdom', 'lib', 'jsdom');
  const outfile = path.join(targetDir, BUNDLE_SUBPATH);
  // css-tree loads its JSON data through createRequire(import.meta.url); keep
  // that pointed at the installed package so the data files resolve.
  const cssTreeUrl = pathToFileURL(path.join(root, 'node_modules', 'css-tree', 'lib', 'index.js')).href;
  esbuild.buildSync({
    stdin: { contents: "module.exports = require('jsdom');", resolveDir: root },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: `node${process.versions.node.split('.')[0]}`,
    outfile,
    // esbuild renames classes that shadow a Node global (Event -> Event2);
    // code under test reads constructor.name, so the names must survive.
    keepNames: true,
    logLevel: 'silent',
    define: { 'import.meta.url': '__jennyCssTreeUrl' },
    banner: { js: `const __jennyCssTreeUrl = ${JSON.stringify(cssTreeUrl)};` },
  });
  fs.mkdirSync(path.join(targetDir, 'browser'), { recursive: true });
  fs.copyFileSync(
    path.join(jsdomLib, 'browser', 'default-stylesheet.css'),
    path.join(targetDir, 'browser', 'default-stylesheet.css')
  );
  // Resolved with require.resolve at load time. Synchronous XHR itself is not
  // supported from the bundle (the worker's own requires stay unbundled).
  fs.copyFileSync(
    path.join(jsdomLib, 'living', 'xhr', 'xhr-sync-worker.js'),
    path.join(path.dirname(outfile), 'xhr-sync-worker.js')
  );
}

// Returns the bundle path, building it on first use, or null when it is turned
// off or cannot be built. Safe to call from several runners at once: each
// builds into its own directory and the rename either wins or finds a winner.
function ensureJsdomBundle({ root = REPO_ROOT, env = process.env, build = buildBundle } = {}) {
  if (env.JENNY_TEST_JSDOM_BUNDLE === '0') return null;
  try {
    const cacheRoot = path.join(root, 'node_modules', '.cache', 'jenny-jsdom-bundle');
    const finalDir = path.join(cacheRoot, bundleKey(root));
    const bundlePath = path.join(finalDir, BUNDLE_SUBPATH);
    if (fs.existsSync(bundlePath)) return bundlePath;
    const stagingDir = `${finalDir}.building-${process.pid}`;
    fs.rmSync(stagingDir, { recursive: true, force: true });
    try {
      build(root, stagingDir);
      // A new key replaces the old bundles (12 MB each) instead of piling up.
      for (const entry of fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot) : []) {
        if (!entry.includes('.building-')) fs.rmSync(path.join(cacheRoot, entry), { recursive: true, force: true });
      }
      fs.renameSync(stagingDir, finalDir);
    } catch (error) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      if (!fs.existsSync(bundlePath)) throw error;
    }
    return bundlePath;
  } catch {
    return null;
  }
}

// node arguments that make a test process use the bundle; empty when there is none.
function jsdomBundleNodeArgs(options) {
  const bundlePath = ensureJsdomBundle(options);
  if (!bundlePath) return [];
  (options?.env || process.env)[BUNDLE_ENV_VAR] = bundlePath;
  return ['--require', PRELOAD_PATH];
}

module.exports = {
  BUNDLE_ENV_VAR,
  PRELOAD_PATH,
  bundleKey,
  ensureJsdomBundle,
  jsdomBundleNodeArgs,
};
