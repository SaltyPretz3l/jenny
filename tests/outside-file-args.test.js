'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  MAX_OUTSIDE_PATHS_PER_LAUNCH,
  buildSecondLaunchData,
  extractOutsideFilePaths,
  readSecondLaunchPaths,
} = require('../services/main/outside-files/outside-file-args');
const { createOutsideFileLaunchBuffer } = require('../services/main/outside-files/outside-file-launch-buffer');

const ROOT = path.resolve(path.sep, 'notes');
const FILE_A = path.join(ROOT, 'a.md');
const FILE_B = path.join(ROOT, 'b.ts');

test('only entries after -- are files; switches and URLs are dropped', () => {
  assert.deepEqual(extractOutsideFilePaths(['electron', '.', '--inspect', FILE_A]), [], 'no -- means no files');
  assert.deepEqual(
    extractOutsideFilePaths(['Jenny.exe', '--', FILE_A, '--original-process-start-time=9', 'https://x.test/a.md', FILE_B]),
    [FILE_A, FILE_B],
  );
});

test('relative entries resolve against the launch cwd and file:// URIs convert', () => {
  const url = pathToFileURL(FILE_B).href;
  assert.deepEqual(extractOutsideFilePaths(['jenny', '--', 'a.md', url], { cwd: ROOT }), [FILE_A, FILE_B]);
});

test('packaged Linux takes bare positionals because the desktop entry passes %U without --', () => {
  const url = pathToFileURL(FILE_A).href;
  assert.deepEqual(extractOutsideFilePaths(['/opt/Jenny/jenny', '--no-sandbox', url], { isPackaged: true, platform: 'linux' }), [FILE_A]);
  assert.deepEqual(extractOutsideFilePaths(['/opt/Jenny/jenny', FILE_A], { isPackaged: false, platform: 'linux' }), []);
  assert.deepEqual(extractOutsideFilePaths(['Jenny.exe', FILE_A], { isPackaged: true, platform: 'win32' }), []);
});

test('duplicates collapse (case-insensitively on Windows) and the count is capped', () => {
  assert.deepEqual(extractOutsideFilePaths(['j', '--', 'C:\\N\\A.md', 'c:\\n\\a.md'], { platform: 'win32', cwd: 'C:\\' }).length, 1);
  const many = Array.from({ length: 40 }, (_, i) => path.join(ROOT, `f${i}.md`));
  assert.equal(extractOutsideFilePaths(['j', '--', ...many]).length, MAX_OUTSIDE_PATHS_PER_LAUNCH);
});

test('the running app prefers validated lock data and falls back to the commandLine', () => {
  const data = buildSecondLaunchData(['j', '--', 'a.md'], { cwd: ROOT });
  assert.deepEqual(data, { v: 1, outsidePaths: [FILE_A], cwd: ROOT });
  assert.deepEqual(readSecondLaunchPaths({ argv: ['j', '--', FILE_B], additionalData: data }), [FILE_A]);
  assert.deepEqual(readSecondLaunchPaths({ argv: ['j', '--', FILE_B], additionalData: null }), [FILE_B]);
  assert.deepEqual(readSecondLaunchPaths({ argv: ['j', '--', FILE_B], additionalData: { mode: 'uninstall-assistant' } }), []);
  assert.deepEqual(readSecondLaunchPaths({ additionalData: { v: 1, outsidePaths: [7, '-x', 'https://e.test', FILE_B] } }), [FILE_B]);
});

test('the launch buffer holds cold, open-file and second-launch requests until the service attaches', () => {
  const listeners = new Map();
  const app = { isPackaged: false, on: (event, handler) => listeners.set(event, handler) };
  const buffer = createOutsideFileLaunchBuffer({
    app,
    processRef: { platform: 'darwin', argv: ['electron', '.', '--', FILE_A], cwd: () => ROOT },
  });
  let prevented = false;
  listeners.get('open-file')({ preventDefault: () => { prevented = true; } }, FILE_B);
  assert.equal(prevented, true, 'macOS open-file is claimed before ready');
  buffer.onSecondInstance({}, [], ROOT, { v: 1, outsidePaths: [FILE_B], cwd: ROOT });
  assert.equal(buffer.pendingCount(), 3);
  const seen = [];
  buffer.attach({ intake: (paths, source) => seen.push([paths, source]) });
  assert.deepEqual(seen, [[[FILE_A], 'launch'], [[FILE_B], 'launch'], [[FILE_B], 'launch']]);
  buffer.onSecondInstance({}, ['j', '--', FILE_A], ROOT, null);
  assert.deepEqual(seen[3], [[FILE_A], 'launch'], 'after attach requests go straight through');
});

test('a disabled buffer (uninstall assistant, plain require) registers nothing and buffers nothing', () => {
  const app = { on: () => { throw new Error('must not listen'); } };
  const buffer = createOutsideFileLaunchBuffer({ app, enabled: false, processRef: { platform: 'darwin', argv: ['j', '--', FILE_A], cwd: () => ROOT } });
  buffer.onSecondInstance({}, ['j', '--', FILE_A], ROOT, null);
  assert.equal(buffer.pendingCount(), 0);
});
