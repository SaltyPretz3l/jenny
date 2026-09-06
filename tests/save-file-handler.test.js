'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildSaveFileHandler,
  registerSaveFileHandler,
  SUPPORTED_FORMATS,
  FORMAT_FILTER_MAP,
} = require('../services/save-file-handler');

function makeLog() {
  const entries = [];
  return {
    write(level, name, payload) {
      entries.push({ level, name, payload });
    },
    entries,
  };
}

function makeDialogStub({ canceled = false, filePath = '' } = {}) {
  const calls = [];
  const dialog = {
    async showSaveDialog(...args) {
      calls.push(args);
      return { canceled, filePath };
    },
  };
  return { dialog, calls };
}

function createTempPath(suffix = '.md') {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(os.tmpdir(), `jenny-save-file-test-${stamp}${suffix}`);
}

test('save-file handler returns canceled passthrough when user cancels', async () => {
  const { dialog } = makeDialogStub({ canceled: true });
  const log = makeLog();
  const handler = buildSaveFileHandler({
    dialog,
    getMainWindow: () => null,
    getProtectedRoots: () => [],
    log,
  });

  const result = await handler({}, {
    defaultName: 'jenny-test.md',
    content: 'hello',
    format: 'markdown',
  });

  assert.deepEqual(result, { canceled: true, path: '', bytesWritten: 0 });
  assert.ok(log.entries.some((entry) => entry.name === 'save_file.canceled'));
});

test('save-file handler writes UTF-8 content + returns bytesWritten on accept', async () => {
  const tempPath = createTempPath('.md');
  try {
    const { dialog } = makeDialogStub({ filePath: tempPath });
    const log = makeLog();
    const handler = buildSaveFileHandler({
      dialog,
      getMainWindow: () => null,
      getProtectedRoots: () => [],
      log,
    });

    const content = '## Hello\nMulti-byte: ✓ café';
    const result = await handler({}, {
      defaultName: 'jenny-test.md',
      content,
      format: 'markdown',
    });

    assert.equal(result.canceled, false);
    assert.equal(result.path, path.resolve(tempPath));
    assert.equal(result.bytesWritten, Buffer.byteLength(content, 'utf8'));

    const onDisk = fs.readFileSync(tempPath, 'utf8');
    assert.equal(onDisk, content);
    assert.ok(log.entries.some((entry) => entry.name === 'save_file.completed'));
  } finally {
    try { fs.unlinkSync(tempPath); } catch (_e) { /* ignore */ }
  }
});

test('save-file handler resolves filters by format', async () => {
  const { dialog, calls } = makeDialogStub({ canceled: true });
  const handler = buildSaveFileHandler({
    dialog,
    getMainWindow: () => null,
    getProtectedRoots: () => [],
    log: makeLog(),
  });
  await handler({}, { defaultName: 'a.md', content: 'x', format: 'markdown' });
  await handler({}, { defaultName: 'a.txt', content: 'x', format: 'plain' });
  await handler({}, { defaultName: 'a.json', content: '{}', format: 'json' });
  await handler({}, { defaultName: 'a.json', content: '{}', format: 'session-json' });

  assert.equal(calls.length, 4);
  // Each call provides a window (null here) + options object.
  const optionsPerCall = calls.map((args) => args[args.length - 1]);
  assert.deepEqual(optionsPerCall[0].filters[0], FORMAT_FILTER_MAP.markdown[0]);
  assert.deepEqual(optionsPerCall[1].filters[0], FORMAT_FILTER_MAP.plain[0]);
  assert.deepEqual(optionsPerCall[2].filters[0], FORMAT_FILTER_MAP.json[0]);
  assert.deepEqual(optionsPerCall[3].filters[0], FORMAT_FILTER_MAP['session-json'][0]);

  // Each filter chain ends with the "All files" wildcard.
  for (const opt of optionsPerCall) {
    const last = opt.filters[opt.filters.length - 1];
    assert.equal(last.name, 'All files');
    assert.deepEqual(last.extensions, ['*']);
  }
});

