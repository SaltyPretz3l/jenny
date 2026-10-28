'use strict';

// Packaged CLI require graph gate (row 9 S9). The installed `jenny` shim runs
// resources/app.asar/cli/main.js under ELECTRON_RUN_AS_NODE=1, so every
// project-internal file the CLI reaches must be inside the asar. This walks
// the same esbuild metafile closure as the main.js gate
// (tests/electron-builder-main-require-graph.test.js) from the CLI entry
// points and asserts each resolved file is covered by the electron-builder
// `files` globs and not re-excluded by a `!` negation. `renderer/**/*` and
// `config/**/*` matter here too: the CLI closure reaches renderer/shared/*
// (and renderer/chat, renderer/shell) helpers and config/*.json, not only
// cli/ and services/.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { minimatch } = require('minimatch');

const ROOT = path.resolve(__dirname, '..');

// cli/main.js statically reaches the subcommand modules; they are listed too
// so a future lazy require in main.js cannot silently drop one from the walk.
const CLI_ENTRY_POINTS = Object.freeze([
  'cli/main.js',
  'cli/mcp-serve.js',
  'cli/interactive.js',
  'cli/sessions.js',
  'cli/config.js',
  'cli/doctor.js',
]);

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function electronBuilderFileGlobs() {
  const text = readRepoFile('electron-builder.yml');
  // Every indented line until the next top-level key, so globs declared after
  // an interspersed `#` comment are not dropped.
  const filesBlockMatch = text.match(/^files:\n(?<block>(?: {2}.*\n)+)/m);
  assert.ok(filesBlockMatch, 'electron-builder.yml must declare a files block');

  const globs = filesBlockMatch.groups.block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.replace(/^- /, '').replace(/^"|"$/g, ''));

  return {
    includes: globs.filter((glob) => !glob.startsWith('!')),
    excludes: globs.filter((glob) => glob.startsWith('!')).map((glob) => glob.slice(1)),
  };
}

// Same parser/bundler family as the main.js gate: `packages: external` leaves
// runtime dependencies to electron-builder while the metafile records every
// reachable project-local source input.
function collectProjectRequireGraph(entryFile) {
  const result = esbuild.buildSync({
    absWorkingDir: ROOT,
    entryPoints: [entryFile],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  return new Set(
    Object.keys(result.metafile.inputs).map((inputPath) => path.resolve(ROOT, inputPath))
  );
}

function toRelative(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

test('cli/main.js statically reaches every CLI subcommand module', () => {
  const graph = new Set([...collectProjectRequireGraph('cli/main.js')].map(toRelative));
  for (const entry of CLI_ENTRY_POINTS) {
    assert.ok(graph.has(entry), `cli/main.js no longer reaches ${entry}`);
  }
});

test('every project-internal file required from the CLI is covered by electron-builder files globs', () => {
  const { includes, excludes } = electronBuilderFileGlobs();
  const reached = new Set();
  for (const entry of CLI_ENTRY_POINTS) {
    for (const absPath of collectProjectRequireGraph(entry)) reached.add(toRelative(absPath));
  }
  assert.ok(reached.size > CLI_ENTRY_POINTS.length, 'the CLI closure must reach past its entry points');

  const uncovered = [];
  for (const relPath of [...reached].sort()) {
    const isIncluded = includes.some((glob) => minimatch(relPath, glob, { dot: true }));
    const isExcluded = excludes.some((glob) => minimatch(relPath, glob, { dot: true }));
    if (!isIncluded || isExcluded) uncovered.push(relPath);
  }

  assert.deepEqual(
    uncovered,
    [],
    `CLI require graph reaches files outside the packaged asar: ${uncovered.join(', ')}`
  );
});
