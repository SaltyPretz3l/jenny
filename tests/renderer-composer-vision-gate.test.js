'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_IMAGE_ATTACHMENTS,
  HEURISTIC_VISION_SOURCES,
  resolveActiveModelVision,
  evaluateComposerVisionGate,
  syncComposerVisionGate,
} = require('../renderer/chat/renderer-composer-vision-gate');
const { createAttachmentQueueController } = require('../renderer/features/renderer-attachment-queue-utils');

function stateWithImages(count, status = {}) {
  return {
    attachments: { queued: Array.from({ length: count }, (_, index) => ({ id: `image-${index}`, kind: 'image' })) },
    modelList: { data: [] },
    status,
    ui: {},
  };
}

test('resolveActiveModelVision resolves status, heuristic, catalog, unknown, and malformed inputs', async (t) => {
  await t.test('status evidence reports unsupported vision', () => {
    assert.deepEqual(resolveActiveModelVision({
      status: { model: 'Qwen', local_runtime: { capabilities: { vision: { available: false, source: 'unsupported' } } } },
    }, {}), { supported: false, source: 'unsupported', modelLabel: 'Qwen' });
  });

  await t.test('status evidence reports supported vision', () => {
    assert.deepEqual(resolveActiveModelVision({
      status: { model: 'Gemma', local_runtime: { capabilities: { vision: { available: true, source: 'runtime' } } } },
    }, {}), { supported: true, source: 'runtime', modelLabel: 'Gemma' });
  });

  await t.test('model-name evidence remains identifiable as heuristic', () => {
    const vision = resolveActiveModelVision({
      status: { model: 'MaybeVision', local_runtime: { capabilities: { vision: { available: false, source: 'model_name' } } } },
    }, {});
    assert.deepEqual(vision, { supported: false, source: 'model_name', modelLabel: 'MaybeVision' });
    assert.equal(HEURISTIC_VISION_SOURCES.has(vision.source), true);
  });

  await t.test('session override resolves a catalog id case-insensitively', () => {
    assert.deepEqual(resolveActiveModelVision({
      status: { model: 'backend-default' },
      modelList: { data: [{ id: 'Vision-Model', capabilities: { vision: true } }] },
    }, { preferredModel: 'vision-model' }), {
      supported: true,
      source: 'catalog',
      modelLabel: 'vision-model',
    });
  });

  await t.test('missing catalog override is unknown', () => {
    assert.deepEqual(resolveActiveModelVision({
      status: { model: 'backend-default' },
      modelList: { data: [] },
    }, { preferredModel: 'missing-model' }), {
      supported: null,
      source: 'unknown',
      modelLabel: 'missing-model',
    });
  });

  await t.test('malformed state fails open as unknown', () => {
    assert.deepEqual(resolveActiveModelVision(null, null), {
      supported: null,
      source: 'unknown',
      modelLabel: 'The active model',
    });
    assert.deepEqual(resolveActiveModelVision({ status: { local_runtime: 'x' } }, {}), {
      supported: null,
      source: 'unknown',
      modelLabel: 'The active model',
    });
    assert.equal(evaluateComposerVisionGate({ state: null }).blocked, false);
    assert.equal(evaluateComposerVisionGate({
      state: { attachments: { queued: [{ kind: 'image' }] }, status: { local_runtime: 'x' } },
    }).blocked, false);
  });
});

test('evaluateComposerVisionGate applies capability and image-cap precedence with approved copy', async (t) => {
  await t.test('zero images has no notice or gate', () => {
    const gate = evaluateComposerVisionGate({ state: stateWithImages(0, { model: 'Qwen' }) });
    assert.deepEqual({ blocked: gate.blocked, notice: gate.notice, tone: gate.tone, sendReason: gate.sendReason, imageCount: gate.imageCount }, {
      blocked: false, notice: '', tone: '', sendReason: '', imageCount: 0,
    });
  });

  await t.test('evidence-backed unsupported vision blocks', () => {
    const gate = evaluateComposerVisionGate({ state: stateWithImages(1, {
      model: 'Qwen',
      local_runtime: { capabilities: { vision: { available: false, source: 'unsupported' } } },
    }) });
    assert.equal(gate.blocked, true);
    assert.equal(gate.notice, "Qwen can't see images. Switch to a vision model or remove the image.");
    assert.equal(gate.tone, 'warning');
    assert.equal(gate.sendReason, 'Remove the image or choose a vision model to send.');
  });

  await t.test('heuristic unsupported vision warns without blocking', () => {
    const gate = evaluateComposerVisionGate({ state: stateWithImages(1, {
      model: 'MaybeVision',
      local_runtime: { capabilities: { vision: { available: false, source: 'model_name' } } },
    }) });
    assert.equal(gate.blocked, false);
    assert.equal(gate.notice, 'MaybeVision may not support images. If the reply fails, switch to a vision model.');
    assert.equal(gate.tone, 'warning');
    assert.equal(gate.sendReason, '');
  });

  await t.test('five images blocks before capability evaluation', () => {
    const gate = evaluateComposerVisionGate({ state: stateWithImages(5, {
      model: 'Vision',
      local_runtime: { capabilities: { vision: { available: true, source: 'runtime' } } },
    }) });
    assert.equal(gate.notice, 'Up to 4 images per message. Remove 1 to send.');
    assert.equal(gate.sendReason, 'Remove 1 image to send.');
    assert.equal(gate.blocked, true);
  });

  await t.test('six images pluralizes the disabled reason', () => {
    const gate = evaluateComposerVisionGate({ state: stateWithImages(6) });
    assert.equal(gate.notice, 'Up to 4 images per message. Remove 2 to send.');
    assert.equal(gate.sendReason, 'Remove 2 images to send.');
  });
});

