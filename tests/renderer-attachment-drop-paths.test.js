const test = require('node:test');
const assert = require('node:assert/strict');

const { createAttachmentQueueController } = require('../renderer/features/renderer-attachment-queue-utils');

function createFileWithoutPath(resolvedPath) {
  const file = { name: 'dropped.txt' };
  // Electron 32+ removed File.path. A regression back to reading it must fail
  // loudly here, not silently return ''.
  Object.defineProperty(file, 'path', {
    get() {
      throw new Error('file.path must not be read: it no longer exists in Electron 40');
    },
  });
  file.__resolvedPath = resolvedPath;
  return file;
}

function createController(windowRef) {
  return createAttachmentQueueController({
    state: { attachments: { queued: [], dragDepth: 0 } },
    windowRef,
    constants: { TOAST_SOURCE: {} },
    callbacks: {},
  });
}

test('getDroppedFilePaths resolves dropped files through the preload webUtils bridge', () => {
  const controller = createController({
    jennyShell: {
      attachments: {
        getPathForFile: (file) => file.__resolvedPath || '',
      },
    },
  });

  const paths = controller.getDroppedFilePaths({
    dataTransfer: {
      files: [
        createFileWithoutPath('C:\\workspace\\one.txt'),
        createFileWithoutPath(''),
        createFileWithoutPath('C:\\workspace\\two.md'),
      ],
    },
  });

  assert.deepEqual(paths, ['C:\\workspace\\one.txt', 'C:\\workspace\\two.md']);
});

test('getDroppedFilePaths fails soft when the preload bridge is unavailable', () => {
  const controller = createController({ jennyShell: { attachments: {} } });

  const paths = controller.getDroppedFilePaths({
    dataTransfer: {
      files: [createFileWithoutPath('C:\\workspace\\one.txt')],
    },
  });

  assert.deepEqual(paths, []);
});

test('disposing an attachment queue releases a managed asset returned by an in-flight save', async () => {
  let resolveSave;
  const released = [];
  const state = { currentSessionId: 's1', attachments: { queued: [], dragDepth: 0 } };
  const controller = createAttachmentQueueController({
    state,
    windowRef: {
      jennyShell: {
        attachments: {
          saveImageAsset: () => new Promise((resolve) => { resolveSave = resolve; }),
          releaseAssets: async (paths) => { released.push(...paths); },
        },
      },
    },
    constants: { TOAST_SOURCE: {} },
    callbacks: {},
  });

  const token = controller.beginAttachmentToken();
  const pending = controller.queueInlineImageAttachment({ bytes: [1] }, token);
  controller.dispose();
  resolveSave({ id: 'late', assetPath: 'C:\\managed\\late.png' });
  await pending;

  assert.deepEqual(state.attachments.queued, []);
  assert.deepEqual(released, ['C:\\managed\\late.png']);
});

