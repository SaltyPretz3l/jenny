'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsPromises = require('node:fs/promises');
const path = require('path');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');
const { WorkspaceIdeService } = require('../services/workspace-ide-service');
const { WORKSPACE_FS_ERROR_CODES } = require('../services/workspace-ide-errors');
const { WorkspaceRootCoordinator } = require('../services/workspace-root-coordinator');

function createStaticRootCoordinator(rootPath) {
  return new WorkspaceRootCoordinator({
    initialRootPath: rootPath,
    normalizeRootPath: (value) => String(value || ''),
    rootIdFactory: (value) => value ? `root:${String(value).toLowerCase()}` : null,
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function fakeDirent(name, kind = 'file') {
  return {
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  };
}

function withDifferentIdentity(stats) {
  return new Proxy(stats, {
    get(target, property) {
      if (property === 'ino') return BigInt(target.ino || 0) + 1n;
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function createService(workspaceRoot, extra = {}) {
  const rootCoordinator = extra.rootCoordinator || createStaticRootCoordinator(workspaceRoot);
  return new WorkspaceIdeService({
    configService: {
      getToolsWorkspaceRoot: () => workspaceRoot,
      getState: () => ({ toolsWorkspaceRoot: workspaceRoot }),
      getWorkspaceRootStatus: () => ({
        state: workspaceRoot ? 'ready' : 'missing',
        message: '',
      }),
    },
    rootContextProvider: () => rootCoordinator,
    ...extra,
  });
}

// The plain createService() config mock reports 'ready' for any non-empty
// root string, which hides the real getWorkspaceRootStatus() contract (it
// stats the configured path on disk). The ROOT_INVALID regression tests need
// that live behavior, so this variant actually stats `root` each call - the
// same shape as the real shell-config-service.
function createServiceWithLiveRootStatus(root, extra = {}) {
  return createService(root, {
    configService: {
      getToolsWorkspaceRoot: () => root,
      getState: () => ({ toolsWorkspaceRoot: root }),
      getWorkspaceRootStatus: () => {
        try {
          return { state: fs.statSync(root).isDirectory() ? 'ready' : 'invalid', message: '' };
        } catch (_error) {
          return { state: 'invalid', message: '' };
        }
      },
    },
    ...extra,
  });
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('workspace-ide-service reads, stats, and writes files inside the root', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'const a = 1;\n', 'utf8');
  const service = createService(root);

  const read = await service.readFile({ path: 'src/app.js' });
  assert.equal(read.content, 'const a = 1;\n');
  assert.equal(read.path, 'src/app.js');
  assert.equal(read.eol, 'lf');
  assert.ok(read.mtimeMs > 0);

  const stat = await service.stat({ path: 'src/app.js' });
  assert.equal(stat.exists, true);
  assert.equal(stat.kind, 'file');

  const missing = await service.stat({ path: 'src/nope.js' });
  assert.equal(missing.exists, false);

  const written = await service.writeFile({
    path: 'src/app.js',
    content: 'const a = 2;\r\n',
    expectedMtimeMs: read.mtimeMs,
  });
  assert.ok(written.mtimeMs >= read.mtimeMs);
  const reread = await service.readFile({ path: 'src/app.js' });
  assert.equal(reread.content, 'const a = 2;\r\n');
  assert.equal(reread.eol, 'crlf');
  // The just-written fingerprint is recorded for watcher self-echo
  // suppression (single-consume: WIDE-028 c).
  const real = fs.realpathSync(path.join(root, 'src', 'app.js'));
  const stats = fs.lstatSync(real);
  assert.equal(service.consumeRecentWrite(real, stats), true);
});

// ---------------------------------------------------------------------------
// WIDE-028 (c): self-write suppression records are short-lived one-shot tokens
// carrying the full stat fingerprint - never a bare path->mtime pair.
// ---------------------------------------------------------------------------

test('wide-028: a suppression token is consumed exactly once (a second identical event is NOT suppressed)', () => {
  const service = createService('C:/anywhere');
  const stats = { dev: 1, ino: 2, size: 30, mtimeMs: 1000, ctimeMs: 1000 };
  service._recordRecentWrite('C:/anywhere/f.txt', stats);
  assert.equal(service.consumeRecentWrite('C:/anywhere/f.txt', stats), true, 'first match consumes');
  assert.equal(service.consumeRecentWrite('C:/anywhere/f.txt', stats), false, 'the token is single-use');
});

test('wide-028: a later edit with the SAME coarse mtime but different bytes is never suppressed', () => {
  const service = createService('C:/anywhere');
  const written = { dev: 1, ino: 2, size: 30, mtimeMs: 1000, ctimeMs: 1000 };
  service._recordRecentWrite('C:/anywhere/f.txt', written);
  // An external tool rewrites the file within the same coarse timestamp tick:
  // same mtime, different size. The fingerprint mismatch must fail the match
  // (and still consume the record so it cannot linger for a third event).
  const externalSameMtime = { dev: 1, ino: 2, size: 31, mtimeMs: 1000, ctimeMs: 1000 };
  assert.equal(service.consumeRecentWrite('C:/anywhere/f.txt', externalSameMtime), false);
});

test('wide-028: an unconsumed suppression token expires after its TTL', () => {
  let clock = 100_000;
  const service = createService('C:/anywhere', { now: () => clock });
  const stats = { dev: 1, ino: 2, size: 30, mtimeMs: 1000, ctimeMs: 1000 };
  service._recordRecentWrite('C:/anywhere/f.txt', stats);
  // The watcher never observed the write (watch stopped / event lost). A
  // matching event long after must NOT be suppressed - before this fix the
  // record lived until cap-eviction and could swallow a real external edit.
  clock += 31_000; // past RECENT_WRITE_TTL_MS
  assert.equal(service.consumeRecentWrite('C:/anywhere/f.txt', stats), false, 'expired token never matches');

  // Within the TTL the token still works.
  service._recordRecentWrite('C:/anywhere/g.txt', stats);
  clock += 1_000;
  assert.equal(service.consumeRecentWrite('C:/anywhere/g.txt', stats), true);
});

test('wide-028: the mtime-only wasRecentlyWritten probe is gone', () => {
  const service = createService('C:/anywhere');
  assert.equal(typeof service.wasRecentlyWritten, 'undefined', 'no path->mtime suppression surface remains');
});

test('workspace-ide-service write creates parent directories and new files atomically', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  const service = createService(root);
  const result = await service.writeFile({ path: 'deep/nested/new.txt', content: 'hello' });
  assert.equal(fs.readFileSync(path.join(root, 'deep', 'nested', 'new.txt'), 'utf8'), 'hello');
  assert.ok(result.mtimeMs > 0);
  const leftovers = fs.readdirSync(path.join(root, 'deep', 'nested')).filter((name) => name.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('workspace-ide-service write conflicts when the file changed on disk', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  fs.writeFileSync(path.join(root, 'notes.md'), 'v1', 'utf8');
  const service = createService(root);
  const read = await service.readFile({ path: 'notes.md' });

  // Simulate an external/AI edit landing after the buffer was loaded.
  fs.writeFileSync(path.join(root, 'notes.md'), 'v2-external', 'utf8');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(root, 'notes.md'), future, future);

  await assert.rejects(
    service.writeFile({ path: 'notes.md', content: 'v2-buffer', expectedMtimeMs: read.mtimeMs }),
    (error) => {
      assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.WRITE_CONFLICT);
      assert.ok(error.details.currentMtimeMs > read.mtimeMs);
      return true;
    }
  );
  assert.equal(fs.readFileSync(path.join(root, 'notes.md'), 'utf8'), 'v2-external');

  // Re-saving with the fresh mtime succeeds (the "overwrite" path).
  const current = await service.stat({ path: 'notes.md' });
  const saved = await service.writeFile({
    path: 'notes.md',
    content: 'v2-buffer',
    expectedMtimeMs: current.mtimeMs,
  });
  assert.ok(saved.mtimeMs > 0);
});

test('workspace-ide-service rejects binary and oversized reads', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0x4a, 0x00, 0x4e, 0x4e, 0x59]));
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(64), 'utf8');
  const service = createService(root);

  await assert.rejects(service.readFile({ path: 'blob.bin' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.BINARY);
    return true;
  });
  await assert.rejects(service.readFile({ path: 'big.txt', maxBytes: 16 }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.TOO_LARGE);
    return true;
  });
  await assert.rejects(service.readFile({ path: 'missing.txt' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.NOT_FOUND);
    return true;
  });
  await assert.rejects(service.readFile({ path: '.' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.PATH_INVALID);
    return true;
  });
});

