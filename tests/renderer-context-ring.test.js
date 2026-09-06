/* Ambient context ring (composer rethink D1) — escalation thresholds at
 * 80/95, single-pulse-per-tick gating, hover tooltip + click popover. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const inventoryChip = require('../renderer/inventory/chip');
const inventoryPopover = require('../renderer/inventory/popover');
const inventoryActionButton = require('../renderer/inventory/action-button');
const inventoryTooltip = require('../renderer/inventory/tooltip');
const contextUsageUtils = require('../renderer/chat/renderer-context-usage-utils');
const contextMeterDetails = require('../renderer/chat/renderer-context-meter-details');
const { createShellRuntimeController } = require('../renderer/shell/renderer-shell-runtime-utils');

function withInventory(t, extras = {}) {
  global.inventory = { chip: inventoryChip, ...extras };
  t.after(() => {
    delete global.inventory;
    contextUsageUtils.clearAllUsage();
    contextMeterDetails.dispose();
    inventoryTooltip.unpin();
    inventoryTooltip.hide();
  });
  contextUsageUtils.clearAllUsage();
}

/* Seeds provider-truth usage (last_request_input_tokens) plus an explicit
 * compact_threshold_tokens equal to the third argument, so every ratio in
 * this file reads as "fraction of the auto-compaction budget" — the ring's
 * denominator since the Ollama meter work. */
function seedUsage(sessionId, usedTokens, compactBudget) {
  contextUsageUtils.updateUsage(sessionId, {
    usage: {
      total_tokens: usedTokens,
      last_request_input_tokens: usedTokens,
      context_tokens_estimate: usedTokens,
      context_window: compactBudget,
      compact_threshold_tokens: compactBudget,
      model: 'test-model',
    },
  });
}

/* Renders into a single shared host per document — mirrors the composer
 * slot, whose innerHTML is replaced (never duplicated) on re-render. */
function renderRing(dom, sessionId) {
  const doc = dom.window.document;
  let host = doc.getElementById('ringHost');
  if (!host) {
    host = doc.createElement('div');
    host.id = 'ringHost';
    doc.body.appendChild(host);
  }
  host.innerHTML = contextUsageUtils.renderContextUsage(sessionId) || '';
  return host.querySelector('#composerContextRing');
}

test('meter reads the latest request size, not the sum across an agentic loop', (t) => {
  /* An agentic turn makes N model calls, so the
   * turn's usage.total_tokens is a SUM across iterations (cost accounting)
   * while usage.context_tokens_estimate is the final working-set size (the
   * latest request). The meter must show the latter, and a later chat.done
   * must REPLACE the stored figure, never accumulate onto it. */
  withInventory(t);
  contextUsageUtils.updateUsage('ring-agentic', {
    usage: {
      /* 6 tool-loop iterations summed: far larger than the context window. */
      total_tokens: 240000,
      input_tokens: 230000,
      context_tokens_estimate: 30000,
      context_window: 131072,
      model: 'test-model',
    },
  });
  let usage = contextUsageUtils.getUsage('ring-agentic');
  assert.equal(usage.usedTokens, 30000, 'used = latest request estimate, not the loop sum');
  assert.equal(usage.usageSource, 'context');
  assert.equal(usage.contextLimit, 131072);

  /* Next turn replaces the stored figure (no accumulation across turns). */
  contextUsageUtils.updateUsage('ring-agentic', {
    usage: {
      total_tokens: 250000,
      context_tokens_estimate: 32000,
      context_window: 131072,
      model: 'test-model',
    },
  });
  usage = contextUsageUtils.getUsage('ring-agentic');
  assert.equal(usage.usedTokens, 32000, 'a later chat.done replaces, never accumulates');
});

