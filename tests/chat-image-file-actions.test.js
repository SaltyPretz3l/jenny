'use strict';

// Copy / Save as / Show in folder for chat images that are not artifacts
// (user-attached images and tool-output images). The renderer names an image
// by session + { kind, id } only; the main process resolves it from the
// persisted session through the managed asset store and never returns a path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AttachmentAssetStore } = require('../services/attachment-asset-store');
const { createJennyShellBridge } = require('../services/ipc-contract');
const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');
const { createChatImageFileActions } = require('../services/chat-image-file-actions');

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]);

function makeEnv(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-chat-image-actions-'));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));
  const store = new AttachmentAssetStore({ rootDir: path.join(rootDir, 'assets'), nativeImage: null });
  const userImage = store.saveImageBufferSync(PNG_BYTES, { displayName: 'holiday.png' });
  const toolImage = store.saveImageBufferSync(JPEG_BYTES, { displayName: 'python-chart' });
  const outsidePath = path.join(rootDir, 'outside.png');
  fs.writeFileSync(outsidePath, PNG_BYTES);
  const messages = [
    {
      role: 'user',
      content: 'look',
      attachments: [
        {
          id: userImage.id, kind: 'image', displayName: '..\\..\\holiday:photo.png',
          mimeType: 'image/png', assetPath: userImage.assetPath,
        },
        { id: 'image_outside', kind: 'image', displayName: 'x.png', mimeType: 'image/png', assetPath: outsidePath },
        { id: 'text_notes', kind: 'text', displayName: 'notes.txt', mimeType: 'text/plain', assetPath: userImage.assetPath },
        { id: 'image_noname', kind: 'image', mimeType: 'image/png', assetPath: userImage.assetPath },
      ],
    },
    {
      role: 'tool',
      kind: 'tool_result',
      tool_result: {
        trusted_attachment_refs: [
          { id: 'image_tool_chart', kind: 'chart', mime_type: 'image/jpeg', asset_path: toolImage.assetPath },
        ],
      },
    },
  ];
  const service = {
    attachmentAssetStore: store,
    sessionStore: { peekSessionMessages: (sessionId) => (sessionId === 'session-a' ? messages : []) },
  };
  return {
    rootDir, store, service, userImage, toolImage, outsidePath,
    userPath: fs.realpathSync(userImage.assetPath),
    toolPath: fs.realpathSync(toolImage.assetPath),
  };
}

function makeActions(env, overrides = {}) {
  const calls = [];
  const image = { isEmpty: () => false };
  const dependencies = {
    service: env.service,
    dialog: {
      async showSaveDialog(...args) {
        calls.push(['dialog', ...args]);
        return { canceled: false, filePath: path.join(env.rootDir, 'saved-copy') };
      },
    },
    clipboard: { writeImage: (value) => calls.push(['clipboard', value]) },
    nativeImage: {
      createFromPath(filePath) {
        calls.push(['image', filePath]);
        return image;
      },
    },
    shell: { showItemInFolder: (filePath) => calls.push(['reveal', filePath]) },
    fs,
    ...overrides,
  };
  return { actions: createChatImageFileActions(dependencies), calls, image };
}

function assertNoPath(result, ...paths) {
  const serialized = JSON.stringify(result);
  for (const filePath of paths) {
    assert.equal(serialized.includes(filePath), false, `result leaked ${filePath}`);
    assert.equal(serialized.includes(JSON.stringify(filePath).slice(1, -1)), false, `result leaked ${filePath}`);
  }
}

test('invalid requests are refused before any lookup', async (t) => {
  const env = makeEnv(t);
  const { actions, calls } = makeActions(env);
  const invalid = [
    ['', { kind: 'attachment', id: env.userImage.id }],
    [undefined, { kind: 'attachment', id: env.userImage.id }],
    ['s'.repeat(129), { kind: 'attachment', id: env.userImage.id }],
    ['session-a', { kind: 'artifact', id: env.userImage.id }],
    ['session-a', { kind: 'attachment', id: '' }],
    ['session-a', { kind: 'attachment', id: 'x'.repeat(257) }],
    ['session-a', { kind: 'tool', id: 42 }],
    ['session-a', null],
    ['session-a', env.userPath],
  ];
  for (const [sessionId, ref] of invalid) {
    for (const action of ['copyImage', 'saveAs', 'reveal']) {
      assert.deepEqual(await actions[action](sessionId, ref), { ok: false, reason: 'invalid_request' });
    }
  }
  assert.deepEqual(calls, []);
});

