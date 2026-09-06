/* ChatGPT plan-usage meter — pure logic + markup: thresholds at 75/90, derived
 * window labels, expiry, limit banner, gates, escaping. Bare JSDOM + the
 * inventory primitives; no app to dispose (mirrors renderer-context-ring.test.js). */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const inventoryChip = require('../renderer/inventory/chip');
const inventoryPopover = require('../renderer/inventory/popover');
const meter = require('../renderer/chat/renderer-plan-usage-meter');

const NOW = Date.UTC(2026, 8, 1, 12, 0, 0);
const SECONDS = (ms) => Math.floor(ms / 1000);

function withInventory(t, extras = {}) {
  global.inventory = { chip: inventoryChip, popover: inventoryPopover, ...extras };
  meter.setClock(() => NOW);
  t.after(() => {
    delete global.inventory;
    meter.dispose();
    meter.setClock(null);
  });
  meter.dispose();
}

function payload({ primary = 62, secondary = 18, reached = '', engineActive = true, capturedAgoMs = 2 * 60 * 1000,
  primaryReset = NOW + 72 * 60 * 1000, secondaryReset = NOW + 3 * 24 * 60 * 60 * 1000, account = { email: 'b@example.test', plan_type: 'plus' } } = {}) {
  return {
    ok: true,
    provider_id: 'chatgpt',
    engine_active: engineActive,
    account,
    snapshot: {
      version: 1,
      primary: primary === null ? undefined : { used_percent: primary, window_minutes: 300, reset_at: SECONDS(primaryReset) },
      secondary: secondary === null ? undefined : { used_percent: secondary, window_minutes: 10080, reset_at: SECONDS(secondaryReset) },
      rate_limit_reached_type: reached,
      captured_at_ms: NOW - capturedAgoMs,
      source: 'chat_done',
    },
  };
}

const chatgptState = { status: { engine: 'chatgpt' }, features: { featureFlags: {} } };

function selectedModelState(preferredModel, engineType, loadedEngine = 'ollama') {
  return {
    currentSessionId: 'session-1',
    sessions: [{ id: 'session-1', preferred_model: preferredModel }],
    modelList: { data: [{ id: preferredModel, engine_type: engineType }] },
    status: { engine: loadedEngine },
    features: { featureFlags: {} },
  };
}

function renderInto(dom, state = chatgptState) {
  const doc = dom.window.document;
  let host = doc.getElementById('planHost');
  if (!host) {
    host = doc.createElement('div');
    host.id = 'planHost';
    doc.body.appendChild(host);
  }
  meter.render(host, state, NOW);
  return host;
}

test('severity thresholds sit at 75 and 90 percent, not the context ring\'s 80/95', (t) => {
  withInventory(t);
  const cases = [[74, ''], [75, 'warning'], [89, 'warning'], [90, 'danger'], [100, 'danger']];
  for (const [percent, expected] of cases) {
    meter.applyPayload(payload({ primary: percent, secondary: 0 }));
    const summary = meter.describePlanUsage(null, NOW);
    assert.equal(summary.severity, expected, `${percent}% -> '${expected}'`);
  }
});

test('ring ratio is the max across non-expired windows', (t) => {
  withInventory(t);
  meter.applyPayload(payload({ primary: 20, secondary: 66 }));
  assert.equal(meter.describePlanUsage(null, NOW).ringRatio, 0.66);
  meter.applyPayload(payload({ primary: 20, secondary: 99, secondaryReset: NOW - 1000 }));
  const summary = meter.describePlanUsage(null, NOW);
  assert.equal(summary.ringRatio, 0.2, 'an expired window no longer drives the ring');
  assert.equal(summary.severity, '');
  assert.equal(summary.windows[1].expired, true);
  assert.match(summary.windows[1].resetLabel, /window reset/);
});

test('window labels are derived from window_minutes and never hardcoded', (t) => {
  withInventory(t);
  assert.equal(meter.formatWindowLabel(300), '5 hr window');
  assert.equal(meter.formatWindowLabel(10080), '7 day window');
  assert.equal(meter.formatWindowLabel(45), '45 min window');
  assert.equal(meter.formatWindowLabel(90), '1.5 hr window');
  assert.equal(meter.formatWindowLabel(0), 'Usage window');
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'chat', 'renderer-plan-usage-meter.js'), 'utf8');
  assert.ok(!/5 hr|7 day|weekly|five-hour/i.test(source), 'no plan-specific window literal in the module');
});

