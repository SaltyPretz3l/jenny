'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createChatWorkspaceDetail, SURFACES } = require('../renderer/features/renderer-chat-workspace-detail');

const MARKUP = '<!doctype html><body>'
  + '<div class="chat-pane" id="pane0">'
  + '<button id="row0">Changes row (pane 0)</button>'
  + '<button data-inv-chip="composer-context-ring" id="ring0">ring 0</button>'
  + '<div id="composerProjectPillSlot"><button id="project0">project 0</button></div>'
  + '<button data-activity-open id="activity0" aria-pressed="false">Activity 0</button>'
  + '</div>'
  + '<div class="chat-pane" id="pane1">'
  + '<button id="row1">Changes row (pane 1)</button>'
  + '<button data-inv-chip="composer-context-ring" id="ring1">ring 1</button>'
  + '<div id="composerProjectPillSlot"><button id="project1">project 1</button></div>'
  + '</div>'
  + '</body>';

function setup(overrides = {}) {
  const dom = new JSDOM(MARKUP);
  const { document } = dom.window;
  const calls = { claim: [], artifact: [], changes: [], activity: [], close: [], logs: [] };
  const clicks = [];
  for (const id of ['ring0', 'ring1', 'project0', 'project1', 'activity0']) {
    document.getElementById(id).addEventListener('click', () => clicks.push(id));
  }
  const detail = createChatWorkspaceDetail({
    windowRef: dom.window,
    claimOwner: (id) => calls.claim.push(id),
    openArtifact: (ref, context) => { calls.artifact.push({ ref, context }); return Promise.resolve(true); },
    openChanges: (context) => { calls.changes.push(context); return true; },
    closePanel: (context) => calls.close.push(context.surface),
    log: (level, code) => calls.logs.push(code),
    ...overrides,
  });
  return { dom, document, detail, calls, clicks, el: (id) => document.getElementById(id) };
}

test('the surfaces are the closed set', () => {
  assert.deepEqual([...SURFACES], ['outputs', 'changes', 'background_tasks', 'browser', 'context', 'environment']);
});

test('browser opens the Browser panel through the shell seam, and reports false when the seam is missing or declines', () => {
  const h = setup();
  const open = () => h.detail.open({ surface: 'browser', ownerSessionId: 's1', opener: h.el('row0') });
  assert.equal(open(), false, 'no seam published: nothing opens');
  assert.equal(h.detail.getCurrent(), null);
  let calls = 0;
  h.dom.window.rendererOpenBrowserUsePanel = () => { calls += 1; return false; };
  assert.equal(open(), false, 'a Browser panel that has not loaded declines');
  h.dom.window.rendererOpenBrowserUsePanel = () => { calls += 1; return true; };
  assert.equal(open(), true);
  assert.equal(calls, 2);
  assert.equal(h.detail.getCurrent(), null, 'the Browser panel closes through its own controls, so it is never tracked as current');
  assert.deepEqual(h.clicks, [], 'no composer control is clicked for it');
});

test('an unknown surface or a missing owner is refused and opens nothing', () => {
  const h = setup();
  assert.equal(h.detail.open({ surface: 'nope', ownerSessionId: 's1', opener: h.el('row0') }), false);
  assert.equal(h.detail.open({ surface: 'changes', ownerSessionId: '', opener: h.el('row0') }), false);
  assert.equal(h.detail.open({ surface: 'changes', ownerSessionId: 'x'.repeat(500), opener: h.el('row0') }), false);
  assert.equal(h.detail.open(null), false);
  assert.deepEqual(h.calls.changes, []);
  assert.deepEqual(h.calls.artifact, []);
  assert.deepEqual(h.clicks, []);
  assert.ok(h.calls.logs.includes('chat_workspace_detail.open_invalid'));
});

test('outputs claims the explicit owner and opens the artifact panel; a resourceRef opens that artifact', () => {
  const h = setup();
  assert.equal(h.detail.open({ surface: 'outputs', ownerSessionId: 'sess_b', opener: h.el('row1') }), true);
  assert.deepEqual(h.calls.claim, ['sess_b']);
  assert.equal(h.calls.artifact[0].ref, '');
  assert.equal(h.calls.artifact[0].context.ownerSessionId, 'sess_b');
  assert.equal(h.detail.open({ surface: 'outputs', ownerSessionId: 'sess_b', opener: h.el('row1'), resourceRef: 'art_123' }), true);
  assert.equal(h.calls.artifact[1].ref, 'art_123');
});

test('outputs is not claimed as opened when no artifact opener is wired', () => {
  const h = setup({ openArtifact: undefined });
  assert.equal(h.detail.open({ surface: 'outputs', ownerSessionId: 's1', opener: h.el('row0') }), false);
});

test('changes hands the owner and the opener to the working-tree page', () => {
  const h = setup();
  const opener = h.el('row0');
  assert.equal(h.detail.open({ surface: 'changes', ownerSessionId: 'sess_a', opener }), true);
  assert.equal(h.calls.changes.length, 1);
  assert.equal(h.calls.changes[0].ownerSessionId, 'sess_a');
  assert.equal(h.calls.changes[0].opener, opener);
  assert.equal(setup({ openChanges: () => false }).detail.open({ surface: 'changes', ownerSessionId: 'a', opener }), false);
});

