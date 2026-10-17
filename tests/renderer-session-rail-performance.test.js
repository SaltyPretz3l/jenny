'use strict';

/* Row 59 checkpoint 6 (renderer): the rail controller with a fake window.jennyShell.performance bridge.
   The Performance section appears after Background tasks only while the counter is on, is never one of
   the five persisted sections, follows its own session, and releases everything on dispose; the Session
   toggle carries a readout only undocked with a live "available" decode rate (value in the accessible
   name, no live region). */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { flush, docked } = require('./helpers/session-rail-fixture.js');
const fx = require('./helpers/performance-snapshot-fixture.js');
const perf = require('../renderer/chat/renderer-session-rail-performance.js');

const sections = (f) => [...f.doc.querySelectorAll('[data-section]')].map((node) => node.dataset.section);
const readout = (f) => f.toggle().querySelector('[data-session-rail-readout]');

test('counter on: the Performance section is appended after Background tasks, expanded, with the PO rows and scope line', async () => {
  const bridge = fx.createPerformanceBridge();
  const f = await docked({ performance: bridge });
  assert.deepEqual(sections(f), ['environment', 'context', 'outputs', 'changes', 'background_tasks', 'performance']);
  assert.deepEqual(bridge.snapshotCalls, [{ schema_version: 1, session_id: 'sess_a' }]);
  const section = f.section('performance');
  assert.equal(section.hidden, false);
  assert.equal(section.querySelector('[data-rail-performance-head]').getAttribute('aria-expanded'), 'true');
  assert.equal(section.querySelector('.session-rail-section-title').textContent, 'Performance');
  assert.equal(section.querySelector('[data-rail-perf-value]').textContent, '182 tok/s');
  assert.deepEqual([...section.querySelectorAll('.session-rail-perf-label')].map((node) => node.textContent), ['Writing', 'Prompt reading', 'First token', 'Reused from cache']);
  assert.match(section.querySelector('.session-rail-perf-scope').textContent, /This PC · GPU 7\.2 GB of 32\.0 GB free/);
  assert.equal(section.querySelector('.session-rail-perf-scope').matches('[data-row-key="scope"]'), true);
  assert.equal(f.rail().querySelector('.session-rail-tray').lastElementChild, section, 'last in the tray');
  f.api.dispose();
});

test('the section is not persisted: folding it writes nothing and leaves the five summary disclosures alone', async () => {
  const bridge = fx.createPerformanceBridge();
  const f = await docked({ performance: bridge });
  const head = f.section('performance').querySelector('[data-rail-performance-head]');
  head.click();
  await flush();
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.equal(f.bridge.setViewCalls.length, 0, 'no workspace-view write');
  head.click();
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  f.api.dispose();
});

test('counter off: the section is not in the DOM at all', async () => {
  const bridge = fx.createPerformanceBridge({ settings: fx.settings({ show_counter: false }) });
  const f = await docked({ performance: bridge });
  assert.deepEqual(sections(f), ['environment', 'context', 'outputs', 'changes', 'background_tasks']);
  f.api.dispose();
});

test('no performance bridge: nothing renders and nothing throws', async () => {
  const f = await docked();
  assert.deepEqual(sections(f), ['environment', 'context', 'outputs', 'changes', 'background_tasks']);
  assert.equal(readout(f).hidden, true);
  f.api.dispose();
});

test('a settings invalidation shows and hides the section', async () => {
  const bridge = fx.createPerformanceBridge({ settings: fx.settings({ show_counter: false }) });
  const f = await docked({ performance: bridge });
  bridge.current = fx.snapshot({ settings: fx.settings({ show_counter: true }) });
  bridge.emit({ session_id: null, terminal: false, scope: 'settings' });
  await flush();
  assert.equal(sections(f).includes('performance'), true);
  bridge.current = fx.snapshot({ settings: fx.settings({ show_counter: false }) });
  bridge.emit({ session_id: null, terminal: false, scope: 'settings' });
  await flush();
  assert.equal(sections(f).includes('performance'), false);
  f.api.dispose();
});

test('invalidations: this session and host-wide events refetch; another session does not; one request in flight', async () => {
  const bridge = fx.createPerformanceBridge();
  const f = await docked({ performance: bridge });
  const base = bridge.snapshotCalls.length;
  bridge.emit({ session_id: 'sess_other', terminal: false, scope: 'inference' });
  await flush();
  assert.equal(bridge.snapshotCalls.length, base, 'another session’s metrics are never fetched for this rail');
  bridge.emit({ session_id: 'sess_a', terminal: false, scope: 'inference' });
  await flush();
  assert.equal(bridge.snapshotCalls.length, base + 1);
  bridge.emit({ session_id: null, terminal: false, scope: 'gpu' });
  await flush();
  assert.equal(bridge.snapshotCalls.length, base + 2, 'a host-wide GPU change refreshes the scope line');

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  bridge.respondSnapshot = async () => { await gate; return bridge.current; };
  bridge.emit({ session_id: 'sess_a', terminal: false, scope: 'inference' });
  bridge.emit({ session_id: 'sess_a', terminal: false, scope: 'inference' });
  bridge.emit({ session_id: 'sess_a', terminal: true, scope: 'inference' });
  await flush();
  assert.equal(bridge.snapshotCalls.length, base + 3, 'the burst waits behind the request in flight');
  release();
  await flush(12);
  assert.equal(bridge.snapshotCalls.length, base + 4, 'exactly one follow-up');
  f.api.dispose();
});

