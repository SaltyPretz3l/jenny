'use strict';

// Row 91: /image arms the composer so the next message is drawn exactly as written,
// and Edit prompt on a generated image re-arms it from that image's provenance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

globalThis.inventoryChip = require('../renderer/inventory/chip');
const imagePrompt = require('../renderer/chat/renderer-image-prompt');
const { createSlashCommandRegistry } = require('../renderer/shell/renderer-slash-command-registry');
const { createSendSlashDispatch } = require('../renderer/chat/renderer-skill-slash-commands');
const artifactCards = require('../renderer/chat/renderer-artifact-card-utils');

test('the composer sizes are the sizes every image family offers', () => {
  const { families } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'sdcpp-families.json'), 'utf8'));
  for (const [name, family] of Object.entries(families)) {
    if (!Array.isArray(family.resolutions)) continue;
    for (const size of imagePrompt.SIZES) assert.ok(family.resolutions.includes(size), `${name} offers ${size}`);
  }
});

test('a pin keeps a supported size, a valid seed and an edit source, and nothing else', () => {
  assert.deepEqual(imagePrompt.normalizePin({}), { width: 1024, height: 1024 });
  assert.deepEqual(imagePrompt.normalizePin({ width: 1664, height: 928, seed: 7, steps: 50 }), { width: 1664, height: 928, seed: 7 });
  assert.equal(imagePrompt.normalizePin({ width: 640, height: 480 }), null);
  assert.equal(imagePrompt.normalizePin({ seed: -1 }), null);
  assert.equal(imagePrompt.normalizePin({ seed: 2 ** 33 }), null);
  assert.equal(imagePrompt.normalizePin({ source_artifact_id: '../x' }), null);
  assert.equal(imagePrompt.normalizePin([]), null);
  // An edit keeps its source size, so an edit pin carries none (a retry or restore must not add 1024 x 1024).
  assert.deepEqual(imagePrompt.normalizePin({ source_artifact_id: 'img-1', width: 1344, height: 1344, region: { kind: 'box' } }),
    { source_artifact_id: 'img-1' });
  assert.equal(imagePrompt.chipsHtml({ source_artifact_id: 'img-1' }).includes('image-prompt-size'), false);
});

test('arm, peek and clear are per chat and bounded', () => {
  const state = {};
  assert.equal(imagePrompt.arm(state, '', {}), null);
  assert.deepEqual(imagePrompt.arm(state, 's1', { seed: 3 }), { width: 1024, height: 1024, seed: 3 });
  const peeked = imagePrompt.peek(state, 's1');
  peeked.seed = 9;
  assert.equal(imagePrompt.peek(state, 's1').seed, 3, 'peek returns a copy');
  assert.equal(imagePrompt.peek(state, 's2'), null);
  for (let i = 0; i < 20; i += 1) imagePrompt.arm(state, `x${i}`, {});
  assert.equal(state.ui.imagePromptPins.size, 16);
  assert.equal(imagePrompt.peek(state, 's1'), null, 'the oldest chat is dropped first');
  assert.equal(imagePrompt.clear(state, 'x19'), true);
  assert.equal(imagePrompt.clear(state, 'x19'), false);
});

test('the command split and the send pin', () => {
  assert.equal(imagePrompt.splitCommand('/image'), '');
  assert.equal(imagePrompt.splitCommand('  /IMAGE  a red fox\nin snow '), 'a red fox\nin snow');
  assert.equal(imagePrompt.splitCommand('/images of foxes'), null);
  assert.equal(imagePrompt.splitCommand('draw /image fox'), null);
  assert.deepEqual(imagePrompt.sendPin({ width: 1664, height: 928, seed: 4 }, null), { width: 1664, height: 928, seed: 4 });
  // An attached edit selection keeps its source size: the armed size is dropped.
  const region = { kind: 'box', points: [[0, 0], [10, 10]] };
  assert.deepEqual(imagePrompt.sendPin({ width: 1664, height: 928, seed: 4 }, { artifactId: 'img-1', region }),
    { seed: 4, source_artifact_id: 'img-1', region });
  assert.equal(imagePrompt.sendPin(null, null), null);
});

