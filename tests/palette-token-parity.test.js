'use strict';

// A palette that sets only some tokens shows Midnight's colours wherever it is
// silent (Lexicon once set 75 of 254). These gates keep every palette sheet
// complete, keep the editor colours present everywhere, and stop palettes from
// carrying tokens nothing reads.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  ROOT,
  readFoundationTokens,
  readPaletteSheets,
  stripComments,
} = require('./helpers/palette-css.js');

// Light canvases need darker inks for these; dark palettes keep the foundation values.
const LIGHT_ONLY_TOKENS = new Set([
  '--atlas-lang-js',
  '--atlas-lang-ts',
  '--atlas-lang-py',
  '--atlas-lang-css',
  '--atlas-lang-html',
  '--atlas-lang-md',
  '--atlas-lang-data',
  '--atlas-lang-other',
  '--playlist-scroll-contrast',
  '--sprite-dot-active',
  '--sprite-dot-warn',
  '--sprite-dot-error',
  '--sprite-dot-ok',
  '--sprite-dot-muted',
]);

// A palette sets these only when its accent is too faint to read as text;
// otherwise the foundation aliases them to --accent-strong.
const OPTIONAL_TOKENS = new Set(['--text-link', '--text-active']);

const SYNTAX_TOKENS = [
  '--syntax-keyword',
  '--syntax-string',
  '--syntax-comment',
  '--syntax-number',
  '--syntax-function',
  '--syntax-type',
  '--syntax-variable',
  '--syntax-constant',
];

function listFiles(dir, extensions, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, extensions, out);
    else if (extensions.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

const sheets = readPaletteSheets();

test('the light-only token list matches what the light palettes set', () => {
  const light = sheets.filter((sheet) => sheet.scheme === 'light');
  assert.ok(light.length >= 3, 'light palette sheets were found');
  const atlas = [...new Set(light.flatMap((sheet) => [...sheet.tokens.keys()]))].filter((name) => name.startsWith('--atlas-lang-'));
  assert.deepEqual(atlas.filter((name) => !LIGHT_ONLY_TOKENS.has(name)), [], 'every light-only language ink is listed');
});

test('every palette sheet declares its colour scheme', () => {
  const undeclared = sheets.filter((sheet) => sheet.scheme !== 'light' && sheet.scheme !== 'dark').map((sheet) => sheet.file);
  assert.deepEqual(undeclared, [], 'each sheet needs color-scheme: light or dark');
});

test('every palette sheet sets every palette token', () => {
  assert.ok(sheets.length >= 11, 'palette sheets were found');
  const union = new Set(sheets.flatMap((sheet) => [...sheet.tokens.keys()]));
  const failures = [];
  for (const sheet of sheets) {
    const missing = [...union]
      .filter((name) => !sheet.tokens.has(name))
      .filter((name) => !OPTIONAL_TOKENS.has(name))
      .filter((name) => sheet.scheme === 'light' || !LIGHT_ONLY_TOKENS.has(name))
      .sort();
    if (missing.length) failures.push(`${sheet.file} is missing ${missing.length}: ${missing.join(', ')}`);
  }
  assert.deepEqual(failures, [], failures.join('\n'));
});

test('every palette, Midnight included, sets the eight editor colours', () => {
  const foundation = readFoundationTokens();
  const failures = [];
  for (const { file, tokens } of [{ file: 'foundation.css', tokens: foundation }, ...sheets]) {
    const missing = SYNTAX_TOKENS.filter((name) => !tokens.has(name));
    if (missing.length) failures.push(`${file}: ${missing.join(', ')}`);
  }
  assert.deepEqual(failures, [], `editor colours missing:\n${failures.join('\n')}`);
});

test('every token a palette sets is read somewhere', () => {
  const cssFiles = [...listFiles(path.join(ROOT, 'styles'), ['.css']), ...listFiles(path.join(ROOT, 'renderer'), ['.css']), path.join(ROOT, 'styles.css')];
  const scriptFiles = [...listFiles(path.join(ROOT, 'renderer'), ['.js', '.html']), path.join(ROOT, 'index.html'), path.join(ROOT, 'uninstall.html')];
  const cssText = cssFiles.map((file) => stripComments(fs.readFileSync(file, 'utf8'))).join('\n');
  const scriptText = scriptFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  const readInCss = new Set();
  for (const match of cssText.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) readInCss.add(match[1]);
  const namedInScript = new Set();
  for (const match of scriptText.matchAll(/--[a-z][a-z0-9-]*/g)) namedInScript.add(match[0]);
  const union = [...new Set(sheets.flatMap((sheet) => [...sheet.tokens.keys()]))].sort();
  const unread = union.filter((name) => !readInCss.has(name) && !namedInScript.has(name));
  assert.deepEqual(unread, [], `palette tokens nothing reads (delete them from every sheet):\n${unread.join('\n')}`);
});