test('counter off: only a settings change refetches (no polling for a section nobody sees)', async () => {
  const bridge = fx.createPerformanceBridge({ settings: fx.settings({ show_counter: false }) });
  const f = await docked({ performance: bridge });
  const base = bridge.snapshotCalls.length;
  bridge.emit({ session_id: 'sess_a', terminal: false, scope: 'inference' });
  bridge.emit({ session_id: null, terminal: false, scope: 'gpu' });
  await flush();
  assert.equal(bridge.snapshotCalls.length, base);
  bridge.emit({ session_id: null, terminal: false, scope: 'settings' });
  await flush();
  assert.equal(bridge.snapshotCalls.length, base + 1);
  f.api.dispose();
});

test('a session change clears the old reading and asks for the new session', async () => {
  const bridge = fx.createPerformanceBridge();
  const f = await docked({ performance: bridge, width: 700 });
  assert.equal(readout(f).hidden, false);
  bridge.respondSnapshot = (request) => (request.session_id === 'sess_b'
    ? fx.snapshot({ inference: fx.inference({ live_decode: fx.metric(null, 'warming', null) }) })
    : bridge.current);
  f.changeSession('sess_b');
  await flush();
  assert.deepEqual(bridge.snapshotCalls.at(-1), { schema_version: 1, session_id: 'sess_b' });
  assert.equal(readout(f).hidden, true, 'warming offers no readout');
  f.api.dispose();
});

test('toggle readout: undocked + counter on + available decode shows "Session · 182 tok/s"', async () => {
  const f = await docked({ performance: fx.createPerformanceBridge(), width: 700 });
  assert.equal(f.pane.dataset.sessionRail, 'undocked');
  const slot = readout(f);
  assert.equal(slot.hidden, false);
  assert.equal(slot.querySelector('[data-session-rail-readout-value]').textContent, '182 tok/s');
  assert.equal(f.toggle().querySelector('.chat-timeline-utility-text').textContent, 'Session');
  assert.equal(f.toggle().getAttribute('aria-label'), 'Session summary · 182 tok/s', 'the value is in the accessible name');
  assert.equal(f.toggle().hasAttribute('data-readout-compact'), false);
  f.api.dispose();
});

test('toggle readout is not a live region', async () => {
  const f = await docked({ performance: fx.createPerformanceBridge(), width: 700 });
  assert.equal(f.toggle().closest('[aria-live]'), null);
  assert.equal(f.toggle().querySelector('[aria-live], [role="status"], [role="alert"]'), null);
  assert.equal(f.toggle().hasAttribute('aria-live'), false);
  f.api.dispose();
});

test('toggle readout: docked rails show none (icon-only toggle, plain name)', async () => {
  const f = await docked({ performance: fx.createPerformanceBridge(), width: 1133 });
  assert.equal(f.pane.dataset.sessionRail, 'docked');
  assert.equal(readout(f).hidden, true);
  assert.equal(f.toggle().hasAttribute('aria-label'), false);
  f.api.dispose();
});

test('toggle readout appears when the rail undocks and leaves when it docks again', async () => {
  const f = await docked({ performance: fx.createPerformanceBridge(), width: 1133 });
  await f.resize(700);
  assert.equal(readout(f).hidden, false);
  await f.resize(1133);
  assert.equal(readout(f).hidden, true);
  assert.equal(f.toggle().hasAttribute('aria-label'), false);
  f.api.dispose();
});

test('toggle readout: only an available decode rate (warming, stale, unavailable, next-request, finished show none)', async () => {
  const cases = {
    warming: fx.inference({ live_decode: fx.metric(null, 'warming', null) }),
    stale: fx.inference({ live_decode: fx.metric(180, 'stale', 900) }),
    unavailable: fx.inference({ live_decode: fx.metric(null, 'unavailable', null) }),
    nextRequest: fx.inference({ live_decode: fx.metric(null, 'available_next_request', null) }),
    finished: fx.inference({ observation: fx.observation({ phase: 'finished', terminal_decode_tps: 124 }) }),
    idle: null,
  };
  for (const [name, inference] of Object.entries(cases)) {
    const f = await docked({ performance: fx.createPerformanceBridge({ inference }), width: 700 });
    assert.equal(readout(f).hidden, true, `${name}: no readout`);
    assert.equal(f.toggle().hasAttribute('aria-label'), false, `${name}: plain name`);
    assert.equal(f.toggle().querySelector('.chat-timeline-utility-text').textContent, 'Session');
    f.api.dispose();
  }
});

