'use strict';

/* Split view W1-4c -- the pane composition: pane 1's lifecycle.
 *
 * mount clones #chatPaneTemplate right after #chatPaneResizer, resolves its
 * nodes through the bootstrap resolvePane seam (the ELEMENT, W1_SPEC §7) and
 * builds runtime -> surface -> pipeline -> shell with the SAME builders pane 0
 * uses; unmount disposes shell -> pipeline -> surface -> runtime and restores
 * the one-pane chat view exactly. The builders here are fakes that record what
 * they were handed; the real construction is covered by the shell boot suite
 * and tests/renderer-pane-streaming-isolation.test.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRig, paneRoot, kickerOf, resolveChatPaneDom, CHAT_PANE_NODE_NAMES, getPaneComposition, paneModel } = require('./helpers/pane-composition-rig');

test('mount: the clone sits right after the divider, resolves its 20 nodes through the seam and builds runtime -> surface -> pipeline -> shell', (t) => {
  const rig = createRig(t);
  rig.layoutController.openBeside('b');
  const root = paneRoot(rig.chatView, 1);
  const divider = rig.doc.getElementById('chatPaneResizer');
  assert.ok(root, 'pane 1 root is mounted');
  assert.equal(divider.nextElementSibling, root, 'the root is inserted right after #chatPaneResizer');
  assert.equal(root.id, '', 'the clone carries no id');
  assert.ok(rig.resolved.includes(root), 'resolvePane is handed the pane ELEMENT');
  const paneDom = resolveChatPaneDom(rig.doc, root);
  assert.equal(CHAT_PANE_NODE_NAMES.filter((name) => paneDom[name]).length, 21, 'exactly the 20 template nodes (W3-2 adds the subagent inspector) and the attach button mount inserts (W2-2b) resolve');
  assert.equal(paneDom.composerAttachShortcut.closest('.composer-toolbar-left'), root.querySelector('.composer-toolbar-left'), 'the attach button sits in the left toolbar');
  assert.equal(rig.chatView.dataset.paneCount, '2');
  assert.equal(divider.classList.contains('hidden'), false, 'the divider shows');
  assert.equal(divider.getAttribute('tabindex'), '0', 'the divider joins the tab order');
  assert.equal(root.querySelector('textarea').getAttribute('spellcheck'), 'true', 'the cloned composer spellchecks like pane 0');
  assert.deepEqual(rig.events.slice(0, 4).map(([kind, id]) => [kind, id]), [['runtime', 1], ['surface', 1], ['pipeline', 1], ['shell', 1]]);
  assert.equal(rig.events[1][2], root, 'the surface cluster works on the pane root');
  assert.equal(rig.events[2][2], paneDom.chatTimeline, 'the pipeline renders into the clone timeline');
  assert.equal(rig.events[3][2], paneDom.chatInput, 'the shell sends from the clone composer');
  assert.deepEqual(
    rig.events.filter(([kind]) => kind === 'resizer' || kind === 'bind').map(([, what]) => what),
    ['shell', 'bind', 'sync']
  );
  assert.ok(root.querySelector('.composer-toolbar-right .composer-send'), 'the clone gets its own Send');
  assert.ok(root.querySelector('.composer-toolbar-right .composer-stop-button.hidden'), 'and its own (hidden) Stop');
  assert.equal(rig.doc.getElementById('chatPane0').dataset.paneFocused, 'true');
  assert.equal(root.dataset.paneFocused, 'false', 'focus stays on pane 0');
  assert.equal(getPaneComposition(), rig.composition, 'the live composition is reachable for the shortcuts');
});

test('unmount: disposes shell -> pipeline -> surface -> runtime and restores the one-pane chat view', (t) => {
  const rig = createRig(t);
  rig.layoutController.openBeside('b');
  const divider = rig.doc.getElementById('chatPaneResizer');
  rig.chatView.style.setProperty('--chat-pane-a', '0.6fr');
  rig.chatView.style.setProperty('--chat-pane-b', '0.4fr');
  rig.events.length = 0;
  rig.layoutController.closePane(1);
  assert.deepEqual(rig.events.filter(([kind]) => kind === 'dispose').map(([, what]) => what), ['shell', 'pipeline', 'surface', 'runtime']);
  assert.ok(rig.events.some(([kind, what]) => kind === 'resizer' && what === 'dispose'));
  assert.equal(paneRoot(rig.chatView, 1), null, 'the root is removed');
  assert.equal(rig.chatView.dataset.paneCount, '1');
  assert.equal(divider.classList.contains('hidden'), true);
  assert.equal(divider.getAttribute('tabindex'), '-1');
  assert.equal(rig.chatView.style.getPropertyValue('--chat-pane-a'), '', 'split tracks cleared');
  assert.equal(rig.chatView.style.getPropertyValue('--chat-pane-b'), '');
  const kicker = rig.doc.getElementById('chatPaneKicker');
  assert.equal(kicker.hidden, true, 'one pane: the kicker is hidden');
  assert.equal(kicker.childNodes.length, 0, 'and empty, as before split view');
  assert.equal(rig.state.currentSessionId, 'a');
});

test('kicker: titles only when both sessions share a project, "· project" after each title when they differ', (t) => {
  const rig = createRig(t);
  rig.layoutController.openBeside('b');
  assert.equal(kickerOf(rig, 0).hidden, false);
  assert.equal(kickerOf(rig, 0).textContent, 'Alpha');
  assert.equal(kickerOf(rig, 1).textContent, 'Beta');
  assert.equal(kickerOf(rig, 1).querySelector('.chat-pane-kicker-project'), null);

  rig.layoutController.openBeside('c');
  assert.equal(kickerOf(rig, 0).textContent, 'Alpha · General');
  assert.equal(kickerOf(rig, 1).textContent, 'Gamma · Work');
  assert.equal(kickerOf(rig, 1).querySelector('.chat-pane-kicker-project').textContent, ' · Work');
});

test('kicker: a rename or project move reaches it through the header/full-render sync, and an unchanged kicker is not rebuilt', (t) => {
  const sessions = [
    { id: 'a', title: 'Alpha', project_id: 'project_general' },
    { id: 'b', title: 'Beta', project_id: 'project_general' },
  ];
  const rig = createRig(t, { sessions });
  rig.layoutController.openBeside('b');
  assert.equal(kickerOf(rig, 1).textContent, 'Beta');
  const close1 = kickerOf(rig, 1).querySelector('.chat-pane-close');

  rig.composition.syncPaneLayout('header');
  assert.equal(kickerOf(rig, 1).querySelector('.chat-pane-close'), close1, 'nothing changed: the kicker keeps its nodes');

  sessions[1].title = 'Beta renamed';
  rig.composition.syncPaneLayout('messages');
  assert.equal(kickerOf(rig, 1).textContent, 'Beta', 'a messages-only render leaves the kicker alone');
  rig.composition.syncPaneLayout('header');
  assert.equal(kickerOf(rig, 1).textContent, 'Beta renamed', 'the header sync picks up the new title');

  sessions[0].project_id = 'proj_work';
  rig.composition.syncPaneLayout('all');
  assert.equal(kickerOf(rig, 0).textContent, 'Alpha · Work', 'a project move shows "· project" without a layout change');
  assert.equal(kickerOf(rig, 1).textContent, 'Beta renamed · General');
});

test('kicker: an unknown project shows the title only, never the raw id', (t) => {
  const rig = createRig(t, { sessions: [
    { id: 'a', title: 'Alpha', project_id: 'proj_gone' },
    { id: 'b', title: 'Beta', project_id: '' },
  ] });
  rig.layoutController.openBeside('b');
  assert.equal(kickerOf(rig, 0).textContent, 'Alpha');
  assert.equal(kickerOf(rig, 1).textContent, 'Beta · General');
});

test('close glyph: each kicker closes its own pane', (t) => {
  const rig = createRig(t);
  rig.layoutController.openBeside('b');
  const close0 = kickerOf(rig, 0).querySelector('.chat-pane-close');
  assert.ok(close0, 'pane 0 carries a close glyph with two panes');
  assert.equal(close0.getAttribute('aria-label'), 'Close pane');
  close0.click();
  assert.equal(rig.layoutController.getPaneCount(), 1);
  assert.equal(rig.state.currentSessionId, 'b', 'closing pane 0 keeps the other conversation on screen');
  assert.equal(paneRoot(rig.chatView, 1), null);
});

test('focus: pointerdown or focusin inside a pane focuses it; syncFocus writes data-pane-focused on every root', (t) => {
  const rig = createRig(t);
  rig.layoutController.openBeside('b');
  const root1 = paneRoot(rig.chatView, 1);
  root1.querySelector('textarea').dispatchEvent(new rig.dom.window.MouseEvent('pointerdown', { bubbles: true }));
  assert.equal(rig.state.panes.focusedPaneId, 1);
  assert.equal(rig.state.currentSessionId, 'b');
  assert.equal(root1.dataset.paneFocused, 'true');
  assert.equal(rig.doc.getElementById('chatPane0').dataset.paneFocused, 'false');
  rig.doc.getElementById('chatThreadStage').dispatchEvent(new rig.dom.window.FocusEvent('focusin', { bubbles: true }));
  assert.equal(rig.state.panes.focusedPaneId, 0);
  assert.ok(rig.fullRenders.length > 0, 'a focus change re-renders the focused-pane chrome');
});

test('measureWidth: pane 0 + divider + pane 1, never the artifact panel', (t) => {
  const rig = createRig(t);
  rig.layoutController.openBeside('b');
  const widths = new Map([
    [rig.doc.getElementById('chatPane0'), 400],
    [rig.doc.getElementById('chatPaneResizer'), 10],
    [paneRoot(rig.chatView, 1), 300],
    [rig.doc.getElementById('artifactReviewPanel'), 500],
    [rig.chatView, 1210],
  ]);
  widths.forEach((width, element) => { element.getBoundingClientRect = () => ({ width }); });
  const resizer = rig.resizers[rig.resizers.length - 1];
  assert.equal(resizer.deps.measureWidth(), 710);
  assert.equal(resizer.deps.chatViewEl, rig.chatView);
  assert.equal(resizer.deps.resizerEl, rig.doc.getElementById('chatPaneResizer'));
  assert.equal(resizer.deps.setSplitRatio(0.9), paneModel.MAX_SPLIT_RATIO, 'the model clamps the ratio');
  resizer.deps.onPersist(0.8);
  assert.deepEqual(rig.persisted[rig.persisted.length - 1], { splitRatio: 0.8 });
});

test('renderSessionPane: undefined with one pane; with two, the pane showing the session renders and nothing else', (t) => {
  const rig = createRig(t);
  assert.equal(rig.composition.renderSessionPane('a', 'messages'), undefined, 'one pane: the global render stands');
  rig.layoutController.openBeside('b');
  rig.events.length = 0;
  rig.primaryRenders.length = 0;
  assert.equal(rig.composition.renderSessionPane('b', 'messages'), true);
  assert.deepEqual(rig.events, [['render', 'pane1']]);
  assert.deepEqual(rig.primaryRenders, []);
  assert.equal(rig.composition.renderSessionPane('a', 'messages'), true);
  assert.deepEqual(rig.primaryRenders, ['a']);
  assert.equal(rig.events.length, 1, 'pane 0 did not re-render pane 1');
  assert.equal(rig.composition.renderSessionPane('zzz', 'messages'), false, 'a session in no pane is hidden');
  assert.equal(rig.composition.renderSessionPane('b', 'composer'), true, 'the non-focused pane owns its composer sync');
  assert.equal(rig.composition.renderSessionPane('a', 'composer'), undefined, 'the focused pane keeps the global composer render');
});

test('toggleSplit: one pane opens the most recent other tab beside; two panes close the non-focused pane', (t) => {
  const rig = createRig(t, { candidates: ['a', 'c', 'b'] });
  assert.equal(rig.composition.toggleSplit(), true);
  assert.deepEqual(rig.state.panes.panes.map((pane) => pane.sessionId), ['a', 'c']);
  rig.layoutController.setFocusedPane(1);
  assert.equal(rig.composition.toggleSplit(), true);
  assert.equal(rig.layoutController.getPaneCount(), 1);
  assert.equal(rig.state.currentSessionId, 'c', 'the focused pane stays');
});

test('toggleSplit: nothing to open is a no-op', (t) => {
  const rig = createRig(t, { candidates: ['a'] });
  assert.equal(rig.composition.toggleSplit(), false);
  assert.equal(rig.layoutController.getPaneCount(), 1);
});

test('hydrateOnce: a stored second pane reopens without a write; a blank one stays closed; only once', (t) => {
  const rig = createRig(t);
  assert.equal(rig.composition.hydrateOnce({ panes: [{ paneId: 0, sessionId: 'a' }, { paneId: 1, sessionId: '' }], focusedPaneId: 0, splitRatio: 0.5 }), false);
  assert.equal(rig.layoutController.getPaneCount(), 1);
  const rig2 = createRig(t);
  assert.equal(rig2.composition.hydrateOnce({ panes: [{ paneId: 0, sessionId: 'a' }, { paneId: 1, sessionId: 'b' }], focusedPaneId: 1, splitRatio: 0.6 }), true);
  assert.equal(rig2.layoutController.getPaneCount(), 2);
  assert.equal(rig2.state.currentSessionId, 'b');
  assert.equal(rig2.state.panes.splitRatio, 0.6);
  assert.deepEqual(rig2.persisted, [], 'the store already holds this layout');
  assert.ok(paneRoot(rig2.chatView, 1));
  assert.equal(
    rig2.composition.hydrateOnce({ panes: [{ paneId: 0, sessionId: 'c' }, { paneId: 1, sessionId: 'a' }] }),
    false,
    'hydrates once'
  );
});

test('the non-focused pane composer: Send needs a draft, Stop shows while its session streams', (t) => {
  const rig = createRig(t, { streaming: ['b'] });
  rig.layoutController.openBeside('b');
  const root = paneRoot(rig.chatView, 1);
  const send = root.querySelector('.composer-send');
  const stop = root.querySelector('.composer-stop-button');
  const input = root.querySelector('textarea');
  rig.composition.renderSessionPane('b', 'composer');
  assert.equal(send.disabled, true, 'no draft, no send');
  assert.equal(stop.classList.contains('hidden'), false, 'its own session streams');
  input.value = 'hello';
  rig.composition.renderSessionPane('b', 'composer');
  assert.equal(send.disabled, false);
});

test('dispose: unmounts pane 1 and forgets the live composition', (t) => {
  const rig = createRig(t);
  rig.layoutController.openBeside('b');
  rig.composition.dispose();
  assert.equal(paneRoot(rig.chatView, 1), null);
  assert.equal(rig.chatView.dataset.paneCount, '1');
  assert.equal(getPaneComposition(), null);
});

test('closing pane 1 while it holds the keyboard moves focus to pane 0, not <body> (chord from pane 1)', (t) => {
  const rig = createRig(t);
  const input0 = rig.doc.createElement('textarea');
  rig.doc.getElementById('chatPane0').appendChild(input0);
  rig.layoutController.openBeside('b');
  paneRoot(rig.chatView, 1).querySelector('textarea').focus();
  assert.equal(rig.state.panes.focusedPaneId, 1);
  assert.equal(rig.composition.toggleSplit(), true);
  assert.equal(rig.layoutController.getPaneCount(), 1);
  assert.equal(rig.state.currentSessionId, 'b');
  assert.equal(rig.doc.activeElement, input0);
  // A close that never touched pane 1's focus leaves the keyboard alone.
  const outside = rig.doc.createElement('button');
  rig.doc.body.appendChild(outside);
  rig.layoutController.openBeside('c');
  outside.focus();
  rig.layoutController.closePane(1);
  assert.equal(rig.doc.activeElement, outside);
});

test('IDE dock: pane 0 is focused while docked (the dock hosts it); undocking hands focus back, DOM focus included', (t) => {
  const rig = createRig(t);
  const input0 = rig.doc.createElement('textarea');
  rig.doc.getElementById('chatPane0').appendChild(input0);
  rig.layoutController.openBeside('b');
  rig.layoutController.setFocusedPane(1);
  assert.equal(rig.state.currentSessionId, 'b');

  assert.equal(rig.composition.handleChatDocked(true), true);
  assert.equal(rig.state.panes.focusedPaneId, 0);
  assert.equal(rig.state.currentSessionId, 'a', 'the dock header and a dock send name the docked chat');

  input0.focus(); // the dock's own focus restore lands in pane 0's composer
  assert.equal(rig.composition.handleChatDocked(false), true);
  assert.equal(rig.state.panes.focusedPaneId, 1);
  assert.equal(rig.state.currentSessionId, 'b');
  assert.equal(rig.doc.activeElement, paneRoot(rig.chatView, 1).querySelector('textarea'));

  // Focus elsewhere (the top-rail tab a click or Ctrl+digit lands on) stays put.
  const railButton = rig.doc.createElement('button');
  rig.doc.body.appendChild(railButton);
  rig.composition.handleChatDocked(true);
  railButton.focus();
  rig.composition.handleChatDocked(false);
  assert.equal(rig.state.panes.focusedPaneId, 1);
  assert.equal(rig.doc.activeElement, railButton);

  // Docking with pane 0 already focused, or one pane, changes nothing.
  rig.layoutController.setFocusedPane(0);
  assert.equal(rig.composition.handleChatDocked(true), false);
  assert.equal(rig.composition.handleChatDocked(false), false);
  assert.equal(rig.state.panes.focusedPaneId, 0);
});

test('focusComposer: with two panes a view activation focuses the focused pane composer; one pane leaves #chatInput to the caller', (t) => {
  const rig = createRig(t);
  assert.equal(rig.composition.focusComposer(), false, 'one pane: the caller focuses #chatInput');
  rig.layoutController.openBeside('b');
  rig.layoutController.setFocusedPane(1);
  assert.equal(rig.composition.focusComposer(), true);
  assert.equal(rig.doc.activeElement, paneRoot(rig.chatView, 1).querySelector('textarea'));
  assert.equal(rig.state.panes.focusedPaneId, 1, 'focusing pane 1 keeps pane 1 focused');
});

// W3 open item (sign-out misfire): only the sign-out reset (reason 'reset') skips the collapse; a
// real close of the owning pane collapses even when the remaining pane 0 is blank.
test('side panel: closing the owning pane collapses it even beside a blank pane 0; the sign-out reset does not', (t) => {
  const rig = createRig(t, { sidePanel: true });
  rig.layoutController.openBeside('b');
  rig.state.ui.sidePanelOwnerSessionId = 'b';
  rig.layoutController.setPaneSession(0, '');
  rig.layoutController.closePane(1);
  assert.deepEqual(rig.events.filter((event) => event[0] === 'collapse-side-panel').length, 1, 'the owner closed: collapse');

  const reset = createRig(t, { sidePanel: true });
  reset.layoutController.openBeside('b');
  reset.state.ui.sidePanelOwnerSessionId = 'b';
  reset.layoutController.resetPanes();
  assert.equal(reset.events.filter((event) => event[0] === 'collapse-side-panel').length, 0, 'sign-out only clears the owner');
  assert.equal(reset.state.ui.sidePanelOwnerSessionId, '');
});

// Owner gate §D open P3 (the Explorer nudge went stale): a header or full render
// raises jenny:focused-chat-changed when the focused chat, pane 0's chat or
// either one's project moved -- and only then; message renders never do.
test('focused-chat signal: raised by a header/full sync on a focus, session or project change, never unchanged or per message render', (t) => {
  const sessions = [
    { id: 'a', title: 'Alpha', project_id: 'project_general' },
    { id: 'b', title: 'Beta', project_id: 'project_general' },
    { id: 'c', title: 'Gamma', project_id: 'proj_work' },
  ];
  const rig = createRig(t, { sessions });
  let raised = 0;
  rig.dom.window.addEventListener('jenny:focused-chat-changed', () => { raised += 1; });
  rig.composition.syncPaneLayout('all');
  raised = 0; // the first sync records the baseline

  rig.composition.syncPaneLayout('header');
  rig.composition.syncPaneLayout('all');
  assert.equal(raised, 0, 'unchanged: nothing raised');

  rig.state.currentSessionId = 'c'; // one pane: a session switch (or the docked chat)
  rig.composition.syncPaneLayout('messages');
  assert.equal(raised, 0, 'a message render never raises it');
  rig.composition.syncPaneLayout('header');
  assert.equal(raised, 1, 'a session switch raises it once');

  sessions[2].project_id = 'project_general';
  rig.composition.syncPaneLayout('all');
  assert.equal(raised, 2, 'the chat moved to another project');

  rig.layoutController.openBeside('b');
  rig.composition.syncPaneLayout('all');
  const afterOpen = raised;
  rig.layoutController.setFocusedPane(1);
  rig.composition.syncPaneLayout('all');
  assert.equal(raised, afterOpen + 1, 'a pane focus change raises it');
  rig.composition.syncPaneLayout('all');
  assert.equal(raised, afterOpen + 1, 'and once');
});

test('mount: pane 1 gets its own follow state and reasoning controller, handed to all three builders (CTR-001/CTR-010)', (t) => {
  const made = [];
  const rig = createRig(t, { createThinkingController: () => { const controller = { id: `thinking-${made.length + 1}` }; made.push(controller); return controller; } });
  rig.layoutController.openBeside('b');
  const [surface] = rig.built.surface;
  const [pipeline] = rig.built.pipeline;
  const [shell] = rig.built.shell;

  assert.equal(made.length, 1, 'one controller per mounted pane');
  assert.equal(surface.controllers.thinkingController, made[0], 'surface builder gets pane 1 controller');
  assert.equal(pipeline.controllers.thinkingController, made[0], 'render pipeline builder gets pane 1 controller');
  assert.equal(shell.controllers.thinkingController, made[0], 'shell builder gets pane 1 controller');
  assert.equal(pipeline.controllers.scrollCoordinator, null, 'the pipeline keeps its other injected controllers');
  assert.equal(shell.controllers.chatScrollCoordinator, null);
  assert.equal(shell.controllers.timelineVirtualizer, null, 'and the shell keeps the virtualizer slot');

  const follow = surface.followState;
  assert.equal(typeof follow.get, 'function');
  assert.equal(follow.get(), true, 'pane 1 starts following');
  follow.set(false);
  assert.equal(follow.get(), false);
  assert.equal(rig.state.ui.followLatest, undefined, 'pane 1 follow state is not the shared state.ui.followLatest');
  assert.equal(surface.getSessionId(), 'b', 'pane 1 resolves its own session');
  rig.state.currentSessionId = 'a';
  assert.equal(surface.getSessionId(), 'b', 'and not the focused mirror');

  // The pipeline reads pane 1 follow through the surface viewport api.
  assert.equal(typeof pipeline.overrides.isFollowingLatest, 'function');
});

test('mount: a second mounted pane gets a distinct controller and follow state, and a missing factory leaves the builders on the app controller', (t) => {
  const rig = createRig(t, { createThinkingController: () => ({}) });
  rig.layoutController.openBeside('b');
  const first = { controller: rig.built.surface[0].controllers.thinkingController, follow: rig.built.surface[0].followState };
  rig.layoutController.closePane(1);
  rig.layoutController.openBeside('c');
  const second = { controller: rig.built.surface[1].controllers.thinkingController, follow: rig.built.surface[1].followState };
  assert.notEqual(first.controller, second.controller, 'each mount builds a fresh controller');
  assert.notEqual(first.follow, second.follow);
  assert.equal(second.follow.get(), true, 'a re-mounted pane starts following again');

  const plain = createRig(t);
  plain.layoutController.openBeside('b');
  assert.deepEqual(plain.built.surface[0].controllers, {}, 'no factory: no override, the builder keeps the app-level controller');
  assert.equal('thinkingController' in plain.built.pipeline[0].controllers, false);
  assert.equal('thinkingController' in plain.built.shell[0].controllers, false);
});

test('pane 1 re-latches its own follow when its session changes; a focus change alone does not (CTR-001)', (t) => {
  const resumed = [];
  const rig = createRig(t, { createThinkingController: () => ({ resumeAutoScroll: () => resumed.push('resume') }) });
  rig.layoutController.openBeside('b');
  const follow = rig.built.surface[0].followState;
  follow.set(false); // the reader scrolled up in pane 1

  rig.layoutController.setFocusedPane(0);
  assert.equal(follow.get(), false, 'focus alone keeps the reading position');
  assert.deepEqual(resumed, []);

  rig.layoutController.setPaneSession(1, 'c');
  assert.equal(follow.get(), true, 'an incoming session follows its latest reply');
  assert.deepEqual(resumed, ['resume']);
});

test('pane 0 re-latches its follow when a layout change gives it another session; a ratio or focus change does not (CTR-001)', (t) => {
  let relatched = 0;
  const rig = createRig(t, { relatchPrimaryFollow: () => { relatched += 1; } });
  rig.layoutController.openBeside('b');
  rig.layoutController.setFocusedPane(0);
  rig.layoutController.setFocusedPane(1);
  assert.equal(relatched, 0, 'opening a split and moving focus leave pane 0 on its session');

  rig.layoutController.swapPanes();
  assert.equal(relatched, 1, 'a swap shows the other session in pane 0');

  rig.layoutController.closePane(0);
  assert.equal(relatched, 2, 'closing pane 0 moves the surviving session into it');
});