test('workspace-ide-service rejects text bytes beyond the cap after stat under-reports', async () => {
  const root = createTrackedTempDir('jenny-ide-'); fs.writeFileSync(path.join(root, 'growing.txt'), 'x');
  const fakeFs = Object.assign(Object.create(fsPromises), {
    stat: async (target) => Object.assign(await fsPromises.stat(target), { size: 1 }),
    readFile: async () => Buffer.alloc(5, 0x61),
    open: async () => ({ read: async (buffer) => ({ bytesRead: buffer.length }), close: async () => {} }),
  });
  await assert.rejects(createService(root, { fs: fakeFs }).readFile({ path: 'growing.txt', maxBytes: 4 }), { code: WORKSPACE_FS_ERROR_CODES.TOO_LARGE });
});

test('workspace-ide-service rejects escaping paths lexically and via junctions', async (t) => {
  const root = createTrackedTempDir('jenny-ide-');
  const outside = createTrackedTempDir('jenny-ide-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret', 'utf8');
  const service = createService(root);

  const lexicalAttacks = [
    '../outside.txt',
    'src/../../outside.txt',
    'C:/Windows/system.ini',
    '/etc/passwd',
    '\\\\server\\share\\file.txt',
    'src/file\0.txt',
    '',
  ];
  for (const attack of lexicalAttacks) {
    await assert.rejects(service.readFile({ path: attack }), (error) => {
      assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.PATH_INVALID, `attack: ${JSON.stringify(attack)}`);
      return true;
    });
    await assert.rejects(service.writeFile({ path: attack, content: 'x' }), (error) => {
      assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.PATH_INVALID, `attack: ${JSON.stringify(attack)}`);
      return true;
    });
  }

  // A junction inside the root pointing outside must be rejected by the
  // realpath containment check even though the lexical path looks relative.
  let junctionCreated = true;
  try {
    fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
  } catch (error) {
    // Junction creation needs privilege / Developer Mode on Windows; when it is
    // unavailable the realpath-containment branch can't be exercised here.
    // Emit a visible diagnostic so this reads as a reported skip, not a silent
    // green that hides a coverage hole.
    junctionCreated = false;
    t.diagnostic(`junction-escape assertion skipped: ${error.code || error.message}`);
  }
  if (junctionCreated) {
    await assert.rejects(service.readFile({ path: 'escape/secret.txt' }), (error) => {
      const code = String(error.code || '');
      assert.ok(
        code === WORKSPACE_FS_ERROR_CODES.PATH_OUTSIDE_ROOT || /outside the working directory/.test(String(error.message)),
        `unexpected junction escape error: ${error.message}`
      );
      return true;
    });
    await assert.rejects(service.writeFile({ path: 'escape/implant.txt', content: 'x' }));
  }
});