test('reset and updated labels', (t) => {
  withInventory(t);
  assert.equal(meter.formatResetLabel(NOW + 72 * 60 * 1000, NOW), 'resets in 1h 12m');
  assert.equal(meter.formatResetLabel(NOW + 42 * 60 * 1000, NOW), 'resets in 42m');
  assert.equal(meter.formatResetLabel(NOW + 30 * 1000, NOW), 'resets in under a minute');
  assert.equal(meter.formatResetLabel(NOW + 3 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000, NOW), 'resets in 3d 2h');
  assert.equal(meter.formatResetLabel(NOW - 1, NOW), 'window reset — awaiting next request');
  assert.equal(meter.formatResetLabel(0, NOW), 'reset time unknown');
  assert.equal(meter.formatUpdatedAgo(NOW - 5000, NOW), 'Updated just now');
  assert.equal(meter.formatUpdatedAgo(NOW + 60000, NOW), 'Updated just now', 'clock skew clamps to zero');
  assert.equal(meter.formatUpdatedAgo(NOW - 7 * 60 * 1000, NOW), 'Updated 7 min ago');
  assert.equal(meter.formatUpdatedAgo(NOW - 3 * 60 * 60 * 1000, NOW), 'Updated 3 hr ago');
  assert.equal(meter.formatUpdatedAgo(0, NOW), 'Updated after the last ChatGPT response');
});

test('limit banner shows for a reached window with a future reset and clears once it passes', (t) => {
  withInventory(t);
  meter.applyPayload(payload({ primary: 100, reached: 'primary', primaryReset: NOW + 42 * 60 * 1000 }));
  let summary = meter.describePlanUsage(null, NOW);
  assert.equal(summary.limitReached, true);
  assert.equal(summary.severity, 'danger');
  assert.equal(summary.limitResetLabel, 'resets in 42m');
  const dom = new JSDOM('<body></body>');
  let host = renderInto(dom);
  const chip = host.querySelector('#composerPlanRing');
  assert.ok(chip.className.includes('inv-plan-ring--exhausted'));
  assert.equal(chip.querySelector('.inv-chip-label').textContent, 'Limit');
  assert.match(host.querySelector('.inv-plan-limit').textContent, /^Limit reached · resets in 42m$/);

  meter.applyPayload(payload({ primary: 100, reached: 'primary', primaryReset: NOW - 1000 }));
  summary = meter.describePlanUsage(null, NOW);
  assert.equal(summary.limitReached, false, 'a reached window whose reset has passed is no longer a limit');
  host = renderInto(dom);
  assert.equal(host.querySelector('.inv-plan-limit'), null);
  assert.ok(!host.querySelector('#composerPlanRing').className.includes('inv-plan-ring--exhausted'));
});

test('unknown reached types and malformed windows are dropped', (t) => {
  withInventory(t);
  meter.applyPayload(payload({ reached: '<script>' }));
  assert.equal(meter.getSnapshot().rateLimitReachedType, '');
  meter.applyPayload({ engine_active: true, snapshot: { version: 1, primary: { used_percent: 'abc' }, secondary: { used_percent: 400 } } });
  const snapshot = meter.getSnapshot();
  assert.equal(snapshot.primary, null, 'non-numeric percent drops the window');
  assert.equal(snapshot.secondary.usedPercent, 100, 'percent is clamped');
  meter.applyPayload({ engine_active: true, snapshot: { version: 1, primary: { used_percent: 'x' } } });
  assert.equal(meter.getSnapshot(), null, 'no usable window -> no snapshot');
  meter.applyPayload(null);
  assert.equal(meter.getSnapshot(), null);
});

test('renders nothing without a snapshot, when the engine is not chatgpt, or when the flag is off', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body></body>');
  assert.equal(renderInto(dom).innerHTML, '', 'no snapshot');
  meter.applyPayload(payload({ engineActive: false }));
  assert.equal(renderInto(dom, { status: { engine: 'ollama' }, features: { featureFlags: {} } }).innerHTML, '', 'ollama');
  assert.notEqual(renderInto(dom, { status: { engine: 'chatgpt' } }).innerHTML, '', 'renderer engine gate passes');
  meter.applyPayload(payload({ engineActive: true }));
  assert.notEqual(renderInto(dom, { status: { engine: 'ollama' } }).innerHTML, '', 'main-process engine_active passes');
  const flagOffHost = renderInto(dom, { status: { engine: 'chatgpt' }, features: { featureFlags: { chatgpt_plan_meter: false } } });
  flagOffHost.querySelector('.inv-plan-usage').dispatchEvent(new dom.window.Event('transitionend', { bubbles: true }));
  assert.equal(flagOffHost.innerHTML, '', 'flag off');
});

