'use strict';

/* Tier-2 Layout foundation: the bottom-panel container. Covers tab rendering +
 * the collapse control, view switching (open/close/toggle/setActiveView), the
 * open-state gate (closed = no content churn), the Run-output placeholder, and
 * the top-edge resize drag (pointer + keyboard, clamped). Standalone JSDOM,
 * mirroring the problems-panel test pattern. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createIdeBottomPanel,
  MIN_BOTTOM_HEIGHT,
  MAX_BOTTOM_HEIGHT,
} = require('../renderer/features/renderer-ide-bottom-panel');

function setup(opts = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="ideShell">
      <div id="ideBottomResizer" class="hidden"></div>
      <div id="ideBottomPanel" class="hidden" data-open="false">
        <div id="ideBottomTabs"></div>
        <div id="ideBottomTerminalHost" class="hidden"></div>
        <div id="ideBottomPanelContent"></div>
      </div>
      <div id="ideBottomHandle" class="hidden"></div>
    </div>
  </body>`);
  const doc = dom.window.document;
  const prevWindow = globalThis.window;
  globalThis.window = dom.window;
  const byId = (id) => doc.getElementById(id);
  const ide = {
    bottomPanelOpen: opts.open !== false,
    bottomPanelHeight: opts.height || 220,
    bottomPanelActiveView: opts.activeView || 'terminal',
  };
  const calls = { render: 0, persist: 0, terminal: 0, problems: 0, testRunner: 0 };
  // UIUX-011: opts.persistentTerminalHost mirrors the real controller wiring
  // once workspace_pty_terminal is on — Terminal paints into its own persistent
  // #ideBottomTerminalHost instead of the shared #ideBottomPanelContent that
  // Problems/Run/Test Runner innerHTML-replace on every activation.
  const persistentTerminalHost = opts.persistentTerminalHost === true;
  const panel = createIdeBottomPanel({
    getDom: () => ({
      ideShell: byId('ideShell'),
      ideBottomResizer: byId('ideBottomResizer'),
      ideBottomPanel: byId('ideBottomPanel'),
      ideBottomTabs: byId('ideBottomTabs'),
      ideBottomPanelContent: byId('ideBottomPanelContent'),
      ideBottomTerminalHost: byId('ideBottomTerminalHost'),
      ideBottomHandle: byId('ideBottomHandle'),
    }),
    getIde: () => ide,
    // Mirror the controller: requestRender re-renders the whole layout (here just
    // the bottom panel) so a tab click repaints.
    requestRender: () => { calls.render += 1; panel.render(); },
    schedulePersist: () => { calls.persist += 1; },
    renderTerminal: () => {
      calls.terminal += 1;
      const host = persistentTerminalHost ? byId('ideBottomTerminalHost') : byId('ideBottomPanelContent');
      host.innerHTML = '<div class="ide-terminal-panel"></div>';
    },
    renderProblems: () => { calls.problems += 1; byId('ideBottomPanelContent').innerHTML = '<div class="ide-prb"></div>'; },
    ...(opts.wireTestRunner
      ? { renderTestRunner: () => { calls.testRunner += 1; byId('ideBottomPanelContent').innerHTML = '<div class="ide-test-runner-panel"></div>'; } }
      : {}),
    ...(persistentTerminalHost ? { hasPersistentTerminalHost: () => true } : {}),
  });
  panel.bindEvents();
  panel.render();
  function dispose() {
    panel.dispose();
    globalThis.window = prevWindow;
  }
  return { dom, doc, byId, ide, calls, panel, dispose };
}

test('renders a tab per view + a collapse control and paints the active view', (t) => {
  const h = setup();
  t.after(() => h.dispose());
  const tabs = [...h.byId('ideBottomTabs').querySelectorAll('[data-ide-bottom-view]')];
  assert.deepEqual(tabs.map((b) => b.dataset.ideBottomView), ['terminal', 'problems', 'run', 'test-runner']);
  // View tabs carry tab semantics inside the role="tablist" nav (index.html).
  assert.ok(tabs.every((b) => b.getAttribute('role') === 'tab'), 'view buttons are tabs');
  assert.equal(
    tabs.find((b) => b.dataset.ideBottomView === 'terminal').getAttribute('aria-selected'),
    'true',
    'the active tab is aria-selected',
  );
  assert.equal(tabs.every((b) => !b.hasAttribute('aria-pressed')), true, 'no toggle-button semantics');
  assert.ok(h.byId('ideBottomTabs').querySelector('[data-ide-bottom-collapse]'), 'collapse control rendered');
  const active = tabs.filter((b) => b.classList.contains('ide-bottom-tab--active'));
  assert.equal(active.length, 1);
  assert.equal(active[0].dataset.ideBottomView, 'terminal');
  assert.ok(h.calls.terminal >= 1, 'terminal view painted');
  assert.equal(h.byId('ideBottomPanel').classList.contains('hidden'), false, 'panel visible when open');
  assert.equal(h.byId('ideBottomPanel').getAttribute('data-open'), 'true');
});

test('view tabs sit in a role=tablist of ONLY tabs (collapse stays outside) with roving tabindex', (t) => {
  const h = setup(); // open on terminal
  t.after(() => h.dispose());
  const tabsEl = h.byId('ideBottomTabs');
  const tablist = tabsEl.querySelector('[role="tablist"]');
  assert.ok(tablist, 'an inner tablist wraps the view tabs');
  assert.ok([...tablist.children].every((el) => el.getAttribute('role') === 'tab'), 'tablist holds only tabs');
  assert.equal(tablist.querySelector('[data-ide-bottom-collapse]'), null, 'collapse is not inside the tablist');
  assert.ok(tabsEl.querySelector('[data-ide-bottom-collapse]'), 'collapse still rendered (toolbar sibling)');
  // Roving tabindex: only the active (terminal) tab is in the Tab order.
  const tabs = [...tabsEl.querySelectorAll('[data-ide-bottom-view]')];
  const inOrder = tabs.filter((b) => b.getAttribute('tabindex') === '0');
  assert.equal(inOrder.length, 1, 'one tab in the Tab order');
  assert.equal(inOrder[0].dataset.ideBottomView, 'terminal');
  assert.ok(
    tabs.filter((b) => b.dataset.ideBottomView !== 'terminal').every((b) => b.getAttribute('tabindex') === '-1'),
    'inactive tabs leave the Tab order',
  );
});

test('bottom-panel arrow keys move focus AND activate the focused view (Home/End jump)', (t) => {
  const h = setup(); // open on terminal
  t.after(() => h.dispose());
  const tabsEl = h.byId('ideBottomTabs');
  const arrowOn = (el, key) => el.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
  const terminal = tabsEl.querySelector('[data-ide-bottom-view="terminal"]');
  terminal.focus();

  // ArrowRight -> next view (problems): activates + focus follows + roving 0 moves.
  arrowOn(terminal, 'ArrowRight');
  assert.equal(h.ide.bottomPanelActiveView, 'problems', 'ArrowRight switches view');
  let focused = h.doc.activeElement;
  assert.equal(focused?.dataset?.ideBottomView, 'problems', 'focus follows the activation');
  assert.equal(focused.getAttribute('tabindex'), '0', 'the newly active tab takes the roving tabindex');

  // End -> last view (test-runner, after the Wave C addition).
  arrowOn(focused, 'End');
  assert.equal(h.ide.bottomPanelActiveView, 'test-runner', 'End jumps to the last view');
  assert.equal(h.doc.activeElement?.dataset?.ideBottomView, 'test-runner', 'focus moved to the last tab');

  // ArrowUp also navigates (horizontal bar accepts both axes); last -> previous (run).
  arrowOn(h.doc.activeElement, 'ArrowUp');
  assert.equal(h.ide.bottomPanelActiveView, 'run', 'ArrowUp moves to the previous view');
});

test('clicking a tab switches the active view, opens, and persists', (t) => {
  const h = setup();
  t.after(() => h.dispose());
  h.byId('ideBottomTabs').querySelector('[data-ide-bottom-view="problems"]').click();
  assert.equal(h.ide.bottomPanelActiveView, 'problems');
  assert.equal(h.ide.bottomPanelOpen, true);
  assert.ok(h.calls.problems >= 1, 'problems view painted after switch');
  assert.ok(h.calls.persist >= 1, 'view switch persisted');
  assert.equal(h.byId('ideBottomPanelContent').querySelector('.ide-terminal-panel'), null, 'terminal markup replaced');
});

test('clicking the already-active tab is a no-op (no re-switch, no extra persist)', (t) => {
  const h = setup(); // open on terminal
  t.after(() => h.dispose());
  const persistBefore = h.calls.persist;
  h.byId('ideBottomTabs').querySelector('[data-ide-bottom-view="terminal"]').click();
  assert.equal(h.ide.bottomPanelActiveView, 'terminal', 'active view unchanged');
  assert.equal(h.calls.persist, persistBefore, 'clicking the active tab does not persist again');
});

test('the collapse control closes the panel', (t) => {
  const h = setup();
  t.after(() => h.dispose());
  h.byId('ideBottomTabs').querySelector('[data-ide-bottom-collapse]').click();
  assert.equal(h.ide.bottomPanelOpen, false);
  assert.equal(h.byId('ideBottomPanel').classList.contains('hidden'), true, 'panel hidden when closed');
  assert.equal(h.byId('ideBottomResizer').classList.contains('hidden'), true, 'resizer hidden when closed');
});

test('the collapsed handle is hidden while open, shown while closed, and reopens on click', (t) => {
  const h = setup(); // open on terminal
  t.after(() => h.dispose());
  const handle = h.byId('ideBottomHandle');
  assert.equal(handle.classList.contains('hidden'), true, 'handle hidden while panel open');
  // Collapse -> the handle takes the panel's place.
  h.byId('ideBottomTabs').querySelector('[data-ide-bottom-collapse]').click();
  assert.equal(h.ide.bottomPanelOpen, false);
  assert.equal(handle.classList.contains('hidden'), false, 'handle shown while collapsed');
  const btn = handle.querySelector('[data-ide-bottom-handle]');
  assert.ok(btn, 'handle control rendered');
  assert.ok(btn.querySelector('svg'), 'handle uses an inline (CSP-safe) glyph');
  assert.match(handle.textContent, /Terminal/, 'handle labels the view it will reopen');
  // Clicking the handle reopens on the last active view.
  btn.click();
  assert.equal(h.ide.bottomPanelOpen, true);
  assert.equal(h.ide.bottomPanelActiveView, 'terminal');
  assert.equal(handle.classList.contains('hidden'), true, 'handle hidden again once open');
});

test('toggle flips open/closed; open(view) targets a view', (t) => {
  const h = setup({ open: false });
  t.after(() => h.dispose());
  assert.equal(h.ide.bottomPanelOpen, false);
  h.panel.toggle();
  assert.equal(h.ide.bottomPanelOpen, true);
  h.panel.toggle();
  assert.equal(h.ide.bottomPanelOpen, false);
  h.panel.open('problems');
  assert.equal(h.ide.bottomPanelOpen, true);
  assert.equal(h.ide.bottomPanelActiveView, 'problems');
});

test('a closed panel skips tab/content rendering', (t) => {
  const h = setup({ open: false });
  t.after(() => h.dispose());
  assert.equal(h.calls.terminal, 0, 'no content paint while closed');
  assert.equal(h.byId('ideBottomTabs').innerHTML, '', 'no tab paint while closed');
  assert.equal(h.byId('ideBottomPanel').classList.contains('hidden'), true);
});

test('the Run output view falls through to a placeholder when no run renderer is wired', (t) => {
  const h = setup({ activeView: 'run' });
  t.after(() => h.dispose());
  assert.equal(h.calls.terminal, 0);
  assert.equal(h.calls.problems, 0);
  assert.ok(h.byId('ideBottomPanelContent').querySelector('[data-ide-bottom-placeholder="run"]'), 'run placeholder rendered');
});

test('the Run output view routes to the injected run renderer when wired', (t) => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="ideShell">
      <div id="ideBottomResizer" class="hidden"></div>
      <div id="ideBottomPanel" data-open="true">
        <div id="ideBottomTabs"></div>
        <div id="ideBottomPanelContent"></div>
      </div>
      <div id="ideBottomHandle" class="hidden"></div>
    </div>
  </body>`);
  const prevWindow = globalThis.window;
  globalThis.window = dom.window;
  const byId = (id) => dom.window.document.getElementById(id);
  const ide = { bottomPanelOpen: true, bottomPanelHeight: 220, bottomPanelActiveView: 'run' };
  let runCalls = 0;
  const panel = createIdeBottomPanel({
    getDom: () => ({
      ideShell: byId('ideShell'),
      ideBottomResizer: byId('ideBottomResizer'),
      ideBottomPanel: byId('ideBottomPanel'),
      ideBottomTabs: byId('ideBottomTabs'),
      ideBottomPanelContent: byId('ideBottomPanelContent'),
      ideBottomHandle: byId('ideBottomHandle'),
    }),
    getIde: () => ide,
    renderRun: () => { runCalls += 1; byId('ideBottomPanelContent').innerHTML = '<div class="ide-run-panel"></div>'; },
  });
  t.after(() => { panel.dispose(); globalThis.window = prevWindow; });
  panel.render();
  assert.ok(runCalls >= 1, 'run renderer invoked for the run view');
  assert.ok(byId('ideBottomPanelContent').querySelector('.ide-run-panel'), 'run output painted');
  assert.equal(byId('ideBottomPanelContent').querySelector('[data-ide-bottom-placeholder="run"]'), null, 'no placeholder once wired');
});

test('the Test Runner view falls through to a placeholder when no renderer is wired', (t) => {
  // RED-BECAUSE: 'test-runner' is not yet an accepted bottom-panel view, so the
  // active view coerces back to 'terminal' and no test-runner placeholder paints.
  const h = setup({ activeView: 'test-runner' });
  t.after(() => h.dispose());
  assert.equal(h.calls.terminal, 0, 'terminal not painted for the test-runner view');
  assert.ok(
    h.byId('ideBottomPanelContent').querySelector('[data-ide-bottom-placeholder="test-runner"]'),
    'test-runner placeholder rendered when unwired'
  );
});

test('the Test Runner view routes to the injected renderTestRunner when wired', (t) => {
  // RED-BECAUSE: the bottom panel does not yet route a 'test-runner' view to an
  // injected renderTestRunner seam.
  const h = setup({ activeView: 'test-runner', wireTestRunner: true });
  t.after(() => h.dispose());
  assert.ok(h.calls.testRunner >= 1, 'renderTestRunner invoked for the test-runner view');
  assert.ok(h.byId('ideBottomPanelContent').querySelector('.ide-test-runner-panel'), 'test-runner content painted');
  assert.equal(
    h.byId('ideBottomPanelContent').querySelector('[data-ide-bottom-placeholder="test-runner"]'),
    null,
    'no placeholder once wired'
  );
});

test('keyboard resize grows/shrinks the height and clamps to bounds', (t) => {
  const h = setup({ height: 220 });
  t.after(() => h.dispose());
  const resizer = h.byId('ideBottomResizer');
  const arrow = (key) => resizer.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
  arrow('ArrowUp');
  assert.equal(h.ide.bottomPanelHeight, 244, 'ArrowUp grows by the step');
  assert.equal(
    h.byId('ideShell').style.getPropertyValue('--ide-bottom-height'),
    '244px',
    'applyHeightVar writes the height to the --ide-bottom-height CSS var'
  );
  arrow('ArrowDown');
  assert.equal(h.ide.bottomPanelHeight, 220, 'ArrowDown shrinks by the step');
  // Clamp at the maximum on repeated growth.
  for (let i = 0; i < 100; i += 1) { arrow('ArrowUp'); }
  assert.equal(h.ide.bottomPanelHeight, MAX_BOTTOM_HEIGHT);
  assert.ok(h.calls.persist >= 1, 'keyboard resize persisted');
});

test('pointer drag on the top-edge resizer resizes (drag up = taller) and clamps', (t) => {
  const h = setup({ height: 220 });
  t.after(() => h.dispose());
  const win = h.dom.window;
  const resizer = h.byId('ideBottomResizer');
  resizer.dispatchEvent(new win.MouseEvent('pointerdown', { clientY: 500, bubbles: true }));
  win.dispatchEvent(new win.MouseEvent('pointermove', { clientY: 400 })); // dragged up 100px
  assert.equal(h.ide.bottomPanelHeight, 320, 'taller by the drag delta');
  win.dispatchEvent(new win.MouseEvent('pointermove', { clientY: -5000 })); // wild drag clamps
  assert.equal(h.ide.bottomPanelHeight, MAX_BOTTOM_HEIGHT);
  win.dispatchEvent(new win.MouseEvent('pointerup', { clientY: -5000 }));
  // Listeners detach on release: a further move changes nothing.
  win.dispatchEvent(new win.MouseEvent('pointermove', { clientY: 600 }));
  assert.equal(h.ide.bottomPanelHeight, MAX_BOTTOM_HEIGHT);
  assert.ok(MIN_BOTTOM_HEIGHT < MAX_BOTTOM_HEIGHT);
});

/* UIUX-011: persistent terminal host — exactly one content host visible at a
 * time, and the terminal host's own DOM survives sibling-view activation
 * (never innerHTML-replaced by Problems/Run/Test Runner). */

