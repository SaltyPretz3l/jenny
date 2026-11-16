'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness({ delayed = false, state, loads, windowExtras, ctxExtras = {}, callbacks = {} } = {}) {
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
    ...(loads ? {} : { inventoryImageViewer: {}, rendererImageViewerStrip: {}, rendererSessionImageList: require('../renderer/chat/renderer-session-image-list') }),
    rendererTranscriptAttachmentsUtils: require('../renderer/chat/renderer-transcript-attachments'),
    rendererImageEditDraft: { createController: value => { draftOptions = value; return { dispose() {} }; } },
    rendererImageViewer: delayed || loads ? null : { createImageViewer },
    scriptLoaderUtils: { ensureScript: async ({ src }) => {
      if (loads) { loads.push(src); if (src.endsWith('/renderer-image-viewer.js')) window.rendererImageViewer = { createImageViewer }; return true; }
      await ready; window.rendererImageViewer = { createImageViewer }; return true;
    } },
    ...windowExtras,
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
    controllers: {}, ...ctxExtras,
    callbacks: { registerCleanup: (fn) => cleanups.push(fn), showToastMessage: (message, opts) => calls.push(['toast', message, opts.tone]), ...callbacks },
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

test('Pin to board (row 150 slice C5): the picture goes to the chat\'s pin entry by session and id, and no path or bytes cross', async () => {
  const h = harness();
  const launcher = h.window.rendererImageViewerController;
  const asked = [];
  h.window.rendererChatMessageActionBindings = { openPinMenu: (args) => { asked.push(args); return true; } };
  const result = await launcher.run('pin', { kind: 'artifact', id: 'gen-1', sessionId: 's1' });
  assert.equal(result.ok, true);
  assert.deepEqual(plain(asked[0].item), { kind: 'image', ref: { kind: 'artifact', id: 'gen-1', sessionId: 's1' } });
  assert.equal(asked[0].sessionId, 's1');
  assert.equal(asked[0].messageId, undefined);
  await launcher.run('pin', { kind: 'tool', id: 'chart-1', sessionId: 's2' });
  assert.deepEqual(plain(asked[1].item.ref), { kind: 'tool', id: 'chart-1', sessionId: 's2' });
  assert.deepEqual(h.calls, [], 'neither the artifact nor the chat-image bridge was called');
  // With no entry, or one that declines (the flag is off), the person is told once and nothing opens.
  h.window.rendererChatMessageActionBindings = { openPinMenu: () => false };
  assert.equal((await launcher.run('pin', { kind: 'artifact', id: 'gen-1', sessionId: 's1' })).ok, false);
  assert.deepEqual(h.calls, [['toast', 'Could not pin that', 'danger']]);
  delete h.window.rendererChatMessageActionBindings;
  assert.equal((await launcher.run('pin', { kind: 'artifact', id: 'gen-1', sessionId: 's1' })).ok, false);
});

test('the lazy-load order puts the strip module between the inventory primitive and the viewer', async () => {
  const loads = [];
  const h = harness({ loads });
  await h.window.rendererImageViewerController.open({ sessionId: 's', artifactId: 'a' });
  assert.deepEqual(loads, ['renderer/chat/renderer-session-image-list.js', 'renderer/inventory/image-viewer.js',
    'renderer/features/renderer-image-viewer-strip.js', 'renderer/features/renderer-image-viewer.js']);
});

test('a cached chat picture opens with no read and doubles as its own thumbnail', async () => {
  const peeked = 'data:image/png;base64,YQ==';
  const h = harness({ windowExtras: { rendererArtifactCardUtils: { peekArtifactImage: (sessionId, artifactId) => (artifactId === 'cached' ? peeked : '') } } });
  await h.window.rendererImageViewerController.open({ sessionId: 's1', artifactId: 'cached' });
  const options = h.getOptions();
  assert.deepEqual(plain(await options.readArtifact('s1', 'cached')), { asset_data_url: peeked });
  assert.equal(h.calls.some((call) => Array.isArray(call) && call[0] === 'read'), false, 'the cache answered');
  options.readArtifact('s1', 'cold');
  assert.deepEqual(h.calls.at(-1), ['read', 's1', 'cold']);
  assert.equal(options.getThumbnail({ kind: 'artifact', sessionId: 's1', artifactId: 'cached' }), peeked);
  assert.equal(options.getThumbnail({ kind: 'artifact', sessionId: 's1', artifactId: 'cold' }), '');
  assert.equal(options.getThumbnail({ kind: 'source', src: 'file:///C:/a.png' }), 'file:///C:/a.png');
  assert.equal(options.getThumbnail({ kind: 'source' }), '');
});