test('selected model engine wins over the loaded ChatGPT engine', (t) => {
  withInventory(t);
  meter.applyPayload(payload({ engineActive: true }));
  const state = selectedModelState('local-model', 'ollama', 'chatgpt');
  assert.equal(meter.isPlanMeterActive(state), false);
  const dom = new JSDOM('<body></body>');
  const host = dom.window.document.createElement('div');
  assert.equal(meter.render(host, state, NOW), '');
  assert.equal(host.innerHTML, '');
});

test('selected ChatGPT model renders while the loaded engine is inactive', (t) => {
  withInventory(t);
  meter.applyPayload(payload({ engineActive: false }));
  const state = selectedModelState('gpt-5', 'CHATGPT', 'ollama');
  assert.equal(meter.isPlanMeterActive(state), true);
  const dom = new JSDOM('<body></body>');
  assert.ok(renderInto(dom, state).querySelector('#composerPlanRing'));
});

test('an unresolvable selection falls back to the loaded-engine rule', (t) => {
  withInventory(t);
  meter.applyPayload(payload({ engineActive: false }));
  const unknown = {
    runtimeDraft: { preferredModel: 'missing-model' },
    modelList: { data: [] },
    status: { engine: 'ollama' },
  };
  assert.equal(meter.isPlanMeterActive(unknown), false);
  meter.applyPayload(payload({ engineActive: true }));
  assert.equal(meter.isPlanMeterActive(unknown), true, 'engine_active fallback passes');
  meter.applyPayload(payload({ engineActive: false }));
  assert.equal(meter.isPlanMeterActive({ ...unknown, status: { engine: 'chatgpt' } }), true, 'renderer engine fallback passes');
});

test('chip and popover markup carry both windows, the account line, and no raw primitives', (t) => {
  withInventory(t);
  meter.applyPayload(payload());
  const dom = new JSDOM('<body></body>');
  const host = renderInto(dom);
  const chip = host.querySelector('#composerPlanRing');
  assert.equal(chip.getAttribute('data-inv-chip'), 'composer-plan-ring');
  assert.equal(chip.getAttribute('aria-controls'), 'composerPlanDetailsPopover');
  assert.equal(chip.querySelector('.inv-chip-label').textContent, '62%');
  assert.ok(chip.className.includes('inv-context-ring'), 'reuses the ring chip styling');
  assert.equal(chip.querySelector('.inv-context-ring-arc').getAttribute('stroke-dasharray'), '31.16 50.27');
  assert.match(chip.getAttribute('title'), /^ChatGPT Plus · signed in as b@example\.test · /);
  assert.match(chip.getAttribute('title'), /5 hr window: 62% used · resets in 1h 12m/);
  assert.match(chip.getAttribute('title'), /7 day window: 18% used · resets in 3d/);
  const popover = host.querySelector('#composerPlanDetailsPopover');
  assert.ok(popover.hidden, 'popover starts hidden');
  assert.equal(popover.querySelector('h3').textContent, 'ChatGPT plan usage');
  assert.equal(popover.querySelector('.inv-plan-account').textContent, 'ChatGPT Plus · signed in as b@example.test');
  const rows = popover.querySelectorAll('.inv-plan-window');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector('.inv-plan-window-label').textContent, '5 hr window');
  assert.equal(rows[0].querySelector('.inv-plan-bar-fill').getAttribute('width'), '62');
  assert.equal(rows[1].querySelector('.inv-plan-window-percent').textContent, '18% used');
  assert.match(popover.querySelector('.inv-plan-updated').textContent, /^Updated 2 min ago · from the last ChatGPT response$/);
  assert.equal(host.querySelectorAll('button').length, 1, 'the chip is the only button (inventory primitive)');
  assert.equal(host.querySelectorAll('input, select').length, 0);
  assert.equal(host.innerHTML.includes('style='), false, 'no inline styles (CSP)');
});

test('provider-supplied strings are escaped', (t) => {
  withInventory(t);
  meter.applyPayload(payload({ account: { email: '<img src=x onerror=alert(1)>', plan_type: 'plus' } }));
  const dom = new JSDOM('<body></body>');
  const host = renderInto(dom);
  assert.equal(host.querySelector('img'), null);
  assert.match(host.querySelector('.inv-plan-account').textContent, /<img src=x onerror=alert\(1\)>/);
});