test('UIUX-011: with a persistent terminal host, switching to a sibling hides the terminal host (its DOM stays intact) and shows the shared host', (t) => {
  const h = setup({ persistentTerminalHost: true }); // opens on terminal
  t.after(() => h.dispose());
  const termHost = h.byId('ideBottomTerminalHost');
  const sharedHost = h.byId('ideBottomPanelContent');
  assert.equal(termHost.classList.contains('hidden'), false, 'terminal host visible while Terminal is active');
  assert.equal(sharedHost.classList.contains('hidden'), true, 'shared host hidden while Terminal is active');
  assert.ok(termHost.querySelector('.ide-terminal-panel'), 'terminal content painted into its own persistent host');

  h.byId('ideBottomTabs').querySelector('[data-ide-bottom-view="problems"]').click();
  assert.equal(termHost.classList.contains('hidden'), true, 'terminal host hidden once a sibling is active');
  assert.ok(termHost.querySelector('.ide-terminal-panel'), 'terminal DOM is UNTOUCHED (hidden, not destroyed)');
  assert.equal(sharedHost.classList.contains('hidden'), false, 'shared host visible for the sibling view');
  assert.ok(sharedHost.querySelector('.ide-prb'), 'problems content painted into the shared host');
  assert.equal(sharedHost.querySelector('.ide-terminal-panel'), null, 'terminal markup never leaked into the shared host');

  h.byId('ideBottomTabs').querySelector('[data-ide-bottom-view="terminal"]').click();
  assert.equal(termHost.classList.contains('hidden'), false, 'terminal host visible again on return');
  assert.equal(sharedHost.classList.contains('hidden'), true, 'shared host hidden once Terminal is active again');
  assert.ok(termHost.querySelector('.ide-terminal-panel'), 'terminal content still present after the round trip');
});

