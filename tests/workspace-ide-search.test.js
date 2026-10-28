'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');
const { searchWorkspaceFiles } = require('../services/workspace-ide-search');
const { WorkspaceIdeService } = require('../services/workspace-ide-service');
const { WORKSPACE_FS_ERROR_CODES } = require('../services/workspace-ide-errors');
const { WorkspaceRootCoordinator } = require('../services/workspace-root-coordinator');

function fakeDirent(name, kind = 'file') {
  return {
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  };
}

function fakeStats(size, ino = 1) {
  return {
    dev: 1,
    ino,
    size,
    mtimeMs: 1,
    ctimeMs: 1,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
}

function fakeHandle(buffer, { openedStats = fakeStats(buffer.length), finalStats = openedStats, onRead = null } = {}) {
  let statCalls = 0;
  return {
    async stat() {
      statCalls += 1;
      return statCalls === 1 ? openedStats : finalStats;
    },
    async read(target, offset, length, position) {
      onRead?.({ target, offset, length, position });
      const source = buffer.subarray(position, position + length);
      source.copy(target, offset);
      return { bytesRead: source.length };
    },
    async close() {},
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createSearchService(root, extra = {}) {
  const coordinator = extra.rootCoordinator || new WorkspaceRootCoordinator({
    initialRootPath: root,
    normalizeRootPath: (value) => String(value || ''),
    rootIdFactory: (value) => value ? `root:${String(value).toLowerCase()}` : null,
  });
  const { rootCoordinator: _rootCoordinator, ...serviceOptions } = extra;
  return new WorkspaceIdeService({
    configService: {
      getToolsWorkspaceRoot: () => root,
      getState: () => ({ toolsWorkspaceRoot: root }),
      getWorkspaceRootStatus: () => ({ state: root ? 'ready' : 'missing', message: '' }),
    },
    rootContextProvider: () => coordinator,
    ...serviceOptions,
  });
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('workspace-ide-search finds literal matches with line/column/preview', async () => {
  const root = createTrackedTempDir('jenny-ide-search-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'const alpha = 1;\nconst Needle = 2;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'README.md'), 'no match here\nneedle in line two\r\n', 'utf8');
  fs.writeFileSync(path.join(root, 'other.txt'), 'nothing\n', 'utf8');

  const result = await searchWorkspaceFiles({ root, query: 'needle' });
  assert.equal(result.limitHit, false);
  assert.equal(result.fileCount, 2);
  assert.equal(result.results.length, 2);

  const readme = result.results.find((entry) => entry.path === 'README.md');
  assert.equal(readme.line, 2);
  assert.equal(readme.column, 1);
  // CRLF stripped from the preview text.
  assert.equal(readme.preview.text, 'needle in line two');
  assert.equal(readme.preview.matchStart, 0);
  assert.equal(readme.preview.matchEnd, 6);

  // Case-insensitive by default; column is 1-based on the raw line.
  const appJs = result.results.find((entry) => entry.path === 'src/app.js');
  assert.equal(appJs.line, 2);
  assert.equal(appJs.column, 7);

  const caseSensitive = await searchWorkspaceFiles({ root, query: 'needle', caseSensitive: true });
  assert.deepEqual(caseSensitive.results.map((entry) => entry.path), ['README.md']);
});

test('workspace-ide-search skips .git, node_modules, binary, and oversize files', async () => {
  const root = createTrackedTempDir('jenny-ide-search-');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'config'), 'needle\n', 'utf8');
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'needle\n', 'utf8');
  fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0x6e, 0x65, 0x00, 0x65]));
  fs.writeFileSync(path.join(root, 'big.txt'), 'needle padding padding\n', 'utf8');
  fs.writeFileSync(path.join(root, 'small.txt'), 'needle\n', 'utf8');

  const result = await searchWorkspaceFiles({
    root,
    query: 'needle',
    maxFileBytes: 16, // big.txt (23 bytes) is over the injected cap
  });
  assert.deepEqual(result.results.map((entry) => entry.path), ['small.txt']);
});

test('workspace-ide-search caps results and reports limitHit', async () => {
  const root = createTrackedTempDir('jenny-ide-search-');
  fs.writeFileSync(path.join(root, 'many.txt'), 'hit\nhit\nhit\nhit\nhit\n', 'utf8');

  const result = await searchWorkspaceFiles({ root, query: 'hit', maxResults: 3 });
  assert.equal(result.results.length, 3);
  assert.equal(result.limitHit, true);
});