test('capacity overflow releases only the unique assets that never enter the queue', async () => {
  const released = [];
  const queued = Array.from({ length: 8 }, (_, index) => ({ id: `a${index}`, assetPath: `C:\\managed\\${index}.png` }));
  const controller = createAttachmentQueueController({
    state: { attachments: { queued, dragDepth: 0 } },
    windowRef: { jennyShell: { attachments: { releaseAssets: async (paths) => { released.push(...paths); } } } },
    constants: { TOAST_SOURCE: {} },
    callbacks: {},
  });

  controller.mergePreparedAttachments({
    accepted: [
      queued[0],
      { id: 'same-asset-alias', path: 'C:\\source\\alias.png', assetPath: queued[0].assetPath },
      { id: 'overflow', assetPath: 'C:\\managed\\overflow.png' },
    ],
    rejected: [{ displayName: 'bad.exe', reason: 'unsupported' }],
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(queued.length, 8);
  assert.deepEqual(released, ['C:\\managed\\overflow.png']);
});

test('duplicate prepared image and audio sources release their newly managed assets', async () => {
  const released = [];
  const queued = [
    { id: 'old-image', kind: 'image', path: 'C:\\source\\a.png', assetPath: 'C:\\managed\\old-a.png' },
    { id: 'old-audio', kind: 'audio', path: 'C:\\source\\b.wav', assetPath: 'C:\\managed\\old-b.wav' },
  ];
  const controller = createAttachmentQueueController({
    state: { attachments: { queued, dragDepth: 0 } },
    windowRef: { jennyShell: { attachments: { releaseAssets: async (paths) => { released.push(...paths); } } } },
    constants: { TOAST_SOURCE: {} },
    callbacks: {},
  });

  controller.mergePreparedAttachments({
    accepted: [
      { id: 'new-image', kind: 'image', path: 'C:\\source\\a.png', assetPath: 'C:\\managed\\new-a.png' },
      { id: 'new-audio', kind: 'audio', path: 'C:\\source\\b.wav', assetPath: 'C:\\managed\\new-b.wav' },
    ],
    rejected: [],
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(queued.map((entry) => entry.id), ['old-image', 'old-audio']);
  assert.deepEqual(released, ['C:\\managed\\new-a.png', 'C:\\managed\\new-b.wav']);
});

test('mixed attachment results retain every accepted item while preserving rejection isolation', () => {
  const state = { attachments: { queued: [], dragDepth: 0 } };
  const controller = createAttachmentQueueController({
    state,
    windowRef: { jennyShell: { attachments: {} } },
    constants: { TOAST_SOURCE: {} },
    callbacks: {},
  });
  controller.mergePreparedAttachments({
    accepted: [{ id: 'good-1' }, { id: 'good-2' }],
    rejected: [{ displayName: 'bad', reason: 'invalid' }],
  });
  assert.deepEqual(state.attachments.queued.map((entry) => entry.id), ['good-1', 'good-2']);
});

test('inline image routing logs an active attachment result', async () => {
  const logs = [];
  const controller = createAttachmentQueueController({ state: { attachments: { queued: [], dragDepth: 0 } }, windowRef: { jennyShell: { attachments: { saveImageAsset: async () => ({ id: 'img_1', assetPath: 'C:\\x\\img_1.png', kind: 'image', sizeBytes: 4 }) } } }, constants: { TOAST_SOURCE: {} }, callbacks: { appendClientLog: (level, event, fields) => logs.push({ level, event, fields }) } });
  const token = controller.beginAttachmentToken();
  await controller.queueInlineImageAttachment({ bytes: new Uint8Array([1, 2, 3, 4]), mimeType: 'image/png', displayName: 'a.png', sourceKind: 'clipboard' }, token);
  const routed = logs.find((entry) => entry.event === 'composer.attachment.routed');
  assert.equal(routed.fields.target, 'active');
  assert.equal(routed.fields.acceptedCount, 1);
});

test('inline image routing warns when the operation becomes stale', async () => {
  const logs = [];
  let resolveSave;
  const controller = createAttachmentQueueController({ state: { attachments: { queued: [], dragDepth: 0 } }, windowRef: { jennyShell: { attachments: { saveImageAsset: () => new Promise((resolve) => { resolveSave = resolve; }) } } }, constants: { TOAST_SOURCE: {} }, callbacks: { appendClientLog: (level, event, fields) => logs.push({ level, event, fields }) } });
  const token = controller.beginAttachmentToken();
  const pending = controller.queueInlineImageAttachment({ bytes: new Uint8Array([1]), mimeType: 'image/png' }, token);
  controller.cancelAttachmentToken(token);
  resolveSave({ id: 'img_1', assetPath: 'C:\\x\\img_1.png', kind: 'image', sizeBytes: 1 });
  await pending;
  const routed = logs.find((entry) => entry.event === 'composer.attachment.routed');
  assert.deepEqual([routed.level, routed.fields.routeReason], ['WARN', 'stale_operation']);
});