test('ring renders a muted arc below the 80% warning threshold', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body></body>');
  seedUsage('ring-low', 500, 1000);
  const ring = renderRing(dom, 'ring-low');
  assert.ok(ring, 'ring button renders');
  assert.ok(!ring.className.includes('inv-context-ring--warning'), 'no warning below 80%');
  assert.ok(!ring.className.includes('inv-context-ring--danger'), 'no danger below 95%');
  const arc = ring.querySelector('.inv-context-ring-arc');
  assert.match(arc.getAttribute('stroke-dasharray'), /^25\.13 50\.27$/, 'arc fills half the circumference at 50%');
});

test('ring escalates to warning at exactly 80%', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body></body>');
  seedUsage('ring-warning', 800, 1000);
  const ring = renderRing(dom, 'ring-warning');
  assert.ok(ring.className.includes('inv-context-ring--warning'), 'warning at 80%');
  assert.ok(!ring.className.includes('inv-context-ring--danger'), 'not yet danger');
});

test('ring escalates to danger at exactly 95%', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body></body>');
  seedUsage('ring-danger', 950, 1000);
  const ring = renderRing(dom, 'ring-danger');
  assert.ok(ring.className.includes('inv-context-ring--danger'), 'danger at 95%');
  assert.ok(!ring.className.includes('inv-context-ring--warning'), 'danger replaces warning');
});

test('ring tooltip carries the multi-line context breakdown; aria-label keeps the one-liner', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body></body>');
  seedUsage('ring-string', 1200, 131072);
  const ring = renderRing(dom, 'ring-string');
  const title = ring.getAttribute('title');
  assert.match(title, /^Context: <1%\n/);
  assert.match(title, /1\.2k of 131\.1k tokens before auto-compact \(last request\)/);
  assert.match(title, /129\.9k remaining/);
  assert.ok(!/Approaching|Nearly full/.test(title), 'no severity hint below the warning threshold');
  assert.match(ring.getAttribute('aria-label'), /^Context usage: 1\.2k \/ 131\.1k last request · <1%$/);
});

test('ring tooltip appends a severity hint at the warning and danger thresholds', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body></body>');
  seedUsage('ring-hint-warning', 850, 1000);
  assert.match(renderRing(dom, 'ring-hint-warning').getAttribute('title'), /Approaching auto-compaction\.$/);
  seedUsage('ring-hint-danger', 980, 1000);
  assert.match(renderRing(dom, 'ring-hint-danger').getAttribute('title'), /Nearly full — auto-compaction is imminent\.$/);
});

test('danger pulse fires once per usage tick, not on every re-render', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body></body>');
  seedUsage('ring-pulse', 960, 1000);

  const first = renderRing(dom, 'ring-pulse');
  assert.ok(first.className.includes('inv-context-ring--pulse'), 'first danger render pulses');

  const second = renderRing(dom, 'ring-pulse');
  assert.ok(!second.className.includes('inv-context-ring--pulse'), 'same-data re-render does not pulse');

  seedUsage('ring-pulse', 980, 1000);
  const third = renderRing(dom, 'ring-pulse');
  assert.ok(third.className.includes('inv-context-ring--pulse'), 'next usage tick pulses again');
});

test('ring renders nothing when no usage data or limit is known', (t) => {
  withInventory(t);
  assert.equal(contextUsageUtils.renderContextUsage('ring-unknown'), '');
});

test('click opens only the context popover and dismisses a visible tooltip', (t) => {
  withInventory(t, {
    tooltip: inventoryTooltip,
    popover: inventoryPopover,
    actionButton: inventoryActionButton,
  });
  const dom = new JSDOM('<body></body>');
  const doc = dom.window.document;
  inventoryTooltip.initTooltipHandlers(doc);
  seedUsage('ring-popover', 500, 1000);
  const ring = renderRing(dom, 'ring-popover');
  const host = doc.getElementById('ringHost');
  host.addEventListener('click', (event) => {
    contextMeterDetails.handleClick({
      event,
      composerWrap: host,
      state: { currentSessionId: 'ring-popover', attachments: { queued: [] } },
    });
  });

  inventoryTooltip.show(ring, ring.getAttribute('title'));
  assert.ok(doc.querySelector('.inv-tooltip').classList.contains('inv-tooltip--visible'));
  ring.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const tip = doc.querySelector('.inv-tooltip');
  const popover = doc.getElementById('composerContextDetailsPopover');
  assert.equal(ring.classList.contains('inv-tooltip-pin'), false, 'ring does not opt into click-to-pin');
  assert.equal(inventoryTooltip.isPinned(), false, 'tooltip remains unpinned');
  assert.ok(!tip.classList.contains('inv-tooltip--visible'), 'visible tooltip is dismissed');
  assert.equal(popover.hidden, false, 'details popover opens');
  assert.equal(ring.getAttribute('aria-expanded'), 'true', 'expanded state is announced');
});