test('JCA-008: every same-line occurrence gets its own result row', async () => {
  // The panel navigates and replaces occurrences individually, so `hit hit`
  // must yield two rows with distinct 1-based columns (non-overlapping scan).
  const root = createTrackedTempDir('jenny-ide-search-');
  fs.writeFileSync(path.join(root, 'twice.txt'), 'hit hit\nlater hit\n', 'utf8');

  const result = await searchWorkspaceFiles({ root, query: 'hit' });
  assert.deepEqual(
    result.results.map((entry) => [entry.line, entry.column]),
    [[1, 1], [1, 5], [2, 7]],
    'both first-line occurrences and the second-line one are individually addressable'
  );
  const second = result.results[1];
  assert.equal(second.preview.matchStart >= 0, true);
  assert.equal(
    second.preview.text.slice(second.preview.matchStart, second.preview.matchEnd),
    'hit'
  );

  // Overlap discipline: 'aaaa' contains two non-overlapping 'aa' matches, not three.
  const overlapRoot = createTrackedTempDir('jenny-ide-search-');
  fs.writeFileSync(path.join(overlapRoot, 'overlap.txt'), 'aaaa\n', 'utf8');
  const overlap = await searchWorkspaceFiles({ root: overlapRoot, query: 'aa' });
  assert.deepEqual(overlap.results.map((entry) => entry.column), [1, 3]);
});

test('JCA-008: the result cap is enforced mid-line', async () => {
  const root = createTrackedTempDir('jenny-ide-search-');
  fs.writeFileSync(path.join(root, 'dense.txt'), 'hit hit hit hit hit\n', 'utf8');

  const result = await searchWorkspaceFiles({ root, query: 'hit', maxResults: 3 });
  assert.equal(result.results.length, 3, 'a single dense line cannot overshoot the cap');
  assert.equal(result.limitHit, true);
});

test('workspace-ide-search anchors columns/previews to the raw line when folding expands (İ)', async () => {
  // 'İ'.toLowerCase() is 'i' + U+0307 (two code units), so whole-line folding
  // drifts offsets right of any İ. Columns and previews must index the RAW
  // line — they drive editor navigation and replace targets downstream.
  const root = createTrackedTempDir('jenny-ide-search-');
  fs.writeFileSync(path.join(root, 'turkish.txt'), 'İİ needle İİ\nin İstanbul today\n', 'utf8');

  const afterFold = await searchWorkspaceFiles({ root, query: 'needle' });
  assert.equal(afterFold.results.length, 1);
  const [needleHit] = afterFold.results;
  assert.equal(needleHit.column, 4, 'column is 1-based into the raw line, not the folded line');
  assert.equal(
    needleHit.preview.text.slice(needleHit.preview.matchStart, needleHit.preview.matchEnd),
    'needle'
  );

  // A needle containing İ still matches case-insensitively, and the highlight
  // spans the whole original word even though the fold expanded it.
  const foldedNeedle = await searchWorkspaceFiles({ root, query: 'İstanbul' });
  assert.deepEqual(foldedNeedle.results.map((entry) => [entry.line, entry.column]), [[2, 4]]);
  const [cityHit] = foldedNeedle.results;
  assert.equal(
    cityHit.preview.text.slice(cityHit.preview.matchStart, cityHit.preview.matchEnd),
    'İstanbul'
  );
});

test('workspace-ide-search windows long-line previews around the match', async () => {
  const root = createTrackedTempDir('jenny-ide-search-');
  const longLine = `${'x'.repeat(500)}needle${'y'.repeat(500)}`;
  fs.writeFileSync(path.join(root, 'minified.js'), `${longLine}\n`, 'utf8');

  const result = await searchWorkspaceFiles({ root, query: 'needle' });
  const [match] = result.results;
  assert.equal(match.column, 501);
  assert.equal(match.preview.text.length, 240);
  assert.equal(
    match.preview.text.slice(match.preview.matchStart, match.preview.matchEnd),
    'needle'
  );
});