test('unknown, out-of-store and non-image refs are all image_unavailable', async (t) => {
  const env = makeEnv(t);
  const { actions, calls } = makeActions(env);
  const unavailable = [
    ['session-a', { kind: 'attachment', id: 'image_missing' }],
    ['session-a', { kind: 'tool', id: 'image_missing' }],
    ['session-b', { kind: 'attachment', id: env.userImage.id }],
    ['session-b', { kind: 'tool', id: 'image_tool_chart' }],
    // A tool id is not an attachment id and vice versa.
    ['session-a', { kind: 'attachment', id: 'image_tool_chart' }],
    ['session-a', { kind: 'tool', id: env.userImage.id }],
    ['session-a', { kind: 'attachment', id: 'image_outside' }],
    ['session-a', { kind: 'attachment', id: 'text_notes' }],
  ];
  for (const [sessionId, ref] of unavailable) {
    for (const action of ['copyImage', 'saveAs', 'reveal']) {
      const result = await actions[action](sessionId, ref);
      assert.deepEqual(result, { ok: false, reason: 'image_unavailable' }, `${action} ${ref.kind}:${ref.id}`);
    }
  }
  assert.deepEqual(calls, []);
});

test('a tool ref resolves through the persisted session and copyImage writes the image', async (t) => {
  const env = makeEnv(t);
  const { actions, calls, image } = makeActions(env);
  const result = await actions.copyImage('session-a', { kind: 'tool', id: 'image_tool_chart' });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [['image', env.toolPath], ['clipboard', image]]);
});

test('copyImage reports an unreadable image without touching the clipboard', async (t) => {
  const env = makeEnv(t);
  const { actions, calls } = makeActions(env, {
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  });
  const result = await actions.copyImage('session-a', { kind: 'attachment', id: env.userImage.id });
  assert.deepEqual(result, { ok: false, reason: 'image_unreadable' });
  assert.deepEqual(calls, []);
});

test('an attachment ref saves its bytes under the sanitised display name', async (t) => {
  const env = makeEnv(t);
  const destination = path.join(env.rootDir, 'chosen.png');
  const win = { isDestroyed: () => false };
  const { actions, calls } = makeActions(env, {
    getMainWindow: () => win,
    dialog: {
      async showSaveDialog(...args) {
        calls.push(['dialog', ...args]);
        return { canceled: false, filePath: destination };
      },
    },
  });
  const result = await actions.saveAs('session-a', { kind: 'attachment', id: env.userImage.id });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(fs.readFileSync(destination), PNG_BYTES);
  assert.deepEqual(calls, [['dialog', win, {
    defaultPath: 'holiday_photo.png',
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  }]]);
});

test('saveAs falls back to image-<id>.<ext> and uses the dialog without a dead window', async (t) => {
  const env = makeEnv(t);
  const { actions, calls } = makeActions(env, { getMainWindow: () => ({ isDestroyed: () => true }) });
  assert.deepEqual(await actions.saveAs('session-a', { kind: 'tool', id: 'image_tool_chart' }), { ok: true });
  assert.deepEqual(calls[0], ['dialog', {
    defaultPath: 'image-image_tool_chart.jpg',
    filters: [{ name: 'File', extensions: ['jpg'] }],
  }]);
  assert.deepEqual(fs.readFileSync(path.join(env.rootDir, 'saved-copy')), JPEG_BYTES);

  calls.length = 0;
  assert.deepEqual(await actions.saveAs('session-a', { kind: 'attachment', id: 'image_noname' }), { ok: true });
  assert.equal(calls[0][1].defaultPath, 'image-image_noname.png');
});