test('syncComposerVisionGate applies send state and owner-scoped notices', () => {
  const calls = { reasons: [], notices: [], clears: [] };
  const sendButton = {
    disabled: false,
    removeAttribute(name) { delete this[name]; },
  };
  const reasonNode = {};
  const state = stateWithImages(1, {
    model: 'Qwen',
    local_runtime: { capabilities: { vision: { available: false, source: 'unsupported' } } },
  });
  const callbacks = {
    sendButton,
    reasonNode,
    syncDisabledReason: (...args) => calls.reasons.push(args),
    setComposerStatusNotice: (...args) => calls.notices.push(args),
    clearComposerStatusNotice: (...args) => calls.clears.push(args),
  };

  syncComposerVisionGate({ state, ...callbacks });
  assert.equal(sendButton.disabled, true);
  assert.equal(sendButton.title, 'Remove the image or choose a vision model to send.');
  assert.deepEqual(calls.reasons.at(-1), [sendButton, reasonNode, 'Remove the image or choose a vision model to send.']);
  assert.deepEqual(calls.notices.at(-1), [
    "Qwen can't see images. Switch to a vision model or remove the image.",
    { owner: 'attachments.vision', tone: 'warning', at: 0 },
  ]);

  state.ui.composerStatusNoticeOwner = 'attachments.vision';
  syncComposerVisionGate({ state, ...callbacks });
  assert.equal(calls.notices.length, 2);
  state.ui.composerStatusNotice = 'Working';
  state.ui.composerStatusNoticeOwner = 'another-owner';
  state.ui.composerStatusNoticeAt = 5;
  syncComposerVisionGate({ state, ...callbacks });
  assert.equal(calls.notices.length, 2);
  assert.equal(state.ui.composerStatusNotice, 'Working');
  assert.equal(state.ui.composerStatusNoticeAt, 5);

  state.attachments.queued = [];
  syncComposerVisionGate({ state, ...callbacks });
  assert.equal(Object.hasOwn(sendButton, 'title'), false);
  assert.deepEqual(calls.clears.at(-1), [{ owner: 'attachments.vision' }]);
});

test('attachment queue mutations re-render composer state after the tray', () => {
  assert.equal(MAX_IMAGE_ATTACHMENTS, 4);
  const calls = [];
  const state = { attachments: { queued: [] } };
  const controller = createAttachmentQueueController({
    state,
    windowRef: {},
    callbacks: {
      renderAttachmentTray: () => calls.push('tray'),
      renderComposerState: () => calls.push('composer'),
    },
  });

  controller.mergePreparedAttachments({
    accepted: [{ id: 'a', kind: 'image', assetPath: 'C:\\x\\a.png' }],
  });
  controller.removeQueuedAttachment('a');
  controller.resetAttachmentQueue();

  assert.deepEqual(calls, [
    'tray', 'composer',
    'tray', 'composer',
    'tray', 'composer',
  ]);
});

test('resolveActiveModelVision fails open while no model is resolved or loaded', async (t) => {
  await t.test('empty backend model with an unsupported capability entry is unknown, not a block', () => {
    // Live-app repro (2026-09-01): fresh profile, "Using backend default", nothing loaded yet —
    // the runtime reports vision {available:false, source:'unsupported'} for the absent model.
    const state = stateWithImages(1, {
      model: '',
      local_runtime: { model: { id: null, loaded: false }, capabilities: { vision: { available: false, source: 'unsupported' } } },
    });
    assert.deepEqual(resolveActiveModelVision(state, {}), { supported: null, source: 'unknown', modelLabel: 'The active model' });
    assert.equal(evaluateComposerVisionGate({ state, runtimePreferences: {} }).blocked, false);
  });

  await t.test('a named but not-yet-loaded model is unknown', () => {
    const state = stateWithImages(1, {
      model: 'gemma4-vision:12b',
      local_runtime: { model: { id: 'gemma4-vision:12b', loaded: false }, capabilities: { vision: { available: false, source: 'unsupported' } } },
    });
    assert.equal(resolveActiveModelVision(state, {}).supported, null);
    assert.equal(evaluateComposerVisionGate({ state, runtimePreferences: {} }).notice, '');
  });

  await t.test('a loaded model with an unsupported entry still blocks', () => {
    const state = stateWithImages(1, {
      model: 'text-only',
      local_runtime: { model: { id: 'text-only', loaded: true }, capabilities: { vision: { available: false, source: 'unsupported' } } },
    });
    assert.equal(evaluateComposerVisionGate({ state, runtimePreferences: {} }).blocked, true);
  });
});

test('a session-override catalog row with capabilities but no vision flag warns softly', () => {
  // Live catalog shape (Ollama): vision is stamped only when true; gpt-oss:20b carries
  // capabilities {thinking, reasoning_effort} and no vision key.
  const state = stateWithImages(1, { model: '' });
  state.modelList.data = [{ id: 'gpt-oss:20b', engine_type: 'ollama', capabilities: { thinking: true } }];
  const vision = resolveActiveModelVision(state, { preferredModel: 'gpt-oss:20b' });
  assert.deepEqual(vision, { supported: false, source: 'catalog_absent', modelLabel: 'gpt-oss:20b' });
  const gate = evaluateComposerVisionGate({ state, runtimePreferences: { preferredModel: 'gpt-oss:20b' } });
  assert.equal(gate.blocked, false);
  assert.equal(gate.notice, 'gpt-oss:20b may not support images. If the reply fails, switch to a vision model.');
  // A row with no capabilities object at all stays unknown.
  state.modelList.data = [{ id: 'ornith:9b', engine_type: 'ollama', capabilities: null }];
  assert.equal(resolveActiveModelVision(state, { preferredModel: 'ornith:9b' }).source, 'unknown');
});