test('workspace-ide-service lists one level: dirs first, .git skipped, caps honored', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref', 'utf8');
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'aaa', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'x', 'utf8');
  const service = createService(root);

  // Empty/absent path lists the workspace root itself.
  const rootListing = await service.listDirectory({});
  assert.equal(rootListing.path, '');
  assert.equal(rootListing.truncated, false);
  assert.equal(rootListing.ordering, 'directory_first_name');
  assert.equal(rootListing.generation, 0);
  assert.equal(rootListing.rootId, `root:${root.toLowerCase()}`);
  assert.deepEqual(rootListing.entries.map((entry) => entry.name), ['docs', 'src', 'a.txt']);
  assert.deepEqual(
    rootListing.entries.map((entry) => entry.kind),
    ['directory', 'directory', 'file']
  );
  const aTxt = rootListing.entries.find((entry) => entry.name === 'a.txt');
  assert.equal(aTxt.relPath, 'a.txt');
  assert.equal(aTxt.size, 3);
  assert.ok(aTxt.mtimeMs > 0);

  const subListing = await service.listDirectory({ path: 'src' });
  assert.deepEqual(subListing.entries.map((entry) => entry.relPath), ['src/app.js']);

  const capped = await service.listDirectory({ maxEntries: 2 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.ordering, 'streamed_subset');
  assert.equal(capped.totalsKnown, false);
  assert.equal(capped.truncationReason, 'item_limit');
  assert.equal(capped.entries.length, 2);
  assert.equal(capped.entries.some((entry) => entry.name === '.git'), false);
  assert.deepEqual(
    capped.entries,
    [...capped.entries].sort((left, right) => {
      const kindOrder = Number(left.kind !== 'directory') - Number(right.kind !== 'directory');
      return kindOrder || left.name.toLowerCase().localeCompare(right.name.toLowerCase());
    })
  );

  await assert.rejects(service.listDirectory({ path: 'a.txt' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.NOT_A_DIRECTORY);
    return true;
  });
  await assert.rejects(service.listDirectory({ path: 'nope' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.NOT_FOUND);
    return true;
  });
});

test('workspace-ide-service listDirectory streams a million-entry source and reports partial totals', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  let pulled = 0;
  const boundedFs = Object.assign(Object.create(fsPromises), {
    async opendir() {
      return {
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 1_000_000; index += 1) {
            pulled += 1;
            yield fakeDirent(`file-${String(index).padStart(7, '0')}.txt`);
          }
        },
        async close() {},
      };
    },
  });
  const service = createService(root, { fs: boundedFs });

  const result = await service.listDirectory({ maxEntries: 2, maxDurationMs: 10000 });

  assert.equal(pulled, 3, 'only one lookahead entry is consumed');
  assert.deepEqual(result.entries.map((entry) => entry.name), [
    'file-0000000.txt',
    'file-0000001.txt',
  ]);
  assert.equal(result.truncated, true);
  assert.equal(result.truncationReason, 'item_limit');
  assert.equal(result.totalsKnown, false);
  assert.equal(result.ordering, 'streamed_subset');
  assert.equal(result.entriesScanned, 3);
});

test('workspace-ide-service listDirectory revalidates root identity before and after opendir', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  let swapped = false;
  let lstatCalls = 0;
  const guardedFs = Object.assign(Object.create(fsPromises), {
    async lstat(targetPath) {
      lstatCalls += 1;
      const stats = await fsPromises.lstat(targetPath);
      return swapped ? withDifferentIdentity(stats) : stats;
    },
    async stat(targetPath) {
      const stats = await fsPromises.stat(targetPath);
      return swapped ? withDifferentIdentity(stats) : stats;
    },
    async opendir() {
      assert.ok(lstatCalls >= 2, 'root is revalidated after lease preparation and before opendir');
      swapped = true;
      return {
        async *[Symbol.asyncIterator]() {},
        async close() {},
      };
    },
  });
  const service = createService(root, { fs: guardedFs });

  await assert.rejects(service.listDirectory(), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.ROOT_INVALID);
    assert.equal(error.details.reason, 'root_identity_changed');
    return true;
  });
});

