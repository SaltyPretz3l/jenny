'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness({ delayed = false, state } = {}) {
  const cleanups = [];
  const calls = [];
  const overlay = { dispose: () => calls.push('overlay-disposed') };
  let options;
  let draftOptions;
  const primaryInput = { pane: 0 };
  const secondaryInput = { pane: 1 };
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const window = {
    document: { getElementById: () => null },
    rendererOverlayManagerUtils: { createOverlayManager: () => overlay },
    inventoryImageViewer: {},
    rendererSessionImageList: require('../renderer/chat/renderer-session-image-list'),
    rendererTranscriptAttachmentsUtils: require('../renderer/chat/renderer-transcript-attachments'),
    rendererImageEditDraft: { createController: value => { draftOptions = value; return { dispose() {} }; } },
    rendererImageViewer: delayed ? null : { createImageViewer },
    scriptLoaderUtils: { ensureScript: async () => { await ready; window.rendererImageViewer = { createImageViewer }; return true; } },
    jennyShell: { artifacts: {
      read: (...args) => calls.push(['read', ...args]),
      capabilities: () => ({ openWith: true }),
      copyImage: (...args) => calls.push(['copy', ...args]),
    }, chatImages: {
      copyImage: (...args) => calls.push(['chat-copy', ...args]),
      saveAs: (...args) => calls.push(['chat-save-as', ...args]),
      reveal: (...args) => calls.push(['chat-reveal', ...args]),
    }, clipboard: { writeText: (...args) => calls.push(['clipboard', ...args]) } },
  };
  function createImageViewer(deps) {
    options = deps;
    calls.push('created');
    return {
      open: (target) => calls.push(['open', target]),
      close: () => calls.push('closed'),
      dispose: () => calls.push('disposed'),
    };
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/app/renderer-app-image-viewer-binding.js'), 'utf8'), { window });
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/app/renderer-app-shell-bindings-overlay-manager.js'), 'utf8'), { window });
  window.rendererAppShellBindingsOverlayManager.bindOverlayManager({
    documentRef: window.document, dom: { chatInput: primaryInput }, state,
    getPaneComposition: () => ({ getPaneCount: () => 2, getPaneSessionId: id => 'session-' + id,
      getPane: id => ({ dom: { chatInput: id === 0 ? primaryInput : secondaryInput } }) }),
    controllers: {}, callbacks: { registerCleanup: (fn) => cleanups.push(fn), showToastMessage: (message, opts) => calls.push(['toast', message, opts.tone]) },
  });
  return { window, calls, cleanups, release, getOptions: () => options,
    getDraftOptions: () => draftOptions, primaryInput, secondaryInput };
}

test('image viewer launcher reuses the controller and actions keep session/artifact identity', async () => {
  const h = harness();
  const launcher = h.window.rendererImageViewerController;
  await launcher.open({ sessionId: 's1', artifactId: 'a1' });
  await launcher.open({ sessionId: 's2', artifactId: 'a2' });
  assert.equal(h.calls.filter((entry) => entry === 'created').length, 1);
  const options = h.getOptions();
  options.readArtifact('s1', 'a1');
  options.onAction('copy', { sessionId: 's1', artifactId: 'a1', path: 'untrusted' });
  assert.deepEqual(h.calls.slice(-2), [['read', 's1', 'a1'], ['copy', 's1', 'a1']]);
  assert.equal(options.getCapabilities().openWith, true);
  for (const cleanup of h.cleanups.reverse()) cleanup();
  assert.equal(h.window.rendererImageViewerController, null);
  assert.ok(h.calls.includes('disposed'));
});

test('disposing while lazy scripts load never creates or opens the viewer', async () => {
  const h = harness({ delayed: true });
  const launcher = h.window.rendererImageViewerController;
  const pending = launcher.open({ sessionId: 's', artifactId: 'a' });
  for (const cleanup of h.cleanups.reverse()) cleanup();
  h.release();
  await pending;
  assert.deepEqual(h.calls, ['overlay-disposed']);
});

test('newer open wins a lazy-load race and close cancels a pending open', async () => {
  const h = harness({ delayed: true });
  const launcher = h.window.rendererImageViewerController;
  const first = launcher.open({ sessionId: 's', artifactId: 'first' });
  const second = launcher.open({ sessionId: 's', artifactId: 'second' });
  h.release();
  await Promise.all([first, second]);
  assert.deepEqual(h.calls.filter(Array.isArray).map((entry) => entry[1].artifactId), ['second']);
  const pending = launcher.open({ sessionId: 's', artifactId: 'cancelled' });
  launcher.close();
  await pending;
  assert.deepEqual(h.calls.filter(Array.isArray).map((entry) => entry[1].artifactId), ['second']);
});


test('source drafts resolve injected pane composers without a global DOM lookup', async () => {
  const h = harness();
  const bindings = h.getDraftOptions().getBindings();
  assert.equal(bindings[0].sessionId, 'session-0');
  assert.equal(bindings[0].input, h.primaryInput);
  assert.equal(bindings[1].sessionId, 'session-1');
  assert.equal(bindings[1].input, h.secondaryInput);
  await h.window.rendererImageViewerController.open({ sessionId: 'session-1', artifactId: 'a' });
  assert.equal(h.getOptions().fallbackFocusTo, h.primaryInput);
  for (const cleanup of h.cleanups.reverse()) cleanup();
});

const plain = (value) => JSON.parse(JSON.stringify(value)); // the binding runs in its own realm

