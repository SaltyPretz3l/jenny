'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createMentionAutocomplete } = require('../renderer/features/renderer-ide-mention-autocomplete');
const { createComposerSessionState } = require('../renderer/chat/renderer-composer-session-state');
const { createControllerHarness } = require('./helpers/send-controller-harness');
const paneDrafts = require('../renderer/chat/renderer-composer-pane-drafts');

function rig(t, { rootMeta = { rootId: 'root-a', generation: 1 } } = {}) {
  const dom = new JSDOM('<textarea id="chatInput"></textarea><textarea id="sideInput"></textarea>');
  const { window } = dom;
  const input = window.document.getElementById('chatInput');
  const side = window.document.getElementById('sideInput');
  const reads = [];
  const files = ['src/app.js', ...Array.from({ length: 65 }, (_, i) => `src/file-${i}.js`)];
  const mentions = createMentionAutocomplete({
    document: window.document, window, getInput: () => input,
    getWorkspaceFs: () => ({
      listAllFiles: async () => ({ files, ...rootMeta }),
      readFile: async ({ path }) => { reads.push(path); return { content: `BODY ${path}` }; },
    }),
  });
  mentions.attach();
  t.after(() => { mentions.dispose(); window.close(); });
  const state = { currentSessionId: 'a', sessions: [], attachments: { queued: [] } };
  const drafts = createComposerSessionState({ state, getChatInput: () => input, getMentionController: () => mentions });
  // The live application captures primary input and pane input through these paths.
  input.addEventListener('input', () => drafts.captureActive(drafts.getQueueSessionId(), 'input'));
  side.addEventListener('input', () => drafts.capturePaneDraft(state.panes?.panes[1]?.sessionId || 'a', side));
  function type(text, target = input) {
    target.value = text;
    target.setSelectionRange(text.length, text.length);
    target.dispatchEvent(new window.Event('input', { bubbles: true }));
  }
  async function accept(path = 'src/app.js') {
    type(`@${path}`);
    await new Promise(resolve => window.setTimeout(resolve, 0));
    const row = [...window.document.querySelectorAll('[data-ide-mention-path]')]
      .find(node => node.getAttribute('data-ide-mention-path') === path);
    assert.ok(row, `suggestion for ${path}`);
    row.click();
  }
  function switchTo(id) {
    drafts.captureActive(state.currentSessionId, 'session_switch');
    state.currentSessionId = id;
    drafts.restoreForSession(id);
  }
  return { window, input, side, state, drafts, mentions, reads, type, accept, switchTo };
}

test('A/B/A retains accepted file content after B is typed and emptied', async t => {
  const r = rig(t);
  await r.accept();
  r.switchTo('b');
  r.type('something');
  r.type('');
  r.switchTo('a');
  assert.equal(r.input.value, '@src/app.js ');
  assert.deepEqual(r.mentions.collectMentionPaths(), ['src/app.js']);
  assert.deepEqual(await r.mentions.collectMentionContents(), [{ path: 'src/app.js', content: 'BODY src/app.js' }]);
});

test('typed @path in B never inherits A approval; same-root restore keeps A bindings', async t => {
  const r = rig(t);
  await r.accept();
  r.switchTo('b');
  r.type('@src/app.js ');
  assert.deepEqual(r.mentions.collectMentionPaths(), []);
  r.switchTo('a');
  assert.deepEqual(r.mentions.collectMentionPaths(), ['src/app.js']);
  r.switchTo('b');
  assert.equal(r.input.value, '@src/app.js ');
  assert.deepEqual(await r.mentions.collectMentionContents(), []);
});

test('accept-history eviction in B cannot evict A bindings', async t => {
  const r = rig(t);
  await r.accept();
  r.switchTo('b');
  for (let i = 0; i < 65; i += 1) await r.accept(`src/file-${i}.js`);
  r.switchTo('a');
  assert.deepEqual(r.mentions.collectMentionPaths(), ['src/app.js']);
});

for (const rootMeta of [{ rootId: 'root-a', generation: 1 }, {}]) {
  test(`committed root reset invalidates saved drafts even with unchanged listing identity ${JSON.stringify(rootMeta)}`, async t => {
    const r = rig(t, { rootMeta });
    await r.accept();
    r.switchTo('b');
    r.window.dispatchEvent(new r.window.Event('ide:workspace-root-committed'));
    // Re-index the same relative path under the newly committed workspace.
    await r.accept();
    r.switchTo('a');
    assert.equal(r.input.value, '@src/app.js ');
    assert.deepEqual(r.mentions.collectMentionPaths(), []);
    assert.deepEqual(await r.mentions.collectMentionContents(), []);
    assert.deepEqual(r.reads, []);
  });
}

