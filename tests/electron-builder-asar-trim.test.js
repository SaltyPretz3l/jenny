'use strict';

// Guards the app.asar trim in electron-builder.yml (row 62 Wave C): every `!`
// exclusion must leave each runtime-loaded vendor file in the package, and a
// whole-package exclusion is only allowed for a package that production code
// can reach solely through the owner whose runtime bundle makes it dead weight
// (mermaid's self-contained mermaid.min.js; pdf.js's browser build).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { minimatch } = require('minimatch');

const ROOT = path.resolve(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function fileGlobs() {
  const match = readRepoFile('electron-builder.yml').match(/^files:\n(?<block>(?: {2}.*\n)+)/m);
  assert.ok(match, 'electron-builder.yml must declare a files block');
  const globs = match.groups.block.split('\n').map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.replace(/^- /, '').replace(/^"|"$/g, ''));
  return {
    includes: globs.filter((glob) => !glob.startsWith('!')),
    excludes: globs.filter((glob) => glob.startsWith('!')).map((glob) => glob.slice(1)),
  };
}

// electron-builder adds production node_modules on its own; the files globs
// can only take vendor files away, so those need only escape every exclusion.
function isPackaged(relPath, { includes, excludes }) {
  const included = relPath.startsWith('node_modules/')
    || includes.some((glob) => minimatch(relPath, glob, { dot: true }));
  return included && !excludes.some((glob) => minimatch(relPath, glob, { dot: true }));
}

function listFiles(relDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel); else out.push(rel);
    }
  };
  walk(relDir);
  return out;
}

// Every literal `node_modules/<file>` the app's HTML, renderer, services and CLI
// reference (script src, dynamic import, workerSrc, stylesheet @import).
function referencedVendorFiles() {
  const sources = ['index.html', 'mermaid-frame.html', 'main.js', 'styles/ide-pdf-pane.css'];
  for (const dir of ['renderer', 'services', 'cli']) {
    sources.push(...listFiles(dir).filter((file) => /\.(js|html|css)$/.test(file)));
  }
  const refs = new Set();
  for (const file of sources) {
    for (const hit of readRepoFile(file).matchAll(/node_modules\/([\w@.\-/]+\.(?:m?js|css))/g)) {
      refs.add(`node_modules/${hit[1]}`);
    }
  }
  return [...refs].sort();
}

test('asar trim: every vendor file the app references at runtime stays packaged', () => {
  const globs = fileGlobs();
  const refs = referencedVendorFiles();
  for (const required of [
    'node_modules/mermaid/dist/mermaid.min.js',
    'node_modules/pdfjs-dist/build/pdf.mjs',
    'node_modules/pdfjs-dist/build/pdf.worker.mjs',
    'node_modules/pdfjs-dist/web/pdf_viewer.mjs',
    'node_modules/pdfjs-dist/web/pdf_viewer.css',
  ]) {
    assert.ok(refs.includes(required), `${required} should still be referenced by app source`);
  }
  const dropped = refs.filter((ref) => fs.existsSync(path.join(ROOT, ref)) && !isPackaged(ref, globs));
  assert.deepEqual(dropped, []);

  // pdf.js data directories passed as cMapUrl / standardFontDataUrl / wasmUrl,
  // and the images pdf_viewer.css points at.
  for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'web/images']) {
    const files = listFiles(`node_modules/pdfjs-dist/${dir}`).filter((file) => !file.endsWith('.map'));
    assert.ok(files.length > 0, dir);
    assert.deepEqual(files.filter((file) => !isPackaged(file, globs)), [], dir);
  }
  // Both locale forms are live: main reads <tag>.json, the renderer <tag>.catalog.js.
  assert.match(readRepoFile('services/i18n-main.js'), /`\$\{activeLocale\}\.json`/);
  assert.match(readRepoFile('renderer/shared/i18n-bootstrap.js'), /\.catalog\.js/);
  assert.equal(isPackaged('locales/en.json', globs), true);
  assert.equal(isPackaged('locales/en.catalog.js', globs), true);
});