function entryNode({ tabindex = null } = {}) {
  const classes = new Set();
  const attrs = new Map(tabindex === null ? [] : [['tabindex', tabindex]]);
  const node = { classes, attrs, focused: [],
    classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name) },
    hasAttribute: (name) => attrs.has(name), setAttribute: (name, value) => attrs.set(name, value),
    focus: (options) => node.focused.push(options) };
  return node;
}

function jumpHarness({ scrolled = true, entry = entryNode(), paneTarget = null } = {}) {
  const timers = [];
  const selectors = [];
  const scrolls = [];
  const paneScrolls = [];
  const timeline = { querySelector: (selector) => { selectors.push(selector); return entry; } };
  const h = harness({
    state: { currentSessionId: 's0' },
    ctxExtras: { dom: { chatTimeline: timeline } },
    callbacks: { scrollMessageIntoView: (...args) => { scrolls.push(args); return scrolled; } },
    windowExtras: {
      setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length - 1; },
      clearTimeout: (id) => { if (timers[id]) timers[id].cleared = true; },
      rendererAppPaneComposition: { getPaneComposition: () => ({ getSessionPaneTarget: (id) => (id === 's1' && paneTarget ? {
        chatTimeline: paneTarget.timeline, scrollMessageIntoView: (...args) => { paneScrolls.push(args); return true; } } : null) }) },
    },
  });
  return { h, timers, selectors, scrolls, paneScrolls, entry };
}

test('Show in chat is offered only for an image whose message and session can be reached', async () => {
  const j = jumpHarness({ paneTarget: { timeline: { querySelector: () => null } } });
  await j.h.window.rendererImageViewerController.open({ sessionId: 's0', artifactId: 'a' });
  const { canShowInChat } = j.h.getOptions();
  assert.equal(canShowInChat({ kind: 'artifact', sessionId: 's0', artifactId: 'a' }), false, 'no message id, as for the composer chip and Team pictures');
  assert.equal(canShowInChat({ messageId: 'm1', kind: 'source' }), false, 'no session');
  assert.equal(canShowInChat({ messageId: 'm1', sessionId: 's0' }), true, 'pane 0 shows the current session');
  assert.equal(canShowInChat({ messageId: 'm1', sessionId: 's1' }), true, 'a later pane has a jump target');
  assert.equal(canShowInChat({ messageId: 'm1', sessionId: 'elsewhere' }), false, 'a chat that is not on screen');
  const bare = harness({ state: { currentSessionId: 's0' } });
  await bare.window.rendererImageViewerController.open({ sessionId: 's0', artifactId: 'a' });
  assert.equal(bare.getOptions().canShowInChat({ messageId: 'm1', sessionId: 's0' }), false, 'pane 0 without a scroll callback');
});

test('Show in chat on a tool result highlights the turn article the turn shell resolves', async () => {
  const j = jumpHarness();
  const article = { classes: new Set(), attrs: new Map(), focused: [], classList: null };
  article.classList = { add: (c) => article.classes.add(c), remove: (c) => article.classes.delete(c) };
  Object.assign(article, { hasAttribute: (n) => article.attrs.has(n), setAttribute: (n, v) => article.attrs.set(n, v), focus: (o) => article.focused.push(o) });
  const row = { closest: (selector) => (selector === '.chat-entry, .chat-row' ? article : null) };
  j.h.window.rendererTurnShell = { resolveVisibleMessageDomTarget: (timeline, id) => (id === 'tool-1' ? row : null) };
  await j.h.window.rendererImageViewerController.open({ sessionId: 's0', artifactId: 'a' });
  j.h.getOptions().onShowInChat({ messageId: 'tool-1', sessionId: 's0' });
  assert.equal(article.classes.has('chat-citation-target-highlight'), true, 'the article holding the tool result, not a missed direct lookup');
  assert.equal(j.selectors.length, 0, 'the turn shell answered; no fallback query');
  assert.equal(j.h.calls.some((call) => call[0] === 'toast'), false);
});