test('workspace-ide-search scopes the scan to a folder when scope is set', async () => {
  const root = createTrackedTempDir('jenny-ide-search-');
  fs.mkdirSync(path.join(root, 'src', 'inner'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'needle here\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'inner', 'deep.js'), 'needle deep\n', 'utf8');
  fs.writeFileSync(path.join(root, 'lib', 'util.js'), 'needle sibling\n', 'utf8');
  fs.writeFileSync(path.join(root, 'top.txt'), 'needle top\n', 'utf8');

  // Only files under src/ (nested included); paths stay workspace-root-relative.
  const scoped = await searchWorkspaceFiles({ root, query: 'needle', scope: 'src' });
  assert.deepEqual(
    scoped.results.map((entry) => entry.path).sort(),
    ['src/app.js', 'src/inner/deep.js']
  );

  // A trailing slash on the scope is tolerated.
  const trailing = await searchWorkspaceFiles({ root, query: 'needle', scope: 'src/' });
  assert.equal(trailing.results.length, 2);

  // No scope = whole workspace (all four files match).
  const unscoped = await searchWorkspaceFiles({ root, query: 'needle' });
  assert.equal(unscoped.results.length, 4);
});

test('workspace-ide-search scopes LITERALLY so a folder with glob metacharacters never leaks siblings', async () => {
  const root = createTrackedTempDir('jenny-ide-search-');
  // `[wip]` is a legal folder name; as a glob it is a character class matching
  // the single chars w/i/p, so a glob-prefix scope would pull in the `w/` sibling.
  fs.mkdirSync(path.join(root, '[wip]'));
  fs.mkdirSync(path.join(root, 'w'));
  fs.writeFileSync(path.join(root, '[wip]', 'note.txt'), 'needle inside wip\n', 'utf8');
  fs.writeFileSync(path.join(root, 'w', 'sibling.txt'), 'needle in sibling\n', 'utf8');

  const scoped = await searchWorkspaceFiles({ root, query: 'needle', scope: '[wip]' });
  // The literal prefix filter returns ONLY the bracketed folder's file.
  assert.deepEqual(scoped.results.map((entry) => entry.path), ['[wip]/note.txt']);
});

test('workspace-ide-search returns empty for blank queries and missing roots', async () => {
  const root = createTrackedTempDir('jenny-ide-search-');
  fs.writeFileSync(path.join(root, 'a.txt'), 'anything\n', 'utf8');
  const blank = await searchWorkspaceFiles({ root, query: '   ' });
  assert.deepEqual(blank.results, []);
  const rootless = await searchWorkspaceFiles({ root: '', query: 'anything' });
  assert.deepEqual(rootless.results, []);
});

test('workspace-ide-search stops a lazy million-entry directory at the file budget', async () => {
  let pulled = 0;
  let closeCalls = 0;
  const warnings = [];
  const fakeFs = {
    async opendir() {
      return {
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 1_000_000; index += 1) {
            pulled += 1;
            yield fakeDirent(`file-${index}.txt`);
          }
        },
        async close() {
          closeCalls += 1;
          const error = new Error('closed');
          error.code = 'ERR_DIR_CLOSED';
          throw error;
        },
      };
    },
    async stat() {
      return fakeStats(7);
    },
    async open() {
      return fakeHandle(Buffer.from('needle\n'));
    },
    async readdir() {
      throw new Error('streaming opendir must be used');
    },
  };

  const result = await searchWorkspaceFiles({
    root: '/fake',
    query: 'needle',
    maxFiles: 3,
    maxDurationMs: 10000,
    fs: fakeFs,
    path: { join: (...parts) => parts.join('/') },
    onWarning: (warning) => warnings.push(warning),
  });

  assert.equal(pulled, 4, 'one lookahead proves truncation without materializing the directory');
  assert.equal(result.results.length, 3);
  assert.equal(result.truncated, true);
  assert.equal(result.truncationReason, 'file_limit');
  assert.equal(result.totalsKnown, false);
  assert.equal(closeCalls, 1, 'budget exit still closes the active directory handle');
  assert.deepEqual(warnings, [], 'Node async-iterator auto-close is not reported as cleanup degradation');
});

