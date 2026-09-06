'use strict';

// Packaged main-process require graph gate. Production-owned Ollama discovery
// now lives under services/, so source-bootstrap scripts do not ship merely to
// satisfy runtime imports. This statically walks every project-internal require
// reachable from main.js and asserts each resolved file is covered by the
// electron-builder `files` globs (and not re-excluded by a `!` negation).
// This catches the whole class -- any future main-process require that
// reaches outside the packaged globs -- without needing a full pack:dir run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { minimatch } = require('minimatch');

const ROOT = path.resolve(__dirname, '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function electronBuilderFileGlobs() {
  const text = readRepoFile('electron-builder.yml');
  // Match every indented line (glob entries AND interspersed `#` comments)
  // until the block dedents to the next top-level key -- a block-scoped
  // regex that only matched `- ` lines would silently stop at the first
  // comment line and drop any globs declared after it (e.g. the `!node_modules/
  // monaco-editor/**` negations, which follow a comment in this file).
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

// Use the same parser/bundler family as the production preload build. A regex
// walker mistakes examples in comments and strings for executable requires,
// and cannot reliably follow ESM edges. `packages: external` leaves runtime
// dependencies to electron-builder while the metafile records every reachable
// project-local source input.
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

test('every project-internal file required from main.js is covered by electron-builder files globs', () => {
  const graph = collectProjectRequireGraph('main.js');
  const { includes, excludes } = electronBuilderFileGlobs();

  const uncovered = [];
  for (const absPath of graph) {
    const relPath = path.relative(ROOT, absPath).split(path.sep).join('/');
    const isIncluded = includes.some((glob) => minimatch(relPath, glob, { dot: true }));
    const isExcluded = excludes.some((glob) => minimatch(relPath, glob, { dot: true }));
    if (!isIncluded || isExcluded) uncovered.push(relPath);
  }

  assert.deepEqual(
    uncovered,
    [],
    `main-process require graph reaches files outside the packaged asar: ${uncovered.join(', ')}`
  );
});