test('toggle readout: counter off shows none even with a live rate', async () => {
  const f = await docked({ performance: fx.createPerformanceBridge({ settings: fx.settings({ show_counter: false }) }), width: 700 });
  assert.equal(readout(f).hidden, true);
  f.api.dispose();
});

test('narrow pane: the word drops (marked for the stylesheet), icon and rate remain', async () => {
  const f = await docked({ performance: fx.createPerformanceBridge(), width: 400 });
  assert.equal(f.pane.dataset.sessionRail, 'undocked');
  assert.equal(readout(f).hidden, false);
  assert.equal(f.toggle().hasAttribute('data-readout-compact'), true);
  assert.equal(f.toggle().querySelector('[data-session-rail-readout-value]').textContent, '182 tok/s');
  await f.resize(perf.NARROW_PANE_PX + 50);
  assert.equal(f.toggle().hasAttribute('data-readout-compact'), false);
  f.api.dispose();
});

test('a reading never freezes as live: the safety refetch surfaces the service’s stale answer', async () => {
  const bridge = fx.createPerformanceBridge();
  const f = await docked({ performance: bridge, width: 700 });
  const timers = [];
  f.window.setTimeout = (callback, delay) => { timers.push({ callback, delay }); return timers.length; };
  f.window.clearTimeout = () => {};
  bridge.emit({ session_id: 'sess_a', terminal: false, scope: 'inference' });
  await flush();
  const safety = timers.find((timer) => timer.delay === perf.SAFETY_REFETCH_MS);
  assert.ok(safety, 'a refetch is scheduled while a live rate is on display');
  const calls = bridge.snapshotCalls.length;
  bridge.current = fx.snapshot({ inference: fx.inference({ live_decode: fx.metric(182.4, 'stale', 1000) }) });
  safety.callback();
  await flush();
  assert.equal(bridge.snapshotCalls.length, calls + 1);
  assert.equal(readout(f).hidden, true, 'the stale rate is not on display');
  f.api.dispose();
});

test('a failed refresh keeps the last reading demoted to stale, never live', async () => {
  const bridge = fx.createPerformanceBridge();
  const f = await docked({ performance: bridge, width: 1133 });
  assert.equal(f.section('performance').querySelector('[data-row-key="writing"]').dataset.state, 'available');
  bridge.respondSnapshot = () => { throw new Error('offline'); };
  bridge.emit({ session_id: 'sess_a', terminal: false, scope: 'inference' });
  await flush();
  const writing = f.section('performance').querySelector('[data-row-key="writing"]');
  assert.equal(writing.dataset.state, 'stale');
  assert.match(writing.textContent, /182 tok\/s.*stale/);
  f.api.dispose();
});

test('dispose releases the bridge subscription, the section and the toggle name; later events do nothing', async () => {
  const bridge = fx.createPerformanceBridge();
  const f = await docked({ performance: bridge, width: 700 });
  assert.equal(bridge.listenerCount(), 1);
  const calls = bridge.snapshotCalls.length;
  f.api.dispose();
  assert.equal(bridge.listenerCount(), 0);
  bridge.emit({ session_id: 'sess_a', terminal: false, scope: 'settings' });
  await flush();
  assert.equal(bridge.snapshotCalls.length, calls);
  assert.equal(f.doc.querySelector('[data-section="performance"]'), null);
});

test('the stylesheet gives the readout tabular numbers, a CSS separator and a compact rule', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-session-rail-performance.css'), 'utf8');
  assert.match(css, /\.session-rail-readout \{[^}]*font-variant-numeric: tabular-nums/s);
  assert.match(css, /\.session-rail-toggle\[data-readout-compact\] \.chat-timeline-utility-text/);
  assert.match(css, /\.session-rail-perf-scope \{[^}]*border-block-start: 1px dashed/s);
  const entry = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(entry, /styles\/chat-session-rail-performance\.css/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|--[a-z-]+:\s*[^;]*;/i, 'tokens only: no literal colours and no new custom properties');
});

test('the readout separator stylesheet is plain text with the middle-dot escape', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-session-rail-performance.css'), 'utf8');
  // eslint-disable-next-line no-control-regex
  assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(css), false, 'no control bytes in the stylesheet');
  assert.ok(css.includes(`content: "${String.fromCharCode(92)}00b7";`), 'the separator is the CSS escape for U+00B7');
});