test('asar trim: source maps and unused vendor builds are excluded', () => {
  const globs = fileGlobs();
  for (const dropped of [
    'node_modules/mermaid/dist/mermaid.min.js.map',
    'node_modules/mermaid/dist/mermaid.js',
    'node_modules/mermaid/dist/mermaid.esm.min.mjs',
    'node_modules/mermaid/dist/chunks/mermaid.core/chunk-AAAAAAAA.mjs',
    'node_modules/cytoscape/dist/cytoscape.cjs.js',
    'node_modules/d3-shape/src/index.js',
    'node_modules/pdfjs-dist/legacy/build/pdf.mjs',
    'node_modules/pdfjs-dist/build/pdf.worker.min.mjs',
    'node_modules/@napi-rs/canvas/index.js',
    'node_modules/@xterm/xterm/lib/xterm.js.map',
  ]) {
    assert.equal(isPackaged(dropped, globs), false, dropped);
  }
  // Nothing turns on runtime source-map loading in the main process or CLI.
  for (const file of ['main.js', ...listFiles('services'), ...listFiles('cli')].filter((f) => f.endsWith('.js'))) {
    assert.doesNotMatch(readRepoFile(file), /setSourceMapsEnabled|enable-source-maps/, file);
  }
});

test('asar trim: mermaid.min.js is self-contained (no chunk or dynamic imports)', () => {
  const bundle = readRepoFile('node_modules/mermaid/dist/mermaid.min.js');
  assert.ok(bundle.length > 1_000_000);
  assert.doesNotMatch(bundle, /chunks\//);
  assert.doesNotMatch(bundle, /\bimport\(/);
});

// Production packages reachable from each root dependency, resolved through the
// lockfile the way Node resolves node_modules (nested first, then hoisted).
function reachableByRoot() {
  const lock = JSON.parse(readRepoFile('package-lock.json'));
  const packages = lock.packages;
  const resolve = (fromPath, name) => {
    let base = fromPath;
    while (true) {
      const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
      if (packages[candidate]) return candidate;
      if (!base) return null;
      const cut = base.lastIndexOf('/node_modules/');
      base = cut === -1 ? '' : base.slice(0, cut);
    }
  };
  const edges = (entry) => Object.keys({
    ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies,
  });
  const rootEntry = packages[''];
  const result = new Map();
  for (const rootName of Object.keys({ ...rootEntry.dependencies, ...rootEntry.optionalDependencies })) {
    const seen = new Set();
    const queue = [resolve('', rootName)].filter(Boolean);
    while (queue.length) {
      const pkgPath = queue.pop();
      if (seen.has(pkgPath)) continue;
      seen.add(pkgPath);
      for (const dep of edges(packages[pkgPath])) {
        const next = resolve(pkgPath, dep);
        if (next && !packages[next].dev) queue.push(next);
      }
    }
    result.set(rootName, seen);
  }
  return { packages, result };
}

test('asar trim: whole-package exclusions only drop packages owned by mermaid or pdf.js', () => {
  const { excludes } = fileGlobs();
  const { packages, result } = reachableByRoot();
  // A package is dropped whole when an exclusion removes its package.json.
  const dropped = Object.keys(packages)
    .filter((key) => key.startsWith('node_modules/') && !packages[key].dev)
    .filter((key) => excludes.some((glob) => minimatch(`${key}/package.json`, glob, { dot: true })));
  const ownerFor = (pkgPath) => (pkgPath.startsWith('node_modules/@napi-rs/') ? 'pdfjs-dist' : 'mermaid');
  const violations = [];
  for (const pkgPath of dropped) {
    const owner = ownerFor(pkgPath);
    if (!result.get(owner).has(pkgPath)) violations.push(`${pkgPath} is not reachable from ${owner}`);
    for (const [rootName, reach] of result) {
      if (rootName !== owner && reach.has(pkgPath)) violations.push(`${pkgPath} <- ${rootName}`);
    }
  }
  assert.ok(dropped.length >= 30, `expected the exclusions to cover the mermaid-only tree, dropped ${dropped.length}`);
  assert.deepEqual(violations, []);
});