test('render memoizes identical frames and preserves an open popover across a repaint', (t) => {
  const opened = [];
  const popoverFake = Object.assign((...args) => inventoryPopover(...args), inventoryPopover, {
    open(el, opts) { opened.push(opts?.trigger?.id); inventoryPopover.open(el, opts); },
  });
  withInventory(t, { popover: popoverFake });
  meter.applyPayload(payload());
  const dom = new JSDOM('<body></body>');
  const host = renderInto(dom);
  const firstChip = host.querySelector('#composerPlanRing');
  renderInto(dom);
  assert.equal(host.querySelector('#composerPlanRing'), firstChip, 'identical frame is a no-op');
  const popover = host.querySelector('#composerPlanDetailsPopover');
  inventoryPopover.open(popover, { trigger: firstChip, focus: false });
  meter.applyPayload(payload({ primary: 70 }));
  renderInto(dom);
  const nextPopover = host.querySelector('#composerPlanDetailsPopover');
  assert.notEqual(nextPopover, popover, 'markup was rebuilt');
  assert.equal(nextPopover.hidden, false, 'popover reopened on the fresh markup');
  assert.deepEqual(opened, ['composerPlanRing']);
});

test('leaving keeps the chip until transitionend, then clears the slot', (t) => {
  withInventory(t);
  meter.applyPayload(payload());
  const dom = new JSDOM('<body></body>');
  const host = renderInto(dom);
  const chip = host.querySelector('#composerPlanRing');
  meter.applyPayload(payload({ engineActive: false }));
  meter.render(host, { status: { engine: 'ollama' } }, NOW);
  assert.equal(host.classList.contains('is-leaving'), true);
  assert.equal(host.querySelector('#composerPlanRing'), chip);
  host.querySelector('.inv-plan-usage').dispatchEvent(new dom.window.Event('transitionend', { bubbles: true }));
  assert.equal(host.innerHTML, '');
  assert.equal(host.classList.contains('is-leaving'), false);
});

test('a child transition ending during leave does not clear the slot early', (t) => {
  withInventory(t);
  meter.applyPayload(payload());
  const dom = new JSDOM('<body></body>');
  const host = renderInto(dom);
  meter.applyPayload(payload({ engineActive: false }));
  meter.render(host, { status: { engine: 'ollama' } }, NOW);
  const animated = host.querySelector('.inv-plan-usage');
  const child = animated.querySelector('.inv-chip-label') || animated.firstElementChild;
  child.dispatchEvent(new dom.window.Event('transitionend', { bubbles: true }));
  assert.equal(host.classList.contains('is-leaving'), true, 'a bubbling child transition is ignored');
  assert.ok(host.querySelector('#composerPlanRing'), 'chip still fading');
  animated.dispatchEvent(new dom.window.Event('transitionend', { bubbles: true }));
  assert.equal(host.innerHTML, '', 'the fading root ends the leave');
});

test('dispose() during a leave empties the slot synchronously', (t) => {
  withInventory(t);
  meter.applyPayload(payload());
  const dom = new JSDOM('<body></body>');
  const host = renderInto(dom);
  meter.applyPayload(payload({ engineActive: false }));
  meter.render(host, { status: { engine: 'ollama' } }, NOW);
  assert.equal(host.classList.contains('is-leaving'), true);
  meter.dispose();
  assert.equal(host.innerHTML, '', 'no stale chip survives dispose');
  assert.equal(host.classList.contains('is-leaving'), false);
});

test('prefers-reduced-motion clears the slot without a fade', (t) => {
  withInventory(t);
  meter.applyPayload(payload());
  const dom = new JSDOM('<body></body>');
  const host = renderInto(dom);
  dom.window.matchMedia = (query) => ({ matches: query === '(prefers-reduced-motion: reduce)' });
  meter.applyPayload(payload({ engineActive: false }));
  meter.render(host, { status: { engine: 'ollama' } }, NOW);
  assert.equal(host.innerHTML, '', 'cleared synchronously');
  assert.equal(host.classList.contains('is-leaving'), false);
});