test('composer re-render preserves an open context popover and its preview', (t) => {
  withInventory(t, {
    tooltip: inventoryTooltip,
    popover: inventoryPopover,
    actionButton: inventoryActionButton,
  });
  const dom = new JSDOM('<body><div id="composerContextUsageSlot"></div></body>');
  const doc = dom.window.document;
  let positionCalls = 0;
  dom.window.inventory = global.inventory;
  dom.window.rendererContextMeterDetails = {
    positionPopover() { positionCalls += 1; },
  };
  const slot = doc.getElementById('composerContextUsageSlot');
  seedUsage('ring-rerender', 500, 1000);

  const controller = createShellRuntimeController({
    windowRef: dom.window,
    state: { currentSessionId: 'ring-rerender', sessions: [{ id: 'ring-rerender' }] },
    dom: { composerContextUsageSlot: slot },
    modules: { contextUsageModule: contextUsageUtils },
    callbacks: {},
  });

  controller.renderComposerEnhancements();
  const firstRing = slot.querySelector('#composerContextRing');
  const firstPopover = slot.querySelector('#composerContextDetailsPopover');
  inventoryPopover.open(firstPopover, { trigger: firstRing, focus: false });
  firstPopover.querySelector('[data-next-turn-context-summary]').textContent = 'Canonical preview';

  // Unchanged usage: the memo skips the innerHTML rewrite, preserving the node.
  controller.renderComposerEnhancements();
  const sameRing = slot.querySelector('#composerContextRing');
  assert.equal(sameRing, firstRing, 'unchanged re-render preserves the ring node');
  assert.equal(firstPopover.hidden, false, 'open popover remains open');

  // Changed usage rewrites the slot and restores the open popover state.
  seedUsage('ring-rerender', 950, 1000);
  controller.renderComposerEnhancements();
  const freshRing = slot.querySelector('#composerContextRing');
  const freshPopover = slot.querySelector('#composerContextDetailsPopover');
  assert.notEqual(freshRing, firstRing, 'changed re-render replaced the ring node');
  assert.equal(freshPopover.hidden, false, 'popover reopens after replacement');
  assert.equal(freshRing.getAttribute('aria-expanded'), 'true', 'fresh trigger reflects open state');
  assert.equal(
    freshPopover.querySelector('[data-next-turn-context-summary]').textContent,
    'Canonical preview',
    'loaded preview survives replacement',
  );
  assert.equal(positionCalls, 1, 'restored popover is clamped to the current viewport');
});

test('ring clamps the displayed percent to 100 when an estimate overshoots the window', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body></body>');
  seedUsage('ring-over', 1500, 1000); // 150%
  const ring = renderRing(dom, 'ring-over');
  const title = ring.getAttribute('title');
  assert.match(title, /^Context: 100%\n/, 'percent clamped to 100 in the tooltip lead');
  assert.match(ring.getAttribute('aria-label'), /· 100%$/, 'percent clamped in the aria-label');
  assert.match(title, /0 remaining/, 'remaining floored at 0');
  assert.ok(ring.className.includes('inv-context-ring--danger'), 'over-limit reads as danger');
  const arc = ring.querySelector('.inv-context-ring-arc');
  assert.match(arc.getAttribute('stroke-dasharray'), /^50\.27 50\.27$/, 'arc fully wraps, never beyond');
});

