/* Denominator/numerator continuity when the composer ring falls back from a
 * stored usage record to the client-side estimate (Cause B of the 2026-08-29
 * context-meter accuracy program): the fallback estimate must inherit the
 * stored record's auto-compact denominator (same model) and never collapse
 * the numerator below the last authoritative reading (model switch). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const inventoryChip = require('../renderer/inventory/chip');
const inventoryPopover = require('../renderer/inventory/popover');
const inventoryActionButton = require('../renderer/inventory/action-button');
const contextUsageUtils = require('../renderer/chat/renderer-context-usage-utils');
const { createShellRuntimeController } = require('../renderer/shell/renderer-shell-runtime-utils');

function withInventory(t, extras = {}) {
  global.inventory = { chip: inventoryChip, ...extras };
  t.after(() => {
    delete global.inventory;
    contextUsageUtils.clearAllUsage();
  });
  contextUsageUtils.clearAllUsage();
}

function sessionMessages() {
  return [
    { id: 'u1', role: 'user', content: 'a'.repeat(400) },
    { id: 'a1', role: 'assistant', content: 'b'.repeat(400) },
    { id: 'u2', role: 'user', content: 'c'.repeat(400) },
    { id: 'a2', role: 'assistant', content: 'd'.repeat(400) },
  ];
}

function makeController(dom, state) {
  const doc = dom.window.document;
  const slot = doc.getElementById('composerContextUsageSlot');
  return createShellRuntimeController({
    windowRef: dom.window,
    state,
    dom: { composerContextUsageSlot: slot },
    modules: { contextUsageModule: contextUsageUtils },
    callbacks: {},
  });
}

test('a compaction-sourced fallback estimate keeps the stored auto-compact denominator', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body><div id="composerContextUsageSlot"></div></body>');
  const messages = sessionMessages();
  const state = {
    currentSessionId: 'continuity',
    sessions: [{
      id: 'continuity',
      compaction_context: {
        version: 1,
        created_at: '2026-08-29T00:00:00.000Z',
        strategy: 'full',
        tokens_before: 2000,
        tokens_after: 800,
        replacement_tokens: 800,
        boundary_message_count: 2,
      },
    }],
    messagesBySession: new Map([['continuity', messages]]),
    status: { effective_context_length: 10000, model: 'test-model' },
    features: { featureFlags: { token_budget: true, context_compaction: true } },
    ui: { contextOverheadTokens: 0 },
  };
  // A completed turn stored the authoritative record: threshold 7000 of a
  // 10000-token window. Manual compaction then replaced it with a
  // compaction-provenance record that keeps both denominators.
  contextUsageUtils.updateUsage('continuity', {
    usage: {
      context_tokens_estimate: 4500,
      context_window: 10000,
      compact_threshold_tokens: 7000,
      model: 'test-model',
    },
  });
  contextUsageUtils.updateCompactionUsage('continuity', {
    compacted: true,
    snapshot_persisted: true,
    tokens_after: 800,
  });

  const controller = makeController(dom, state);
  controller.renderComposerEnhancements();
  const ring = dom.window.document.querySelector('#composerContextRing');
  assert.ok(ring, 'ring renders from the compaction-sourced fallback estimate');
  const title = ring.getAttribute('title');
  assert.match(
    title,
    /of 7\.0k tokens before auto-compact/,
    'fallback keeps the stored 7000-token denominator instead of jumping to the 10000-token window',
  );
});

test('after a model switch the fallback estimate never collapses below the last reading', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body><div id="composerContextUsageSlot"></div></body>');
  const state = {
    currentSessionId: 'switch',
    sessions: [{ id: 'switch' }],
    messagesBySession: new Map([['switch', sessionMessages()]]),
    // The active model changed mid-session; its window differs.
    status: { effective_context_length: 20000, model: 'model-b' },
    features: { featureFlags: { token_budget: true, context_compaction: true } },
    ui: { contextOverheadTokens: 0 },
  };
  // The last authoritative reading (old model) says the conversation is ~5000
  // tokens. The chars/4 estimate over the visible messages is far smaller.
  contextUsageUtils.updateUsage('switch', {
    usage: {
      context_tokens_estimate: 5000,
      context_window: 10000,
      compact_threshold_tokens: 7000,
      model: 'model-a',
    },
  });

  const controller = makeController(dom, state);
  controller.renderComposerEnhancements();
  const ring = dom.window.document.querySelector('#composerContextRing');
  assert.ok(ring, 'ring renders from the fallback estimate for the new model');
  const title = ring.getAttribute('title');
  assert.match(
    title,
    /Context: 25%/,
    'numerator floored at the prior 5000-token reading against the new 20000-token window',
  );
  assert.doesNotMatch(
    title,
    /before auto-compact/,
    'the old model’s auto-compact threshold is not inherited across a model switch',
  );
});

/* Cold reopen (commit 4): no in-memory usage record exists yet, so the same
 * two continuity inputs come from the session summary's persisted
 * `context_usage` seed. Semantics mirror the stored-record cases above
 * exactly — threshold inherited only on a model match, floor always. */