test('split-pane handoff preserves A bindings and collects only the sending textarea', async t => {
  const r = rig(t);
  await r.accept();
  r.state.panes = { panes: [{ sessionId: 'a' }, { sessionId: 'b' }], focusedPaneId: 0 };
  // Actual handoff order: side capture, live rebind, side restore.
  r.drafts.restorePaneDraft('b', r.side);
  r.drafts.capturePaneDraft('b', r.side);
  r.state.panes.panes = [{ sessionId: 'b' }, { sessionId: 'a' }];
  paneDrafts.rebindLive(r.drafts, 'a', 'b');
  r.drafts.restorePaneDraft('a', r.side);
  assert.equal(r.side.value, '@src/app.js ');
  assert.deepEqual(r.mentions.collectMentionPaths(r.input), []);
  assert.deepEqual(r.mentions.collectMentionPaths(r.side), ['src/app.js']);
  assert.deepEqual(await r.mentions.collectMentionContents({ input: r.side }), [{ path: 'src/app.js', content: 'BODY src/app.js' }]);
  r.type('different chat'); r.type('');
  r.drafts.capturePaneDraft('a', r.side);
  r.state.panes.panes = [{ sessionId: 'a' }, { sessionId: 'b' }];
  paneDrafts.rebindLive(r.drafts, 'b', 'a');
  r.drafts.restorePaneDraft('b', r.side);
  assert.deepEqual(r.mentions.collectMentionPaths(), ['src/app.js']);
  assert.deepEqual(r.mentions.collectMentionPaths(r.side), []);
});

test('empty input in pane 1 clears only its own bindings and cannot approve typed text', async t => {
  const r = rig(t);
  await r.accept();
  r.drafts.captureActive('a');
  r.state.panes = { panes: [{ sessionId: 'b' }, { sessionId: 'a' }], focusedPaneId: 1 };
  paneDrafts.rebindLive(r.drafts, 'a', 'b');
  r.drafts.restorePaneDraft('a', r.side);
  r.type('', r.side);
  r.type('@src/app.js ', r.side);
  assert.deepEqual(r.mentions.collectMentionPaths(r.side), []);
  r.drafts.capturePaneDraft('a', r.side);
  r.state.panes.panes = [{ sessionId: 'a' }, { sessionId: 'b' }];
  paneDrafts.rebindLive(r.drafts, 'b', 'a');
  assert.equal(r.input.value, '@src/app.js ');
  assert.deepEqual(r.mentions.collectMentionPaths(), []);
});

test('root reset invalidates pane 1 bindings and their saved snapshot', async t => {
  const r = rig(t);
  await r.accept();
  r.drafts.captureActive('a');
  r.state.panes = { panes: [{ sessionId: 'b' }, { sessionId: 'a' }], focusedPaneId: 1 };
  paneDrafts.rebindLive(r.drafts, 'a', 'b');
  r.drafts.restorePaneDraft('a', r.side);
  r.window.dispatchEvent(new r.window.Event('ide:workspace-root-committed'));
  assert.deepEqual(r.mentions.collectMentionPaths(r.side), []);
  await r.accept();
  r.drafts.restorePaneDraft('a', r.side);
  assert.deepEqual(r.mentions.collectMentionPaths(r.side), []);
});

for (const paneId of [0, 1]) {
  test(`pane ${paneId} sends restored approved content through startPromptSend before consuming text`, async t => {
    const r = rig(t);
    await r.accept();
    r.switchTo('b'); r.type('other'); r.type(''); r.switchTo('a');
    const sendingInput = paneId === 0 ? r.input : r.side;
    if (paneId === 1) {
      r.drafts.restorePaneDraft('a', r.side);
      r.switchTo('b');
      r.type('@src/file-0.js '); // primary pane must never supply this send's mentions
    }
    const h = createControllerHarness([], {
      chatInput: sendingInput,
      sessionContextFor: () => ({
        paneId, getSessionId: () => 'session-1', setSessionId() {},
        isCurrent: id => id === 'session-1',
      }),
    });
    t.after(() => { h.controller.dispose(); h.restore(); });
    global.window.rendererIdeMentionAutocomplete = r.mentions;
    const originalDrafts = global.rendererComposerSessionStateController;
    global.rendererComposerSessionStateController = createComposerSessionState({
      state: h.state, getChatInput: () => r.input, getMentionController: () => r.mentions,
    });
    t.after(() => { global.rendererComposerSessionStateController = originalDrafts; });
    await h.controller.startPromptSend(sendingInput.value);
    assert.equal(sendingInput.value, '', 'receipt consumes the live draft');
    if (paneId === 1) assert.equal(r.input.value, '@src/file-0.js ', 'other pane remains unchanged');
    assert.equal(h.calls.startStream.length, 1);
    assert.deepEqual(h.calls.startStream[0].mentionContents, [{ path: 'src/app.js', content: 'BODY src/app.js' }]);
  });
}