test('warning crossing fires a one-shot warn-pulse, distinct from the danger pulse, once per tick', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body></body>');
  seedUsage('ring-warnpulse', 820, 1000); // 82% warning
  const first = renderRing(dom, 'ring-warnpulse');
  assert.ok(first.className.includes('inv-context-ring--warn-pulse'), 'first warning render fires the warn cue');
  assert.ok(!first.className.includes('inv-context-ring--pulse'), 'warning uses the subtler cue, not the danger pulse');
  const second = renderRing(dom, 'ring-warnpulse');
  assert.ok(!second.className.includes('inv-context-ring--warn-pulse'), 'same-data re-render does not re-cue');
});

test('pruneUsage evicts the pulse memo alongside the usage record (no leak)', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body></body>');
  seedUsage('prune-a', 980, 1000);
  assert.ok(renderRing(dom, 'prune-a').className.includes('inv-context-ring--pulse'), 'first danger pulses');
  assert.ok(!renderRing(dom, 'prune-a').className.includes('inv-context-ring--pulse'), 'same tick does not re-pulse');
  // Force a deterministic overflow eviction of the older 'prune-a'.
  seedUsage('prune-keep', 100, 1000);
  contextUsageUtils.pruneUsage({ maxEntries: 1, keepSessionIds: ['prune-keep'] });
  assert.equal(contextUsageUtils.getUsage('prune-a'), null, 'usage record evicted');
  // Re-seed the SAME usage: the pulse fires again only if the pulse memo was
  // pruned with the record — a leaked memo would keep it silent.
  seedUsage('prune-a', 980, 1000);
  assert.ok(renderRing(dom, 'prune-a').className.includes('inv-context-ring--pulse'), 'pulse memo was pruned, not leaked');
});

test('buildContextUsageEstimate counts queued attachments on top of message text', (t) => {
  withInventory(t);
  const messages = [{ id: 'm1', role: 'user', content: 'hello' }]; // ceil(5/4) = 2 text tokens
  const opts = { contextLimit: 100000, model: 'test-model' };
  assert.equal(contextUsageUtils.buildContextUsageEstimate(messages, opts).usedTokens, 2);
  assert.equal(
    contextUsageUtils.buildContextUsageEstimate(messages, { ...opts, attachments: [{ kind: 'image' }] }).usedTokens,
    2 + 768,
    'an image adds the flat vision allowance',
  );
  assert.equal(
    contextUsageUtils.buildContextUsageEstimate(messages, { ...opts, attachments: [{ kind: 'audio' }] }).usedTokens,
    2 + 1024,
    'audio adds the larger transcript allowance',
  );
});

test('describeContextUsage classifies severity and clamps percent, and drops a stale-model record', (t) => {
  withInventory(t);
  seedUsage('desc', 800, 1000);
  assert.equal(contextUsageUtils.describeContextUsage('desc').severity, 'warning');
  seedUsage('desc', 950, 1000);
  assert.equal(contextUsageUtils.describeContextUsage('desc').severity, 'danger');
  seedUsage('desc', 1500, 1000);
  assert.equal(contextUsageUtils.describeContextUsage('desc').percent, 100, 'percent clamped to 100');
  seedUsage('desc', 500, 1000);
  assert.equal(contextUsageUtils.describeContextUsage('desc').severity, '', 'no severity below 80%');

  // Stored record is from model-a; once the active model is model-b a fallback
  // wins. Without an exact forwarded trigger, the honest fallback target is
  // the reported context window.
  contextUsageUtils.updateUsage('switch', {
    usage: {
      total_tokens: 810,
      context_tokens_estimate: 810,
      context_window: 1000,
      compact_threshold_tokens: 900,
      model: 'model-a',
    },
  });
  assert.equal(contextUsageUtils.describeContextUsage('switch', { activeModel: 'model-a' }).percent, 90, 'matching model keeps the stored record (810 / 900)');
  const fallbackEstimate = { usedTokens: 1800, contextLimit: 8000, model: 'model-b', usageSource: 'estimate' };
  assert.equal(
    contextUsageUtils.describeContextUsage('switch', { activeModel: 'model-b', fallbackEstimate }).percent,
    23,
    'a mismatched active model drops to the fallback (1800 / 8000), not the stale 90%',
  );
});