function persistedSeed(overrides = {}) {
  return {
    version: 1,
    used_tokens: 5000,
    context_window: 10000,
    compact_threshold_tokens: 7000,
    model: 'test-model',
    usage_source: 'estimate',
    updated_at: '2026-08-29T12:00:00.000Z',
    ...overrides,
  };
}

function reopenedState(sessionOverrides = {}, statusOverrides = {}) {
  return {
    currentSessionId: 'reopened',
    sessions: [{ id: 'reopened', context_usage: persistedSeed(), ...sessionOverrides }],
    messagesBySession: new Map([['reopened', sessionMessages()]]),
    status: { effective_context_length: 10000, model: 'test-model', ...statusOverrides },
    features: { featureFlags: { token_budget: true, context_compaction: true } },
    ui: { contextOverheadTokens: 0 },
  };
}

test('a reopened session seeds the ring from its persisted context_usage record', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body><div id="composerContextUsageSlot"></div></body>');
  // Deliberately NO contextUsageUtils.updateUsage call: this is the cold-load
  // state the seed exists for.
  const controller = makeController(dom, reopenedState());
  controller.renderComposerEnhancements();

  const ring = dom.window.document.querySelector('#composerContextRing');
  assert.ok(ring, 'the ring renders from the seeded fallback estimate');
  const title = ring.getAttribute('title');
  assert.match(
    title,
    /of 7\.0k tokens before auto-compact/,
    'the persisted auto-compact threshold is the denominator, not the 10000-token window',
  );
  assert.match(
    title,
    /Context: 71%/,
    'the numerator is floored at the persisted 5000-token reading (5000/7000)',
  );
});

test('a persisted seed from another model floors the numerator but not the denominator', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body><div id="composerContextUsageSlot"></div></body>');
  const state = reopenedState(
    { context_usage: persistedSeed({ model: 'model-a' }) },
    { effective_context_length: 20000, model: 'model-b' },
  );

  const controller = makeController(dom, state);
  controller.renderComposerEnhancements();

  const ring = dom.window.document.querySelector('#composerContextRing');
  assert.ok(ring, 'the ring still renders for the new model');
  const title = ring.getAttribute('title');
  assert.match(
    title,
    /Context: 25%/,
    'numerator floored at the persisted 5000-token reading against the new 20000-token window',
  );
  assert.doesNotMatch(
    title,
    /before auto-compact/,
    'a model-specific threshold is never inherited across a model switch',
  );
});

test('a malformed persisted seed is ignored and never crashes the composer render', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body><div id="composerContextUsageSlot"></div></body>');
  const state = reopenedState({
    context_usage: { version: 2, used_tokens: 5000, compact_threshold_tokens: 7000 },
  });

  const controller = makeController(dom, state);
  controller.renderComposerEnhancements();

  const ring = dom.window.document.querySelector('#composerContextRing');
  assert.ok(ring, 'the bare chars/4 estimate still renders');
  const title = ring.getAttribute('title');
  assert.doesNotMatch(title, /before auto-compact/, 'an unknown record version seeds nothing');
  assert.doesNotMatch(title, /Context: 71%/, 'and its numerator is not adopted either');
});

/* Audit fixes (post-review of the accuracy program). */

test('a seed whose window no longer matches drops the threshold but keeps the floor', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body><div id="composerContextUsageSlot"></div></body>');
  // Same model, but the served window changed (num_ctx override / engine
  // reload) since the seed was written: its 7000-token threshold was computed
  // for a 10000-token window and would misread against the new 32768 one.
  const state = reopenedState({}, { effective_context_length: 32768 });

  const controller = makeController(dom, state);
  controller.renderComposerEnhancements();

  const ring = dom.window.document.querySelector('#composerContextRing');
  assert.ok(ring, 'the ring renders from the floored estimate');
  const title = ring.getAttribute('title');
  assert.doesNotMatch(
    title,
    /before auto-compact/,
    'a threshold computed for a different window is never inherited',
  );
  assert.match(
    title,
    /Context: 15%/,
    'the numerator floor still applies (5000/32768)',
  );
});

test('the prior-usage floor does not apply to a partial history scope', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body><div id="composerContextUsageSlot"></div></body>');
  // historyScope "recent" deliberately measures LESS than the full session, so
  // flooring it at the full-session reading would silently over-report.
  const state = reopenedState(
    { context_usage: persistedSeed({ model: 'model-a' }) },
    { effective_context_length: 20000, model: 'model-b' },
  );
  state.runtimeDraft = { contextPreferences: { historyScope: 'recent' } };

  const controller = makeController(dom, state);
  controller.renderComposerEnhancements();

  const ring = dom.window.document.querySelector('#composerContextRing');
  assert.ok(ring, 'the scoped estimate renders');
  assert.match(
    ring.getAttribute('title'),
    /Context: 2%/,
    'the recent-scope estimate (400 tokens) is not floored at the 5000-token seed',
  );
});