test('workspace-ide-search charges binary reads to the aggregate byte budget before allocation', async () => {
  let reads = 0;
  const fakeFs = {
    async opendir() {
      return {
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 10; index += 1) yield fakeDirent(`binary-${index}.bin`);
        },
        async close() {},
      };
    },
    async stat() {
      return fakeStats(4);
    },
    async open() {
      return fakeHandle(Buffer.from([0, 1, 2, 3]), {
        onRead({ position }) {
          if (position === 0) reads += 1;
        },
      });
    },
  };

  const result = await searchWorkspaceFiles({
    root: '/fake',
    query: 'needle',
    maxTotalBytes: 8,
    maxDurationMs: 10000,
    fs: fakeFs,
    path: { join: (...parts) => parts.join('/') },
  });

  assert.equal(reads, 2, 'the third file is rejected by expected size before opening a handle');
  assert.equal(result.bytesScanned, 8);
  assert.equal(result.truncationReason, 'byte_limit');
});

test('workspace-ide-search bounds growth after stat with a cap+1 handle read', async () => {
  const expected = fakeStats(4, 11);
  const grown = fakeStats(9, 11);
  let largestRequestedRead = 0;
  const fakeFs = {
    async opendir() {
      return {
        async *[Symbol.asyncIterator]() { yield fakeDirent('growing.txt'); },
        async close() {},
      };
    },
    async stat() {
      return expected;
    },
    async open() {
      return fakeHandle(Buffer.from('needle+++'), {
        openedStats: expected,
        finalStats: grown,
        onRead({ length }) { largestRequestedRead = Math.max(largestRequestedRead, length); },
      });
    },
    async readFile() {
      throw new Error('unbounded readFile must never be called');
    },
  };

  const result = await searchWorkspaceFiles({
    root: '/fake',
    query: 'needle',
    maxFileBytes: 16,
    maxTotalBytes: 8,
    maxDurationMs: 10000,
    fs: fakeFs,
    path: { join: (...parts) => parts.join('/') },
  });

  assert.equal(largestRequestedRead, 5, 'tiny files allocate expected-size+1, not the full aggregate cap');
  assert.equal(result.results.length, 0);
  assert.equal(result.truncationReason, 'file_changed');
});

test('workspace-ide-search rejects a file swapped between resolution and open before reading bytes', async () => {
  const expected = fakeStats(7, 21);
  const swapped = fakeStats(7, 22);
  let readCalls = 0;
  const fakeFs = {
    async opendir() {
      return {
        async *[Symbol.asyncIterator]() { yield fakeDirent('swapped.txt'); },
        async close() {},
      };
    },
    async stat() {
      return expected;
    },
    async open() {
      return fakeHandle(Buffer.from('needle\n'), {
        openedStats: swapped,
        onRead() { readCalls += 1; },
      });
    },
  };

  const result = await searchWorkspaceFiles({
    root: '/fake',
    query: 'needle',
    maxDurationMs: 10000,
    fs: fakeFs,
    path: { join: (...parts) => parts.join('/') },
  });

  assert.equal(readCalls, 0, 'opened identity is checked before allocating/reading content');
  assert.equal(result.results.length, 0);
  assert.equal(result.truncationReason, 'file_changed');
});

test('workspace-ide-search rejects an unchanged-stat short read instead of projecting partial bytes', async () => {
  const expected = fakeStats(7, 23);
  const fakeFs = {
    async opendir() {
      return {
        async *[Symbol.asyncIterator]() { yield fakeDirent('short.txt'); },
        async close() {},
      };
    },
    async stat() {
      return expected;
    },
    async open() {
      return fakeHandle(Buffer.from('nee'), {
        openedStats: expected,
        finalStats: expected,
      });
    },
  };

  const result = await searchWorkspaceFiles({
    root: '/fake',
    query: 'nee',
    maxDurationMs: 10000,
    fs: fakeFs,
    path: { join: (...parts) => parts.join('/') },
  });

  assert.equal(result.results.length, 0, 'partial content is never searched or projected');
  assert.equal(result.truncationReason, 'file_changed');
});

test('workspace-ide-search uses nonblocking no-follow flags for FIFO/symlink swaps where supported', async () => {
  const expected = fakeStats(7, 31);
  let observedFlags = 0;
  const fakeFs = {
    async opendir() {
      return {
        async *[Symbol.asyncIterator]() { yield fakeDirent('pipe-link.txt'); },
        async close() {},
      };
    },
    async stat() {
      return expected;
    },
    async open(_filePath, flags) {
      observedFlags = flags;
      const error = new Error('symbolic link refused');
      error.code = 'ELOOP';
      throw error;
    },
  };

  const result = await searchWorkspaceFiles({
    root: '/fake',
    query: 'needle',
    maxDurationMs: 10000,
    fs: fakeFs,
    path: { join: (...parts) => parts.join('/') },
    openConstants: { O_RDONLY: 1, O_NONBLOCK: 2, O_NOFOLLOW: 4 },
  });

  assert.equal(observedFlags, 7);
  assert.equal(result.results.length, 0);
  assert.equal(result.truncationReason, 'file_changed');
});