test('the composer announces context severity to assistive tech once per threshold crossing', (t) => {
  withInventory(t, { tooltip: inventoryTooltip });
  const dom = new JSDOM('<body><div id="composerContextUsageSlot"></div></body>');
  const slot = dom.window.document.getElementById('composerContextUsageSlot');
  const controller = createShellRuntimeController({
    state: {
      currentSessionId: 'announce',
      sessions: [{ id: 'announce' }],
      features: { featureFlags: { token_budget: true, context_compaction: true } },
    },
    dom: { composerContextUsageSlot: slot },
    modules: { contextUsageModule: contextUsageUtils },
    callbacks: {},
  });

  seedUsage('announce', 500, 1000);
  controller.renderComposerEnhancements();
  const live = slot.parentNode.querySelector('.composer-context-usage-announcer');
  assert.ok(live, 'a polite live region is created in the slot host');
  assert.equal(live.getAttribute('aria-live'), 'polite');
  assert.equal(live.textContent, '', 'nothing announced below the warning threshold');

  seedUsage('announce', 850, 1000);
  controller.renderComposerEnhancements();
  assert.match(live.textContent, /approaching auto-compaction/i, 'warning crossing is announced');

  const warnText = live.textContent;
  controller.renderComposerEnhancements();
  assert.equal(live.textContent, warnText, 'no re-announcement without a fresh crossing');

  seedUsage('announce', 980, 1000);
  controller.renderComposerEnhancements();
  assert.match(live.textContent, /nearly full/i, 'danger crossing is announced');
});

/* ── Provider-truth numerator + auto-compact denominator (Ollama meter work) ── */

test('the ring reads provider tokens over the char-estimate when both are present', (t) => {
  withInventory(t);
  contextUsageUtils.updateUsage('provider-wins', {
    usage: {
      total_tokens: 9999,
      last_request_input_tokens: 700,
      context_tokens_estimate: 400,
      context_window: 1000,
      compact_threshold_tokens: 1000,
      model: 'test-model',
    },
  });
  const stored = contextUsageUtils.getUsage('provider-wins');
  assert.equal(stored.usedTokens, 700, 'provider truth wins over the estimate');
  assert.equal(stored.usageSource, 'provider');
  const dom = new JSDOM('<body></body>');
  const ring = renderRing(dom, 'provider-wins');
  assert.match(ring.getAttribute('aria-label'), /^Context usage: 700 \/ 1\.0k last request · 70%$/);
});

test('a chat.done without provider tokens still uses the sidecar context estimate', (t) => {
  withInventory(t);
  contextUsageUtils.updateUsage('estimate-fallback', {
    usage: {
      total_tokens: 9999,
      context_tokens_estimate: 400,
      context_window: 1000,
      model: 'test-model',
    },
  });
  const stored = contextUsageUtils.getUsage('estimate-fallback');
  assert.equal(stored.usedTokens, 400);
  assert.equal(stored.usageSource, 'context');
});

test('zero-check: present-but-zero provider and estimate records never read as the summed total', (t) => {
  withInventory(t);
  contextUsageUtils.updateUsage('zero-check', {
    usage: {
      total_tokens: 5000, // summed across tool-loop iterations — must NOT drive the ring
      last_request_input_tokens: 0,
      context_tokens_estimate: 0,
      context_window: 1000,
      model: 'test-model',
    },
  });
  const stored = contextUsageUtils.getUsage('zero-check');
  assert.equal(stored.usedTokens, 0, 'no numerator rather than the summed total');
  assert.equal(contextUsageUtils.renderContextUsage('zero-check'), '', 'ring shows nothing ("no estimate yet")');
  assert.equal(contextUsageUtils.describeContextUsage('zero-check'), null, 'aria summary agrees');
});

