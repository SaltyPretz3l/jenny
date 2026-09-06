'use strict';

/* Presentation policy for model-initiated workspace_present requests
 * (renderer/features/renderer-workspace-presentation-controller.js). Covers:
 * newest-wins coalescing, the safety gates (active view, typing guard,
 * pending approval, oscillation), the non-stealing chip (polite live region,
 * Show/dismiss, newest replaces older), file_map routing + reveal, the
 * defensive wire-path re-gate, the NON-REPLAY contract (live push only;
 * degrades off when the preload surface is absent), and dispose cleanup. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createWorkspacePresentationController,
} = require('../renderer/features/renderer-workspace-presentation-controller');

const WORKSPACE_ID = `root_${'a'.repeat(24)}`;

function makeController(overrides = {}) {
  const dom = new JSDOM('<div id="ideMain"></div>');
  const ideMain = dom.window.document.getElementById('ideMain');
  const calls = {
    previews: [], maps: 0, reveals: [], logs: [],
    diffs: [], panels: 0, toasts: [], subscribed: 0, unsubscribed: 0,
  };
  let clock = 100_000;
  const timers = [];
  let pushRequest = null;
  const windowRef = {
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: (handle) => {
      const index = timers.indexOf(handle && handle.fn ? handle.fn : handle);
      if (index >= 0) timers[index] = null;
    },
    document: dom.window.document,
    jennyShell: overrides.noApi ? {} : {
      workspacePresentation: {
        onRequest(listener) {
          calls.subscribed += 1;
          pushRequest = listener;
          return () => { calls.unsubscribed += 1; };
        },
      },
    },
  };
  const controller = createWorkspacePresentationController({
    getDom: () => ({ ideMain }),
    windowRef,
    escapeHtml: (v) => String(v == null ? '' : v).replace(/[<>&"]/g, ''),
    appendClientLog: (level, event, meta) => calls.logs.push({ level, event, meta }),
    getActiveView: overrides.getActiveView || (() => 'ide'),
    openPreview: (path) => calls.previews.push(path),
    openFileMap: () => { calls.maps += 1; },
    revealInMap: (path) => calls.reveals.push(path),
    getSessionId: overrides.getSessionId || (() => 'session-1'),
    getWorkspaceId: overrides.getWorkspaceId || (() => WORKSPACE_ID),
    getChangeLedger: overrides.getChangeLedger || (() => ({ changes: [] })),
    openChangeDiff: overrides.noDiffIntegration ? null : (change) => calls.diffs.push(change),
    openChangesPanel: () => { calls.panels += 1; },
    showShellErrorToast: (message, options) => calls.toasts.push({ message, options }),
    isSurfaceEnabled: overrides.isSurfaceEnabled || (() => true),
    now: () => clock,
    isApprovalPending: overrides.isApprovalPending || (() => false),
  });
  function fireTimers() {
    const pending = timers.splice(0);
    for (const fn of pending) if (typeof fn === 'function') fn();
  }
  return {
    controller, calls, ideMain, fireTimers,
    advance: (ms) => { clock += ms; },
    push: (payload) => pushRequest && pushRequest(payload),
    chip: () => ideMain.querySelector('.ide-presentation-chip'),
  };
}

function click(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('click', { bubbles: true }));
}

test('safe request applies after the coalesce window; newest request wins', (t) => {
  const h = makeController();
  t.after(() => h.controller.dispose());

  h.controller.handleRequest({ view: 'preview', path: 'docs/a.md' });
  h.controller.handleRequest({ view: 'preview', path: 'docs/b.md' });
  assert.deepEqual(h.calls.previews, [], 'nothing applies before the window settles');

  h.fireTimers();
  assert.deepEqual(h.calls.previews, ['docs/b.md'], 'only the newest coalesced request applies');
  assert.equal(h.chip(), null, 'safe apply raises no chip');
  assert.ok(h.calls.logs.some((l) => l.event === 'workspace_presentation.applied'));
});

test('file_map routes through openFileMap and reveals only when a path is given', (t) => {
  const h = makeController();
  t.after(() => h.controller.dispose());

  h.controller.handleRequest({ view: 'file_map', path: 'src/x.js' });
  h.fireTimers();
  assert.equal(h.calls.maps, 1);
  assert.deepEqual(h.calls.reveals, ['src/x.js']);

  h.controller.handleRequest({ view: 'file_map' });
  h.fireTimers();
  assert.equal(h.calls.maps, 2);
  assert.deepEqual(h.calls.reveals, ['src/x.js'], 'no reveal without a path');
});

test('change_diff resolves one exact current-session change and opens only that diff', (t) => {
  const changes = [
    { changeId: 'change:1', workspaceId: WORKSPACE_ID, path: 'src/a.js' },
    { changeId: 'change:2', workspaceId: WORKSPACE_ID, path: 'src/a.js' },
    { changeId: 'change:3', workspaceId: WORKSPACE_ID, path: 'src/b.js' },
  ];
  const h = makeController({ getChangeLedger: () => ({ changes }) });
  t.after(() => h.controller.dispose());

  h.controller.handleRequest({
    view: 'change_diff', path: 'src/a.js', change_id: 'change:1',
    session_id: 'session-1', workspace_id: WORKSPACE_ID,
  });
  h.fireTimers();

  assert.deepEqual(h.calls.diffs.map((change) => change.changeId), ['change:1']);
  assert.equal(h.calls.panels, 0);
});

test('change_diff without a change id selects the newest exact path match', (t) => {
  const changes = [
    { changeId: 'change:old', workspaceId: WORKSPACE_ID, path: 'src/a.js' },
    { changeId: 'change:new', workspaceId: WORKSPACE_ID, path: 'src/a.js' },
  ];
  const h = makeController({ getChangeLedger: () => ({ changes }) });
  t.after(() => h.controller.dispose());

  h.controller.handleRequest({
    view: 'change_diff', path: 'src/a.js',
    session_id: 'session-1', workspace_id: WORKSPACE_ID,
  });
  h.fireTimers();
  assert.deepEqual(h.calls.diffs.map((change) => change.changeId), ['change:new']);
});

test('change_diff denies wrong session/workspace and drops a request after context switches', (t) => {
  let workspaceId = WORKSPACE_ID;
  const changes = [{ changeId: 'change:1', workspaceId: WORKSPACE_ID, path: 'src/a.js' }];
  const h = makeController({
    getWorkspaceId: () => workspaceId,
    getChangeLedger: () => ({ changes }),
  });
  t.after(() => h.controller.dispose());

  h.controller.handleRequest({
    view: 'change_diff', path: 'src/a.js', change_id: 'change:1',
    session_id: 'session-other', workspace_id: WORKSPACE_ID,
  });
  h.fireTimers();
  assert.deepEqual(h.calls.diffs, []);

  h.controller.handleRequest({
    view: 'change_diff', path: 'src/a.js', change_id: 'change:1',
    session_id: 'session-1', workspace_id: WORKSPACE_ID,
  });
  workspaceId = `root_${'b'.repeat(24)}`;
  h.fireTimers();
  assert.deepEqual(h.calls.diffs, [], 'a root switch invalidates the one-shot intent');
});

test('missing change falls back to the passive Changes panel with bounded warning', (t) => {
  const h = makeController();
  t.after(() => h.controller.dispose());
  h.controller.handleRequest({
    view: 'change_diff', path: 'src/missing.js', change_id: 'change:missing',
    session_id: 'session-1', workspace_id: WORKSPACE_ID,
  });
  h.fireTimers();

  assert.equal(h.calls.panels, 1);
  assert.equal(h.calls.diffs.length, 0);
  assert.equal(h.calls.toasts.length, 1);
  assert.doesNotMatch(h.calls.toasts[0].message, /[A-Z]:\\|\/Users\//);
});

test('missing change-diff integration degrades without opening or throwing', (t) => {
  const h = makeController({ noDiffIntegration: true });
  t.after(() => h.controller.dispose());
  h.controller.handleRequest({
    view: 'change_diff', path: 'src/a.js',
    session_id: 'session-1', workspace_id: WORKSPACE_ID,
  });
  h.fireTimers();
  assert.deepEqual(h.calls.diffs, []);
  assert.equal(h.calls.panels, 1);
  assert.equal(h.calls.toasts.length, 1);
  assert.ok(h.calls.logs.some((entry) => entry.event === 'workspace_presentation.change_context_rejected'));
});

test('recent typing defers to the non-stealing chip; Show applies user-initiated', (t) => {
  const h = makeController();
  t.after(() => h.controller.dispose());

  h.controller.noteEdit();
  h.controller.handleRequest({ view: 'preview', path: 'docs/plan.md' });
  h.fireTimers();

  assert.deepEqual(h.calls.previews, [], 'typing guard blocks auto-apply');
  const chip = h.chip();
  assert.ok(chip, 'pending chip raised instead');
  assert.equal(chip.getAttribute('role'), 'status');
  assert.equal(chip.getAttribute('aria-live'), 'polite');
  assert.match(chip.textContent, /Jenny wants to show a preview of docs\/plan\.md/);
  assert.ok(h.calls.logs.some((l) => l.event === 'workspace_presentation.deferred'));

  click(chip.querySelector('[data-presentation-show]'));
  assert.deepEqual(h.calls.previews, ['docs/plan.md'], 'Show applies immediately');
  assert.equal(h.chip(), null, 'chip removed after apply');
  const applied = h.calls.logs.find((l) => l.event === 'workspace_presentation.applied');
  assert.equal(applied.meta.user_initiated, true);
});

test('typing guard drains: the same request auto-applies once the horizon passes', (t) => {
  const h = makeController();
  t.after(() => h.controller.dispose());

  h.controller.noteEdit();
  h.advance(h.controller.TYPING_GUARD_MS + 1);
  h.controller.handleRequest({ view: 'preview', path: 'docs/late.md' });
  h.fireTimers();
  assert.deepEqual(h.calls.previews, ['docs/late.md']);
});

test('pending approval row defers to the chip', (t) => {
  const h = makeController({ isApprovalPending: () => true });
  t.after(() => h.controller.dispose());

  h.controller.handleRequest({ view: 'preview', path: 'a.md' });
  h.fireTimers();
  assert.deepEqual(h.calls.previews, []);
  assert.ok(h.chip());
});

test('a non-IDE active view defers to the chip', (t) => {
  const h = makeController({ getActiveView: () => 'chat' });
  t.after(() => h.controller.dispose());

  h.controller.handleRequest({ view: 'file_map' });
  h.fireTimers();
  assert.equal(h.calls.maps, 0);
  assert.ok(h.chip());
});

test('oscillation guard: the fourth rapid auto-apply defers, then drains with time', (t) => {
  const h = makeController();
  t.after(() => h.controller.dispose());

  for (let i = 0; i < 3; i += 1) {
    h.controller.handleRequest({ view: 'preview', path: `f${i}.md` });
    h.fireTimers();
    h.advance(1000);
  }
  assert.equal(h.calls.previews.length, 3);

  h.controller.handleRequest({ view: 'preview', path: 'f3.md' });
  h.fireTimers();
  assert.equal(h.calls.previews.length, 3, 'fourth switch inside the window is deferred');
  assert.ok(h.chip());

  h.advance(11_000);
  h.controller.handleRequest({ view: 'preview', path: 'f4.md' });
  h.fireTimers();
  assert.deepEqual(h.calls.previews.at(-1), 'f4.md', 'guard drains outside the window');
});

test('user-initiated Show does not count toward the oscillation guard', (t) => {
  const h = makeController({ getActiveView: () => 'chat' });
  t.after(() => h.controller.dispose());

  for (let i = 0; i < 4; i += 1) {
    h.controller.handleRequest({ view: 'preview', path: `u${i}.md` });
    h.fireTimers();
    click(h.chip().querySelector('[data-presentation-show]'));
    h.advance(500);
  }
  assert.equal(h.calls.previews.length, 4, 'every explicit Show applied');
});

test('a newer deferred request replaces the pending chip (newest wins)', (t) => {
  const h = makeController({ isApprovalPending: () => true });
  t.after(() => h.controller.dispose());

  h.controller.handleRequest({ view: 'preview', path: 'old.md' });
  h.fireTimers();
  assert.match(h.chip().textContent, /old\.md/);

  h.controller.handleRequest({ view: 'file_map', path: 'src/new.js' });
  h.fireTimers();
  const chips = h.ideMain.querySelectorAll('.ide-presentation-chip');
  assert.equal(chips.length, 1, 'only one chip at a time');
  assert.match(chips[0].textContent, /File Map for src\/new\.js/);
});

test('dismiss removes the chip without applying', (t) => {
  const h = makeController({ isApprovalPending: () => true });
  t.after(() => h.controller.dispose());

  h.controller.handleRequest({ view: 'preview', path: 'a.md' });
  h.fireTimers();
  click(h.chip().querySelector('[data-presentation-dismiss]'));
  assert.equal(h.chip(), null);
  assert.deepEqual(h.calls.previews, []);
  assert.ok(h.calls.logs.some((l) => l.event === 'workspace_presentation.dismissed'));
});

test('disabled surfaces and unknown views are rejected with a WARN, never queued', (t) => {
  const h = makeController({ isSurfaceEnabled: (view) => view === 'preview' });
  t.after(() => h.controller.dispose());

  h.controller.handleRequest({ view: 'file_map' });
  h.controller.handleRequest({ view: 'settings' });
  h.controller.handleRequest('not-an-object');
  h.fireTimers();

  assert.equal(h.calls.maps, 0);
  assert.equal(h.calls.previews.length, 0);
  assert.equal(
    h.calls.logs.filter((l) => l.event === 'workspace_presentation.request_rejected').length,
    2
  );
});

test('the wire-path re-gate strips traversal/absolute/scheme-like paths', (t) => {
  const h = makeController();
  t.after(() => h.controller.dispose());

  for (const bad of ['../secrets.md', '/etc/passwd', 'C:\\x\\y.md', 'preview://x']) {
    h.controller.handleRequest({ view: 'preview', path: bad });
    h.fireTimers();
    h.advance(11_000); // stay clear of the oscillation guard between applies
  }
  assert.deepEqual(h.calls.previews, ['', '', '', ''], 'unsafe paths coerce to empty (no explicit target)');
});

test('bindEvents subscribes to the live push only; requests arrive through it (non-replay contract)', (t) => {
  const h = makeController();
  t.after(() => h.controller.dispose());

  h.controller.bindEvents();
  h.controller.bindEvents();
  assert.equal(h.calls.subscribed, 1, 'idempotent subscription');
  assert.deepEqual(h.calls.diffs, [], 'rehydrated ledger entries never replay themselves');

  h.push({ view: 'preview', path: 'via/push.md' });
  h.fireTimers();
  assert.deepEqual(h.calls.previews, ['via/push.md']);
});

test('missing preload surface degrades off silently', (t) => {
  const h = makeController({ noApi: true });
  t.after(() => h.controller.dispose());
  h.controller.bindEvents();
  assert.equal(h.calls.subscribed, 0);
});

test('dispose unsubscribes, clears pending work, removes the chip, and blocks late requests', (t) => {
  const h = makeController({ isApprovalPending: () => true });
  h.controller.bindEvents();
  h.controller.handleRequest({ view: 'preview', path: 'a.md' });
  h.fireTimers();
  assert.ok(h.chip());

  h.controller.handleRequest({ view: 'preview', path: 'b.md' });
  h.controller.dispose();
  h.fireTimers();
  assert.equal(h.chip(), null, 'chip removed on dispose');
  assert.equal(h.calls.unsubscribed, 1);
  assert.deepEqual(h.calls.previews, [], 'queued request dropped by dispose');

  h.controller.handleRequest({ view: 'preview', path: 'c.md' });
  h.fireTimers();
  assert.deepEqual(h.calls.previews, [], 'post-dispose requests are ignored');
});