test('background tasks opens Activity through the injected opener, else the opener pane\'s own button once', () => {
  const injected = setup({ openActivity: (context) => { return context.ownerSessionId === 's1'; } });
  assert.equal(injected.detail.open({ surface: 'background_tasks', ownerSessionId: 's1', opener: injected.el('row0') }), true);
  assert.deepEqual(injected.calls.claim, ['s1']);

  const h = setup();
  assert.equal(h.detail.open({ surface: 'background_tasks', ownerSessionId: 's1', opener: h.el('row0') }), true);
  assert.deepEqual(h.clicks, ['activity0']);
  h.el('activity0').setAttribute('aria-pressed', 'true');
  h.detail.open({ surface: 'background_tasks', ownerSessionId: 's1', opener: h.el('row0') });
  assert.deepEqual(h.clicks, ['activity0'], 'an Activity that is already open swaps in place, it is not toggled shut');
  // Pane 1 has no Activity button: nothing to open, and it is not borrowed from pane 0.
  assert.equal(h.detail.open({ surface: 'background_tasks', ownerSessionId: 's2', opener: h.el('row1') }), false);
});

test('background tasks opens the Background tasks panel with the row\'s task id', () => {
  const seen = [];
  const h = setup({ openBackgroundTasks: (context) => { seen.push(context); return true; } });
  const opener = h.el('row0');
  assert.equal(h.detail.open({ surface: 'background_tasks', ownerSessionId: 's1', opener, resourceRef: 'job:abc123abc123' }), true);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { ownerSessionId: 's1', opener, taskId: 'job:abc123abc123' });
  assert.deepEqual(h.clicks, [], 'the Activity button is not clicked once the panel opener is wired');
  assert.equal(h.detail.open({ surface: 'background_tasks', ownerSessionId: 's1', opener }), true);
  assert.equal(seen[1].taskId, '');
  assert.equal(h.detail.getCurrent().surface, 'background_tasks');
});

test('context and environment click their own pane\'s popover trigger, never another pane\'s', () => {
  const h = setup();
  assert.equal(h.detail.open({ surface: 'context', ownerSessionId: 's2', opener: h.el('row1') }), true);
  assert.equal(h.detail.open({ surface: 'environment', ownerSessionId: 's2', opener: h.el('row1') }), true);
  assert.equal(h.detail.open({ surface: 'context', ownerSessionId: 's1', opener: h.el('row0') }), true);
  assert.deepEqual(h.clicks, ['ring1', 'project1', 'ring0']);
  // No opener, no pane: the first control in the document is not guessed at for a detached opener.
  assert.equal(h.detail.open({ surface: 'context', ownerSessionId: 's1', opener: null }), true);
  assert.equal(h.clicks.at(-1), 'ring0');
});

test('a missing or disabled trigger reports false instead of pretending', () => {
  const h = setup();
  h.el('ring0').disabled = true;
  assert.equal(h.detail.open({ surface: 'context', ownerSessionId: 's1', opener: h.el('row0') }), false);
  h.el('project0').remove();
  assert.equal(h.detail.open({ surface: 'environment', ownerSessionId: 's1', opener: h.el('row0') }), false);
});

test('close runs the panel close and returns focus to the opener while it is connected', () => {
  const h = setup();
  const opener = h.el('row0');
  h.detail.open({ surface: 'changes', ownerSessionId: 's1', opener });
  h.el('row1').focus();
  assert.equal(h.detail.close(), true);
  assert.equal(h.document.activeElement, opener);
  assert.deepEqual(h.calls.close, ['changes']);
  assert.equal(h.detail.getCurrent(), null);
});

test('close does not focus a detached opener and does not close a panel it never opened', () => {
  const h = setup();
  const opener = h.el('row0');
  h.detail.open({ surface: 'outputs', ownerSessionId: 's1', opener });
  opener.remove();
  h.el('row1').focus();
  assert.equal(h.detail.close(), false);
  assert.equal(h.document.activeElement, h.el('row1'));
  assert.equal(h.detail.close(), false, 'a second close is a no-op');
  assert.deepEqual(h.calls.close, ['outputs']);
});

test('opening another surface while one is open swaps in place: no panel close between them', () => {
  const h = setup();
  h.detail.open({ surface: 'outputs', ownerSessionId: 's1', opener: h.el('row0') });
  h.detail.open({ surface: 'changes', ownerSessionId: 's1', opener: h.el('row0') });
  h.detail.open({ surface: 'background_tasks', ownerSessionId: 's1', opener: h.el('row0') });
  assert.deepEqual(h.calls.close, []);
  assert.equal(h.detail.getCurrent().surface, 'background_tasks');
  assert.equal(h.detail.getCurrent().ownerSessionId, 's1');
});

