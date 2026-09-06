'use strict';

/* tests/renderer-ide-map-activity-rail.test.js — the activity presenter:
 * rel→node-id resolution (exact / Windows case-insensitive / bucket-chip
 * prefix fallback), node-id-native forwarding to view.applyActivity, rail
 * rows + click-to-reveal, turn-end fade/clear choreography on ONE timer
 * pair, session filtering, and the Activity layer visibility gate. Uses
 * the REAL activity bus (integration honesty) + a stub view + jsdom. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createMapActivityPresenter } = require('../renderer/features/renderer-ide-map-activity-rail');
const { createMapActivityBus } = require('../renderer/features/renderer-ide-map-activity-bus');

const ROOT = 'C:\\dev\\jenny';

function makeFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId; nextId += 1;
      pending.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    fire(msAtLeast) {
      for (const [id, t] of [...pending]) {
        if (t.ms <= msAtLeast) {
          pending.delete(id);
          t.fn();
        }
      }
    },
    pendingCount() { return pending.size; },
  };
}

function makeStubView(ids) {
  const calls = [];
  return {
    calls,
    getAllNodeIds: () => new Set(ids),
    applyActivity: (state) => calls.push(state),
  };
}

function setup(t, opts) {
  const dom = new JSDOM('<div id="vp"><span data-map-bucket="dist"></span></div>');
  const previousWindow = globalThis.window;
  globalThis.window = dom.window;
  const viewportEl = dom.window.document.getElementById('vp');
  const bus = createMapActivityBus({ getRootPath: () => ROOT, now: () => 1000 });
  const view = makeStubView((opts && opts.ids) || ['renderer/App.js', 'services/x.js']);
  const timers = makeFakeTimers();
  const revealed = [];
  const turnStates = [];
  const presenter = createMapActivityPresenter({
    bus,
    getSessionId: () => 'sess1',
    view,
    viewportEl,
    timers,
    onTurnActiveChange: (active) => turnStates.push(active),
    onRowClick: (id) => revealed.push(id),
  });
  t.after(() => {
    presenter.dispose();
    bus.dispose();
    globalThis.window = previousWindow;
  });
  return { bus, view, presenter, viewportEl, timers, revealed, turnStates, dom };
}

function use(bus, over) {
  bus.ingest({
    type: 'tool_use', streamId: 's1', sessionId: 'sess1',
    callId: `c${JSON.stringify(over).length}_${over.toolName}_${(over.input || {}).path}`,
    toolName: 'read_file', input: {}, ...over,
  });
}

test('resolution: exact, case-insensitive, and bucket-prefix fallback', (t) => {
  const { bus, view, viewportEl } = setup(t);
  use(bus, { callId: 'c1', input: { path: 'renderer/App.js' } });          // exact
  use(bus, { callId: 'c2', input: { path: 'SERVICES/X.JS' } });            // case-mismatch
  use(bus, { callId: 'c3', toolName: 'write_file', input: { path: 'dist/bundle.js' } }); // bucketed
  const last = view.calls[view.calls.length - 1];
  assert.deepEqual([...last.heat.keys()].sort(), ['renderer/App.js', 'services/x.js']);
  const chip = viewportEl.querySelector('[data-map-bucket="dist"]');
  assert.ok(chip.classList.contains('is-heat'), 'gitignored write heats the bucket chip');
});

test('trail forwards resolved steps renumbered; rail renders rows newest-first with reveal clicks', (t) => {
  const { bus, view, viewportEl, revealed, dom } = setup(t);
  use(bus, { callId: 'c1', input: { path: 'renderer/App.js' } });
  use(bus, { callId: 'c2', toolName: 'run_command', input: { command: 'npm test' } });
  use(bus, { callId: 'c3', toolName: 'edit_file', input: { path: 'services/x.js' } });
  const last = view.calls[view.calls.length - 1];
  assert.deepEqual(last.trail.map((s) => [s.id, s.n]), [['renderer/App.js', 1], ['services/x.js', 2]]);
  assert.ok(last.editedIds.has('services/x.js'));

  const rows = viewportEl.querySelectorAll('.ide-map-activity-row');
  assert.equal(rows.length, 3);
  assert.ok(rows[0].classList.contains('is-edit'), 'newest (the edit) first');
  assert.equal(rows[0].title, 'Reveal services/x.js in the map');
  assert.ok(rows[1].classList.contains('is-static'), 'run_command row is non-interactive');
  rows[0].dispatchEvent(new dom.window.Event('click', { bubbles: true }));
  assert.deepEqual(revealed, ['services/x.js']);
});

test('turn lifecycle: freeze hook fires on start/end; fade then clear on one timer pair', (t) => {
  const { bus, view, presenter, timers, turnStates, viewportEl } = setup(t);
  use(bus, { callId: 'c1', input: { path: 'renderer/App.js' } });
  assert.deepEqual(turnStates, [true]);
  assert.ok(viewportEl.querySelector('.ide-map-activity-rail').classList.contains('is-live'));

  bus.ingest({ type: 'complete', streamId: 's1', sessionId: 'sess1' });
  assert.deepEqual(turnStates, [true, false]);
  assert.equal(timers.pendingCount(), 2, 'exactly one fade + one clear timer');

  timers.fire(4000);
  let last = view.calls[view.calls.length - 1];
  assert.equal(last.faded, true, 'fade pass');
  assert.ok(last.heat.size > 0, 'heat still present during fade');

  timers.fire(8000);
  last = view.calls[view.calls.length - 1];
  assert.equal(last.heat.size, 0, 'cleared after the choreography');
  assert.equal(last.trail.length, 0);
  presenter.refresh();
  last = view.calls[view.calls.length - 1];
  assert.equal(last.heat.size, 0, 'refresh cannot resurrect expired heat');
  assert.ok(viewportEl.querySelector('.ide-map-activity-rail').classList.contains('hidden'));
});

test('pending approval takes precedence in the live rail title', (t) => {
  const { bus, viewportEl } = setup(t);
  bus.ingest({
    type: 'tool_approval_needed', streamId: 's1', sessionId: 'sess1',
    callId: 'c1', toolName: 'Bash', input: {},
  });

  assert.equal(
    viewportEl.querySelector('.ide-map-activity-rail-title').textContent,
    'Jenny · waiting for approval'
  );
});

test('a new turn cancels pending fade/clear timers', (t) => {
  const { bus, timers } = setup(t);
  use(bus, { callId: 'c1', input: { path: 'renderer/App.js' } });
  bus.ingest({ type: 'complete', streamId: 's1', sessionId: 'sess1' });
  assert.equal(timers.pendingCount(), 2);
  use(bus, { streamId: 's2', callId: 'c2', input: { path: 'services/x.js' } });
  assert.equal(timers.pendingCount(), 0, 'choreography cancelled by the new turn');
});

test('foreign-session events never paint; refresh repaints after a re-render wipe', (t) => {
  const { bus, view, presenter } = setup(t);
  bus.ingest({ type: 'tool_use', streamId: 'sF', sessionId: 'OTHER', callId: 'c1', toolName: 'read_file', input: { path: 'renderer/App.js' } });
  assert.equal(view.calls.length, 0, 'other session ignored');
  use(bus, { callId: 'c2', input: { path: 'renderer/App.js' } });
  const paintCount = view.calls.length;
  presenter.refresh();
  assert.equal(view.calls.length, paintCount + 1, 'refresh repaints from the snapshot');
});

test('setVisible gates the rail chrome, not the state', (t) => {
  const { bus, presenter, viewportEl } = setup(t);
  use(bus, { callId: 'c1', input: { path: 'renderer/App.js' } });
  const rail = viewportEl.querySelector('.ide-map-activity-rail');
  assert.ok(!rail.classList.contains('hidden'));
  presenter.setVisible(false);
  assert.ok(rail.classList.contains('hidden'));
  presenter.setVisible(true);
  assert.ok(!rail.classList.contains('hidden'));
});

test('outside-workspace counter reaches the rail foot', (t) => {
  const { bus, viewportEl } = setup(t);
  use(bus, { callId: 'c1', input: { path: 'renderer/App.js' } });
  use(bus, { callId: 'c2', input: { path: 'C:\\elsewhere\\x.js' } });
  const foot = viewportEl.querySelector('.ide-map-activity-rail-foot');
  assert.ok(foot.textContent.includes('1 outside workspace'));
});

test('dispose removes the rail and stops reacting', (t) => {
  const { bus, presenter, viewportEl, view } = setup(t);
  use(bus, { callId: 'c1', input: { path: 'renderer/App.js' } });
  presenter.dispose();
  assert.equal(viewportEl.querySelector('.ide-map-activity-rail'), null);
  const paintCount = view.calls.length;
  use(bus, { callId: 'c2', input: { path: 'services/x.js' } });
  assert.equal(view.calls.length, paintCount, 'no paints after dispose');
});