test('save-file handler rejects writes inside protected roots', async () => {
  const protectedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-protected-'));
  const targetPath = path.join(protectedRoot, 'should-not-write.md');
  try {
    const { dialog } = makeDialogStub({ filePath: targetPath });
    const log = makeLog();
    const handler = buildSaveFileHandler({
      dialog,
      getMainWindow: () => null,
      getProtectedRoots: () => [protectedRoot],
      log,
    });

    await assert.rejects(
      () => handler({}, { defaultName: 'x.md', content: 'hi', format: 'markdown' }),
      /protected Jenny directory/,
    );
    assert.equal(fs.existsSync(targetPath), false);
    assert.ok(log.entries.some((entry) => entry.name === 'save_file.refused_protected_path'));
  } finally {
    try { fs.rmSync(protectedRoot, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
});

test('save-file handler rejects a portable symlink escape into a protected root', {
  skip: process.platform === 'win32' ? 'portable directory symlink coverage runs on non-Windows' : false,
}, async (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-save-symlink-'));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));
  const protectedRoot = path.join(basePath, 'protected');
  const aliasPath = path.join(basePath, 'outside-alias');
  fs.mkdirSync(protectedRoot);
  try {
    fs.symlinkSync(protectedRoot, aliasPath, 'dir');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip(`directory symlinks are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const targetPath = path.join(aliasPath, 'should-not-write.md');
  const { dialog } = makeDialogStub({ filePath: targetPath });
  const handler = buildSaveFileHandler({
    dialog,
    getMainWindow: () => null,
    getProtectedRoots: () => [protectedRoot],
    log: makeLog(),
  });

  await assert.rejects(
    () => handler({}, { defaultName: 'x.md', content: 'hi', format: 'markdown' }),
    /protected Jenny directory/,
  );
  assert.equal(fs.existsSync(path.join(protectedRoot, 'should-not-write.md')), false);
});

test('save-file handler rejects a Windows junction escape into a protected root', {
  skip: process.platform !== 'win32' ? 'Windows junctions are only available on Windows' : false,
}, async (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-save-junction-'));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));
  const protectedRoot = path.join(basePath, 'protected');
  const aliasPath = path.join(basePath, 'outside-alias');
  fs.mkdirSync(protectedRoot);
  try {
    fs.symlinkSync(protectedRoot, aliasPath, 'junction');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip(`directory junctions are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  const targetPath = path.join(aliasPath, 'should-not-write.md');
  const { dialog } = makeDialogStub({ filePath: targetPath });
  const handler = buildSaveFileHandler({
    dialog,
    getMainWindow: () => null,
    getProtectedRoots: () => [protectedRoot],
    log: makeLog(),
  });

  await assert.rejects(
    () => handler({}, { defaultName: 'x.md', content: 'hi', format: 'markdown' }),
    /protected Jenny directory/,
  );
  assert.equal(fs.existsSync(path.join(protectedRoot, 'should-not-write.md')), false);
});

test('save-file handler refuses unsupported format', async () => {
  const { dialog } = makeDialogStub({ canceled: true });
  const log = makeLog();
  const handler = buildSaveFileHandler({
    dialog,
    getMainWindow: () => null,
    getProtectedRoots: () => [],
    log,
  });

  await assert.rejects(
    () => handler({}, { defaultName: 'x', content: '', format: 'binary' }),
    /Unsupported save-file format/,
  );
  assert.ok(log.entries.some((entry) => entry.name === 'save_file.invalid_format'));
});

test('save-file handler logs save_file.failed and rethrows on write error', async () => {
  // Point at a directory path that does not exist so fs.writeFile rejects.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-savefail-'));
  const targetPath = path.join(tempDir, 'missing-subdir', 'x.md');
  try {
    const { dialog } = makeDialogStub({ filePath: targetPath });
    const log = makeLog();
    const handler = buildSaveFileHandler({
      dialog,
      getMainWindow: () => null,
      getProtectedRoots: () => [],
      log,
    });

    await assert.rejects(
      () => handler({}, { defaultName: 'x.md', content: 'x', format: 'markdown' }),
    );
    assert.ok(log.entries.some((entry) => entry.name === 'save_file.failed'));
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
});

test('save-file handler accepts override filters and appends wildcard', async () => {
  const { dialog, calls } = makeDialogStub({ canceled: true });
  const handler = buildSaveFileHandler({
    dialog,
    getMainWindow: () => null,
    getProtectedRoots: () => [],
    log: makeLog(),
  });

  await handler({}, {
    defaultName: 'x.custom',
    content: '',
    format: 'markdown',
    filters: [{ name: 'Custom', extensions: ['custom'] }],
  });

  const options = calls[0][calls[0].length - 1];
  assert.deepEqual(options.filters[0], { name: 'Custom', extensions: ['custom'] });
  assert.equal(options.filters[options.filters.length - 1].name, 'All files');
});

test('registerSaveFileHandler wires through registerIpcInvokeHandlers', async () => {
  const channels = new Map();
  const ipcMainLike = {
    handle(channel, handler) { channels.set(channel, handler); },
  };
  const { dialog } = makeDialogStub({ canceled: true });
  registerSaveFileHandler({
    ipcMainLike,
    dialog,
    getMainWindow: () => null,
    log: makeLog(),
  });
  // Channel for dialog.saveFile descriptor is "dialog:save-file".
  assert.ok(channels.has('dialog:save-file'));
  const handler = channels.get('dialog:save-file');
  const result = await handler({}, { defaultName: 'x.md', content: '', format: 'markdown' });
  assert.equal(result.canceled, true);
});

test('SUPPORTED_FORMATS exposes the format whitelist', () => {
  assert.ok(SUPPORTED_FORMATS.has('markdown'));
  assert.ok(SUPPORTED_FORMATS.has('plain'));
  assert.ok(SUPPORTED_FORMATS.has('json'));
  assert.ok(SUPPORTED_FORMATS.has('session-json'));
  assert.equal(SUPPORTED_FORMATS.size, 4);
});
