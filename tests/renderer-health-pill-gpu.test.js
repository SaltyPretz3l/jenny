'use strict';

/* Row 59 checkpoint 6 (renderer): GPU-memory evidence in the health pill popover. Tones, evidence,
   the external process named by basename only (escaped), "Hide for 10 minutes" calling dismissWarning with
   the CURRENT warning_id (a stale id re-reads instead of failing), one calm toast per warning episode, and
   the pill following the warning. No remediation anywhere. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const gpuModule = require('../renderer/shell/renderer-health-pill-gpu.js');
const { buildPopoverMarkup } = require('../renderer/shell/renderer-health-pill-markup-utils.js');
const { createHealthPillController } = require('../renderer/shell/renderer-health-pill-utils.js');
const { deriveRuntimeHealthState } = require('../renderer/shell/renderer-runtime-health-utils.js');
const fx = require('./helpers/performance-snapshot-fixture.js');

const flush = async (rounds = 8) => { for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const NOW = 1_000_000;

const lowGpu = (overrides = {}, warning = {}) => fx.gpu({
  adapter: { ...fx.gpu().adapter, dedicated_free_bytes: 0.6 * fx.GiB },
  warning: fx.warning({ warning_id: fx.UUID_A, state: 'low_headroom', since: 900_000, evidence_codes: ['low_headroom_latched'], last_confirmed_state: 'low_headroom', ...warning }),
  ...overrides,
});
const contentionGpu = (rows) => lowGpu({ external_processes: rows }, { state: 'possible_contention', evidence_codes: ['low_headroom_latched', 'external_dedicated_allocation'], last_confirmed_state: 'possible_contention' });
const spillGpu = () => lowGpu({}, { state: 'possible_spill', evidence_codes: ['low_headroom_latched', 'managed_shared_above_baseline'], last_confirmed_state: 'possible_spill' });
const proc = (basename, gib, pid = 7) => ({ pid, created_at: '1', basename, dedicated_bytes: gib * fx.GiB, shared_bytes: 0 });

test('tones: low headroom and possible contention are warning, possible spill is danger', () => {
  const settings = fx.settings();
  assert.equal(gpuModule.describeGpu(lowGpu(), settings, NOW).tone, 'warning');
  assert.equal(gpuModule.describeGpu(contentionGpu([proc('ollama.exe', 6)]), settings, NOW).tone, 'warning');
  assert.equal(gpuModule.describeGpu(spillGpu(), settings, NOW).tone, 'danger');
});

test('state lines say "possible" and never claim a cause', () => {
  const settings = fx.settings();
  assert.equal(gpuModule.describeGpu(lowGpu(), settings, NOW).stateLine, 'GPU memory headroom is low');
  assert.equal(gpuModule.describeGpu(contentionGpu([proc('ollama.exe', 6)]), settings, NOW).stateLine, 'Possible GPU memory contention');
  assert.equal(gpuModule.describeGpu(spillGpu(), settings, NOW).stateLine, 'Possible spill into shared GPU memory');
  assert.match(gpuModule.describeGpu(spillGpu(), settings, NOW).caveat, /not a proven cause/);
});

test('nothing to say: clear, warnings off, dismissed, or unknown with nothing confirmed', () => {
  assert.equal(gpuModule.describeGpu(fx.gpu(), fx.settings(), NOW), null, 'clear');
  assert.equal(gpuModule.describeGpu(lowGpu(), fx.settings({ gpu_warnings_enabled: false }), NOW), null, 'warnings off');
  assert.equal(gpuModule.describeGpu(lowGpu({}, { dismissed_until: NOW + 60_000 }), fx.settings(), NOW), null, 'dismissed');
  assert.notEqual(gpuModule.describeGpu(lowGpu({}, { dismissed_until: NOW - 1 }), fx.settings(), NOW), null, 'a lapsed dismissal shows again');
  assert.equal(gpuModule.describeGpu(fx.gpu({ warning: fx.warning({ state: 'unknown' }) }), fx.settings(), NOW), null, 'unknown, nothing confirmed');
  assert.equal(gpuModule.describeGpu(fx.gpu({ warning: fx.warning({ state: 'unknown', last_confirmed_state: 'clear' }) }), fx.settings(), NOW), null, 'unknown after clear');
  assert.equal(gpuModule.describeGpu(null, fx.settings(), NOW), null);
});

test('unknown keeps the last confirmed state, muted, with no actionable id and no evidence guesses', () => {
  const view = gpuModule.describeGpu(lowGpu({ state: 'stale' }, { state: 'unknown', evidence_codes: [], last_confirmed_state: 'possible_spill' }), fx.settings(), NOW);
  assert.equal(view.tone, 'muted');
  assert.equal(view.state, 'unknown');
  assert.equal(view.stateLine, 'GPU memory can\u2019t be confirmed right now');
  assert.deepEqual(view.evidence, ['Last confirmed: Possible spill into shared GPU memory']);
});

test('evidence lines: free/total, the engine\u2019s shared use, and the named external process', () => {
  const settings = fx.settings();
  assert.deepEqual(gpuModule.describeGpu(lowGpu(), settings, NOW).evidence, ['Free GPU memory: 0.6 GB of 32.0 GB']);
  assert.deepEqual(gpuModule.describeGpu(spillGpu(), settings, NOW).evidence, [
    'Free GPU memory: 0.6 GB of 32.0 GB',
    'The local engine holds 0.2 GB of shared GPU memory, above its usual level.',
  ]);
  const view = gpuModule.describeGpu(contentionGpu([proc('ollama.exe', 6.4), proc('tiny.exe', 0.1), proc('browser.exe', 1.0)]), settings, NOW);
  assert.deepEqual(view.evidence, [
    'Free GPU memory: 0.6 GB of 32.0 GB',
    'Another process, ollama.exe, holds 6.4 GB of GPU memory.',
    'Another process, browser.exe, holds 1.0 GB of GPU memory.',
  ], 'only rows at or above the 256 MiB threshold, largest first, at most two');
  const partial = gpuModule.describeGpu(lowGpu({ state: 'partial' }), settings, NOW);
  assert.ok(partial.evidence.includes('Some processes may not be listed.'));
  const stale = gpuModule.describeGpu(lowGpu({ state: 'stale' }), settings, NOW);
  assert.ok(stale.evidence.includes('This reading is out of date.'));
});

test('an external process is shown by basename only and escaped in the markup', () => {
  assert.equal(gpuModule.safeBasename('C:\\Program Files\\Evil\\ollama.exe'), 'ollama.exe');
  assert.equal(gpuModule.safeBasename('/usr/bin/evil\u0007name'), 'evilname');
  assert.equal(gpuModule.safeBasename(null), '');
  const view = gpuModule.describeGpu(contentionGpu([proc('C:\\tools\\<img src=x onerror=alert(1)>.exe', 3)]), fx.settings(), NOW);
  assert.ok(view.evidence.some((line) => line.includes('<img src=x onerror=alert(1)>.exe')), 'the model-visible text is the basename');
  assert.ok(!view.evidence.some((line) => line.includes('tools')), 'no path reaches the view');
  const html = gpuModule.buildGpuSection(view);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;\.exe/);
});

test('the section offers "Hide for 10 minutes" and no remediation', () => {
  const html = gpuModule.buildGpuSection(gpuModule.describeGpu(spillGpu(), fx.settings(), NOW));
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  const actions = [...doc.querySelectorAll('[data-health-pill-action]')];
  assert.deepEqual(actions.map((node) => [node.dataset.healthPillAction, node.textContent.trim()]), [['hide-gpu-warning', 'Hide for 10 minutes']]);
  assert.doesNotMatch(doc.body.textContent, /\b(restart|stop|kill|unload|close the|end task|terminate)\b/i);
  assert.equal(doc.querySelector('[data-health-gpu]').dataset.gpuTone, 'danger');
  assert.equal(gpuModule.buildGpuSection(null), '');
  const muted = gpuModule.buildGpuSection(gpuModule.describeGpu(lowGpu({}, { state: 'unknown', evidence_codes: [] }), fx.settings(), NOW));
  assert.match(muted, /data-gpu-tone="muted"/);
});

test('the popover markup places the section after Recent errors and is byte-identical without one', () => {
  const state = { error: '', toneLabel: { tone: 'success', label: 'Ready' } };
  const snapshot = { runtime: { lifecycle: { available: true, state: 'ready', phase: 'ready' }, provider_capability_profiles: [], recent_tool_observations: [] } };
  const plain = buildPopoverMarkup(state, snapshot, {});
  assert.equal(buildPopoverMarkup(state, snapshot, { gpuSection: '' }), plain);
  const section = gpuModule.buildGpuSection(gpuModule.describeGpu(lowGpu(), fx.settings(), NOW));
  const withGpu = buildPopoverMarkup(state, snapshot, { gpuSection: section, recentErrors: [{ code: 'E', title: 'boom', severity: 'danger', at: 1, seen: false, key: 'k' }] });
  assert.ok(withGpu.indexOf('workbench-health-popover-gpu') > withGpu.indexOf('workbench-health-popover-errors'));
  assert.ok(withGpu.indexOf('workbench-health-popover-gpu') < withGpu.indexOf('workbench-health-popover-actions'));
});

function feedWith(initial, extra = {}) {
  const bridge = fx.createPerformanceBridge(initial);
  const toasts = [];
  const opened = [];
  let changes = 0;
  const feed = gpuModule.createGpuFeed({
    window: { jennyShell: { performance: bridge } }, now: () => NOW,
    showToastMessage: (message, options) => toasts.push({ message, options }),
    openPopover: () => opened.push(1), onChange: () => { changes += 1; }, ...extra,
  });
  return { bridge, feed, toasts, opened, changes: () => changes };
}

test('absent bridge: no feed at all', () => {
  assert.equal(gpuModule.createGpuFeed({ window: { jennyShell: {} } }), null);
  assert.equal(gpuModule.createGpuFeed({ window: {} }), null);
});

test('one calm toast per warning episode: dedupeKey is the warning_id, the action opens the popover', async () => {
  const { bridge, feed, toasts, opened } = feedWith({ gpu: lowGpu() });
  feed.start();
  await flush();
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].message, 'GPU memory headroom is low');
  assert.equal(toasts[0].options.dedupeKey, fx.UUID_A);
  assert.equal(toasts[0].options.tone, 'warning');
  assert.equal(toasts[0].options.sticky, undefined, 'not sticky: calm');
  assert.equal(toasts[0].options.actions.length, 1);
  toasts[0].options.actions[0].onClick();
  assert.equal(opened.length, 1, 'the action opens the health pill popover');

  bridge.emit({ session_id: null, terminal: false, scope: 'gpu' });
  bridge.emit({ session_id: null, terminal: false, scope: 'gpu' });
  await flush();
  assert.equal(toasts.length, 1, 'the same episode never toasts again');

  bridge.current = fx.snapshot({ gpu: spillGpu() });
  bridge.emit({ session_id: null, terminal: false, scope: 'gpu' });
  await flush();
  assert.equal(toasts.length, 1, 'a worsening within the same warning_id is still the same episode');

  bridge.current = fx.snapshot({ gpu: lowGpu({}, { warning_id: fx.UUID_B }) });
  bridge.emit({ session_id: null, terminal: false, scope: 'gpu' });
  await flush();
  assert.equal(toasts.length, 2, 'a new episode toasts once');
  assert.equal(toasts[1].options.dedupeKey, fx.UUID_B);
  feed.dispose();
});

test('no toast for clear, unknown, dismissed, or warnings turned off', async () => {
  for (const initial of [
    { gpu: fx.gpu() },
    { gpu: lowGpu({}, { state: 'unknown', evidence_codes: [] }) },
    { gpu: lowGpu({}, { dismissed_until: Date.now() + 600_000 }) },
    { gpu: lowGpu(), settings: fx.settings({ gpu_warnings_enabled: false }) },
  ]) {
    const { feed, toasts } = feedWith(initial, { now: () => Date.now() });
    feed.start();
    await flush();
    assert.equal(toasts.length, 0);
    feed.dispose();
  }
});

test('warnings do not depend on the Performance section: they show with the counter off', async () => {
  const { feed, toasts } = feedWith({ gpu: lowGpu(), settings: fx.settings({ show_counter: false }) });
  feed.start();
  await flush();
  assert.equal(toasts.length, 1);
  assert.notEqual(feed.sectionHtml(), '');
  feed.dispose();
});

test('Hide for 10 minutes calls dismissWarning with the current warning_id; the section follows the answer', async () => {
  const { bridge, feed } = feedWith({ gpu: lowGpu() });
  feed.start();
  await flush();
  assert.equal(feed.view().warningId, fx.UUID_A);
  bridge.respondDismiss = () => ({ ok: true, gpu: lowGpu({}, { dismissed_until: Date.now() + 600_000 }) });
  const result = await feed.dismiss();
  assert.equal(result, true);
  assert.deepEqual(bridge.dismissCalls, [{ schema_version: 1, session_id: gpuModule.HOST_SESSION_ID, warning_id: fx.UUID_A }]);
  assert.equal(feed.view(), null);
  assert.equal(feed.sectionHtml(), '');
  feed.dispose();
});

test('a stale warning id is not an error to show: the snapshot is re-read and the section follows it', async () => {
  const { bridge, feed } = feedWith({ gpu: lowGpu() });
  feed.start();
  await flush();
  const before = bridge.snapshotCalls.length;
  bridge.current = fx.snapshot({ gpu: fx.gpu() });
  bridge.respondDismiss = () => ({ ok: false, code: 'CMP-PERFORMANCE-0004', reason: 'stale_warning' });
  assert.equal(await feed.dismiss(), false);
  await flush();
  assert.equal(bridge.snapshotCalls.length, before + 1);
  assert.equal(feed.view(), null, 'the ended episode is gone');
  bridge.respondDismiss = () => { throw new Error('bridge died'); };
  assert.equal(await feed.dismiss(), false, 'nothing to dismiss and nothing thrown');
  feed.dispose();
});

test('dismiss with a thrown bridge error is handled', async () => {
  const { bridge, feed } = feedWith({ gpu: lowGpu() });
  feed.start();
  await flush();
  bridge.respondDismiss = () => { throw new Error('bridge died'); };
  assert.equal(await feed.dismiss(), false);
  feed.dispose();
});

test('the pill\u2019s tone follows an active warning only while it would otherwise read healthy', async () => {
  const { feed } = feedWith({ gpu: spillGpu() });
  feed.start();
  await flush();
  const ready = { tone: 'success', label: 'Ready', summary: '', segments: [] };
  const adjusted = feed.adjustSignal(ready);
  assert.equal(adjusted.tone, 'danger');
  assert.equal(adjusted.label, 'GPU memory');
  assert.equal(adjusted.summary, 'Possible spill into shared GPU memory');
  const loading = { tone: 'pending', label: 'Loading', summary: '' };
  assert.equal(feed.adjustSignal(loading), loading);
  const danger = { tone: 'danger', label: 'Error', summary: '' };
  assert.equal(feed.adjustSignal(danger), danger);
  feed.dispose();
  const unknown = feedWith({ gpu: lowGpu({}, { state: 'unknown', evidence_codes: [], last_confirmed_state: 'possible_spill' }) });
  unknown.feed.start();
  await flush();
  assert.equal(unknown.feed.adjustSignal(ready), ready, 'unknown does not repaint the pill');
  unknown.feed.dispose();
});

test('dispose releases the subscription', async () => {
  const { bridge, feed } = feedWith({ gpu: lowGpu() });
  feed.start();
  await flush();
  assert.equal(bridge.listenerCount(), 1);
  feed.dispose();
  assert.equal(bridge.listenerCount(), 0);
});

// ── the real pill controller ──────────────────────────────────────────────
function pillHarness(bridge) {
  const dom = new JSDOM('<!doctype html><body><div id="slot"></div></body>');
  const { window } = dom;
  const toasts = [];
  window.jennyShell = {
    diagnostics: { getJennyStatus: async () => ({ runtime: { lifecycle: { available: true, state: 'ready', phase: 'ready' }, provider_capability_profiles: [], recent_tool_observations: [] } }) },
    ...(bridge ? { performance: bridge } : {}),
  };
  globalThis.rendererHealthPillGpu = gpuModule;
  const controller = createHealthPillController({
    window, document: window.document, slot: window.document.getElementById('slot'), deriveRuntimeHealthState,
    setActiveView() {}, setActiveSettingsSection() {}, showToastMessage: (message, options) => toasts.push({ message, options }),
  });
  return { window, controller, toasts, slot: window.document.getElementById('slot') };
}

test('the real pill: the popover carries the GPU section, Hide calls dismissWarning, the popover stays open', async (t) => {
  t.after(() => { delete globalThis.rendererHealthPillGpu; });
  const bridge = fx.createPerformanceBridge({ gpu: contentionGpu([proc('ollama.exe', 6.4)]) });
  const { window, controller, toasts, slot } = pillHarness(bridge);
  t.after(() => controller.dispose());
  await controller.refresh({ silent: true });
  await flush();
  assert.equal(toasts.length, 1, 'one toast for the episode');
  const pill = slot.querySelector('button');
  assert.match(slot.innerHTML, /data-health-tone="warning"/, 'the pill follows the warning tone');
  pill.click();
  const doc = window.document;
  const section = doc.querySelector('.workbench-health-popover [data-health-gpu]');
  assert.ok(section, 'the popover has the GPU section');
  assert.match(section.textContent, /Possible GPU memory contention/);
  assert.match(section.textContent, /Another process, ollama\.exe, holds 6\.4 GB of GPU memory\./);

  bridge.respondDismiss = () => ({ ok: true, gpu: lowGpu({}, { state: 'possible_contention', dismissed_until: Date.now() + 600_000 }) });
  doc.querySelector('[data-health-pill-action="hide-gpu-warning"]').click();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(bridge.dismissCalls)), [{ schema_version: 1, session_id: gpuModule.HOST_SESSION_ID, warning_id: fx.UUID_A }]);
  assert.equal(controller.isPopoverOpen(), true, 'hiding the warning does not close the popover');
  assert.equal(doc.querySelector('[data-health-gpu]'), null, 'the section is gone once hidden');
  assert.doesNotMatch(slot.innerHTML, /data-health-tone="warning"/, 'and the pill is calm again');
});

test('the real pill: a GPU invalidation repaints the open popover (the signature includes the GPU fields)', async (t) => {
  t.after(() => { delete globalThis.rendererHealthPillGpu; });
  const bridge = fx.createPerformanceBridge({ gpu: fx.gpu() });
  const { window, controller } = pillHarness(bridge);
  t.after(() => controller.dispose());
  await controller.refresh({ silent: true });
  await flush();
  window.document.querySelector('button').click();
  assert.equal(window.document.querySelector('[data-health-gpu]'), null);
  bridge.current = fx.snapshot({ gpu: spillGpu() });
  bridge.emit({ session_id: null, terminal: false, scope: 'gpu' });
  await flush();
  const section = window.document.querySelector('[data-health-gpu]');
  assert.ok(section);
  assert.equal(section.dataset.gpuTone, 'danger');
  bridge.current = fx.snapshot({ gpu: fx.gpu() });
  bridge.emit({ session_id: null, terminal: false, scope: 'gpu' });
  await flush();
  assert.equal(window.document.querySelector('[data-health-gpu]'), null);
});

test('the real pill without the bridge is exactly as before', async (t) => {
  t.after(() => { delete globalThis.rendererHealthPillGpu; });
  const { window, controller } = pillHarness(null);
  t.after(() => controller.dispose());
  await controller.refresh({ silent: true });
  window.document.querySelector('button').click();
  assert.equal(window.document.querySelector('[data-health-gpu]'), null);
  assert.equal(controller.getState().tone, 'success');
});
