'use strict';

/* Workspace Chat Dock (ide_chat_dock): the chat transcript + composer subtree
 * relocated into a full-height IDE side column. This suite
 * covers the static host contract (index.html markup + stylesheet import) and
 * the dock module (reconcile / toggle / resize / persist). Standalone JSDOM. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

test('index.html hosts the chat dock aside (hidden, right default) inside #ideShell', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const dock = doc.getElementById('ideChatDock');
  assert.ok(dock, '#ideChatDock exists');
  assert.equal(dock.tagName, 'ASIDE');
  assert.ok(dock.classList.contains('hidden'), 'dock starts hidden');
  assert.equal(dock.dataset.dockSide, 'right', 'right is the default side (decision 1)');
  assert.equal(dock.closest('#ideShell')?.id, 'ideShell', 'dock is an #ideShell column');

  const resizer = doc.getElementById('ideChatDockResizer');
  assert.ok(resizer, '#ideChatDockResizer exists');
  assert.ok(resizer.classList.contains('hidden'), 'resizer starts hidden');
  assert.equal(resizer.getAttribute('role'), 'separator');
  assert.equal(resizer.getAttribute('aria-orientation'), 'vertical');
  assert.equal(resizer.getAttribute('tabindex'), '0');

  assert.ok(doc.getElementById('ideChatDockHeader'), '#ideChatDockHeader exists');
  assert.ok(doc.getElementById('ideChatDockBody'), '#ideChatDockBody exists');
  const inspector = doc.getElementById('subagentInspector');
  assert.ok(inspector, '#subagentInspector exists');
  assert.equal(inspector.closest('#chatThreadStage')?.id, 'chatThreadStage');
  assert.equal(inspector.getAttribute('aria-hidden'), 'true');

  // The dock is the OUTERMOST column: it sits after the secondary sidebar in
  // source order, directly under #ideShell.
  const shell = doc.getElementById('ideShell');
  assert.equal(dock.parentElement, shell, 'dock is a direct #ideShell child');
  const secondary = doc.getElementById('ideSecondarySidebar');
  assert.ok(
    secondary.compareDocumentPosition(dock) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    'dock follows the secondary sidebar'
  );
});

// ---- Dock module (reconcile / toggle / resize / persist) -------------------

const {
  createIdeChatDock,
  MIN_CHAT_DOCK_WIDTH,
  MAX_CHAT_DOCK_WIDTH,
} = require('../renderer/features/renderer-ide-chat-dock');

function setupDock(opts = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <section id="chatView">
      <div id="chatThreadStage"><div id="chatThreadScroll"><div id="chatTimeline">
        <article class="chat-entry" data-message-id="m1"></article>
        <article class="chat-entry" data-message-id="m2"></article>
      </div></div><aside id="subagentInspector" hidden></aside></div>
      <div id="composerWrap"><textarea id="chatInput"></textarea></div>
      <div id="artifactReviewResizer"></div>
      <aside id="artifactReviewPanel"></aside>
    </section>
    <section id="ideView">
      <div id="ideShell">
        <div id="ideMain"><div id="ideEditorHost" tabindex="0"></div></div>
        <aside id="ideChatDock" class="hidden" data-dock-side="right">
          <div id="ideChatDockResizer" class="hidden" role="separator" tabindex="0"></div>
          <header id="ideChatDockHeader"></header>
          <div id="ideChatDockBody"></div>
        </aside>
      </div>
    </section>
  </body>`);
  const doc = dom.window.document;
  opts.configureWindow?.(dom.window);
  const byId = (id) => doc.getElementById(id);
  const state = {
    ui: { activeView: 'view' in opts ? opts.view : 'ide' },
    features: { featureFlags: { ide_chat_dock: opts.flag !== false } },
    sessions: opts.sessions || [{ id: 'session-1', title: 'Session One', session_type: 'chat', updated_at: '2026-08-02T12:00:00.000Z' }],
    currentSessionId: 'currentSessionId' in opts ? opts.currentSessionId : 'session-1',
  };
  if (opts.pendingSessionDeletes) state.ui.pendingSessionDeletes = opts.pendingSessionDeletes;
  const ide = {
    chatDockOpen: 'open' in opts ? opts.open : true,
    chatDockSide: opts.side || 'right',
    chatDockWidth: opts.width || 380,
  };
  const calls = { render: 0, persist: 0, layout: 0, hostChanged: [], newChat: 0, selectSession: [], logs: [], toasts: [] };
  const dock = createIdeChatDock({
    state,
    getDom: () => ({
      ideShell: byId('ideShell'),
      ideChatDock: byId('ideChatDock'),
      ideChatDockResizer: byId('ideChatDockResizer'),
      ideChatDockHeader: byId('ideChatDockHeader'),
      ideChatDockBody: byId('ideChatDockBody'),
    }),
    getIde: () => ide,
    requestRender: () => { calls.render += 1; dock.reconcile(); },
    schedulePersist: () => { calls.persist += 1; },
    layoutIdeEditor: () => { calls.layout += 1; },
    onHostChanged: (docked) => { calls.hostChanged.push(docked); },
    onNewChat: () => { calls.newChat += 1; },
    onSelectSession: async (sessionId) => {
      calls.selectSession.push(sessionId);
      if (opts.onSelectSession) return opts.onSelectSession(sessionId, state);
      state.currentSessionId = sessionId;
      return undefined;
    },
    showShellErrorToast: (...args) => { calls.toasts.push(args); },
    appendClientLog: (level, event, data) => { calls.logs.push({ level, event, data }); },
    getMaxWidth: () => opts.maxWidth ?? Infinity,
    windowRef: dom.window,
    noteProgrammaticWrite: opts.noteProgrammaticWrite,
  });
  return { dom, doc, byId, state, ide, calls, dock };
}

function openSessionPicker(fixture) {
  fixture.dock.reconcile();
  fixture.dock.bindEvents();
  const header = fixture.byId('ideChatDockHeader');
  header.querySelector('[data-ide-chatdock-session-trigger]').click();
  return header;
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const nextTimer = () => new Promise((resolve) => setTimeout(resolve, 0));

test('reconcile moves the 2 chat nodes into the dock body in order and is idempotent', () => {
  const { byId, dock, calls } = setupDock();
  assert.equal(dock.reconcile(), true, 'first reconcile moves');
  const body = byId('ideChatDockBody');
  assert.deepEqual(
    [...body.children].map((el) => el.id),
    ['chatThreadStage', 'composerWrap'],
    'fixed order: transcript | composer'
  );
  assert.equal(calls.layout, 1, 'Monaco relayout after the move');
  assert.deepEqual(calls.hostChanged, [true]);
  assert.equal(
    byId('subagentInspector').closest('#ideChatDockBody')?.id,
    'ideChatDockBody',
    'the single inspector rides inside the moved thread stage'
  );
  // Double-reconcile is a no-op: no re-append, no extra layout.
  assert.equal(dock.reconcile(), false, 'second reconcile no-ops');
  assert.equal(calls.layout, 1);
});

test('leaving Workspace restores the nodes into #chatView before #artifactReviewResizer', () => {
  const { byId, state, dock, calls } = setupDock();
  dock.reconcile();
  state.ui.activeView = 'chat';
  assert.equal(dock.reconcile(), true, 'restore moves');
  const chatView = byId('chatView');
  const ids = [...chatView.children].map((el) => el.id);
  assert.deepEqual(
    ids,
    ['chatThreadStage', 'composerWrap', 'artifactReviewResizer', 'artifactReviewPanel'],
    'original order restored, anchored before the artifact-review resizer'
  );
  assert.deepEqual(calls.hostChanged, [true, false]);
  assert.equal(dock.reconcile(), false, 'restore is idempotent too');
});

test('first dock visit preserves the current logical reader anchor through reflow', async () => {
  const { byId, dock } = setupDock();
  const scroll = byId('chatThreadScroll');
  const row = byId('chatTimeline').children[0];
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 400 },
  });
  scroll.getBoundingClientRect = () => ({ top: 0, bottom: 400 });
  row.getBoundingClientRect = () => ({ top: -10, bottom: 30 });
  scroll.scrollTop = 300;

  dock.reconcile();
  row.getBoundingClientRect = () => ({ top: 50, bottom: 90 });
  await nextTimer();

  assert.equal(scroll.scrollTop, 360);
});

test('dock switches preserve logical anchors separately by session and surface', async () => {
  const { byId, state, dock } = setupDock();
  const scroll = byId('chatThreadScroll');
  const rows = [...byId('chatTimeline').children];
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 400 },
  });
  scroll.getBoundingClientRect = () => ({ top: 0, bottom: 400 });
  rows[0].getBoundingClientRect = () => ({ top: -10, bottom: 30 });
  rows[1].getBoundingClientRect = () => ({ top: 30, bottom: 70 });

  scroll.scrollTop = 300;
  dock.reconcile();
  await nextTimer();

  scroll.scrollTop = 600;
  rows[0].getBoundingClientRect = () => ({ top: -30, bottom: 10 });
  state.ui.activeView = 'chat';
  dock.reconcile();
  rows[0].getBoundingClientRect = () => ({ top: 50, bottom: 90 });
  await nextTimer();
  assert.equal(scroll.scrollTop, 660, 'Chat logical row returns to its original -10px offset after reflow');

  rows[0].getBoundingClientRect = () => ({ top: -10, bottom: 30 });
  state.currentSessionId = 'session-2';
  dock.reconcile();
  await nextTimer();
  scroll.scrollTop = 900;
  rows[0].getBoundingClientRect = () => ({ top: -20, bottom: 20 });
  state.currentSessionId = 'session-1';
  dock.reconcile();
  rows[0].getBoundingClientRect = () => ({ top: 20, bottom: 60 });
  await nextTimer();
  assert.equal(scroll.scrollTop, 930, 'returning to session-1 restores that session surface anchor');
});

test('session transition captures the outgoing transcript before incoming near-bottom markup can overwrite it', async () => {
  const { byId, state, dock } = setupDock({ view: 'chat' });
  const scroll = byId('chatThreadScroll');
  const rows = [...byId('chatTimeline').children];
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 400 },
  });
  scroll.getBoundingClientRect = () => ({ top: 0, bottom: 400 });
  rows[0].getBoundingClientRect = () => ({ top: -10, bottom: 30 });
  rows[1].getBoundingClientRect = () => ({ top: 30, bottom: 70 });

  scroll.scrollTop = 300;
  dock.reconcile();
  assert.equal(dock.prepareSessionTransition('session-1', 'session-2'), true);
  state.currentSessionId = 'session-2';
  scroll.scrollTop = 1600;
  dock.reconcile();
  await nextTimer();

  assert.equal(dock.prepareSessionTransition('session-2', 'session-1'), true);
  state.currentSessionId = 'session-1';
  rows[0].getBoundingClientRect = () => ({ top: 20, bottom: 60 });
  scroll.scrollTop = 1600;
  dock.reconcile();
  await nextTimer();

  assert.equal(scroll.scrollTop, 1630, 'session-1 restores its logical offset instead of session-2 near-bottom intent');
  assert.equal(state.ui.followLatest, false);
});

test('stale delayed anchor restore is fenced after the current session changes', () => {
  const frames = [];
  const { byId, state, dock } = setupDock({
    view: 'chat',
    configureWindow(windowRef) {
      windowRef.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
      windowRef.cancelAnimationFrame = () => {};
    },
  });
  const scroll = byId('chatThreadScroll');
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 400 },
  });
  scroll.scrollTop = 300;
  dock.reconcile();
  dock.prepareSessionTransition('session-1', 'session-2');
  state.currentSessionId = 'session-2';
  dock.reconcile();
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(frames.length, 1);
  state.currentSessionId = 'session-3';
  scroll.scrollTop = 900;
  frames.shift()();

  assert.equal(scroll.scrollTop, 900);
});

test('dock anchor restore carries near-bottom follow intent', async () => {
  const { byId, state, dock } = setupDock();
  const scroll = byId('chatThreadScroll');
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 400 },
  });
  scroll.scrollTop = 1600;
  dock.reconcile();
  await nextTimer();

  scroll.scrollTop = 200;
  state.ui.activeView = 'chat';
  dock.reconcile();
  await nextTimer();

  assert.equal(scroll.scrollTop, 1600);
  assert.equal(state.ui.followLatest, true);
});

test('dock disposal cancels a pending anchor restore timer', async () => {
  const { byId, dock } = setupDock();
  const scroll = byId('chatThreadScroll');
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 300 },
  });
  scroll.scrollTop = 240;
  dock.reconcile();
  dock.dispose();
  await nextTurn();
  assert.equal(scroll.scrollTop, 240);
});

test('dock disposal cancels both animation-frame stages and fences a stale callback', () => {
  const frames = [];
  const cancelled = [];
  const { dock } = setupDock({
    configureWindow(windowRef) {
      windowRef.requestAnimationFrame = (callback) => {
        frames.push(callback);
        return frames.length;
      };
      windowRef.cancelAnimationFrame = (id) => { cancelled.push(id); };
    },
  });
  dock.reconcile();
  assert.equal(frames.length, 1);
  dock.dispose();
  assert.deepEqual(cancelled, [1]);
  frames[0]();
  assert.equal(frames.length, 1, 'an already-delivered first-stage callback cannot queue post-dispose work');
  assert.equal(dock.reconcile(), false);
});

test('missing dock body leaves Chat mounted and does not record a false Workspace anchor', () => {
  const { byId, dock } = setupDock();
  byId('ideChatDockBody').remove();

  assert.equal(dock.reconcile(), false);
  assert.equal(byId('chatThreadStage').parentElement.id, 'chatView');
});

test('flag-off reconcile never docks, never touches hosts, never writes shell attrs (byte-identical contract)', () => {
  const { byId, dock } = setupDock({ flag: false });
  assert.equal(dock.reconcile(), false);
  assert.equal(byId('ideChatDockBody').children.length, 0);
  assert.equal(byId('chatThreadStage').parentElement.id, 'chatView');
  assert.equal(byId('ideShell').hasAttribute('data-chatdock-open'), false, 'no dock attribute appears flag-off');
  assert.equal(byId('ideShell').style.getPropertyValue('--ide-chat-dock-width'), '', 'no width var appears flag-off');
  assert.equal(byId('ideChatDockHeader').innerHTML, '', 'no header chrome renders flag-off');
  // Toggle entry points are inert flag-off: open() refuses even when bound
  // (bind is unconditional to dodge the flag-hydration race; behavior gates live).
  dock.bindEvents();
  dock.open();
  assert.equal(dock.reconcile(), false);
  assert.equal(byId('ideChatDockBody').children.length, 0);
  assert.equal(byId('ideShell').hasAttribute('data-chatdock-open'), false);
});

test('toggle flips [data-chatdock-open] + the state.ui.ideChatDockOpen mirror and persists', () => {
  const { byId, state, ide, dock, calls } = setupDock({ open: false });
  dock.reconcile();
  assert.equal(byId('ideShell').getAttribute('data-chatdock-open'), 'false');
  assert.equal(state.ui.ideChatDockOpen, false);

  dock.toggle();
  assert.equal(ide.chatDockOpen, true);
  assert.equal(state.ui.ideChatDockOpen, true);
  assert.equal(byId('ideShell').getAttribute('data-chatdock-open'), 'true');
  assert.equal(byId('ideShell').getAttribute('data-chatdock-side'), 'right');
  assert.ok(calls.persist >= 1, 'toggle persists');
  assert.equal(byId('ideChatDock').classList.contains('hidden'), false);
  assert.equal(byId('chatThreadStage').parentElement.id, 'ideChatDockBody', 'open() docks via requestRender');
  // Opening focuses the composer (§11 #7).
  assert.equal(byId('chatInput').ownerDocument.activeElement?.id, 'chatInput');

  dock.toggle();
  assert.equal(ide.chatDockOpen, false);
  assert.equal(state.ui.ideChatDockOpen, false);
  assert.equal(byId('ideShell').getAttribute('data-chatdock-open'), 'false');
  assert.equal(byId('chatThreadStage').parentElement.id, 'chatView', 'close() restores');
});

test('the resizer clamps 280-2400, is side-aware, and writes the width var', () => {
  const { byId, ide, dock, dom, calls } = setupDock({ width: 380 });
  dock.reconcile();
  dock.bindEvents();
  const resizer = byId('ideChatDockResizer');
  const shell = byId('ideShell');

  // Pointer drag on the RIGHT dock: dragging left (clientX shrinks) widens.
  resizer.dispatchEvent(new dom.window.PointerEvent('pointerdown', { clientX: 1000, bubbles: true }));
  dom.window.dispatchEvent(new dom.window.PointerEvent('pointermove', { clientX: 900 }));
  assert.equal(ide.chatDockWidth, 480);
  assert.equal(shell.style.getPropertyValue('--ide-chat-dock-width'), '480px');
  // Clamp at MAX on a huge drag.
  dom.window.dispatchEvent(new dom.window.PointerEvent('pointermove', { clientX: -3000 }));
  assert.equal(ide.chatDockWidth, MAX_CHAT_DOCK_WIDTH);
  dom.window.dispatchEvent(new dom.window.PointerEvent('pointerup', {}));
  assert.ok(calls.persist >= 1, 'drag end persists');

  // Clamp at MIN via keyboard (right dock: ArrowRight shrinks).
  ide.chatDockWidth = 290;
  for (let i = 0; i < 5; i += 1) {
    resizer.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  }
  assert.equal(ide.chatDockWidth, MIN_CHAT_DOCK_WIDTH);
  // Right dock: ArrowLeft grows.
  resizer.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(ide.chatDockWidth, MIN_CHAT_DOCK_WIDTH + 24);

  assert.equal(MIN_CHAT_DOCK_WIDTH, 280);
  assert.equal(MAX_CHAT_DOCK_WIDTH, 2400);
});

test('viewport maximum clamps display without overwriting a wider persisted preference', () => {
  const { byId, ide, dock } = setupDock({ width: 1800, maxWidth: 760 });
  dock.reconcile();
  const shell = byId('ideShell');
  const resizer = byId('ideChatDockResizer');
  assert.equal(shell.style.getPropertyValue('--ide-chat-dock-width'), '760px');
  assert.equal(ide.chatDockWidth, 1800, 'display clamp preserves the persisted request');
  assert.equal(resizer.getAttribute('aria-valuemin'), '280');
  assert.equal(resizer.getAttribute('aria-valuemax'), '760');
  assert.equal(resizer.getAttribute('aria-valuenow'), '760');
});

test('the featherweight header renders the active session picker + new-chat + collapse', () => {
  const { byId, dock, calls, dom } = setupDock();
  dock.reconcile();
  dock.bindEvents();
  const header = byId('ideChatDockHeader');
  assert.match(header.textContent, /Jenny · Session One/);
  const trigger = header.querySelector('[data-ide-chatdock-session-trigger]');
  assert.ok(trigger, 'session trigger present');
  assert.equal(trigger.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(trigger.getAttribute('title'), 'Switch chat session. Current: Session One');
  assert.ok(header.querySelector('#ideChatDockSessionPicker').hidden, 'picker starts closed');
  const newChat = header.querySelector('[data-ide-chatdock-new-chat]');
  const collapse = header.querySelector('[data-ide-chatdock-collapse]');
  assert.ok(newChat, 'new-chat action present');
  assert.ok(collapse, 'collapse action present');
  assert.equal(collapse.getAttribute('aria-label'), 'Collapse chat dock');
  newChat.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(calls.newChat, 1, 'new-chat click invokes the new-session callback');
  trigger.click();
  assert.equal(header.querySelector('#ideChatDockSessionPicker').hidden, false);
  collapse.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(byId('ideShell').getAttribute('data-chatdock-open'), 'false', 'collapse closes the dock');
  assert.equal(header.querySelector('#ideChatDockSessionPicker').hidden, true, 'collapse also closes the picker');
});

test('session picker shows active + recent chats and filters plugin, archived, and pending-delete sessions', () => {
  const chats = Array.from({ length: 15 }, (_, index) => ({
    id: `chat-${index + 1}`,
    title: `Conversation ${index + 1}`,
    session_type: 'chat',
    updated_at: `2026-08-${String(15 - index).padStart(2, '0')}T12:00:00.000Z`,
  }));
  const sessions = chats.concat(
    { id: 'plugin-1', title: 'Image session', session_type: 'plugin', updated_at: '2026-08-20T12:00:00.000Z' },
    { id: 'archived-1', title: 'Archived chat', session_type: 'chat', archived_at: '2026-08-19T12:00:00.000Z' },
    { id: 'legacy-chat', title: '', updated_at: '2026-08-18T12:00:00.000Z' }
  );
  const fixture = setupDock({ sessions, currentSessionId: 'chat-15', pendingSessionDeletes: ['chat-2'] });
  const header = openSessionPicker(fixture);
  const options = [...header.querySelectorAll('[data-ide-chatdock-session-id]')];
  assert.equal(options.length, 12, 'active + eleven recent eligible sessions');
  assert.equal(options[0].dataset.ideChatdockSessionId, 'chat-15', 'active session is pinned first');
  assert.equal(options[0].getAttribute('aria-selected'), 'true');
  assert.ok(options.every((option) => option.getAttribute('title') === 'Switch chat session'));
  const ids = options.map((option) => option.dataset.ideChatdockSessionId);
  assert.equal(ids.includes('plugin-1'), false);
  assert.equal(ids.includes('archived-1'), false);
  assert.equal(ids.includes('chat-2'), false);
  assert.equal(ids.includes('legacy-chat'), true, 'missing session_type is treated as chat');
});

test('session picker searches all eligible titles, reports truncation, and resets after close', () => {
  const sessions = Array.from({ length: 55 }, (_, index) => ({
    id: `match-${index + 1}`,
    title: `Match session ${index + 1}`,
    session_type: 'chat',
    updated_at: `2026-08-01T12:${String(index).padStart(2, '0')}:00.000Z`,
  })).concat({ id: 'other', title: 'Different title', session_type: 'chat' });
  const fixture = setupDock({ sessions, currentSessionId: 'other' });
  const { dom } = fixture;
  const header = openSessionPicker(fixture);
  const trigger = header.querySelector('[data-ide-chatdock-session-trigger]');
  const input = header.querySelector('[data-ide-chatdock-session-search]');
  input.value = 'match session';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(header.querySelectorAll('[data-ide-chatdock-session-id]').length, 50);
  assert.equal(header.querySelector('.ide-chat-dock-session-status').textContent, 'Showing first 50 of 55 matches');
  input.value = 'not present';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.match(header.querySelector('.ide-chat-dock-session-list').textContent, /No chats found/);
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(input.value, '', 'closing resets the query');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

test('session picker keyboard navigation selects through the workspace callback', async () => {
  const sessions = [
    { id: 'session-1', title: 'First', session_type: 'chat', updated_at: '2026-08-03T00:00:00.000Z' },
    { id: 'session-2', title: 'Second', session_type: 'chat', updated_at: '2026-08-02T00:00:00.000Z' },
    { id: 'session-3', title: 'Third', session_type: 'chat', updated_at: '2026-08-01T00:00:00.000Z' },
  ];
  const fixture = setupDock({ sessions, currentSessionId: 'session-1' });
  const { dom, calls, state } = fixture;
  const header = openSessionPicker(fixture);
  const input = header.querySelector('[data-ide-chatdock-session-search]');
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  const first = dom.window.document.activeElement;
  assert.equal(first.dataset.ideChatdockSessionId, 'session-1');
  first.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  const second = dom.window.document.activeElement;
  assert.equal(second.dataset.ideChatdockSessionId, 'session-2');
  second.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await nextTurn();
  assert.deepEqual(calls.selectSession, ['session-2']);
  assert.equal(state.currentSessionId, 'session-2');
  assert.equal(header.querySelector('[data-ide-chatdock-session-title]').textContent, 'Jenny · Second');
  assert.equal(dom.window.document.activeElement, header.querySelector('[data-ide-chatdock-session-trigger]'));
});

test('session picker no-ops the active choice, rejects duplicate switches, and reports failures', async () => {
  const sessions = [
    { id: 'session-1', title: 'First', session_type: 'chat' },
    { id: 'session-2', title: 'Second', session_type: 'chat' },
  ];
  let releaseSwitch;
  const switchPromise = new Promise((resolve) => { releaseSwitch = resolve; });
  const pending = setupDock({
    sessions,
    currentSessionId: 'session-1',
    onSelectSession: async (sessionId, state) => { await switchPromise; state.currentSessionId = sessionId; },
  });
  const pendingHeader = openSessionPicker(pending);
  pendingHeader.querySelector('[data-ide-chatdock-session-id="session-1"]').click();
  assert.deepEqual(pending.calls.selectSession, [], 'active selection is a no-op');
  pendingHeader.querySelector('[data-ide-chatdock-session-trigger]').click();
  pendingHeader.querySelector('[data-ide-chatdock-session-id="session-2"]').click();
  pendingHeader.querySelector('[data-ide-chatdock-session-trigger]').click();
  assert.ok(pendingHeader.querySelector('[data-ide-chatdock-session-id="session-1"]').disabled);
  pendingHeader.querySelector('[data-ide-chatdock-session-id="session-1"]').click();
  assert.deepEqual(pending.calls.selectSession, ['session-2']);
  releaseSwitch();
  await nextTurn();

  const failed = setupDock({ sessions, onSelectSession: async () => { throw new Error('switch exploded'); } });
  const failedHeader = openSessionPicker(failed);
  failedHeader.querySelector('[data-ide-chatdock-session-id="session-2"]').click();
  await nextTurn();
  assert.equal(failed.state.currentSessionId, 'session-1');
  assert.equal(failed.calls.toasts.length, 1);
  assert.equal(failed.calls.logs.some((entry) => entry.event === 'ide_chat_dock.session_switch_failed'), true);
});

test('session picker fences a late switch failure after disposal', async () => {
  let rejectSwitch;
  const switchPromise = new Promise((_resolve, reject) => { rejectSwitch = reject; });
  const setup = setupDock({
    sessions: [
      { id: 'session-1', title: 'First', session_type: 'chat' },
      { id: 'session-2', title: 'Second', session_type: 'chat' },
    ],
    onSelectSession: () => switchPromise,
  });
  const header = openSessionPicker(setup);
  header.querySelector('[data-ide-chatdock-session-id="session-2"]').click();
  setup.dock.dispose();
  rejectSwitch(new Error('late failure'));
  await nextTurn();
  assert.equal(setup.calls.toasts.length, 0);
  assert.equal(setup.calls.logs.some((entry) => entry.event === 'ide_chat_dock.session_switch_failed'), false);
});

test('styles.css imports the bounded chat-dock styles after the chat media queries', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const mediaIdx = css.indexOf('./styles/chat-media-queries.css');
  const monitorIdx = css.indexOf('./styles/chat-subagent-monitor.css');
  const dockIdx = css.indexOf('./styles/ide-chat-dock.css');
  const pickerIdx = css.indexOf('./styles/ide-chat-session-picker.css');
  assert.ok(mediaIdx >= 0, 'chat-media-queries import present');
  assert.ok(monitorIdx > mediaIdx, 'subagent monitor styles follow main chat media rules');
  assert.ok(dockIdx > monitorIdx, 'dock overrides load after subagent monitor styles');
  assert.ok(pickerIdx > dockIdx, 'session-picker styles imported after the dock layout');
  assert.ok(fs.existsSync(path.join(ROOT, 'styles', 'ide-chat-dock.css')), 'styles/ide-chat-dock.css exists');
  assert.ok(fs.existsSync(path.join(ROOT, 'styles', 'chat-subagent-monitor.css')), 'styles/chat-subagent-monitor.css exists');
  assert.ok(fs.existsSync(path.join(ROOT, 'styles', 'ide-chat-session-picker.css')), 'styles/ide-chat-session-picker.css exists');
});

test('wide subagent monitor puts the chat shell in the first grid column', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles', 'chat-subagent-monitor.css'), 'utf8');
  assert.match(css, /subagent-monitor-stage-open:not\(\.subagent-monitor-stage-compact\) > \.chat-thread-shell[\s\S]*position:\s*relative;[\s\S]*grid-column:\s*1;/);
  assert.match(css, /\.subagent-monitor-inspector\s*\{[\s\S]*grid-column:\s*2;[\s\S]*grid-row:\s*1;/);
});

// ── Step 7: dock CSS contract pins (styles/ide-chat-dock.css) ──────────────
// jsdom does not compute grid layout from stylesheets, so the movable-matrix
// and suppression contracts are pinned at the source level; the attribute
// drivers ([data-chatdock-*], width var) are behavior-tested above.

const DOCK_CSS = fs.readFileSync(path.join(ROOT, 'styles', 'ide-chat-dock.css'), 'utf8')
  // Strip comments: the header comment QUOTES the forbidden patterns (".composer::after",
  // gradients) as prose, so guardrail scans must only see code.
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('grid matrix: all 8 open variants present, dock outermost, gated on data-chatdock-open', () => {
  const areas = [
    '"main rail chatdock"',
    '"chatdock main rail"',
    '"secondary main rail chatdock"',
    '"chatdock secondary main rail"',
    '"rail main chatdock"',
    '"chatdock rail main"',
    '"rail main secondary chatdock"',
    '"chatdock rail main secondary"',
  ];
  for (const area of areas) {
    assert.ok(DOCK_CSS.includes(`grid-template-areas: ${area};`), `matrix variant ${area}`);
  }
  // Every template rewrite is gated on the open attribute, so the 4 closed-case
  // rules in ide-view.css stay byte-identical (flag-off/closed regression pin).
  const rewrites = (DOCK_CSS.match(/grid-template-areas/g) || []).length;
  const gated = (DOCK_CSS.match(/data-chatdock-open="true"[^{]*\{[^}]*grid-template-areas/g) || []).length;
  assert.equal(rewrites, 10, '8 matrix variants + 2 stacked-narrow rewrites');
  assert.equal(rewrites, gated, 'every shell grid-template-areas rewrite is [data-chatdock-open="true"]-gated');
});

test('stacked-narrow (<860px): dock is the FIRST row above main and the resizer hides', () => {
  const mediaStart = DOCK_CSS.indexOf('@media (max-width: 860px)');
  assert.ok(mediaStart >= 0, 'stacked-narrow media block present');
  const media = DOCK_CSS.slice(mediaStart);
  assert.ok(media.includes('"chatdock" "main" "rail"'), 'dock stacks above main (no secondary)');
  assert.ok(media.includes('"chatdock" "main" "secondary" "rail"'), 'dock stacks above main (secondary open)');
  assert.match(media, /\.ide-chat-dock-resizer \{\s*display: none;/, 'resizer hidden while stacked');
  assert.ok(media.includes('max-height: 50%'), 'stacked dock caps at half height');

  const desktopVariants = [
    '.ide-shell[data-chatdock-open="true"]:not([data-rail-side="left"]):not([data-secondary-open="true"]):not([data-chatdock-side="left"])',
    '.ide-shell[data-chatdock-open="true"]:not([data-rail-side="left"]):not([data-secondary-open="true"])[data-chatdock-side="left"]',
    '.ide-shell[data-chatdock-open="true"][data-rail-side="left"]:not([data-secondary-open="true"]):not([data-chatdock-side="left"])',
    '.ide-shell[data-chatdock-open="true"][data-rail-side="left"]:not([data-secondary-open="true"])[data-chatdock-side="left"]',
    '.ide-shell[data-chatdock-open="true"]:not([data-rail-side="left"])[data-secondary-open="true"]:not([data-chatdock-side="left"])',
    '.ide-shell[data-chatdock-open="true"]:not([data-rail-side="left"])[data-secondary-open="true"][data-chatdock-side="left"]',
    '.ide-shell[data-chatdock-open="true"][data-rail-side="left"][data-secondary-open="true"]:not([data-chatdock-side="left"])',
    '.ide-shell[data-chatdock-open="true"][data-rail-side="left"][data-secondary-open="true"][data-chatdock-side="left"]',
  ];
  for (const selector of desktopVariants) {
    assert.ok(
      media.includes(selector),
      `stacked rule should match desktop selector specificity for ${selector}`
    );
  }
});

test('dock body is the chatdock @container and re-derives the chat width vars', () => {
  assert.ok(DOCK_CSS.includes('container-type: inline-size'), 'dock body establishes a size container');
  assert.ok(DOCK_CSS.includes('container-name: chatdock'), 'container is named chatdock');
  assert.ok(DOCK_CSS.includes('@container chatdock (max-width: 700px)'), 'narrow port keys off dock width');
  assert.ok(DOCK_CSS.includes('--content-column-width: min(100%, calc(var(--ide-chat-dock-width, 380px) - 24px))'));
  assert.ok(DOCK_CSS.includes('--composer-width: min(100%, calc(var(--ide-chat-dock-width, 380px) - 32px))'));
  assert.ok(DOCK_CSS.includes(
    '--chat-user-bubble-max-width: max(0px, calc(100% - var(--thread-dot-hit-size) - var(--space-5)))'
  ));
  assert.equal(DOCK_CSS.includes('--chat-user-bubble-max-width: 100%'), false);
});

test('dock thread indentation spends no extra gutter at depth 1 and flattens after depth 2', () => {
  assert.match(DOCK_CSS, /chat-thread-children\[data-thread-depth="1"\]\s*\{\s*padding-left:\s*0;/);
  assert.match(DOCK_CSS, /chat-thread-children\[data-thread-depth="2"\]\s*\{\s*padding-left:\s*var\(--space-3\);/);
  assert.match(DOCK_CSS, /chat-thread-children:not\(\[data-thread-depth="1"\]\):not\(\[data-thread-depth="2"\]\)\s*\{\s*padding-left:\s*0;/);
});

test('compact dock nodes keep primary semantic fills with a protected edge gutter', () => {
  const compactStart = DOCK_CSS.indexOf('@container chatdock (max-width: 700px)');
  const compactEnd = DOCK_CSS.indexOf('@media (max-width: 860px)', compactStart);
  assert.ok(compactStart >= 0, 'compact dock container exists');
  assert.ok(compactEnd > compactStart, 'compact overrides end before stacked layout rules');
  const compactCss = DOCK_CSS.slice(compactStart, compactEnd);
  assert.match(compactCss, /\.chat-thread-column\s*\{[\s\S]*?padding-left:\s*var\(--space-3\);/);
  assert.match(compactCss, /--thread-dot-size:\s*calc\(7px \* var\(--chat-zoom-factor, 1\)\);/);
  assert.match(
    compactCss,
    /\.chat-thread-toggle::before,[\s\S]*?\.chat-thread-toggle-spacer::before,[\s\S]*?\.chat-row-node-dot\s*\{[\s\S]*?border-width:\s*1px;/
  );
  assert.equal(
    DOCK_CSS.slice(0, compactStart).includes('--thread-dot-size'),
    false,
    'primary Chat and wide dock dot sizing remain untouched'
  );
});

test('chat-active mirror reveals the moved thread shell (transcript visibility, load-bearing)', () => {
  const revealIdx = DOCK_CSS.indexOf('.ide-chat-dock-body.chat-active .chat-thread-shell');
  assert.ok(revealIdx >= 0, 'reveal rule present — base .chat-thread-shell is opacity:0 outside .chat-view.chat-active');
  const block = DOCK_CSS.slice(revealIdx, DOCK_CSS.indexOf('}', revealIdx));
  assert.ok(block.includes('opacity: 1'), 'shell opaque when dock body carries .chat-active');
  assert.ok(block.includes('pointer-events: auto'), 'shell interactive when active');
});

test('simplified-dock suppression: sprite and terminal shortcut hidden (§7 + §17.1)', () => {
  assert.match(DOCK_CSS, /\.ide-chat-dock-body \.chat-sprite-layer \{\s*display: none;/);
  assert.ok(DOCK_CSS.includes('--chat-sprite-size: 0px'), 'sprite size zeroed');
  assert.ok(DOCK_CSS.includes('--chat-sprite-rail-offset: 0px'), 'thread column rail offset zeroed');
  assert.match(DOCK_CSS, /\.ide-chat-dock-body #composerTerminalShortcut \{\s*display: none;/);
  assert.doesNotMatch(DOCK_CSS, /composer-mode-chip-research/, 'retired research chip has no dead CSS');
});

test('holo + palette guardrails: no composer holo suppression, no gradients, no raw hex, no bottom-panel coupling', () => {
  assert.ok(!DOCK_CSS.includes('box-shadow'), 'no box-shadow anywhere — the composer holo ring is untouched');
  assert.ok(!/composer[^\n{]*::after/.test(DOCK_CSS), 'no rule targets the composer ::after holo ring');
  assert.ok(!DOCK_CSS.includes('data-composer-holo'), 'holo state attribute never keyed on');
  assert.ok(!/gradient\(/.test(DOCK_CSS), 'no gradients');
  assert.ok(!/#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b/.test(DOCK_CSS), 'no hardcoded hex colors (palette vars only)');
  assert.ok(!/bottom-panel|data-bottom/i.test(DOCK_CSS), 'fully independent of the shared bottom panel');
  assert.match(DOCK_CSS, /\.ide-chat-dock\.hidden \{\s*display: none;/, 'flag-off/closed aside stays display:none via .hidden');
});

test('dock open/close/resize never touches bottom-panel or foreign shell state (independence)', () => {
  const { byId, dock } = setupDock({ open: false });
  const shell = byId('ideShell');
  const main = byId('ideMain');
  main.setAttribute('data-bottom-panel-open', 'true'); // stand-in for the bottom panel driver
  shell.setAttribute('data-secondary-open', 'true');
  dock.toggle(); // open
  dock.reconcile();
  dock.toggle(); // close
  dock.reconcile();
  assert.equal(main.getAttribute('data-bottom-panel-open'), 'true', 'bottom panel state untouched');
  assert.equal(shell.getAttribute('data-secondary-open'), 'true', 'secondary sidebar state untouched');
  const foreign = [...shell.attributes].map((a) => a.name).filter((n) => n.startsWith('data-') && !n.startsWith('data-chatdock'));
  assert.deepEqual(foreign, ['data-secondary-open'], 'dock only writes data-chatdock-* attributes on the shell');
});

test('undocking keeps focus in the chat composer', () => {
  const { byId, dock } = setupDock();
  dock.reconcile();
  byId('chatInput').focus();

  dock.toggle();

  assert.equal(byId('chatInput').ownerDocument.activeElement?.id, 'chatInput');
});

test('plain re-docking keeps focus in the chat composer', () => {
  const { byId, ide, dock } = setupDock({ open: false });
  dock.reconcile();
  byId('chatInput').focus();

  ide.chatDockOpen = true;
  dock.reconcile();

  assert.equal(byId('chatInput').ownerDocument.activeElement?.id, 'chatInput');
});

test('open focuses the composer once without leaking intent into a later re-dock', () => {
  const { byId, ide, dock, dom } = setupDock({ open: false });
  dock.reconcile();
  const focusTarget = dom.window.document.createElement('button');
  focusTarget.id = 'composerFocusTarget';
  byId('composerWrap').appendChild(focusTarget);
  focusTarget.focus();

  dock.open();
  assert.equal(byId('chatInput').ownerDocument.activeElement?.id, 'chatInput');

  focusTarget.focus();
  ide.chatDockOpen = false;
  dock.reconcile();
  ide.chatDockOpen = true;
  dock.reconcile();
  assert.equal(byId('chatInput').ownerDocument.activeElement?.id, 'composerFocusTarget');
});

test('undocking dock chrome focus still falls back to the editor', () => {
  const { byId, dock } = setupDock();
  dock.reconcile();
  const collapse = byId('ideChatDockHeader').querySelector('[data-ide-chatdock-collapse]');
  collapse.focus();

  dock.toggle();

  assert.equal(byId('chatInput').ownerDocument.activeElement?.id, 'ideEditorHost');
});

test('reparenting in either direction never steals unrelated focus', () => {
  const { byId, ide, dock, dom } = setupDock({ open: false });
  const unrelated = dom.window.document.createElement('button');
  unrelated.id = 'unrelatedFocusTarget';
  dom.window.document.body.appendChild(unrelated);
  dock.reconcile();
  unrelated.focus();

  ide.chatDockOpen = true;
  dock.reconcile();
  assert.equal(byId('chatInput').ownerDocument.activeElement?.id, 'unrelatedFocusTarget');

  ide.chatDockOpen = false;
  dock.reconcile();
  assert.equal(byId('chatInput').ownerDocument.activeElement?.id, 'unrelatedFocusTarget');
});

// Scroll-program W3: dock anchor restores write scrollTop on the SAME
// container the scroll coordinator watches. Unattributed, they would emit the
// chat.scroll_jump_unattributed flicker signature on every host move or
// dock session switch — so the dock reports its restores through an optional
// noteProgrammaticWrite dep (threaded from the coordinator).
test('dock anchor restores report a programmatic write before touching scrollTop', async () => {
  const writes = [];
  const { byId, state, dock } = setupDock({
    view: 'chat',
    noteProgrammaticWrite: (reason) => writes.push(reason),
  });
  const scroll = byId('chatThreadScroll');
  const rows = [...byId('chatTimeline').children];
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 400 },
  });
  scroll.getBoundingClientRect = () => ({ top: 0, bottom: 400 });
  rows[0].getBoundingClientRect = () => ({ top: -10, bottom: 30 });
  rows[1].getBoundingClientRect = () => ({ top: 30, bottom: 70 });

  scroll.scrollTop = 300;
  dock.reconcile();
  assert.equal(dock.prepareSessionTransition('session-1', 'session-2'), true);
  state.currentSessionId = 'session-2';
  scroll.scrollTop = 1600;
  dock.reconcile();
  await nextTimer();

  assert.equal(dock.prepareSessionTransition('session-2', 'session-1'), true);
  state.currentSessionId = 'session-1';
  rows[0].getBoundingClientRect = () => ({ top: 20, bottom: 60 });
  scroll.scrollTop = 1600;
  dock.reconcile();
  writes.length = 0;
  await nextTimer();

  assert.equal(scroll.scrollTop, 1630, 'the restore itself still lands');
  assert.ok(writes.length >= 1, 'the restore must be attributed before its scroll event is seen');
  assert.ok(writes.every((reason) => reason === 'anchor_restore'), JSON.stringify(writes));
});

// Pre-land fix (codex finding): a restore whose outcome is missing/unavailable
// wrote nothing — arming attribution anyway would label the reader's next
// genuine scroll as anchor_restore, hiding exactly the diagnostic the
// telemetry exists to surface. Attribution arms only for outcomes that wrote.
test('a missing anchor restore does not arm attribution', async () => {
  const writes = [];
  const { byId, state, dock } = setupDock({
    view: 'chat',
    noteProgrammaticWrite: (reason) => writes.push(reason),
  });
  const scroll = byId('chatThreadScroll');
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 2000 },
    clientHeight: { configurable: true, value: 400 },
  });
  scroll.getBoundingClientRect = () => ({ top: 0, bottom: 400 });

  scroll.scrollTop = 300;
  dock.reconcile();
  assert.equal(dock.prepareSessionTransition('session-1', 'session-fresh'), true);
  state.currentSessionId = 'session-fresh';
  writes.length = 0;
  dock.reconcile();
  await nextTimer();

  assert.equal(scroll.scrollTop, 300, 'a missing restore writes nothing');
  assert.deepEqual(writes, [], 'and must not attribute the reader\'s next frame');
});