test('a non-empty render during leave cancels the pending clear', (t) => {
  withInventory(t);
  meter.applyPayload(payload());
  const dom = new JSDOM('<body></body>');
  const host = renderInto(dom);
  meter.applyPayload(payload({ engineActive: false }));
  meter.render(host, { status: { engine: 'ollama' } }, NOW);
  assert.equal(host.classList.contains('is-leaving'), true);
  meter.applyPayload(payload({ engineActive: true, primary: 71 }));
  meter.render(host, chatgptState, NOW);
  assert.equal(host.classList.contains('is-leaving'), false);
  assert.equal(host.querySelector('.inv-chip-label').textContent, '71%');
  host.querySelector('.inv-plan-usage').dispatchEvent(new dom.window.Event('transitionend', { bubbles: true }));
  assert.ok(host.querySelector('#composerPlanRing'), 'cancelled leave cannot clear the new chip');
});

test('two consecutive empty frames only write innerHTML once', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body></body>');
  const host = dom.window.document.createElement('div');
  const descriptor = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'innerHTML');
  let writes = 0;
  Object.defineProperty(host, 'innerHTML', {
    configurable: true,
    get() { return descriptor.get.call(this); },
    set(value) { writes += 1; descriptor.set.call(this, value); },
  });
  assert.equal(meter.render(host, { status: { engine: 'ollama' } }, NOW), '');
  assert.equal(writes, 1);
  assert.equal(meter.render(host, { status: { engine: 'ollama' } }, NOW), '');
  assert.equal(writes, 1, 'identical empty frame is memoized');
});

test('handleClick toggles only the plan popover and dismisses tooltip state first', (t) => {
  const calls = [];
  withInventory(t, {
    tooltip: { unpin() { calls.push('unpin'); }, hide() { calls.push('hide'); } },
    popover: { toggle(el) { calls.push('toggle:' + el.id); el.hidden = false; } },
  });
  const dom = new JSDOM('<div id="wrap"><button data-inv-chip="composer-plan-ring"></button>'
    + '<button data-inv-chip="composer-context-ring"></button>'
    + '<div id="composerPlanDetailsPopover" hidden></div><div id="composerContextDetailsPopover" hidden></div></div>');
  const doc = dom.window.document;
  const wrap = doc.getElementById('wrap');
  const planChip = doc.querySelector('[data-inv-chip="composer-plan-ring"]');
  const contextChip = doc.querySelector('[data-inv-chip="composer-context-ring"]');
  assert.equal(meter.handleClick({ event: { target: planChip }, composerWrap: wrap, state: {} }), true);
  assert.deepEqual(calls, ['unpin', 'hide', 'toggle:composerPlanDetailsPopover']);
  assert.equal(doc.getElementById('composerContextDetailsPopover').hidden, true);
  assert.equal(meter.handleClick({ event: { target: contextChip }, composerWrap: wrap, state: {} }), false, 'context ring is not ours');
  assert.equal(meter.handleClick({ event: { target: null }, composerWrap: wrap, state: {} }), false);
});

test('install seeds from getSnapshot, follows onSnapshot, and tears down cleanly', async (t) => {
  withInventory(t);
  let listener = null;
  let unsubscribed = 0;
  let changes = 0;
  const shell = {
    chatgptPlanUsage: {
      async getSnapshot() { return payload({ primary: 10 }); },
      onSnapshot(fn) { listener = fn; return () => { unsubscribed += 1; }; },
    },
  };
  const teardown = meter.install({ shell, state: chatgptState, onChange: () => { changes += 1; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(meter.getSnapshot().primary.usedPercent, 10);
  assert.equal(changes, 1);
  listener(payload({ primary: 55 }));
  assert.equal(meter.getSnapshot().primary.usedPercent, 55);
  assert.equal(changes, 2);
  teardown();
  teardown();
  assert.equal(unsubscribed, 1, 'teardown is idempotent');
  listener(payload({ primary: 99 }));
  assert.equal(meter.getSnapshot().primary.usedPercent, 55, 'a late push after teardown is ignored');
  assert.equal(typeof meter.install({ shell: {} }), 'function', 'missing namespace -> inert teardown');
});

test('dispose() invalidates the render memo so the next render clears the slot', (t) => {
  withInventory(t);
  meter.applyPayload(payload());
  const dom = new JSDOM('<body></body>');
  const host = renderInto(dom);
  assert.ok(host.querySelector('#composerPlanRing'), 'chip rendered');
  meter.dispose();
  meter.setClock(() => NOW);
  renderInto(dom);
  assert.equal(host.classList.contains('is-leaving'), true, 'the stale chip fades out rather than lingering');
  host.querySelector('.inv-plan-usage').dispatchEvent(new dom.window.Event('transitionend', { bubbles: true }));
  assert.equal(host.querySelector('#composerPlanRing'), null, 'previous session chip is gone after dispose + render');
  assert.equal(host.innerHTML, '');
});