test('workspace-ide-search enforces wall-clock and cancellation budgets while streaming', async () => {
  let elapsed = 0;
  let pulled = 0;
  let closeCalls = 0;
  const controller = new AbortController();
  const makeFs = ({ abortOnRead = false } = {}) => ({
    async opendir() {
      return {
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 1000; index += 1) {
            pulled += 1;
            elapsed += 5;
            yield fakeDirent(`file-${index}.txt`);
          }
        },
        async close() { closeCalls += 1; },
      };
    },
    async stat() {
      return fakeStats(7);
    },
    async open() {
      return fakeHandle(Buffer.from('needle\n'), {
        onRead() {
          if (abortOnRead) controller.abort();
        },
      });
    },
  });

  const timed = await searchWorkspaceFiles({
    root: '/fake',
    query: 'needle',
    maxDurationMs: 12,
    fs: makeFs(),
    path: { join: (...parts) => parts.join('/') },
    now: () => elapsed,
  });
  assert.equal(timed.truncationReason, 'time_limit');
  assert.ok(pulled <= 3, 'deadline stops the producer instead of draining it');

  elapsed = 0;
  pulled = 0;
  const cancelled = await searchWorkspaceFiles({
    root: '/fake',
    query: 'needle',
    maxDurationMs: 10000,
    fs: makeFs({ abortOnRead: true }),
    path: { join: (...parts) => parts.join('/') },
    signal: controller.signal,
    now: () => elapsed,
  });
  assert.equal(cancelled.truncationReason, 'cancelled');
  assert.equal(cancelled.results.length, 0, 'post-cancel file content is never projected');
  assert.equal(pulled, 1);
  assert.equal(closeCalls, 2, 'deadline and cancellation exits both close their active directory handles');
});

test('workspace-ide-search stops a superseded read before deferred path revalidation', async () => {
  const controller = new AbortController();
  const readCompleted = deferred();
  const revalidation = deferred();
  let revalidateCalls = 0;
  const fakeFs = {
    async opendir() {
      return {
        async *[Symbol.asyncIterator]() { yield fakeDirent('cancelled.txt'); },
        async close() {},
      };
    },
    async stat() {
      return fakeStats(7);
    },
    async open() {
      return fakeHandle(Buffer.from('needle\n'), {
        onRead() {
          controller.abort();
          readCompleted.resolve();
        },
      });
    },
  };

  const searchPromise = searchWorkspaceFiles({
    root: '/fake',
    query: 'needle',
    maxDurationMs: 10000,
    fs: fakeFs,
    path: { join: (...parts) => parts.join('/') },
    signal: controller.signal,
    revalidateFile: async () => {
      revalidateCalls += 1;
      return revalidation.promise;
    },
  });

  await readCompleted.promise;
  await new Promise((resolve) => setImmediate(resolve));
  const callsBeforeRelease = revalidateCalls;
  revalidation.resolve(true);
  const result = await searchPromise;

  assert.equal(callsBeforeRelease, 0, 'superseded work never enters another resolve/revalidation await');
  assert.equal(result.truncationReason, 'cancelled');
  assert.equal(result.results.length, 0);
});

test('workspace-ide-service searchInFiles requires a root and short-circuits empty queries', async () => {
  const root = createTrackedTempDir('jenny-ide-search-');
  fs.writeFileSync(path.join(root, 'doc.md'), 'jenny waves hello\n', 'utf8');
  const service = createSearchService(root);

  const found = await service.searchInFiles({ query: 'waves' });
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].path, 'doc.md');

  const empty = await service.searchInFiles({ query: '   ' });
  assert.deepEqual(empty.results, []);

  const rootless = createSearchService('');
  await assert.rejects(
    rootless.searchInFiles({ query: 'waves' }),
    (error) => {
      assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.ROOT_MISSING);
      return true;
    }
  );
});