test('saveAs cancel and copy failure return no path', async (t) => {
  const env = makeEnv(t);
  const canceled = makeActions(env, { dialog: { showSaveDialog: async () => ({ canceled: true }) } });
  assert.deepEqual(
    await canceled.actions.saveAs('session-a', { kind: 'attachment', id: env.userImage.id }),
    { ok: false, canceled: true },
  );
  const failing = makeActions(env, {
    fs: {
      promises: {
        copyFile: async (source, destination) => {
          throw new Error(`EACCES: permission denied, copyfile '${source}' -> '${destination}'`);
        },
      },
    },
  });
  const result = await failing.actions.saveAs('session-a', { kind: 'attachment', id: env.userImage.id });
  assert.deepEqual(result, { ok: false, reason: 'copy_failed' });
  assertNoPath(result, env.userPath, env.userImage.assetPath, env.rootDir);
});

test('saveAs refuses an asset that left the managed store while the dialog was open', async (t) => {
  const env = makeEnv(t);
  const destination = path.join(env.rootDir, 'late.png');
  const { actions } = makeActions(env, {
    dialog: {
      async showSaveDialog() {
        fs.rmSync(env.userPath);
        return { canceled: false, filePath: destination };
      },
    },
  });
  const result = await actions.saveAs('session-a', { kind: 'attachment', id: env.userImage.id });
  assert.deepEqual(result, { ok: false, reason: 'image_unavailable' });
  assert.equal(fs.existsSync(destination), false);
});

test('reveal shows the managed real path in its folder', async (t) => {
  const env = makeEnv(t);
  const { actions, calls } = makeActions(env);
  assert.deepEqual(await actions.reveal('session-a', { kind: 'attachment', id: env.userImage.id }), { ok: true });
  assert.deepEqual(await actions.reveal('session-a', { kind: 'tool', id: 'image_tool_chart' }), { ok: true });
  assert.deepEqual(calls, [['reveal', env.userPath], ['reveal', env.toolPath]]);
});

test('no result ever contains an asset path', async (t) => {
  const env = makeEnv(t);
  const { actions } = makeActions(env);
  const refs = [
    { kind: 'attachment', id: env.userImage.id },
    { kind: 'attachment', id: 'image_outside' },
    { kind: 'attachment', id: 'text_notes' },
    { kind: 'tool', id: 'image_tool_chart' },
    { kind: 'tool', id: 'image_missing' },
  ];
  for (const ref of refs) {
    for (const action of ['copyImage', 'saveAs', 'reveal']) {
      assertNoPath(await actions[action]('session-a', ref),
        env.userPath, env.toolPath, env.userImage.assetPath, env.toolImage.assetPath, env.outsidePath, env.rootDir);
    }
  }
});

test('the preload chatImages bridge reaches the registered main handlers with IDs only', async (t) => {
  const env = makeEnv(t);
  const handlers = new Map();
  const calls = [];
  const image = { isEmpty: () => false };
  registerAuxiliaryIpcHandlers({
    ipcMainLike: { handle: (channel, handler) => handlers.set(channel, handler) },
    backendService: { chatgptAuthService: {}, ...env.service },
    artifactService: {},
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    clipboard: { writeImage: (value) => calls.push(['clipboard', value]) },
    nativeImage: { createFromPath: () => image },
    shell: { showItemInFolder: (filePath) => calls.push(['reveal', filePath]) },
  });
  const bridge = createJennyShellBridge({
    ipcRenderer: {
      invoke(channel, ...args) {
        calls.push(['invoke', channel, ...args]);
        return handlers.get(channel)({}, ...args);
      },
    },
  });
  const ref = { kind: 'attachment', id: env.userImage.id };
  assert.deepEqual(await bridge.chatImages.copyImage('session-a', ref), { ok: true });
  assert.deepEqual(await bridge.chatImages.saveAs('session-a', ref), { ok: false, canceled: true });
  assert.deepEqual(await bridge.chatImages.reveal('session-a', ref), { ok: true });
  assert.deepEqual(calls, [
    ['invoke', 'chat-images:copy-image', 'session-a', ref],
    ['clipboard', image],
    ['invoke', 'chat-images:save-as', 'session-a', ref],
    ['invoke', 'chat-images:reveal', 'session-a', ref],
    ['reveal', env.userPath],
  ]);
});
