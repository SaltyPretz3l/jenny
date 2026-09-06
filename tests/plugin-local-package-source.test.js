'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_ARCHIVE_BYTES,
  normalizedPathDigest,
  sameSnapshot,
  createPluginLocalPackageSource,
} = require('../services/main/plugin-local-package-source');

function snapshot(overrides = {}) {
  return {
    size: 6,
    mtimeMs: 10,
    ctimeMs: 11,
    dev: 2,
    ino: 3,
    isFile: () => true,
    ...overrides,
  };
}

function fakeHandle({ bytes = Buffer.from('plugin'), before = snapshot(), after = before, chunkSize = bytes.length } = {}) {
  let stats = 0;
  let closed = 0;
  return {
    async stat() { stats += 1; return stats === 1 ? before : after; },
    async read(target, offset, length, position) {
      const count = Math.min(chunkSize, length, Math.max(0, bytes.length - position));
      bytes.copy(target, offset, position, position + count);
      return { bytesRead: count };
    },
    async close() { closed += 1; },
    get closeCount() { return closed; },
  };
}

test('native picker cancellation is a structured no-op', async () => {
  let openCalls = 0;
  const source = createPluginLocalPackageSource({
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    openFile: async () => { openCalls += 1; },
  });
  assert.deepEqual(await source(), { ok: true, canceled: true, changed: false });
  assert.equal(openCalls, 0);
});

test('selected regular file is read through one handle in partial chunks and only its path digest escapes', async () => {
  const handle = fakeHandle({ chunkSize: 2 });
  let pickerOptions;
  let openedPath;
  const source = createPluginLocalPackageSource({
    dialog: { showOpenDialog: async (options) => {
      pickerOptions = options;
      return { canceled: false, filePaths: ['C:\\Private\\Plugin.jenny-plugin'] };
    } },
    openFile: async (filePath, flags) => { openedPath = [filePath, flags]; return handle; },
  });
  const result = await source();
  assert.equal(result.ok, true);
  assert.equal(result.bytes.toString('utf8'), 'plugin');
  assert.equal(result.sourcePathDigest, normalizedPathDigest('C:\\Private\\Plugin.jenny-plugin'));
  assert.equal(JSON.stringify(result).includes('Private'), false);
  assert.deepEqual(openedPath, ['C:\\Private\\Plugin.jenny-plugin', 'r']);
  assert.deepEqual(pickerOptions.filters, [{ name: 'Jenny plugin package', extensions: ['jenny-plugin'] }]);
  assert.equal(handle.closeCount, 1);
});

test('extension, regular-file, size, truncation, and TOCTOU checks fail closed and close the handle', async () => {
  const invalidExtension = createPluginLocalPackageSource({
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['x.zip'] }) },
    openFile: async () => { throw new Error('must not open'); },
  });
  assert.equal((await invalidExtension()).reason, 'package_extension_invalid');

  for (const [label, handle, reason] of [
    ['not regular', fakeHandle({ before: snapshot({ isFile: () => false }) }), 'package_source_not_regular_file'],
    ['too large', fakeHandle({ before: snapshot({ size: MAX_ARCHIVE_BYTES + 1 }) }), 'package_source_size_invalid'],
    ['truncated', fakeHandle({ bytes: Buffer.alloc(0), before: snapshot({ size: 1 }), chunkSize: 0 }), 'package_read_truncated'],
    ['changed', fakeHandle({ after: snapshot({ mtimeMs: 12 }) }), 'package_source_changed_during_read'],
  ]) {
    const source = createPluginLocalPackageSource({
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['x.jenny-plugin'] }) },
      openFile: async () => handle,
    });
    assert.equal((await source()).reason, reason, label);
    assert.equal(handle.closeCount, 1, `${label}: opened handle must close`);
  }
});

test('snapshot identity uses inode/device when available and picker/read errors stay bounded', async () => {
  assert.equal(sameSnapshot(snapshot(), snapshot()), true);
  assert.equal(sameSnapshot(snapshot(), snapshot({ ino: 4 })), false);
  assert.equal(sameSnapshot(snapshot({ ino: 0 }), snapshot({ ino: 0, dev: 99 })), true);

  const pickerFailure = createPluginLocalPackageSource({
    dialog: { showOpenDialog: async () => { throw new Error('C:\\private\\picker'); } },
  });
  assert.deepEqual({ ...(await pickerFailure()), code: undefined }, {
    ok: false, code: undefined, reason: 'package_picker_failed',
  });

  const readFailure = createPluginLocalPackageSource({
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['x.jenny-plugin'] }) },
    openFile: async () => { throw new Error('C:\\private\\file'); },
  });
  const result = await readFailure();
  assert.equal(result.reason, 'package_source_read_failed');
  assert.equal(JSON.stringify(result).includes('private'), false);
});