test('workspace-ide-service createFile/createDirectory enforce EXISTS conflicts', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  const service = createService(root);

  const created = await service.createFile({ path: 'notes/todo.md' });
  assert.equal(created.kind, 'file');
  assert.equal(created.size, 0);
  assert.ok(created.mtimeMs > 0);
  assert.equal(fs.readFileSync(path.join(root, 'notes', 'todo.md'), 'utf8'), '');

  await assert.rejects(service.createFile({ path: 'notes/todo.md' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.EXISTS);
    return true;
  });
  // A directory occupying the name conflicts the same way.
  await assert.rejects(service.createFile({ path: 'notes' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.EXISTS);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(root, 'notes', 'todo.md'), 'utf8'), '');

  const dir = await service.createDirectory({ path: 'notes/archive' });
  assert.equal(dir.kind, 'directory');
  assert.ok(fs.statSync(path.join(root, 'notes', 'archive')).isDirectory());
  await assert.rejects(service.createDirectory({ path: 'notes/archive' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.EXISTS);
    return true;
  });
  await assert.rejects(service.createDirectory({ path: 'notes/todo.md' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.EXISTS);
    return true;
  });
});

test('workspace-ide-service mutators refuse with ROOT_INVALID when the configured root is deleted, never recreating it', async () => {
  // Regression harness for the audit-reproduced defect (WIDE-007 stopgap):
  // _requireRoot() only checked the config string was non-empty, so a
  // mutator's own mkdir(dirname(...), {recursive:true}) silently recreated a
  // root the owner had deleted (or unmounted). Each of the five mutators must
  // now refuse before touching the filesystem at all.
  const root = createTrackedTempDir('jenny-ide-');
  const service = createServiceWithLiveRootStatus(root);

  fs.rmSync(root, { recursive: true, force: true });
  assert.equal(fs.existsSync(root), false);

  const mutators = [
    ['writeFile', () => service.writeFile({ path: 'src/new-file.js', content: 'x' })],
    ['createFile', () => service.createFile({ path: 'src/new-file.js' })],
    ['createDirectory', () => service.createDirectory({ path: 'src/new-dir' })],
    ['rename', () => service.rename({ from: 'src/a.js', to: 'src/b.js' })],
    ['delete', () => service.delete({ path: 'src/a.js' })],
  ];

  for (const [name, runMutator] of mutators) {
    await assert.rejects(runMutator(), (error) => {
      assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.ROOT_INVALID, `${name}: wrong error code`);
      assert.equal(error.error_code, 'CMP-WORKSPACEFS-0007', `${name}: wrong error_code`);
      return true;
    });
    // The whole point of the stopgap: a refused mutator must never recreate
    // the deleted root via its dirname(...) mkdir.
    assert.equal(fs.existsSync(root), false, `${name}: must not recreate the deleted root`);
  }

  const rootState = service.getRootState();
  assert.notEqual(rootState.workspaceRootStatus.state, 'ready');
});

test('workspace-ide-service mutators refuse with ROOT_INVALID when the configured root is a file, not a directory', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  fs.rmSync(root, { recursive: true, force: true });
  fs.writeFileSync(root, 'not a directory', 'utf8');
  const service = createServiceWithLiveRootStatus(root);

  const mutators = [
    ['writeFile', () => service.writeFile({ path: 'src/new-file.js', content: 'x' })],
    ['createFile', () => service.createFile({ path: 'src/new-file.js' })],
    ['createDirectory', () => service.createDirectory({ path: 'src/new-dir' })],
    ['rename', () => service.rename({ from: 'src/a.js', to: 'src/b.js' })],
    ['delete', () => service.delete({ path: 'src/a.js' })],
  ];

  for (const [name, runMutator] of mutators) {
    await assert.rejects(runMutator(), (error) => {
      assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.ROOT_INVALID, `${name}: wrong error code`);
      return true;
    });
  }
  // The file occupying the configured root path must be left untouched.
  assert.equal(fs.readFileSync(root, 'utf8'), 'not a directory');
});

test('wide-042: getRootState reads the root directly without cloning the full shell config', () => {
  const root = 'G:/fake-root';
  const service = createService(root, {
    configService: {
      getState: () => { throw new Error('full config clone must not run'); },
      getToolsWorkspaceRoot: () => root,
      getWorkspaceRootStatus: () => ({ state: 'checking', message: 'Checking workspace root.' }),
    },
  });
  assert.deepEqual(service.getRootState(), {
    workspaceRoot: root,
    workspaceRootStatus: { state: 'checking', message: 'Checking workspace root.' },
  });
});