test('workspace-ide-service searchInFiles validates + forwards an optional folder scope', async () => {
  const root = createTrackedTempDir('jenny-ide-search-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'token\n', 'utf8');
  fs.writeFileSync(path.join(root, 'docs', 'b.md'), 'token\n', 'utf8');
  const service = createSearchService(root);

  // A valid scope narrows results to that folder; paths stay root-relative.
  const scoped = await service.searchInFiles({ query: 'token', scope: 'src' });
  assert.deepEqual(scoped.results.map((entry) => entry.path), ['src/a.js']);

  // No scope (and a whitespace-only scope) search the whole workspace.
  assert.equal((await service.searchInFiles({ query: 'token' })).results.length, 2);
  assert.equal((await service.searchInFiles({ query: 'token', scope: '   ' })).results.length, 2);

  // A traversal scope is rejected by the lexical gate and yields zero results
  // (it never widens back to the whole workspace, and never throws).
  const escaped = await service.searchInFiles({ query: 'token', scope: '../../etc' });
  assert.deepEqual(escaped.results, []);
});

test('workspace-ide-service search rejects bytes that finish after a root transition', async () => {
  const rootA = createTrackedTempDir('jenny-ide-search-a-');
  const rootB = createTrackedTempDir('jenny-ide-search-b-');
  fs.writeFileSync(path.join(rootA, 'doc.md'), 'needle\n', 'utf8');
  const enteredRead = deferred();
  const releaseRead = deferred();
  const coordinator = new WorkspaceRootCoordinator({
    initialRootPath: rootA,
    normalizeRootPath: (value) => String(value || ''),
    rootIdFactory: (value) => value ? `root:${String(value).toLowerCase()}` : null,
  });
  const blockingFs = Object.assign(Object.create(fs.promises), {
    async open(filePath, flags) {
      const handle = await fs.promises.open(filePath, flags);
      return {
        stat: () => handle.stat(),
        async read(...args) {
          enteredRead.resolve();
          await releaseRead.promise;
          return handle.read(...args);
        },
        close: () => handle.close(),
      };
    },
  });
  const service = createSearchService(rootA, {
    rootCoordinator: coordinator,
    fs: blockingFs,
  });

  const search = service.searchInFiles({ query: 'needle', maxDurationMs: 10000 });
  await enteredRead.promise;
  const rejection = assert.rejects(search, (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.ROOT_TRANSITIONING);
    assert.equal(error.details.reason, 'operation_cancelled');
    return true;
  });
  const prepared = await coordinator.prepareTarget(rootB);
  const commit = coordinator.commit({ transitionId: prepared.transitionId });
  releaseRead.resolve();

  await rejection;
  const committed = await commit;
  assert.equal(committed.committed, true);
});

test('a leading UTF-8 BOM does not shift line-1 columns', async () => {
  const root = createTrackedTempDir('jenny-ide-search-');
  fs.writeFileSync(path.join(root, 'bom.txt'), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hit x hit\nhit\n', 'utf8'),
  ]));

  const result = await searchWorkspaceFiles({ root, query: 'hit' });
  assert.deepEqual(result.results.map((entry) => [entry.line, entry.column]), [[1, 1], [1, 7], [2, 1]]);
  assert.equal(result.results[0].preview.text.charCodeAt(0) === 0xfeff, false, 'the BOM is not previewed');
});

// ---- row 82 slice X2: whole word, include/exclude globs ----

test('workspace-ide-search wholeWord rejects a needle embedded in a longer word', async () => {
  const root = createTrackedTempDir('jenny-ide-search-');
  fs.writeFileSync(path.join(root, 'only.txt'), 'testing\n', 'utf8');
  const result = await searchWorkspaceFiles({ root, query: 'test', wholeWord: true });
  assert.equal(result.results.length, 0, 'wholeWord must reject `testing`');
  assert.equal(result.fileCount, 0);
  const loose = await searchWorkspaceFiles({ root, query: 'test' });
  assert.equal(loose.results.length, 1, 'without wholeWord the substring still matches');
});