test('the tray shows the image chip, the size and an optional seed; the chips edit the armed state', () => {
  const dom = new JSDOM('<!doctype html><div id="tray"></div>');
  const tray = dom.window.document.getElementById('tray');
  const state = {};
  assert.equal(imagePrompt.chipsHtml(null), '');
  imagePrompt.arm(state, 's1', { width: 928, height: 1664, seed: 12 });
  let renders = 0;
  const paint = () => {
    tray.innerHTML = imagePrompt.chipsHtml(imagePrompt.peek(state, 's1'));
    imagePrompt.bindChips(tray, { state, sessionId: 's1', rerender: () => { renders += 1; paint(); } });
  };
  paint();
  const chips = [...tray.querySelectorAll('[data-inv-chip]')].map((node) => node.dataset.invChip);
  assert.deepEqual(chips, ['image-prompt', 'image-prompt-size', 'image-prompt-seed']);
  assert.equal(tray.querySelector('[data-inv-chip="image-prompt-size"]').textContent.includes('928 × 1664'), true);
  tray.querySelector('[data-inv-chip="image-prompt-seed"]').click();
  assert.deepEqual(imagePrompt.peek(state, 's1'), { width: 928, height: 1664 });
  assert.equal(tray.querySelector('[data-inv-chip="image-prompt-seed"]'), null);
  tray.querySelector('[data-inv-chip="image-prompt"]').click();
  assert.equal(imagePrompt.peek(state, 's1'), null);
  assert.equal(tray.innerHTML, '');
  assert.equal(renders, 2);
});

function controllerHarness(value = '') {
  const dom = new JSDOM(`<!doctype html><textarea id="input">${value}</textarea>`);
  const input = dom.window.document.getElementById('input');
  const state = { messagesBySession: new Map() };
  const calls = { repaint: [], notices: [], syncs: 0 };
  const controller = imagePrompt.createController({
    state, getInput: (sessionId) => (sessionId === 's1' ? input : null),
    repaint: (sessionId) => calls.repaint.push(sessionId), syncInput: () => { calls.syncs += 1; },
    setNotice: (sessionId, text) => calls.notices.push([sessionId, text]),
  });
  return { input, state, calls, controller };
}

test('Edit prompt puts the prompt, size and seed back in that chat composer', () => {
  const h = controllerHarness('half-written note');
  assert.equal(h.controller.editPrompt({ sessionId: 's1', prompt: 'a red fox', width: 1472, height: 1120, seed: 5 }), true);
  assert.equal(h.input.value, 'a red fox');
  assert.deepEqual(imagePrompt.peek(h.state, 's1'), { width: 1472, height: 1120, seed: 5 });
  assert.deepEqual(h.calls.repaint, ['s1']);
  assert.equal(h.calls.syncs, 1);
  // An off-list size falls back to the default; a chat without a composer is refused.
  assert.equal(h.controller.editPrompt({ sessionId: 's1', prompt: 'fox', width: 512, height: 512 }), true);
  assert.deepEqual(imagePrompt.peek(h.state, 's1'), { width: 1024, height: 1024 });
  assert.equal(h.controller.editPrompt({ sessionId: 's2', prompt: 'fox' }), false);
  assert.equal(h.controller.editPrompt({ sessionId: 's1', prompt: '' }), false);
});

test('a /image turn that drew nothing puts the prompt back armed, once the composer is empty', () => {
  const h = controllerHarness();
  h.state.messagesBySession.set('s1', [
    { role: 'user', content: 'older', image_prompt_pin: { width: 1024, height: 1024 } },
    { role: 'user', content: 'a fox in snow', image_prompt_pin: { width: 1664, height: 928 } },
    { role: 'assistant', content: 'Sure.' },
  ]);
  assert.equal(h.controller.onTerminal({ kind: 'complete', payload: { sessionId: 's1' } }), false, 'unflagged turns are left alone');
  assert.equal(h.controller.onTerminal({ kind: 'error', payload: { sessionId: 's1', imagePromptUndrawn: true } }), false);
  assert.equal(h.controller.onTerminal({ kind: 'complete', payload: { sessionId: 's1', imagePromptUndrawn: true } }), true);
  assert.equal(h.input.value, 'a fox in snow');
  assert.deepEqual(imagePrompt.peek(h.state, 's1'), { width: 1664, height: 928 });
  assert.equal(h.calls.notices.length, 1);
  // Words typed since then are never replaced.
  h.input.value = 'something new';
  assert.equal(h.controller.onTerminal({ kind: 'complete', payload: { sessionId: 's1', imagePromptUndrawn: true } }), false);
  assert.equal(h.input.value, 'something new');
});

