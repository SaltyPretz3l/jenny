'use strict';

// Release contract for the packaged `jenny` command-line tool (row 9 S9, plan
// decision 13 in docs/plans/JENNY_CLI.md). An installed copy runs the CLI by
// launching the installed Electron executable with ELECTRON_RUN_AS_NODE=1 on
// resources/app.asar/cli/main.js through a shim in resources/bin. This file
// pins every builder and shim fact that route depends on. It runs in
// `npm run test:dist` (public CI after `npm ci`), so it uses only node:test,
// node:assert and fs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

function readRaw(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function readText(relativePath) {
  return readRaw(relativePath).replace(/\r\n/g, '\n');
}

function topLevelBlock(text, key) {
  const match = new RegExp(`^${key}:\\n((?:(?: {2}.*)?\\n)*)`, 'm').exec(text);
  assert.ok(match, `electron-builder.yml must declare a top-level ${key}: block`);
  return match[1];
}

function listEntries(block) {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.replace(/^- /, '').replace(/^"|"$/g, ''));
}

test('the CLI sources ship inside app.asar', () => {
  const files = listEntries(topLevelBlock(readText('electron-builder.yml'), 'files'));
  assert.ok(files.includes('cli/**/*'), 'files: must include cli/**/*');
  assert.equal(files.includes('!cli/**/*'), false);
});

// Each platform copies only its own shim: PATHEXT would ignore a stray
// extensionless `jenny` on Windows, and a `.cmd` is dead weight on POSIX.
for (const [platform, shim] of [['win', 'jenny.cmd'], ['mac', 'jenny'], ['linux', 'jenny']]) {
  test(`the ${platform} build copies ${shim} to resources/bin`, () => {
    const block = topLevelBlock(readText('electron-builder.yml'), platform);
    const extraResources = /\n {2}extraResources:\n((?: {4}.*\n|\n)*)/.exec(`\n${block}`);
    assert.ok(extraResources, `${platform} must declare extraResources`);
    const entry = new RegExp(`- from: build/cli\\n\\s+to: bin\\n\\s+filter:\\n\\s+- ${shim.replace('.', '\\.')}\\n`);
    assert.match(extraResources[1], entry, `${platform} extraResources must copy build/cli/${shim} to bin`);
    assert.doesNotMatch(extraResources[1], /- from: build\/cli\n\s+to: bin\n\s+filter:\n\s+- "\*\*\/\*"/);
  });
}

test('the POSIX profile lock helper is unpacked from the asar', () => {
  const unpacked = listEntries(topLevelBlock(readText('electron-builder.yml'), 'asarUnpack'));
  assert.ok(unpacked.includes('services/host/profile_lock.py'));
});

test('no Electron fuse is configured', () => {
  // ELECTRON_RUN_AS_NODE must keep working: the installed CLI shims depend on
  // it, and the RunAsNode fuse would silently break every packaged `jenny`.
  const fusePattern = /\b(?:electron)?fuses\b/i;
  assert.doesNotMatch(readText('electron-builder.yml'), fusePattern);
  assert.doesNotMatch(readText('package.json'), fusePattern);
});

test('the Windows shim runs Jenny.exe as Node on the asar CLI entry', () => {
  const raw = readRaw('build/cli/jenny.cmd');
  assert.ok(raw.length > 0);
  assert.equal(raw.charCodeAt(0) === 0xfeff, false, 'jenny.cmd must not carry a BOM');
  assert.equal(/\r(?!\n)/.test(raw), false, 'jenny.cmd must not contain a bare CR');
  assert.equal(/(?<!\r)\n/.test(raw), false, 'jenny.cmd must use CRLF line endings only');
  assert.ok(raw.endsWith('\r\n'));
  assert.ok(raw.startsWith('@echo off\r\n'));
  assert.ok(raw.includes('set "ELECTRON_RUN_AS_NODE=1"'));
  assert.ok(raw.includes(
    '"%~dp0..\\..\\Jenny.exe" --no-deprecation "%~dp0..\\app.asar\\cli\\main.js" %*',
  ));
  assert.ok(raw.includes('exit /b %ERRORLEVEL%'));
});

test('the Windows shim leaves Electron\'s console attach on for the interactive loop', () => {
  // Row 61 (docs/plans/CLI_WINDOWS_CONSOLE_LAUNCHER.md): the GUI-subsystem
  // Jenny.exe gets no stdin handle; cli/console-input.js opens \\.\CONIN$,
  // which works only because Electron attaches the run-as-node process to the
  // parent console. ELECTRON_NO_ATTACH_CONSOLE would turn that off, and the
  // route needs no second executable beside Jenny.exe.
  const raw = readRaw('build/cli/jenny.cmd');
  assert.doesNotMatch(raw, /ELECTRON_NO_ATTACH_CONSOLE/);
  assert.equal((raw.match(/\.exe"/g) || []).length, 1, 'the shim launches exactly one executable');
  const winBlock = topLevelBlock(readText('electron-builder.yml'), 'win');
  assert.doesNotMatch(winBlock, /^\s*(?:- )?(?:from|to|filter):.*\.exe\b/m, 'no extra executable ships for the CLI');
  assert.doesNotMatch(winBlock, /^\s*- [^#\n]*\.exe\s*$/m, 'no extra executable ships for the CLI');
  assert.ok(fs.existsSync(path.join(ROOT, 'cli', 'console-input.js')), 'cli/console-input.js ships under cli/**/*');
});

test('the POSIX shim runs the desktop executable as Node on the asar CLI entry', () => {
  const raw = readRaw('build/cli/jenny');
  assert.equal(raw.includes('\r'), false, 'build/cli/jenny must use LF line endings only');
  assert.ok(raw.startsWith('#!/bin/sh\n'));
  assert.ok(raw.endsWith('\n'));
  assert.ok(raw.includes(
    'ELECTRON_RUN_AS_NODE=1 exec "$exe" --no-deprecation "$resources/app.asar/cli/main.js" "$@"',
  ));
  assert.ok(raw.includes('Darwin) exe="$resources/../MacOS/Jenny" ;;'));
  assert.ok(raw.includes('*) exe="$resources/../jenny" ;;'));
});

test('package.json keeps the source-tree bin entry', () => {
  const pkg = JSON.parse(readRaw('package.json'));
  assert.equal(pkg.bin && pkg.bin.jenny, 'cli/main.js');
});