test('workspace-ide-search wholeWord keeps punctuation/edge hits and rescans after a rejected candidate', async () => {
  const root = createTrackedTempDir('jenny-ide-search-');
  fs.writeFileSync(path.join(root, 'a.txt'), [
    'a test.',
    '(test)',
    'test at start',
    'ends with test',
    'testing',
    'retest',
    'test_x',
    'x_test',
    'testing test',
    'test',
  ].join('\n'), 'utf8');
  const result = await searchWorkspaceFiles({ root, query: 'test', wholeWord: true });
  assert.deepEqual(
    result.results.map((entry) => [entry.line, entry.column]),
    [[1, 3], [2, 2], [3, 1], [4, 11], [9, 9], [10, 1]]
  );
});

test('workspace-ide-search wholeWord works with the case-fold map path (İ expands on fold)', async () => {
  const root = createTrackedTempDir('jenny-ide-search-');
  fs.writeFileSync(path.join(root, 'a.txt'), 'İ needle needles\n', 'utf8');
  const result = await searchWorkspaceFiles({ root, query: 'needle', wholeWord: true });
  assert.deepEqual(result.results.map((entry) => entry.column), [3]);
});

test('workspace-ide-search include globs limit files by folder and by extension', async () => {
  const root = createTrackedTempDir('jenny-ide-search-');
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'token\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'deep', 'b.js'), 'token\n', 'utf8');
  fs.writeFileSync(path.join(root, 'docs', 'c.md'), 'token\n', 'utf8');
  fs.writeFileSync(path.join(root, 'README.md'), 'token\n', 'utf8');

  const byFolder = await searchWorkspaceFiles({ root, query: 'token', include: ['src'] });
  assert.deepEqual(byFolder.results.map((entry) => entry.path).sort(), ['src/a.js', 'src/deep/b.js']);
  assert.equal(byFolder.fileCount, 2);
  const byExt = await searchWorkspaceFiles({ root, query: 'token', include: ['*.md'] });
  assert.deepEqual(byExt.results.map((entry) => entry.path).sort(), ['README.md', 'docs/c.md']);
  const rootAnchored = await searchWorkspaceFiles({ root, query: 'token', include: ['/README.md'] });
  assert.deepEqual(rootAnchored.results.map((entry) => entry.path), ['README.md']);
  // Patterns test the root-relative path even when a scope is set.
  const scoped = await searchWorkspaceFiles({ root, query: 'token', scope: 'src', include: ['/src/deep'] });
  assert.deepEqual(scoped.results.map((entry) => entry.path), ['src/deep/b.js']);
});

test('workspace-ide-search exclude prunes directories without reading them', async () => {
  const opened = [];
  const dirs = {
    '/fake': [fakeDirent('keep', 'directory'), fakeDirent('vendor', 'directory'), fakeDirent('top.txt')],
    '/fake/keep': [fakeDirent('a.txt'), fakeDirent('b.log')],
    '/fake/vendor': [fakeDirent('lib.txt')],
  };
  const fakeFs = {
    async opendir(directoryPath) {
      opened.push(directoryPath);
      const entries = dirs[directoryPath] || [];
      return {
        async *[Symbol.asyncIterator]() { for (const entry of entries) yield entry; },
        async close() {},
      };
    },
    async stat() { return fakeStats(6); },
    async open() { return fakeHandle(Buffer.from('needle')); },
  };
  const result = await searchWorkspaceFiles({
    root: '/fake',
    query: 'needle',
    exclude: ['vendor', '*.log'],
    fs: fakeFs,
    path: { join: (...parts) => parts.filter(Boolean).join('/') },
  });
  assert.deepEqual(result.results.map((entry) => entry.path).sort(), ['keep/a.txt', 'top.txt']);
  assert.ok(!opened.includes('/fake/vendor'), 'excluded directory is never opened');
  assert.ok(opened.includes('/fake/keep'));
});