function galleryState() {
  return {
    messagesBySession: new Map([['s1', [
      { id: 'u1', role: 'user', attachments: [{ id: 'att-1', kind: 'image', assetPath: 'C:\\managed\\cat.png', displayName: 'Cat' }] },
      { id: 'r1', kind: 'tool_result', tool_result: {
        generated_artifacts: [{ artifact_id: 'gen-1', artifact_kind: 'image', title: 'Fox', status: 'available' }],
        metadata: { provenance: { image_prompt: 'a fox', seed: 7 } },
      } },
      { id: 'r2', kind: 'tool_result', tool_result: {
        trusted_attachment_refs: [{ id: 'chart-1', kind: 'chart', asset_path: 'C:\\attachments\\chart-1.png' }],
      } },
    ]]]),
    artifacts: { deletedArtifactIds: [] },
  };
}

test('select opens the whole chat gallery at the chosen image', async () => {
  const h = harness({ state: galleryState() });
  const launcher = h.window.rendererImageViewerController;
  const contextNode = { node: true };
  await launcher.open({ sessionId: 's1', select: { kind: 'tool', id: 'chart-1' }, contextNode });
  const [, opened] = h.calls.find(Array.isArray);
  assert.equal(opened.index, 2);
  assert.equal(opened.contextNode, contextNode);
  assert.deepEqual(opened.items.map((item) => item.key), ['attachment:att-1', 'artifact:gen-1', 'tool:chart-1']);
  assert.equal(opened.items[0].src, 'file:///C:/managed/cat.png');
  assert.deepEqual(opened.items[1].details, { prompt: 'a fox', seed: 7 });
  await launcher.open({ sessionId: 's1', select: { kind: 'artifact', id: 'gen-1' } });
  assert.equal(h.calls.filter(Array.isArray).at(-1)[1].index, 1);
});

test('an unlisted artifact falls back to a single open and an unlisted attachment opens nothing', async () => {
  const h = harness({ state: galleryState() });
  const launcher = h.window.rendererImageViewerController;
  await launcher.open({ sessionId: 's1', select: { kind: 'artifact', id: 'gone' }, contextNode: 'node' });
  assert.deepEqual(plain(h.calls.filter(Array.isArray).at(-1)), ['open', { sessionId: 's1', artifactId: 'gone', contextNode: 'node' }]);
  const before = h.calls.length;
  assert.equal(await launcher.open({ sessionId: 's1', select: { kind: 'attachment', id: 'missing' } }), false);
  assert.equal(await launcher.open({ sessionId: 'other', select: { kind: 'tool', id: 'chart-1' } }), false);
  assert.equal(h.calls.length, before);
});

test('source items route copy/save/reveal to chat images; copy prompt uses the clipboard', async () => {
  const h = harness({ state: galleryState() });
  await h.window.rendererImageViewerController.open({ sessionId: 's1', select: { kind: 'attachment', id: 'att-1' } });
  const options = h.getOptions();
  const ref = { kind: 'attachment', id: 'att-1' };
  const item = { kind: 'source', sessionId: 's1', src: 'file:///x.png', ref };
  options.onAction('copy', item);
  options.onAction('save-as', item);
  options.onAction('reveal', item);
  assert.deepEqual(plain(h.calls.slice(-3)), [['chat-copy', 's1', ref], ['chat-save-as', 's1', ref], ['chat-reveal', 's1', ref]]);
  assert.deepEqual(plain(options.onAction('open', item)), { ok: false, reason: 'unsupported' });
  assert.deepEqual(plain(options.onAction('copy', { kind: 'source', sessionId: 's1', src: 'data:image/png;base64,aA==' })), { ok: false, reason: 'unsupported' });
  options.onAction('copy', { kind: 'artifact', sessionId: 's1', artifactId: 'gen-1' });
  options.copyText('a fox');
  assert.deepEqual(h.calls.slice(-2), [['copy', 's1', 'gen-1'], ['clipboard', 'a fox']]);
});

test('run routes chat and panel image actions by kind and reports each outcome once by toast', async () => {
  const h = harness();
  const shell = h.window.jennyShell;
  shell.artifacts.copyImage = async (...args) => { h.calls.push(['copy', ...args]); return { ok: true }; };
  shell.artifacts.saveAs = async () => ({ ok: false, canceled: true });
  shell.artifacts.reveal = async () => { throw new Error('gone'); };
  shell.chatImages.copyImage = async (...args) => { h.calls.push(['chat-copy', ...args]); return { ok: false, reason: 'image_unavailable' }; };
  const run = h.window.rendererImageViewerController.run;
  assert.deepEqual(plain(await run('copy', { kind: 'artifact', id: 'a1', sessionId: 's1' })), { ok: true });
  assert.deepEqual(plain(await run('save-as', { kind: 'artifact', id: 'a1', sessionId: 's1' })), { ok: false, canceled: true });
  assert.deepEqual(plain(await run('reveal', { kind: 'artifact', id: 'a1', sessionId: 's1' })), { ok: false });
  await run('copy', { kind: 'tool', id: 't1', sessionId: 's1' });
  assert.deepEqual(plain(await run('open', { kind: 'attachment', id: 'x', sessionId: 's1' })), { ok: false, reason: 'unsupported' });
  assert.deepEqual(plain(h.calls.filter((call) => Array.isArray(call) && call[0] !== 'read')), [
    ['copy', 's1', 'a1'], ['toast', 'Image copied.', 'info'],
    ['toast', 'Could not show the image in its folder.', 'danger'],
    ['chat-copy', 's1', { kind: 'tool', id: 't1' }], ['toast', 'Could not copy the image.', 'danger'],
    ['toast', 'Open externally failed.', 'danger'],
  ]);
});
