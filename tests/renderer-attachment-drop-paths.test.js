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

test('dropped Files go to the preload prepareDroppedFiles bridge, not the root-checked prepare', async () => {
  const calls = [];
  const state = { currentSessionId: 's1', attachments: { queued: [], dragDepth: 0 } };
  const file = createFileWithoutPath('D:\\outside\\notes.txt');
  const controller = createAttachmentQueueController({
    state,
    windowRef: {
      jennyShell: {
        attachments: {
          prepare: async (...args) => { calls.push(['prepare', ...args]); return { accepted: [], rejected: [] }; },
          prepareDroppedFiles: async (...args) => {
            calls.push(['prepareDroppedFiles', ...args]);
            return { accepted: [{ id: 'notes', kind: 'text', path: 'D:\\outside\\notes.txt' }], rejected: [] };
          },
        },
      },
    },
    constants: { TOAST_SOURCE: {} },
    callbacks: {},
  });

  await controller.prepareDroppedAttachments([file], controller.beginAttachmentToken());

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'prepareDroppedFiles');
  assert.equal(calls[0][1][0], file);
  assert.deepEqual(calls[0][2], { session_id: 's1' });
  assert.deepEqual(state.attachments.queued.map((entry) => entry.id), ['notes']);
});

test('without the Files bridge a drop resolves paths and keeps the root-checked prepare', async () => {
  const calls = [];
  const controller = createAttachmentQueueController({
    state: { currentSessionId: 's1', attachments: { queued: [], dragDepth: 0 } },
    windowRef: {
      jennyShell: {
        attachments: {
          getPathForFile: (file) => file.__resolvedPath || '',
          prepare: async (paths) => { calls.push(paths); return { accepted: [], rejected: [] }; },
        },
      },
    },
    constants: { TOAST_SOURCE: {} },
    callbacks: {},
  });

  await controller.prepareDroppedAttachments([createFileWithoutPath('C:\\workspace\\one.txt'), createFileWithoutPath('')]);
  await controller.prepareDroppedAttachments(['C:\\workspace\\two.md']);
  await controller.prepareDroppedAttachments([createFileWithoutPath('')]);

  assert.deepEqual(calls, [['C:\\workspace\\one.txt'], ['C:\\workspace\\two.md']]);
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

// Row 153: the drop-state guard and the preparing placeholders.
function pendingRig(attachments = {}) {
  const renders = [];
  const state = { currentSessionId: 'session-a', attachments: { queued: [], dragDepth: 0 } };
  const controller = createAttachmentQueueController({
    state,
    windowRef: { jennyShell: { attachments } },
    constants: { TOAST_SOURCE: {} },
    callbacks: { renderAttachmentTray: () => renders.push((state.attachmentPending || []).map((entry) => entry.name)) },
  });
  return { state, controller, renders };
}

test('setDropActive renders only when the drop state changes', () => {
  const { controller, renders } = pendingRig();
  for (let index = 0; index < 10; index += 1) controller.setDropActive(true);
  assert.equal(renders.length, 1);
  controller.setDropActive(false);
  controller.setDropActive(false);
  assert.equal(renders.length, 2);
});

test('a drop lists placeholders until its result merges, then the items replace them', async () => {
  let resolvePrepare;
  const { state, controller, renders } = pendingRig({
    prepareDroppedFiles: () => new Promise((resolve) => { resolvePrepare = resolve; }),
  });
  const token = controller.beginAttachmentToken();
  const run = controller.prepareDroppedAttachments([{ name: 'shot.png', type: 'image/png' }, { name: 'notes.md', type: 'text/markdown' }], token);
  assert.deepEqual(state.attachmentPending.map((entry) => [entry.kind, entry.name, entry.sessionId]), [['image', 'shot.png', 'session-a'], ['file', 'notes.md', 'session-a']]);
  assert.deepEqual(renders.at(-1), ['shot.png', 'notes.md'], 'the placeholders rendered at once');
  resolvePrepare({ accepted: [{ id: 'a1', path: 'C:/w/shot.png', kind: 'image' }], rejected: [] });
  await run;
  assert.deepEqual(state.attachmentPending, []);
  assert.deepEqual(renders.at(-1), [], 'the merge render shows no placeholder');
  assert.deepEqual(state.attachments.queued.map((entry) => entry.id), ['a1']);
});

test('a failed paste clears its placeholder', async () => {
  const { state, controller, renders } = pendingRig({ saveImageAsset: () => Promise.reject(new Error('disk full')) });
  const token = controller.beginAttachmentToken();
  await assert.rejects(controller.queueInlineImageAttachment({ bytes: new Uint8Array(1), mimeType: 'image/png', displayName: 'Pasted Image.png' }, token), /disk full/);
  assert.deepEqual(state.attachmentPending, []);
  assert.deepEqual(renders, [['Pasted Image.png'], []]);
});

test('dispose drops the placeholders of its own ops only', () => {
  const { state, controller } = pendingRig({ prepareDroppedFiles: () => new Promise(() => {}) });
  state.attachmentPending = [{ operationId: 'other_op', sessionId: 'session-a', kind: 'file', name: 'kept.md' }];
  controller.prepareDroppedAttachments([{ name: 'gone.md', type: '' }], controller.beginAttachmentToken());
  assert.equal(state.attachmentPending.length, 2);
  controller.dispose();
  assert.deepEqual(state.attachmentPending.map((entry) => entry.name), ['kept.md']);
});

test('a dropped path string names its placeholder by the file name, Windows separators included', () => {
  const { state, controller } = pendingRig({ prepare: () => new Promise(() => {}) });
  controller.prepareDroppedAttachments(['C:\\workspace\\shots\\screen.PNG', '/home/me/notes.md'], controller.beginAttachmentToken());
  assert.deepEqual(state.attachmentPending.map((entry) => [entry.kind, entry.name]), [['image', 'screen.PNG'], ['file', 'notes.md']]);
});

function pictureController(overrides = {}) {
  const saved = [];
  const state = { attachments: { queued: [], dragDepth: 0 }, sessions: [], currentSessionId: '', runtimeDraft: {}, ...overrides.state };
  const windowRef = { jennyShell: { attachments: { saveImageAsset: overrides.save || (async (payload) => { saved.push(payload); return { id: `img_${saved.length}`, assetPath: `C:/x/img_${saved.length}.png`, kind: 'image', sizeBytes: 8 }; }) } } };
  const controller = createAttachmentQueueController({ state, windowRef, constants: { TOAST_SOURCE: {} }, callbacks: {} });
  return { controller, state, windowRef, saved };
}

test('attachPicture queues an app-made picture through the inline image path and is reachable as a window object', async () => {
  const { controller, state, windowRef, saved } = pictureController();
  assert.equal(typeof windowRef.rendererComposerPictures.attachPicture, 'function');
  const result = await windowRef.rendererComposerPictures.attachPicture({ bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png', displayName: 'marked-up-drawing.png' });
  assert.deepEqual(result, { ok: true });
  assert.equal(saved[0].displayName, 'marked-up-drawing.png');
  assert.equal(saved[0].sourceKind, 'capture');
  assert.deepEqual(state.attachments.queued.map((entry) => entry.id), ['img_1']);
  controller.dispose();
  assert.equal(windowRef.rendererComposerPictures, null, 'dispose takes the object away');
});

test('attachPicture refuses a fifth picture and a ninth attachment, and names a too-large or failed save', async () => {
  const images = (count) => Array.from({ length: count }, (_, index) => ({ id: `i${index}`, kind: 'image' }));
  assert.deepEqual(await pictureController({ state: { attachments: { queued: images(4), dragDepth: 0 } } }).controller.attachPicture({ bytes: new Uint8Array([1]) }), { ok: false, reason: 'too_many' });
  const files = Array.from({ length: 8 }, (_, index) => ({ id: `f${index}`, kind: 'file' }));
  assert.deepEqual(await pictureController({ state: { attachments: { queued: files, dragDepth: 0 } } }).controller.attachPicture({ bytes: new Uint8Array([1]) }), { ok: false, reason: 'too_many' });
  const large = pictureController({ save: async () => { throw new Error('Image buffer exceeds the 10000000 byte limit (received 10000001 bytes).'); } });
  assert.deepEqual(await large.controller.attachPicture({ bytes: new Uint8Array([1]) }), { ok: false, reason: 'too_large' });
  const broken = pictureController({ save: async () => { throw new Error('disk full'); } });
  assert.deepEqual(await broken.controller.attachPicture({ bytes: new Uint8Array([1]) }), { ok: false, reason: 'failed' });
});

test('resolveActiveVision reads the vision gate for the active session\'s model', () => {
  const previous = globalThis.rendererComposerVisionGate;
  globalThis.rendererComposerVisionGate = require('../renderer/chat/renderer-composer-vision-gate');
  try {
    const modelList = { data: [{ id: 'text-only', capabilities: { vision: false } }, { id: 'seer', capabilities: { vision: true } }] };
    const { controller } = pictureController({ state: { sessions: [{ id: 's1', preferred_model: 'text-only' }], currentSessionId: 's1', modelList, status: { model: 'other' } } });
    assert.deepEqual(controller.resolveActiveVision(), { supported: false, source: 'catalog', modelLabel: 'text-only' });
    const draft = pictureController({ state: { runtimeDraft: { preferredModel: 'seer' }, modelList, status: { model: 'other' } } });
    assert.equal(draft.controller.resolveActiveVision().supported, true);
    assert.equal(pictureController().controller.resolveActiveVision().supported, null);
  } finally {
    globalThis.rendererComposerVisionGate = previous;
  }
});