test('UIUX-011: without a persistent terminal host (legacy/flag-off), the terminal host stays hidden and Terminal keeps using the shared host', (t) => {
  const h = setup(); // no persistentTerminalHost — today's default behavior
  t.after(() => h.dispose());
  const termHost = h.byId('ideBottomTerminalHost');
  const sharedHost = h.byId('ideBottomPanelContent');
  assert.equal(termHost.classList.contains('hidden'), true, 'the unused persistent host never shows itself');
  assert.equal(sharedHost.classList.contains('hidden'), false, 'the shared host stays visible (legacy behavior unchanged)');
  assert.ok(sharedHost.querySelector('.ide-terminal-panel'), 'terminal still paints into the shared host by default');
});

test('UIUX-011: repeated cycles between Terminal and every sibling never show two hosts at once', (t) => {
  const h = setup({ persistentTerminalHost: true });
  t.after(() => h.dispose());
  const termHost = h.byId('ideBottomTerminalHost');
  const sharedHost = h.byId('ideBottomPanelContent');
  const views = ['problems', 'run', 'test-runner', 'terminal', 'problems', 'terminal'];
  for (const view of views) {
    h.byId('ideBottomTabs').querySelector(`[data-ide-bottom-view="${view}"]`).click();
    const termVisible = !termHost.classList.contains('hidden');
    const sharedVisible = !sharedHost.classList.contains('hidden');
    assert.notEqual(termVisible, sharedVisible, `cycle "${view}": exactly one host is visible, never both/neither`);
    assert.equal(termVisible, view === 'terminal', `cycle "${view}": terminal host visibility matches the active view`);
  }
});