test('workspace-ide-service rename moves entries and rejects conflicts and escapes', async (t) => {
  const root = createTrackedTempDir('jenny-ide-');
  const outside = createTrackedTempDir('jenny-ide-outside-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'aaa', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'b.js'), 'bbb', 'utf8');
  const service = createService(root);

  const renamed = await service.rename({ from: 'src/a.js', to: 'src/lib/renamed.js' });
  assert.deepEqual(renamed, { from: 'src/a.js', to: 'src/lib/renamed.js', kind: 'file' });
  assert.equal(fs.existsSync(path.join(root, 'src', 'a.js')), false);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'lib', 'renamed.js'), 'utf8'), 'aaa');

  const dirRenamed = await service.rename({ from: 'src/lib', to: 'src/lib2' });
  assert.equal(dirRenamed.kind, 'directory');
  assert.equal(fs.readFileSync(path.join(root, 'src', 'lib2', 'renamed.js'), 'utf8'), 'aaa');

  await assert.rejects(service.rename({ from: 'src/missing.js', to: 'src/x.js' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.NOT_FOUND);
    return true;
  });
  await assert.rejects(service.rename({ from: 'src/b.js', to: 'src/lib2/renamed.js' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.EXISTS);
    return true;
  });

  // Lexical escapes are rejected on EITHER endpoint before any fs mutation.
  await assert.rejects(service.rename({ from: '../evil.txt', to: 'src/x.js' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.PATH_INVALID);
    return true;
  });
  await assert.rejects(service.rename({ from: 'src/b.js', to: '../evil.txt' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.PATH_INVALID);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(root, 'src', 'b.js'), 'utf8'), 'bbb');

  // A junction target endpoint must fail realpath containment.
  let junctionCreated = true;
  try {
    fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
  } catch (error) {
    // Junction creation needs privilege / Developer Mode on Windows; when it is
    // unavailable the realpath-containment branch can't be exercised here.
    // Emit a visible diagnostic so this reads as a reported skip, not a silent
    // green that hides a coverage hole.
    junctionCreated = false;
    t.diagnostic(`junction-escape assertion skipped: ${error.code || error.message}`);
  }
  if (junctionCreated) {
    await assert.rejects(service.rename({ from: 'src/b.js', to: 'escape/implant.js' }), (error) => {
      const code = String(error.code || '');
      assert.ok(
        code === WORKSPACE_FS_ERROR_CODES.PATH_OUTSIDE_ROOT
          || /outside the working directory/.test(String(error.message)),
        `unexpected junction escape error: ${error.message}`
      );
      return true;
    });
    assert.equal(fs.existsSync(path.join(outside, 'implant.js')), false);
    assert.equal(fs.readFileSync(path.join(root, 'src', 'b.js'), 'utf8'), 'bbb');
  }
});

test('workspace-ide-service rename moves a safe leaf symlink itself, not its target', async (t) => {
  const root = createTrackedTempDir('jenny-ide-');
  fs.writeFileSync(path.join(root, 'target.txt'), 'target', 'utf8');
  try {
    fs.symlinkSync(path.join(root, 'target.txt'), path.join(root, 'link.txt'), 'file');
  } catch (error) {
    t.diagnostic(`file-symlink rename assertion skipped: ${error.code || error.message}`);
    return;
  }
  const service = createService(root);

  const renamed = await service.rename({ from: 'link.txt', to: 'renamed-link.txt' });

  assert.deepEqual(renamed, { from: 'link.txt', to: 'renamed-link.txt', kind: 'file' });
  assert.equal(fs.existsSync(path.join(root, 'link.txt')), false, 'the original symlink path moved');
  assert.equal(fs.lstatSync(path.join(root, 'renamed-link.txt')).isSymbolicLink(), true, 'the symlink itself moved');
  assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'target', 'target content is untouched');
});

test('workspace-ide-service rename moves a safe leaf junction itself, not its target', async (t) => {
  // Junctions create WITHOUT elevation on Windows and lstat as symbolic links, so
  // this exercises the _resolveMutableLeaf symlink-leaf branch on stock hosts where
  // the file-symlink test above EPERM-skips (keeps REV-004 coverage from going false-green).
  const root = createTrackedTempDir('jenny-ide-');
  fs.mkdirSync(path.join(root, 'target-dir'));
  fs.writeFileSync(path.join(root, 'target-dir', 'inner.txt'), 'inner', 'utf8');
  try {
    fs.symlinkSync(path.join(root, 'target-dir'), path.join(root, 'link-dir'), 'junction');
  } catch (error) {
    t.diagnostic(`junction-leaf rename assertion skipped: ${error.code || error.message}`);
    return;
  }
  const service = createService(root);

  const renamed = await service.rename({ from: 'link-dir', to: 'renamed-link' });

  assert.deepEqual(renamed, { from: 'link-dir', to: 'renamed-link', kind: 'file' });
  assert.equal(fs.existsSync(path.join(root, 'link-dir')), false, 'the original junction leaf moved');
  assert.equal(fs.lstatSync(path.join(root, 'renamed-link')).isSymbolicLink(), true, 'the junction itself moved, not its target directory');
  assert.equal(fs.readFileSync(path.join(root, 'target-dir', 'inner.txt'), 'utf8'), 'inner', 'the junction target directory is untouched');
});