test('resolveContextTarget uses exact sidecar triggers and otherwise the reported window', (t) => {
  withInventory(t);
  assert.equal(
    contextUsageUtils.resolveContextTarget({ compactThresholdTokens: 12345, contextLimit: 131072 }).limit,
    12345,
    'forwarded sidecar trigger wins',
  );
  assert.equal(
    contextUsageUtils.resolveContextTarget({ contextLimit: 131072 }).limit,
    131072,
    'the reported window applies when no exact trigger was forwarded',
  );
  assert.equal(
    contextUsageUtils.resolveContextTarget({ contextLimit: 1000 }).limit,
    1000,
    'small reported windows remain truthful rather than applying guessed reservations',
  );
  assert.equal(contextUsageUtils.resolveContextTarget({}).limit, 0, 'nothing known → not renderable');
});

test('severity is classified against an exact forwarded compaction budget', (t) => {
  withInventory(t);
  // 86262 used of a 131072-token window and exact 95846 trigger reads 90%.
  contextUsageUtils.updateUsage('budget-severity', {
    usage: {
      last_request_input_tokens: 86262,
      context_window: 131072,
      compact_threshold_tokens: 95846,
      total_tokens: 86262,
      model: 'test-model',
    },
  });
  const summary = contextUsageUtils.describeContextUsage('budget-severity');
  assert.equal(summary.limit, 95846);
  assert.equal(summary.percent, 90);
  assert.equal(summary.severity, 'warning');
});

test('disabled auto-compaction ignores a stale trigger and uses window-pressure copy', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body></body>');
  seedUsage('disabled-compaction', 850, 1000);
  const html = contextUsageUtils.renderContextUsage('disabled-compaction', {
    autoCompactEnabled: false,
  });
  const host = dom.window.document.createElement('div');
  host.innerHTML = html;
  const ring = host.querySelector('#composerContextRing');
  assert.match(ring.getAttribute('title'), /token context window/);
  assert.doesNotMatch(ring.getAttribute('title'), /auto-compact/i);
  assert.equal(contextUsageUtils.describeContextUsage('disabled-compaction', {
    autoCompactEnabled: false,
  }).targetType, 'context_window');
});

test('a KV-cache-undercounted provider reading never drags the meter below the sent-context estimate', (t) => {
  withInventory(t);
  // Ollama's prompt_eval_count covers only newly evaluated tokens: on a cache
  // hit it can be a tiny fraction of the true sent context. The estimate wins
  // whenever it is larger, keeping the meter monotone-safe.
  contextUsageUtils.updateUsage('cache-undercount', {
    usage: {
      last_request_input_tokens: 50,
      context_tokens_estimate: 30000,
      context_window: 131072,
      compact_threshold_tokens: 95846,
      model: 'test-model',
    },
  });
  const stored = contextUsageUtils.getUsage('cache-undercount');
  assert.equal(stored.usedTokens, 30000, 'the larger sent-context estimate wins');
  assert.equal(stored.usageSource, 'context');
});

/* Mid-turn context.usage snapshots (commit 2). The ring must MOVE during a
 * long agentic turn instead of showing the previous turn's number until the
 * terminal lands — and that turn's terminal must stay authoritative after.
 * `kind` picks the lane: a mid-turn stream payload or the turn terminal. */
function seedTurnUsage(sessionId, kind, streamId, usedTokens, compactBudget) {
  const mid = kind === 'mid';
  return contextUsageUtils.updateUsage(sessionId, {
    type: mid ? 'context_usage' : 'complete',
    phase: mid ? 'iteration' : undefined,
    streamId,
    usage: {
      context_used_tokens: usedTokens,
      context_used_source: mid ? 'estimate' : 'provider',
      context_tokens_estimate: usedTokens,
      last_request_input_tokens: mid ? 0 : usedTokens,
      total_tokens: usedTokens,
      context_window: compactBudget,
      compact_threshold_tokens: compactBudget,
      model: 'test-model',
    },
  });
}

