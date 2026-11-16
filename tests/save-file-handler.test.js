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
const { linkDirectory, posixOnly, windowsOnly } = require('./helpers/platform-skips');

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
  skip: posixOnly('portable directory symlink coverage'),
}, async (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-save-symlink-'));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));
  const protectedRoot = path.join(basePath, 'protected');
  const aliasPath = path.join(basePath, 'outside-alias');
  fs.mkdirSync(protectedRoot);
  linkDirectory(protectedRoot, aliasPath);
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
  skip: windowsOnly('junctions'),
}, async (t) => {
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-save-junction-'));
  t.after(() => fs.rmSync(basePath, { recursive: true, force: true }));
  const protectedRoot = path.join(basePath, 'protected');
  const aliasPath = path.join(basePath, 'outside-alias');
  fs.mkdirSync(protectedRoot);
  linkDirectory(protectedRoot, aliasPath);
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

test('registerSaveFileHandler applies authorization before opening the save dialog', async () => {
  const channels = new Map();
  const { dialog, calls } = makeDialogStub({ canceled: true });
  registerSaveFileHandler({
    ipcMainLike: { handle: (channel, handler) => channels.set(channel, handler) },
    dialog,
    getMainWindow: () => null,
    log: makeLog(),
    authorization: {
      authorize: (event) => event?.trusted === true,
      unauthorizedResult: () => ({ ok: false, authorized: false, code: 'ipc_sender_unauthorized' }),
    },
  });

  const handler = channels.get('dialog:save-file');
  const payload = { defaultName: 'x.md', content: '', format: 'markdown' };
  assert.deepEqual(await handler({ trusted: false }, payload), {
    ok: false, authorized: false, code: 'ipc_sender_unauthorized',
  });
  assert.equal(calls.length, 0);
  assert.equal((await handler({ trusted: true }, payload)).canceled, true);
  assert.equal(calls.length, 1);
});

test('SUPPORTED_FORMATS exposes the format whitelist', () => {
  assert.ok(SUPPORTED_FORMATS.has('markdown'));
  assert.ok(SUPPORTED_FORMATS.has('plain'));
  assert.ok(SUPPORTED_FORMATS.has('json'));
  assert.ok(SUPPORTED_FORMATS.has('session-json'));
  assert.equal(SUPPORTED_FORMATS.size, 4);
});

// Row 123 slice 2a-6c: one export, two formats; the type picked in the dialog is the one written.
test('save-file handler with contents offers each format and writes the picked one', async () => {
  for (const [suffix, expected] of [['.json', '{"a":1}'], ['.md', '# A'], ['', '# A']]) {
    const tempPath = createTempPath(suffix);
    try {
      const { dialog, calls } = makeDialogStub({ filePath: tempPath });
      const log = makeLog();
      const handler = buildSaveFileHandler({ dialog, getMainWindow: () => null, getProtectedRoots: () => [], log });
      const filters = [{ name: 'Markdown, to read', extensions: ['md'] }, { name: 'JSON, for other tools', extensions: ['json'] }];
      const result = await handler({}, { defaultName: 'team.md', format: 'markdown', contents: { markdown: '# A', json: '{"a":1}', 'session-json': 'x', bogus: 'y' }, filters });
      assert.deepEqual(calls[0][0].filters, filters, 'the given types only, no All files');
      assert.equal(fs.readFileSync(tempPath, 'utf8'), expected);
      assert.equal(result.format, suffix === '.json' ? 'json' : 'markdown');
      const logged = JSON.stringify(log.entries);
      assert.equal(logged.includes('# A') || logged.includes('"a":1'), false, 'no contents in the log');
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }
});

test('save-file handler with contents: derived filters, cancel writes nothing, protected roots still refuse', async () => {
  const { dialog, calls } = makeDialogStub({ canceled: true });
  const handler = buildSaveFileHandler({ dialog, getMainWindow: () => null, getProtectedRoots: () => [], log: makeLog() });
  const canceled = await handler({}, { defaultName: 'team.md', format: 'markdown', contents: { markdown: '# A', json: '{}' } });
  assert.deepEqual(canceled, { canceled: true, path: '', bytesWritten: 0 });
  assert.deepEqual(calls[0][0].filters, [FORMAT_FILTER_MAP.markdown[0], FORMAT_FILTER_MAP.json[0]]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-save-root-'));
  try {
    const target = path.join(root, 'team.json');
    const blocked = buildSaveFileHandler({ dialog: makeDialogStub({ filePath: target }).dialog, getMainWindow: () => null, getProtectedRoots: () => [root], log: makeLog() });
    await assert.rejects(blocked({}, { defaultName: 'team.md', format: 'markdown', contents: { markdown: '# A', json: '{}' } }));
    assert.equal(fs.existsSync(target), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  // A contents map without the named format is refused before the dialog: never an empty or wrong file.
  const tempPath = createTempPath('.md');
  const stub = makeDialogStub({ filePath: tempPath });
  const plain = buildSaveFileHandler({ dialog: stub.dialog, getMainWindow: () => null, getProtectedRoots: () => [], log: makeLog() });
  await assert.rejects(plain({}, { defaultName: 'x.md', format: 'markdown', content: '', contents: { json: '{}' } }), /No text was given/);
  await assert.rejects(plain({}, { defaultName: 'x.md', format: 'markdown', contents: 'not a map' }), /No text was given/);
  assert.deepEqual([stub.calls.length, fs.existsSync(tempPath)], [0, false]);
});

test('save-file handler: contents with anonymizePaths redact the picked text; a failed write leaves no file at the path', async () => {
  const tempPath = createTempPath('.md');
  const home = os.homedir();
  try {
    const handler = buildSaveFileHandler({ dialog: makeDialogStub({ filePath: tempPath }).dialog, getMainWindow: () => null, getProtectedRoots: () => [], log: makeLog() });
    await handler({}, { defaultName: 'x.md', format: 'markdown', anonymizePaths: true, contents: { markdown: 'see ' + path.join(home, 'secret.txt'), json: '{}' } });
    assert.equal(fs.readFileSync(tempPath, 'utf8').includes(home), false);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-save-dir-'));
  try {
    const target = path.join(dir, 'busy.md');
    fs.mkdirSync(target); // a directory where the file should go: the rename fails
    const handler = buildSaveFileHandler({ dialog: makeDialogStub({ filePath: target }).dialog, getMainWindow: () => null, getProtectedRoots: () => [], log: makeLog() });
    await assert.rejects(handler({}, { defaultName: 'x.md', format: 'markdown', content: 'x' }));
    assert.deepEqual(fs.readdirSync(dir), ['busy.md'], 'the temporary file is removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('save-file handler with a team export document builds only the picked format and refuses a malformed or oversized one', async () => {
  const format = require('../services/team-export-format');
  const doc = { kind: 'team-export', team: 'T', exportedBy: 'B', exportedAt: Date.UTC(2026, 10, 12), locale: 'en-GB',
    words: { edited: ' (edited)', facts: '{team} · exported {when} by {you} · {count} messages', deleted: 'Message deleted by {name}' },
    conversations: [{ name: '#team', kind: 'channel', messages: [{ id: 'm1', sender: 'Maya', sent_at: '2026-11-11T09:00:00.000Z', edited: false, text: 'hi', replies: [] }] }] };
  for (const [suffix, starts] of [['.json', '{'], ['.md', '# #team']]) {
    const tempPath = createTempPath(suffix);
    try {
      const handler = buildSaveFileHandler({ dialog: makeDialogStub({ filePath: tempPath }).dialog, getMainWindow: () => null, getProtectedRoots: () => [], log: makeLog() });
      const result = await handler({}, { defaultName: 'team.md', format: 'markdown', document: doc });
      assert.ok(fs.readFileSync(tempPath, 'utf8').startsWith(starts));
      assert.equal(result.format, suffix === '.json' ? 'json' : 'markdown');
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }
  const stub = makeDialogStub({ filePath: createTempPath('.md') });
  const handler = buildSaveFileHandler({ dialog: stub.dialog, getMainWindow: () => null, getProtectedRoots: () => [], log: makeLog() });
  await assert.rejects(handler({}, { format: 'markdown', document: { kind: 'other' } }), /not one this app writes/);
  const huge = { ...doc, conversations: [{ name: '#team', kind: 'channel', messages: [{ id: 'm', sender: 'x', sent_at: '', text: 'x'.repeat(format.MAX_TEXT_CHARS + 1), replies: [] }] }] };
  await assert.rejects(handler({}, { format: 'markdown', document: huge }), /not one this app writes/);
  assert.equal(stub.calls.length, 0, 'refused before the dialog');
});

// A picture chosen through the dialog (sketch export, slice S6): `encoding: 'base64'` marks the content as bytes.
test('save-file handler with encoding base64 writes the decoded bytes through the write-beside-and-rename path', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80]);
  const tempPath = createTempPath('.png');
  try {
    const stub = makeDialogStub({ filePath: tempPath });
    const log = makeLog();
    const handler = buildSaveFileHandler({ dialog: stub.dialog, getMainWindow: () => null, getProtectedRoots: () => [], log });
    const result = await handler({}, {
      defaultName: 'drawing.png', content: bytes.toString('base64'), encoding: 'base64', format: 'plain', filters: [{ name: 'PNG image', extensions: ['png'] }],
    });
    assert.equal(result.canceled, false);
    assert.equal(result.bytesWritten, bytes.length);
    assert.deepEqual(fs.readFileSync(tempPath), bytes);
    assert.deepEqual(fs.readdirSync(path.dirname(tempPath)).filter((name) => name.startsWith(path.basename(tempPath) + '.')), [], 'no temporary file is left');
    assert.deepEqual(stub.calls[0].at(-1).filters, [{ name: 'PNG image', extensions: ['png'] }, { name: 'All files', extensions: ['*'] }]);
    assert.ok(log.entries.some((entry) => entry.name === 'save_file.completed' && entry.payload.bytesWritten === bytes.length));
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
});

test('save-file handler refuses base64 content that is malformed, oversize or paired with anonymizePaths, before the dialog and with nothing written', async () => {
  const tempPath = createTempPath('.png');
  const stub = makeDialogStub({ filePath: tempPath });
  const log = makeLog();
  const handler = buildSaveFileHandler({ dialog: stub.dialog, getMainWindow: () => null, getProtectedRoots: () => [], log });
  const base = { defaultName: 'drawing.png', format: 'plain', encoding: 'base64' };
  const refused = [
    ['not base64!', /base64/],
    ['AAA=\n', /base64/],
    ['AA=A', /base64/],
    ['AAAA===', /base64/],
    ['', /base64/],
    [123, /base64/],
    ['A'.repeat(32 * 1024 * 1024 + 1), /too large/],
  ];
  for (const [content, message] of refused) {
    await assert.rejects(handler({}, { ...base, content }), message);
  }
  await assert.rejects(handler({}, { ...base, content: 'AAAA', anonymizePaths: true }), /cannot be combined/);
  await assert.rejects(handler({}, { ...base, content: 'AAAA', encoding: 'hex' }), /encoding/);
  await assert.rejects(handler({}, { ...base, content: 'AAAA', contents: { plain: 'x' } }), /cannot be combined/);
  assert.equal(stub.calls.length, 0, 'refused before the dialog');
  assert.equal(fs.existsSync(tempPath), false);
  assert.ok(log.entries.some((entry) => entry.name === 'save_file.invalid_encoding'));
});

test('save-file handler accepts base64 content of exactly 32 MiB', async () => {
  const tempPath = createTempPath('.png');
  try {
    const handler = buildSaveFileHandler({ dialog: makeDialogStub({ filePath: tempPath }).dialog, getMainWindow: () => null, getProtectedRoots: () => [], log: makeLog() });
    const result = await handler({}, { defaultName: 'big.png', format: 'plain', encoding: 'base64', content: 'A'.repeat(32 * 1024 * 1024) });
    assert.equal(result.bytesWritten, 24 * 1024 * 1024);
    assert.equal(fs.statSync(tempPath).size, 24 * 1024 * 1024);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
});

test('save-file handler without encoding still writes the content as UTF-8 text', async () => {
  const tempPath = createTempPath('.svg');
  try {
    const handler = buildSaveFileHandler({ dialog: makeDialogStub({ filePath: tempPath }).dialog, getMainWindow: () => null, getProtectedRoots: () => [], log: makeLog() });
    await handler({}, { defaultName: 'drawing.svg', content: 'QUJD', format: 'plain' });
    assert.equal(fs.readFileSync(tempPath, 'utf8'), 'QUJD');
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
});