test('workspace-ide-service delete uses the injected recycle-bin impl, never a hard unlink', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  fs.writeFileSync(path.join(root, 'junk.txt'), 'junk', 'utf8');
  fs.mkdirSync(path.join(root, 'junkdir'));
  const trashed = [];
  const service = createService(root, {
    trashItemImpl: async (target) => {
      trashed.push(target);
    },
  });

  const result = await service.delete({ path: 'junk.txt' });
  assert.deepEqual(result, { path: 'junk.txt', trashed: true, kind: 'file' });
  assert.equal(trashed.length, 1);
  assert.equal(path.basename(trashed[0]), 'junk.txt');
  // The stub recorded but kept the file: the service itself never unlinks.
  assert.equal(fs.existsSync(path.join(root, 'junk.txt')), true);

  const dirResult = await service.delete({ path: 'junkdir' });
  assert.equal(dirResult.kind, 'directory');
  assert.equal(trashed.length, 2);

  await assert.rejects(service.delete({ path: 'missing.txt' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.NOT_FOUND);
    return true;
  });

  const failing = createService(root, {
    trashItemImpl: async () => {
      throw new Error('recycle bin offline');
    },
  });
  await assert.rejects(failing.delete({ path: 'junk.txt' }), (error) => {
    assert.deepEqual([error.code, error.message], [WORKSPACE_FS_ERROR_CODES.TRASH_FAILED, "The item couldn't be moved to the recycle bin. Delete it from your file manager instead."]);
    return true;
  });
  assert.equal(fs.existsSync(path.join(root, 'junk.txt')), true);

  const noImpl = createService(root);
  await assert.rejects(noImpl.delete({ path: 'junk.txt' }), (error) => {
    assert.deepEqual([error.code, error.message], [WORKSPACE_FS_ERROR_CODES.TRASH_FAILED, "Delete is unavailable in this shell mode — the OS recycle bin isn't reachable. Delete the item from your file manager instead."]);
    return true;
  });
  assert.equal(fs.existsSync(path.join(root, 'junk.txt')), true);
});

test('workspace-ide-service delete trashes a safe leaf symlink itself, not its target', async (t) => {
  const root = createTrackedTempDir('jenny-ide-');
  fs.writeFileSync(path.join(root, 'target.txt'), 'target', 'utf8');
  try {
    fs.symlinkSync(path.join(root, 'target.txt'), path.join(root, 'link.txt'), 'file');
  } catch (error) {
    t.diagnostic(`file-symlink delete assertion skipped: ${error.code || error.message}`);
    return;
  }
  const trashed = [];
  const service = createService(root, {
    trashItemImpl: async (target) => {
      trashed.push(target);
    },
  });

  const result = await service.delete({ path: 'link.txt' });

  assert.deepEqual(result, { path: 'link.txt', trashed: true, kind: 'file' });
  assert.equal(trashed.length, 1);
  assert.equal(path.basename(trashed[0]), 'link.txt', 'the shell receives the symlink path');
  assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'target', 'target content is untouched');
});

test('workspace-ide-service delete trashes a safe leaf junction itself, not its target', async (t) => {
  // Admin-free counterpart to the file-symlink delete test above (junctions need no
  // elevation), so the _resolveMutableLeaf leaf-vs-target branch is covered on stock CI.
  const root = createTrackedTempDir('jenny-ide-');
  fs.mkdirSync(path.join(root, 'target-dir'));
  fs.writeFileSync(path.join(root, 'target-dir', 'inner.txt'), 'inner', 'utf8');
  try {
    fs.symlinkSync(path.join(root, 'target-dir'), path.join(root, 'link-dir'), 'junction');
  } catch (error) {
    t.diagnostic(`junction-leaf delete assertion skipped: ${error.code || error.message}`);
    return;
  }
  const trashed = [];
  const service = createService(root, {
    trashItemImpl: async (target) => {
      trashed.push(target);
    },
  });

  const result = await service.delete({ path: 'link-dir' });

  assert.deepEqual(result, { path: 'link-dir', trashed: true, kind: 'file' });
  assert.equal(trashed.length, 1);
  assert.equal(path.basename(trashed[0]), 'link-dir', 'the recycle-bin impl receives the junction leaf, not its target');
  assert.equal(fs.readFileSync(path.join(root, 'target-dir', 'inner.txt'), 'utf8'), 'inner', 'the junction target directory is untouched');
});