test('the owner is always the one passed in, even for a second pane while the first is focused', () => {
  const h = setup();
  h.el('row0').focus();
  h.detail.open({ surface: 'changes', ownerSessionId: 'sess_of_pane_1', opener: h.el('row1') });
  assert.equal(h.calls.changes[0].ownerSessionId, 'sess_of_pane_1');
  assert.equal(h.detail.getCurrent().ownerSessionId, 'sess_of_pane_1');
});

test('an opener that throws is contained and logged', () => {
  const h = setup({ openChanges: () => { throw new Error('boom'); } });
  assert.equal(h.detail.open({ surface: 'changes', ownerSessionId: 's1', opener: h.el('row0') }), false);
  assert.ok(h.calls.logs.includes('chat_workspace_detail.open_failed'));
  assert.equal(h.detail.getCurrent(), null);
});

test('Open in Workspace uses the cancelable path-open seam; Open in Git needs its wiring', () => {
  const h = setup();
  const events = [];
  h.dom.window.addEventListener('ide:open-file-at-line', (event) => { events.push(event.detail); event.preventDefault(); });
  assert.equal(h.detail.openInWorkspace('src/a.js'), true);
  assert.deepEqual(events, [{ path: 'src/a.js', line: null, column: null, preferIde: true }]);
  assert.equal(h.detail.openInWorkspace(''), false);
  const unclaimed = setup();
  assert.equal(unclaimed.detail.openInWorkspace('src/a.js'), false, 'nothing claimed the open');
  assert.equal(unclaimed.detail.openInGit(), false);
  let opened = 0;
  unclaimed.detail.configure({ openInGit: () => { opened += 1; } });
  assert.equal(unclaimed.detail.openInGit(), true);
  assert.equal(opened, 1);
});

test('configure merges new openers over the old ones', () => {
  const h = setup();
  const seen = [];
  h.detail.configure({ openChanges: (context) => { seen.push(context.ownerSessionId); return true; } });
  h.detail.open({ surface: 'changes', ownerSessionId: 'later', opener: h.el('row0') });
  assert.deepEqual(seen, ['later']);
  assert.equal(h.calls.changes.length, 0);
});

test('changes passes a chat findings list on to the working-tree page only when one is given', () => {
  const h = setup();
  const opener = h.el('row0');
  const reviewFindings = { sessionId: 'sess_a', toolCallId: 'c1', focusIndex: 1, findings: [] };
  assert.equal(h.detail.open({ surface: 'changes', ownerSessionId: 'sess_a', opener, reviewFindings }), true);
  assert.equal(h.calls.changes[0].reviewFindings, reviewFindings);
  assert.equal(h.detail.open({ surface: 'changes', ownerSessionId: 'sess_a', opener }), true);
  assert.equal('reviewFindings' in h.calls.changes[1], false);
});

/* Row 195 C14: the Session rail is hosted in the stack, outside every pane, so its opener has no pane of its own. */
function hostedOpener(h) {
  const host = h.document.createElement('div');
  const opener = h.document.createElement('button');
  host.append(opener);
  h.document.body.append(host);
  return opener;
}

test('an action taken from a rail hosted outside the panes lands in the pane the rail is bound to, not the left one', () => {
  const h = setup();
  const opener = hostedOpener(h);
  const pane = h.el('pane1');
  assert.equal(h.detail.open({ surface: 'context', ownerSessionId: 's2', opener, pane }), true);
  assert.equal(h.detail.open({ surface: 'environment', ownerSessionId: 's2', opener, pane }), true);
  assert.deepEqual(h.clicks, ['ring1', 'project1']);
  // The right pane has no Activity button: nothing opens, and the left pane's is not borrowed.
  assert.equal(h.detail.open({ surface: 'background_tasks', ownerSessionId: 's2', opener, pane }), false);
  assert.deepEqual(h.clicks, ['ring1', 'project1']);
  // Without a named pane the old reading stands: the first pane in the document.
  assert.equal(h.detail.open({ surface: 'context', ownerSessionId: 's1', opener }), true);
  assert.equal(h.clicks.at(-1), 'ring0');
  // A pane that is not an element is ignored, not trusted.
  assert.equal(h.detail.open({ surface: 'context', ownerSessionId: 's1', opener, pane: { nope: true } }), true);
  assert.equal(h.clicks.at(-1), 'ring0');
});

test('the injected openers get the named pane in their context, and only when one was named', () => {
  const seen = [];
  const h = setup({
    openChanges: (context) => { seen.push(['changes', context.pane]); return true; },
    openBackgroundTasks: (context) => { seen.push(['runs', context.pane]); return true; },
    openArtifact: (ref, context) => { seen.push(['artifact', context.pane]); return true; },
  });
  const opener = hostedOpener(h);
  const pane = h.el('pane1');
  for (const surface of ['changes', 'background_tasks', 'outputs']) h.detail.open({ surface, ownerSessionId: 's2', opener, pane });
  assert.deepEqual(seen, [['changes', pane], ['runs', pane], ['artifact', pane]]);
  h.detail.open({ surface: 'background_tasks', ownerSessionId: 's2', opener });
  assert.deepEqual(seen.at(-1), ['runs', undefined], 'no pane named: no pane key');
});