function dispatchHarness(features) {
  const state = { currentSessionId: 's1', ui: {}, composerSessionState: new Map(), ...(features ? { features } : {}) };
  const chatInput = { value: '', focus() {}, addEventListener() {}, removeEventListener() {} };
  let trayRenders = 0;
  const dispatch = createSendSlashDispatch({ state, registry: createSlashCommandRegistry({ state }), chatInput,
    renderAttachmentTray: () => { trayRenders += 1; } });
  return { state, chatInput, dispatch, trays: () => trayRenders };
}

test('"/image words" sends the words with the pin; bare "/image" only arms the chat', async () => {
  const h = dispatchHarness();
  const sent = await h.dispatch.dispatch('/image a red fox', { attachImageEditDraft: true });
  assert.equal(sent.handled, false);
  assert.equal(sent.prompt, 'a red fox');
  assert.deepEqual(sent.settings.imagePromptPin, { width: 1024, height: 1024 });
  // An accepted or queued send disarms the chat; the queued replay itself and an edit do not.
  assert.equal(h.dispatch.clearAcceptedImagePrompt({ streamId: 'x' }, sent.settings.imagePromptPin, 's1', { outboxDispatch: true }), false);
  assert.equal(h.dispatch.clearAcceptedImagePrompt({ streamId: 'x' }, sent.settings.imagePromptPin, 's1', { editedMessageId: 'u1' }), false);
  assert.equal(h.dispatch.clearAcceptedImagePrompt({ queued: true }, sent.settings.imagePromptPin, 's1', {}), true);
  imagePrompt.arm(h.state, 's1', {});
  assert.equal(h.dispatch.clearAcceptedImagePrompt({ streamId: 'x' }, sent.settings.imagePromptPin, 's1', {}), true);
  assert.equal(imagePrompt.peek(h.state, 's1'), null);

  const armed = await h.dispatch.dispatch('/image', { attachImageEditDraft: true });
  assert.equal(armed.handled, true);
  assert.deepEqual(imagePrompt.peek(h.state, 's1'), { width: 1024, height: 1024 });
  const next = await h.dispatch.dispatch('/help is not a command here', { attachImageEditDraft: true });
  assert.equal(next.handled, false, 'an armed chat sends its text as the prompt, slash and all');
  assert.ok(next.settings.imagePromptPin);
  assert.ok(h.trays() >= 2);
  h.dispatch.dispose();
});

test('with image generation off, "/image" is left to the command registry', async () => {
  const h = dispatchHarness({ featureFlags: { tools_image_generate_enabled: false } });
  const result = await h.dispatch.dispatch('/image a fox', { attachImageEditDraft: true });
  assert.equal(result.settings.imagePromptPin, undefined);
  assert.equal(imagePrompt.peek(h.state, 's1'), null);
  h.dispatch.dispose();
});

test('a generated image figure offers Edit prompt and says when the prompt was the user\'s', () => {
  const image = { artifact_id: 'img-1', artifact_kind: 'image', title: 'Fox', file_name: 'img-1.png',
    display_path: '.jenny/artifacts/s1/img-1.png', mime_type: 'image/png', width: 1664, height: 928,
    local_trusted: true, session_id: 's1' };
  artifactCards.resetArtifactImageLoaderForTests();
  const user = new JSDOM(artifactCards.renderArtifactCards([image], 'call-1',
    { seed: 7, prompt: 'a "red" fox', promptSource: 'user', sessionId: 's1' })).window.document;
  assert.equal(user.querySelector('.inv-artifact-figure-meta').textContent, '1664 × 928 · seed 7 · your prompt');
  const edit = user.querySelector('[data-image-edit-prompt]');
  assert.equal(edit.textContent, 'Edit prompt');
  assert.deepEqual({ ...edit.dataset }, { imageEditPrompt: '', sessionId: 's1', imagePrompt: 'a "red" fox',
    imageSeed: '7', imageWidth: '1664', imageHeight: '928' });

  artifactCards.resetArtifactImageLoaderForTests();
  const model = new JSDOM(artifactCards.renderArtifactCards([image], 'call-1',
    { seed: 7, prompt: 'a red fox', promptSource: 'model', sessionId: 's1' })).window.document;
  assert.equal(model.querySelector('.inv-artifact-figure-meta').textContent, '1664 × 928 · seed 7');
  assert.ok(model.querySelector('[data-image-edit-prompt]'), 'a model-written prompt can be edited too');

  artifactCards.resetArtifactImageLoaderForTests();
  const none = new JSDOM(artifactCards.renderArtifactCards([image], 'call-1', { seed: 7, sessionId: 's1' })).window.document;
  assert.equal(none.querySelector('[data-image-edit-prompt]'), null, 'no prompt, nothing to edit');
});