test('workspace-ide-service revealInFolder resolves inside the root and uses the injected shell impl', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'a', 'utf8');
  const revealed = [];
  const service = createService(root, {
    showItemInFolderImpl: (target) => {
      revealed.push(target);
    },
  });

  const fileResult = await service.revealInFolder({ path: 'src/app.js' });
  assert.deepEqual(fileResult, { path: 'src/app.js', revealed: true });
  const dirResult = await service.revealInFolder({ path: 'src' });
  assert.deepEqual(dirResult, { path: 'src', revealed: true });
  assert.equal(revealed.length, 2);
  // The shell receives the resolved REAL path, never the renderer string.
  assert.equal(revealed[0], fs.realpathSync(path.join(root, 'src', 'app.js')));

  // Root-escape and absolute renderer paths are rejected lexically.
  for (const escape of ['../outside.txt', 'src/../../outside.txt', 'C:\\Windows\\system32', '/etc/passwd']) {
    await assert.rejects(service.revealInFolder({ path: escape }), (error) => {
      assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.PATH_INVALID, `expected lexical rejection for ${escape}`);
      return true;
    });
  }
  assert.equal(revealed.length, 2, 'no shell call for rejected paths');

  await assert.rejects(service.revealInFolder({ path: 'src/missing.js' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.NOT_FOUND);
    return true;
  });

  const noImpl = createService(root);
  await assert.rejects(noImpl.revealInFolder({ path: 'src/app.js' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.REVEAL_UNAVAILABLE);
    return true;
  });
});

test('workspace-ide-service openInDefaultApp surfaces shell failures as typed errors', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  fs.writeFileSync(path.join(root, 'doc.txt'), 'd', 'utf8');
  const opened = [];
  const service = createService(root, {
    openPathImpl: async (target) => {
      opened.push(target);
      return '';
    },
  });

  const result = await service.openInDefaultApp({ path: 'doc.txt' });
  assert.deepEqual(result, { path: 'doc.txt', opened: true });
  assert.equal(opened[0], fs.realpathSync(path.join(root, 'doc.txt')));

  await assert.rejects(service.openInDefaultApp({ path: '../outside.txt' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.PATH_INVALID);
    return true;
  });
  await assert.rejects(service.openInDefaultApp({ path: 'missing.txt' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.NOT_FOUND);
    return true;
  });

  // Electron shell.openPath signals failure via a non-empty string.
  const failing = createService(root, {
    openPathImpl: async () => 'No application is associated.',
  });
  await assert.rejects(failing.openInDefaultApp({ path: 'doc.txt' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.OPEN_FAILED);
    assert.equal(error.details.message, 'No application is associated.');
    return true;
  });

  const noImpl = createService(root);
  await assert.rejects(noImpl.openInDefaultApp({ path: 'doc.txt' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.OPEN_UNAVAILABLE);
    return true;
  });
});

test('workspace-ide-service requires a configured workspace root', async () => {
  const service = createService('');
  await assert.rejects(service.readFile({ path: 'anything.txt' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.ROOT_MISSING);
    return true;
  });
  const rootState = service.getRootState();
  assert.equal(rootState.workspaceRoot, '');
  assert.equal(rootState.workspaceRootStatus.state, 'missing');
});

test('workspace-ide-service readPreChange resolves snapshots and treats misses as data', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  fs.writeFileSync(path.join(root, 'app.js'), 'current', 'utf8');
  const reads = [];
  const service = createService(root, {
    snapshotStore: {
      async read(hash) {
        reads.push(hash);
        return hash === 'sha256:known'
          ? { found: true, content: 'the original' }
          : { found: false, reason: 'missing' };
      },
    },
  });

  const hit = await service.readPreChange({ path: 'app.js', beforeHash: 'sha256:known' });
  assert.deepEqual(hit, { path: 'app.js', found: true, content: 'the original' });
  const miss = await service.readPreChange({ path: 'app.js', beforeHash: 'sha256:other' });
  assert.deepEqual(miss, { path: 'app.js', found: false, reason: 'missing' });
  assert.deepEqual(reads, ['sha256:known', 'sha256:other']);

  // The path still goes through the full validation surface.
  await assert.rejects(service.readPreChange({ path: '../escape.js', beforeHash: 'sha256:known' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.PATH_INVALID);
    return true;
  });

  // No store injected: a miss, never an error.
  const storeless = createService(root);
  assert.deepEqual(
    await storeless.readPreChange({ path: 'app.js', beforeHash: 'sha256:known' }),
    { path: 'app.js', found: false, reason: 'unavailable' }
  );
});

test('workspace-ide-service listAllFiles walks files, prunes heavy dirs, never follows symlinks', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'r', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'a', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'deep', 'util.js'), 'u', 'utf8');
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x', 'utf8');
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref', 'utf8');
  fs.writeFileSync(path.join(root, '.cache', 'blob'), 'b', 'utf8');
  // Dot FILES at any level are kept; only dot DIRECTORIES are pruned.
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules', 'utf8');
  // Symlinked directory pointing outside the root must never be descended.
  const outside = createTrackedTempDir('jenny-ide-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's', 'utf8');
  try {
    fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
  } catch (_error) {
    /* symlink creation can fail without privileges; the prune assert below
       still covers the dirent.isSymbolicLink() branch when it succeeded */
  }
  const service = createService(root);

  const result = await service.listAllFiles();
  assert.equal(result.truncated, false);
  assert.deepEqual(
    [...result.files].sort(),
    ['.gitignore', 'README.md', 'src/app.js', 'src/deep/util.js']
  );
});