test('Show in chat scrolls the message to the middle, highlights it for 2200 ms and focuses it', async () => {
  const j = jumpHarness();
  await j.h.window.rendererImageViewerController.open({ sessionId: 's0', artifactId: 'a' });
  j.h.getOptions().onShowInChat({ messageId: 'm"1', sessionId: 's0' });
  assert.deepEqual(plain(j.scrolls), [['m"1', { block: 'center', followLatest: false, reason: 'image_viewer_jump' }]]);
  assert.equal(j.selectors[0], '[data-message-id="m\\"1"]', 'the id is escaped, never spliced in raw');
  assert.equal(j.entry.classes.has('chat-citation-target-highlight'), true);
  assert.equal(j.entry.attrs.get('tabindex'), '-1');
  assert.deepEqual(plain(j.entry.focused), [{ preventScroll: true }]);
  assert.equal(j.timers.length, 1);
  assert.equal(j.timers[0].ms, 2200);
  j.timers[0].fn();
  assert.equal(j.entry.classes.has('chat-citation-target-highlight'), false);
  assert.equal(j.h.calls.some((call) => call[0] === 'toast'), false);
});

test('Show in chat keeps an existing tabindex, prefers a pane target and clears its timer on dispose', async () => {
  const entry = entryNode({ tabindex: '0' });
  const j = jumpHarness({ paneTarget: { timeline: { querySelector: () => entry } } });
  await j.h.window.rendererImageViewerController.open({ sessionId: 's1', artifactId: 'a' });
  j.h.getOptions().onShowInChat({ messageId: 'm2', sessionId: 's1' });
  assert.equal(j.scrolls.length, 0, 'pane 0 was not asked');
  assert.deepEqual(plain(j.paneScrolls), [['m2', { block: 'center', followLatest: false, reason: 'image_viewer_jump' }]]);
  assert.equal(entry.attrs.get('tabindex'), '0');
  assert.equal(entry.classes.has('chat-citation-target-highlight'), true);
  for (const cleanup of j.h.cleanups.reverse()) cleanup();
  assert.equal(j.timers[0].cleared, true, 'dispose clears the highlight timer');
  assert.equal(entry.classes.has('chat-citation-target-highlight'), false, 'and takes the highlight off');
});

test('Show in chat says so once when the message is no longer there', async () => {
  const gone = jumpHarness({ scrolled: false });
  await gone.h.window.rendererImageViewerController.open({ sessionId: 's0', artifactId: 'a' });
  gone.h.getOptions().onShowInChat({ messageId: 'm1', sessionId: 's0' });
  assert.deepEqual(gone.h.calls.filter((call) => call[0] === 'toast'), [['toast', 'That message is no longer in this chat.', 'info']]);
  assert.equal(gone.timers.length, 0);
  const noEntry = jumpHarness({ entry: null });
  await noEntry.h.window.rendererImageViewerController.open({ sessionId: 's0', artifactId: 'a' });
  noEntry.h.getOptions().onShowInChat({ messageId: 'm1', sessionId: 's0' });
  assert.equal(noEntry.h.calls.filter((call) => call[0] === 'toast').length, 1);
  const noId = jumpHarness();
  await noId.h.window.rendererImageViewerController.open({ sessionId: 's0', artifactId: 'a' });
  noId.h.getOptions().onShowInChat({ messageId: '', sessionId: 's0' });
  assert.equal(noId.scrolls.length, 0, 'nothing to jump to without a message id');
});

// Gate sitting 2026-11-14 (G10): in one pane, Show in chat never appeared. Pane 0 falls back to
// ctx.callbacks.scrollMessageIntoView, and app.js's hand-off to the shell bindings did not pass it.
test('the app shell hand-off passes scrollMessageIntoView, which Show in chat needs in pane 0', async () => {
  const seen = [];
  const window = { rendererAppShellBindings: { bindAppShell: (ctx) => { seen.push(ctx); return Promise.resolve(); } } };
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer/app/renderer-app-shell-bindings-composition.js'), 'utf8');
  vm.runInNewContext(source, { window, document: {} });
  const scrolls = [];
  await window.rendererAppShellBindingsComposition.bindAppShellFromApp({ scrollMessageIntoView: (...args) => { scrolls.push(args); return true; } });
  const { callbacks } = seen[0];
  assert.equal(typeof callbacks.scrollMessageIntoView, 'function');
  assert.equal(callbacks.scrollMessageIntoView('m1', { block: 'center' }), true);
  assert.deepEqual(scrolls, [['m1', { block: 'center' }]]);
});
