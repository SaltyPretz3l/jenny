'use strict';

/* Row 59 checkpoint 6 (renderer): the rail controller with a fake window.jennyShell.performance bridge.
   The Performance section appears after the last section only while the counter is on, is never one of
   the persisted sections, follows its own session, reads nothing while the rail is not shown (row 195),
   and releases everything on dispose. */

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { flush, docked } = require('./helpers/session-rail-fixture.js');
const fx = require('./helpers/performance-snapshot-fixture.js');
const perf = require('../renderer/chat/renderer-session-rail-performance.js');
const rails = require('../renderer/chat/renderer-session-rail.js');

const sections = (f) => [...f.doc.querySelectorAll('[data-section]')].map((node) => node.dataset.section);
const writingState = (f) => f.section('performance').querySelector('[data-row-key="writing"]').dataset.state;

test('counter on: the Performance section is appended after the last section, expanded, with the PO rows and scope line', async () => {
  const bridge = fx.createPerformanceBridge();
  const f = await docked({ performance: bridge });
  assert.deepEqual(sections(f), ['this_chat', 'context', 'running_now', 'performance']);
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

test('the section is not persisted: folding it writes nothing and leaves the summary disclosures alone', async () => {
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
  assert.deepEqual(sections(f), ['this_chat', 'context', 'running_now']);
  f.api.dispose();
});

test('no performance bridge: nothing renders and nothing throws', async () => {
  const f = await docked();
  assert.deepEqual(sections(f), ['this_chat', 'context', 'running_now']);
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
  const f = await docked({ performance: bridge });
  assert.equal(writingState(f), 'available');
  bridge.respondSnapshot = (request) => (request.session_id === 'sess_b'
    ? fx.snapshot({ inference: fx.inference({ live_decode: fx.metric(null, 'warming', null) }) })
    : bridge.current);
  f.changeSession('sess_b');
  await flush();
  assert.deepEqual(bridge.snapshotCalls.at(-1), { schema_version: 1, session_id: 'sess_b' });
  assert.equal(writingState(f), 'warming', 'the old session\'s rate is gone');
  f.api.dispose();
});

test('a reading never freezes as live: the safety refetch surfaces the service’s stale answer', async () => {
  const bridge = fx.createPerformanceBridge();
  const f = await docked({ performance: bridge });
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
  assert.equal(writingState(f), 'stale', 'the stale rate is not on display as live');
  f.api.dispose();
});

test('a failed refresh keeps the last reading demoted to stale, never live', async () => {
  const bridge = fx.createPerformanceBridge();
  const f = await docked({ performance: bridge });
  assert.equal(f.section('performance').querySelector('[data-row-key="writing"]').dataset.state, 'available');
  bridge.respondSnapshot = () => { throw new Error('offline'); };
  bridge.emit({ session_id: 'sess_a', terminal: false, scope: 'inference' });
  await flush();
  const writing = f.section('performance').querySelector('[data-row-key="writing"]');
  assert.equal(writing.dataset.state, 'stale');
  assert.match(writing.textContent, /182 tok\/s.*stale/);
  f.api.dispose();
});

test('dispose releases the bridge subscription and the section; later events do nothing', async () => {
  const bridge = fx.createPerformanceBridge();
  const f = await docked({ performance: bridge });
  assert.equal(bridge.listenerCount(), 1);
  const calls = bridge.snapshotCalls.length;
  f.api.dispose();
  assert.equal(bridge.listenerCount(), 0);
  bridge.emit({ session_id: 'sess_a', terminal: false, scope: 'settings' });
  await flush();
  assert.equal(bridge.snapshotCalls.length, calls);
  assert.equal(f.doc.querySelector('[data-section="performance"]'), null);
});

test('the stylesheet gives the scope line its dashed rule, is imported, and uses tokens only', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-session-rail-performance.css'), 'utf8');
  assert.match(css, /\.session-rail-perf-scope \{[^}]*border-block-start: 1px dashed/s);
  const entry = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
  assert.match(entry, /styles\/chat-session-rail-performance\.css/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(|--[a-z-]+:\s*[^;]*;/i, 'tokens only: no literal colours and no new custom properties');
});

test('the performance stylesheet is plain text', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-session-rail-performance.css'), 'utf8');
  // eslint-disable-next-line no-control-regex
  assert.equal(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(css), false, 'no control bytes in the stylesheet');
});

test('a closed tab costs nothing: hidden, the section reads nothing and its safety timer stops; shown again, it reads once', async (t) => {
  let shown = false;
  rails.configure({ isShown: () => shown });
  t.after(() => rails.configure({ isShown: null }));
  const bridge = fx.createPerformanceBridge();
  const f = await docked({ performance: bridge });
  t.after(() => { f.api.dispose(); f.window.close(); });
  const timers = new Map();
  let nextId = 0;
  f.window.setTimeout = (callback, delay) => { nextId += 1; timers.set(nextId, { callback, delay }); return nextId; };
  f.window.clearTimeout = (id) => { timers.delete(id); };
  assert.equal(bridge.snapshotCalls.length, 0, 'not shown at mount: no read');
  bridge.emit({ session_id: 'sess_a', terminal: false, scope: 'inference' });
  bridge.emit({ session_id: null, scope: 'settings' });
  await flush();
  assert.equal(bridge.snapshotCalls.length, 0, 'events do no read while hidden');
  shown = true;
  rails.syncHosts();
  await flush();
  assert.equal(bridge.snapshotCalls.length, 1, 'one read when it shows');
  assert.ok([...timers.values()].some((timer) => timer.delay === perf.SAFETY_REFETCH_MS), 'a live rate is on display, so the safety timer runs');
  shown = false;
  rails.syncHosts();
  assert.equal([...timers.values()].some((timer) => timer.delay === perf.SAFETY_REFETCH_MS), false, 'hiding stops the safety timer');
  bridge.emit({ session_id: 'sess_a', terminal: false, scope: 'inference' });
  await flush();
  assert.equal(bridge.snapshotCalls.length, 1);
});