test('workspace-ide-service listAllFiles bounds a lazy 20k-directory corpus before queue growth', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  let pulled = 0;
  let openCalls = 0;
  const boundedFs = Object.assign(Object.create(fsPromises), {
    async opendir() {
      openCalls += 1;
      return {
        async *[Symbol.asyncIterator]() {
          for (let index = 0; index < 20_000; index += 1) {
            pulled += 1;
            yield fakeDirent(`dir-${index}`, 'directory');
          }
        },
        async close() {},
      };
    },
  });
  const logs = [];
  const service = createService(root, {
    fs: boundedFs,
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  const result = await service.listAllFiles({ maxDirectories: 3, maxDurationMs: 10000 });

  assert.equal(openCalls, 1, 'the directory budget stops before queued children are opened');
  assert.equal(pulled, 3);
  assert.deepEqual(result.files, []);
  assert.equal(result.truncated, true);
  assert.equal(result.truncationReason, 'directory_limit');
  assert.equal(result.totalsKnown, false);
  const diagnostic = logs.find((entry) => entry.event === 'workspace_fs.list_all_truncated');
  assert.equal(diagnostic.details.root_id, result.rootId);
  assert.equal(diagnostic.details.root_generation, result.generation);
  assert.equal(diagnostic.details.totals_known, false);
  assert.equal(typeof diagnostic.details.elapsed_ms, 'number');
});

test('workspace-ide-service listAllFiles rejects a late result after root cancellation', async () => {
  const rootA = createTrackedTempDir('jenny-ide-root-a-');
  const rootB = createTrackedTempDir('jenny-ide-root-b-');
  const entered = deferred();
  const release = deferred();
  const coordinator = createStaticRootCoordinator(rootA);
  const blockingFs = Object.assign(Object.create(fsPromises), {
    async opendir() {
      return {
        async *[Symbol.asyncIterator]() {
          yield fakeDirent('first.txt');
          entered.resolve();
          await release.promise;
          yield fakeDirent('late.txt');
        },
        async close() {},
      };
    },
  });
  const service = createService(rootA, { rootCoordinator: coordinator, fs: blockingFs });

  const listing = service.listAllFiles({ maxDurationMs: 10000 });
  await entered.promise;
  const prepared = await coordinator.prepareTarget(rootB);
  const commit = coordinator.commit({ transitionId: prepared.transitionId });
  release.resolve();

  await assert.rejects(listing, (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.ROOT_TRANSITIONING);
    assert.equal(error.details.reason, 'operation_cancelled');
    return true;
  });
  const committed = await commit;
  assert.equal(committed.committed, true);
});

test('workspace-ide-service listAllFiles requires a configured root', async () => {
  const service = createService('');
  await assert.rejects(service.listAllFiles(), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.ROOT_MISSING);
    return true;
  });
});

test('workspace-ide-service readFileBase64 reads binaries with mime, caps size, contains paths', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  fs.mkdirSync(path.join(root, 'assets'));
  // Real binary content incl. NUL bytes - the text lane would reject this.
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
  fs.writeFileSync(path.join(root, 'assets', 'pic.png'), bytes);
  const service = createService(root);

  const result = await service.readFileBase64({ path: 'assets/pic.png' });
  assert.equal(result.mime, 'image/png');
  assert.equal(result.base64, bytes.toString('base64'));
  assert.equal(result.size, bytes.length);
  assert.ok(result.mtimeMs > 0);

  await assert.rejects(service.readFileBase64({ path: 'assets/missing.png' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.NOT_FOUND);
    return true;
  });
  await assert.rejects(service.readFileBase64({ path: '../escape.png' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.PATH_INVALID);
    return true;
  });
});

test('workspace-ide-service readFileBase64 rejects oversized images', async () => {
  const root = createTrackedTempDir('jenny-ide-');
  fs.writeFileSync(path.join(root, 'big.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
  const service = createService(root);
  await assert.rejects(service.readFileBase64({ path: 'big.png' }), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.IMAGE_TOO_LARGE);
    return true;
  });
});

test('workspace-ide-service rejects Base64 bytes beyond the cap after stat under-reports', async () => {
  const root = createTrackedTempDir('jenny-ide-'); fs.writeFileSync(path.join(root, 'growing.png'), 'x');
  const fakeFs = Object.assign(Object.create(fsPromises), {
    stat: async (target) => Object.assign(await fsPromises.stat(target), { size: 1 }),
    readFile: async () => Buffer.alloc(10 * 1024 * 1024 + 1, 0x61),
    open: async () => ({ read: async (buffer) => ({ bytesRead: buffer.length }), close: async () => {} }),
  });
  await assert.rejects(createService(root, { fs: fakeFs }).readFileBase64({ path: 'growing.png' }), { code: WORKSPACE_FS_ERROR_CODES.IMAGE_TOO_LARGE });
});