test('a threshold-only stored record does not rebuild the fallback estimate per repaint', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body><div id="composerContextUsageSlot"></div></body>');
  // Engines that expose no window getter publish a compact threshold but no
  // context_window. Such a record renders on its own; rebuilding the fallback
  // estimate on every repaint would be a full chars/4 walk per mid-turn
  // snapshot only for resolveRenderUsage to discard it.
  contextUsageUtils.updateUsage('threshold-only', {
    usage: {
      context_used_tokens: 3000,
      context_used_source: 'estimate',
      compact_threshold_tokens: 7000,
      model: 'test-model',
    },
  });
  const estimateCalls = { count: 0 };
  const spyModule = Object.create(contextUsageUtils);
  spyModule.buildCachedContextUsageEstimate = (...args) => {
    estimateCalls.count += 1;
    return contextUsageUtils.buildCachedContextUsageEstimate(...args);
  };
  const slot = dom.window.document.getElementById('composerContextUsageSlot');
  const controller = createShellRuntimeController({
    windowRef: dom.window,
    state: {
      currentSessionId: 'threshold-only',
      sessions: [{ id: 'threshold-only' }],
      messagesBySession: new Map([['threshold-only', sessionMessages()]]),
      status: { model: 'test-model' },
      features: { featureFlags: { token_budget: true, context_compaction: true } },
      ui: { contextOverheadTokens: 0 },
    },
    dom: { composerContextUsageSlot: slot },
    modules: { contextUsageModule: spyModule },
    callbacks: {},
  });

  controller.renderComposerEnhancements();
  controller.renderComposerEnhancements();

  const ring = dom.window.document.querySelector('#composerContextRing');
  assert.ok(ring, 'the threshold-only record renders directly');
  assert.match(ring.getAttribute('title'), /before auto-compact/);
  assert.equal(estimateCalls.count, 0, 'no fallback estimate is built while the record renders');
});

test('an open details popover freezes mid-turn ring rewrites until the popover closes', (t) => {
  withInventory(t, { popover: inventoryPopover, actionButton: inventoryActionButton });
  const dom = new JSDOM('<body><div id="composerContextUsageSlot"></div></body>');
  const state = {
    currentSessionId: 'freeze',
    sessions: [{ id: 'freeze' }],
    messagesBySession: new Map([['freeze', sessionMessages()]]),
    status: { effective_context_length: 10000, model: 'test-model' },
    features: { featureFlags: { token_budget: true, context_compaction: true } },
    ui: { contextOverheadTokens: 0 },
  };
  contextUsageUtils.updateUsage('freeze', {
    streamId: 'turn-1',
    usage: {
      context_used_tokens: 3000,
      context_used_source: 'estimate',
      context_window: 10000,
      compact_threshold_tokens: 7000,
      model: 'test-model',
    },
  });
  const controller = makeController(dom, state);
  controller.renderComposerEnhancements();
  const doc = dom.window.document;
  const firstRing = doc.querySelector('#composerContextRing');
  const popover = doc.querySelector('#composerContextDetailsPopover');
  assert.ok(firstRing && popover);
  // Simulate the open popover the was-open detection looks for.
  popover.hidden = false;

  // A mid-turn snapshot arrives while the user is reading the details: the
  // slot must NOT be torn down under the pointer.
  contextUsageUtils.updateUsage('freeze', {
    type: 'context_usage',
    streamId: 'turn-2',
    phase: 'iteration',
    usage: {
      context_used_tokens: 5000,
      context_used_source: 'estimate',
      context_window: 10000,
      compact_threshold_tokens: 7000,
      model: 'test-model',
    },
  });
  controller.renderComposerEnhancements();
  assert.equal(
    doc.querySelector('#composerContextRing'),
    firstRing,
    'mid-turn snapshots never rebuild the slot while the popover is open',
  );

  // The turn's terminal reading still rebuilds (and would restore the popover).
  contextUsageUtils.updateUsage('freeze', {
    streamId: 'turn-2',
    usage: {
      context_used_tokens: 6000,
      context_used_source: 'estimate',
      context_window: 10000,
      compact_threshold_tokens: 7000,
      model: 'test-model',
    },
  });
  controller.renderComposerEnhancements();
  assert.notEqual(
    doc.querySelector('#composerContextRing'),
    firstRing,
    'the terminal reading rebuilds the slot as before',
  );
});

test('a live stored record still wins over the persisted seed', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body><div id="composerContextUsageSlot"></div></body>');
  // The reopened session already completed a turn: the in-memory record is
  // authoritative and renders directly, seed or no seed.
  contextUsageUtils.updateUsage('reopened', {
    usage: {
      context_used_tokens: 3000,
      context_used_source: 'estimate',
      context_window: 10000,
      compact_threshold_tokens: 7000,
      model: 'test-model',
    },
  });

  const controller = makeController(dom, reopenedState());
  controller.renderComposerEnhancements();

  const ring = dom.window.document.querySelector('#composerContextRing');
  assert.ok(ring);
  assert.match(
    ring.getAttribute('title'),
    /Context: 43%/,
    'the live 3000/7000 reading is shown, not the stale 5000-token seed',
  );
});