test('mid-turn snapshots move the arc and percent label across one turn', (t) => {
  withInventory(t);
  const dom = new JSDOM('<body></body>');
  const arcs = [];
  const labels = [];
  for (const used of [250, 500, 950]) {
    seedTurnUsage('ring-midturn', 'mid', 'stream-mid', used, 1000);
    arcs.push(renderRing(dom, 'ring-midturn').querySelector('.inv-context-ring-arc').getAttribute('stroke-dasharray'));
    labels.push(contextUsageUtils.describeContextUsage('ring-midturn').percentLabel);
  }
  assert.deepEqual(labels, ['25%', '50%', '95%']);
  assert.equal(new Set(arcs).size, 3, 'the arc moves on every snapshot');
  assert.equal(contextUsageUtils.describeContextUsage('ring-midturn').severity, 'danger');
});

test('a mid-turn snapshot is authoritative enough to suppress the fallback estimate', (t) => {
  withInventory(t);
  /* resolveRenderUsage needs NO change for mid-turn: the snapshot normalizes
   * to 'context'/'provider', which already beats a supplied fallback. */
  seedTurnUsage('ring-auth', 'mid', 'stream-auth', 700, 1000);
  const stored = contextUsageUtils.getUsage('ring-auth');
  assert.equal(stored.usageSource, 'context');
  assert.equal(stored.phase, 'iteration');
  assert.equal(stored.turnId, 'stream-auth');
  const summary = contextUsageUtils.describeContextUsage('ring-auth', {
    activeModel: 'test-model',
    fallbackEstimate: {
      usedTokens: 120, contextLimit: 1000, compactThresholdTokens: 0,
      model: 'test-model', usageSource: 'estimate',
    },
  });
  assert.equal(summary.used, 700, 'the chars/4 fallback never overrides a live snapshot');
  assert.equal(summary.limit, 1000, 'and the snapshot brings its own auto-compact denominator');
});

test('the turn terminal supersedes its mid-turn snapshots, and a late one is a no-op', (t) => {
  withInventory(t);
  seedTurnUsage('ring-term', 'mid', 'stream-term', 400, 1000);
  seedTurnUsage('ring-term', 'terminal', 'stream-term', 880, 1000);
  assert.equal(contextUsageUtils.getUsage('ring-term').usedTokens, 880);
  assert.equal(contextUsageUtils.getUsage('ring-term').phase, 'terminal');
  assert.equal(contextUsageUtils.getUsage('ring-term').usageSource, 'provider');

  const late = seedTurnUsage('ring-term', 'mid', 'stream-term', 400, 1000);
  assert.equal(contextUsageUtils.getUsage('ring-term').usedTokens, 880, 'the terminal stays authoritative');
  assert.equal(late.usedTokens, 880, 'the dropped write returns the unchanged stored record');

  /* Fencing is turn-scoped: the NEXT turn's first snapshot must land. */
  seedTurnUsage('ring-term', 'mid', 'stream-term-2', 400, 1000);
  assert.equal(contextUsageUtils.getUsage('ring-term').usedTokens, 400);
});

test('an unchanged mid-turn snapshot does not rewrite the stored record', (t) => {
  withInventory(t);
  seedTurnUsage('ring-repeat', 'mid', 'stream-repeat', 500, 1000);
  const first = contextUsageUtils.getUsage('ring-repeat');
  seedTurnUsage('ring-repeat', 'mid', 'stream-repeat', 500, 1000);
  assert.equal(contextUsageUtils.getUsage('ring-repeat'), first, 'identical readings are dropped');
  seedTurnUsage('ring-repeat', 'mid', 'stream-repeat', 501, 1000);
  assert.equal(contextUsageUtils.getUsage('ring-repeat').usedTokens, 501);
});