test('workspace-ide-service searchInFiles forwards wholeWord/include/exclude and ignores junk', async () => {
  const root = createTrackedTempDir('jenny-ide-search-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'test testing\n', 'utf8');
  fs.writeFileSync(path.join(root, 'lib', 'b.js'), 'test\n', 'utf8');
  const logs = [];
  const service = createSearchService(root, { logger: (level, event, data) => logs.push({ level, event, data }) });

  const word = await service.searchInFiles({ query: 'test', wholeWord: true });
  assert.deepEqual(word.results.map((entry) => [entry.path, entry.column]).sort(), [['lib/b.js', 1], ['src/a.js', 1]]);
  const filtered = await service.searchInFiles({
    query: 'test', wholeWord: true, include: ['src'], exclude: ['lib'],
  });
  assert.deepEqual(filtered.results.map((entry) => entry.path), ['src/a.js']);
  // Non-array junk is ignored; non-string entries are coerced; oversize entries are dropped.
  const junk = await service.searchInFiles({ query: 'test', include: 'src', exclude: { a: 1 }, wholeWord: 'yes' });
  assert.equal(junk.results.length, 3, 'junk options do not filter and wholeWord must be boolean true');
  const oversize = await service.searchInFiles({ query: 'test', include: ['x'.repeat(300)] });
  assert.equal(oversize.results.length, 3, 'an oversize entry is dropped rather than failing the search');
  const logged = logs.find((entry) => entry.event === 'workspace_fs.search' && entry.data.include_count === 1);
  assert.ok(logged, 'log carries counts');
  assert.equal(logged.data.whole_word, true);
  assert.equal(logged.data.exclude_count, 1);
  assert.ok(!JSON.stringify(logged.data).includes('src'), 'patterns are never logged');
});

// ---- row 82 cleanup X1: filters before the file budget, anchored-include pruning ----

test('X1: an include-filtered walk counts only matching files', async () => {
  const root = createTrackedTempDir('jenny-ide-search-');
  for (let index = 0; index < 30; index += 1) fs.writeFileSync(path.join(root, `n${index}.txt`), 'token\n', 'utf8');
  fs.mkdirSync(path.join(root, 'src'));
  for (let index = 0; index < 3; index += 1) fs.writeFileSync(path.join(root, 'src', `a${index}.js`), 'token\n', 'utf8');
  const result = await searchWorkspaceFiles({ root, query: 'token', include: ['*.js'], maxFiles: 5 });
  assert.deepEqual(result.results.map((entry) => entry.path).sort(), ['src/a0.js', 'src/a1.js', 'src/a2.js']);
  assert.equal(result.truncated, false, 'thirty filtered files do not spend the five-file budget');
  assert.equal(result.filesScanned, 3);
  // Matching files still stop at the budget.
  const capped = await searchWorkspaceFiles({ root, query: 'token', include: ['*.js'], maxFiles: 2 });
  assert.equal(capped.results.length, 2);
  assert.equal(capped.truncationReason, 'file_limit');
  // Without a filter the budget counts every file, as before.
  const plain = await searchWorkspaceFiles({ root, query: 'token', maxFiles: 5 });
  assert.equal(plain.truncationReason, 'file_limit');
});

test('X1: an anchored include never lists an unrelated top-level directory', async () => {
  const opened = [];
  const dirs = {
    '/fake': [fakeDirent('docs', 'directory'), fakeDirent('src', 'directory'), fakeDirent('top.js')],
    '/fake/src': [fakeDirent('a.js'), fakeDirent('nested', 'directory')],
    '/fake/src/nested': [fakeDirent('b.js')],
    '/fake/docs': [fakeDirent('src', 'directory'), fakeDirent('c.js')],
    '/fake/docs/src': [fakeDirent('d.js')],
  };
  const fakeFs = {
    async opendir(directoryPath) {
      opened.push(directoryPath);
      const entries = dirs[directoryPath] || [];
      return {
        async *[Symbol.asyncIterator]() { for (const entry of entries) yield entry; },
        async close() {},
      };
    },
    async stat() { return fakeStats(6); },
    async open() { return fakeHandle(Buffer.from('needle')); },
  };
  const run = (include) => searchWorkspaceFiles({
    root: '/fake', query: 'needle', include, fs: fakeFs, path: { join: (...parts) => parts.filter(Boolean).join('/') },
  });
  const anchored = await run(['/src/**']);
  assert.deepEqual(anchored.results.map((entry) => entry.path).sort(), ['src/a.js', 'src/nested/b.js']);
  assert.ok(!opened.includes('/fake/docs'), 'docs/ is never listed');
  // An unanchored `src/**` matches at any depth, so docs/src/ must still be walked.
  opened.length = 0;
  const anywhere = await run(['src/**']);
  assert.deepEqual(anywhere.results.map((entry) => entry.path).sort(), ['docs/src/d.js', 'src/a.js', 'src/nested/b.js']);
  assert.ok(opened.includes('/fake/docs/src'));
});
