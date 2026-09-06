const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const segmentedControl = require('../renderer/inventory/segmented-control');
const { createUsageController } = require('../renderer/shell/renderer-usage-controller');
const { buildCsv } = require('../renderer/shell/renderer-usage-markup-utils');

test('CSV export neutralizes formula-leading model and provider text before quoting', () => {
  const csv = buildCsv([{
    model: '=2+2',
    provider: '  @SUM(A1:A2),remote',
  }]);
  const dataRow = csv.split('\r\n')[1];

  assert.match(dataRow, /,,,,,,'=2\+2,/);
  assert.match(dataRow, /,"' {2}@SUM\(A1:A2\),remote",/);
  assert.doesNotMatch(dataRow, /,,,,,,=2\+2,/);
});

function totals(rows) {
  const models = {};
  for (const row of rows) {
    const bucket = models[row.model] || {
      turn_count: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0,
      duration_ms: 0, speed: {
        measured_turns: 1,
        tokens_per_second: { median: 10, p10: 10, p90: 10 },
        ttft_ms: { measured_turns: 1, median: 100 },
      },
    };
    bucket.turn_count += 1;
    bucket.input_tokens += row.input_tokens;
    bucket.output_tokens += row.output_tokens;
    bucket.total_tokens += row.total_tokens;
    bucket.duration_ms += row.duration_ms;
    models[row.model] = bucket;
  }
  return {
    turn_count: rows.length,
    input_tokens: rows.reduce((sum, row) => sum + row.input_tokens, 0),
    output_tokens: rows.reduce((sum, row) => sum + row.output_tokens, 0),
    total_tokens: rows.reduce((sum, row) => sum + row.total_tokens, 0),
    estimated_turns: rows.filter((row) => row.estimated).length,
    duration_ms: rows.reduce((sum, row) => sum + row.duration_ms, 0),
    outcomes: {
      complete: rows.filter((row) => row.outcome === 'complete').length,
      error: rows.filter((row) => row.outcome === 'error').length,
      cancelled: rows.filter((row) => row.outcome === 'cancelled').length,
    },
    provider_cost_usd: 0,
    cost_coverage: { local_zero_turns: rows.length, provider_reported_turns: 0, unavailable_turns: 0 },
    speed: {
      measured_turns: rows.length,
      tokens_per_second: { median: 10, p10: 8, p90: 12 },
      ttft_ms: { measured_turns: rows.length, median: 100 },
    },
    models,
  };
}

function makeRows(count = 120) {
  const base = Date.parse('2026-08-18T12:00:00.000Z');
  return Array.from({ length: count }, (_, index) => ({
    record_id: `stream:${index}`,
    recorded_at: new Date(base - index * 1000).toISOString(),
    session_id: index % 3 ? 'session-a' : 'session-b',
    stream_id: `stream-${index}`,
    request_id: `request-${index}`,
    trace_id: `trace-${index}`,
    model: index % 2 ? 'qwen' : 'gemma',
    provider: 'ollama',
    terminal_type: index % 5 ? 'complete' : 'error',
    outcome: index % 5 ? 'complete' : 'error',
    outcome_detail: index % 5 ? '' : 'CMP-CHAT-0001',
    duration_ms: 1000,
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
    generation_tokens: 5,
    generation_duration_ms: 500,
    ttft_ms: 100,
    estimated: index === 0,
    cost_source: 'local_zero',
    cost_usd: 0,
  }));
}

function makeSnapshot(rows = makeRows()) {
  const allTotals = totals(rows);
  return {
    available: true,
    persistence: { available: true, durable: true, read_only_reason: null },
    retention: {
      max_age_days: 30, max_turns: 500, retained_turns: rows.length,
      oldest_at: rows.at(-1)?.recorded_at || '',
    },
    today: allTotals,
    session: totals(rows.filter((row) => row.session_id === 'session-a')),
    cumulative: allTotals,
    recent_turns: rows,
    last_record_error: null,
  };
}

function harness(options = {}) {
  const jsdom = new JSDOM('<!doctype html><body>' + [
    'usageBadge', 'usageScope', 'usageStats', 'usageByModel', 'usageRecentMeta',
    'usageRecentTurns', 'usageMore', 'usageRetentionSummary', 'usageRecordWarning',
    'usageActions', 'usageActionStatus',
  ].map((id) => `<div id="${id}"></div>`).join('') + '</body>', { url: 'http://localhost' });
  const document = jsdom.window.document;
  const dom = Object.fromEntries([...document.querySelectorAll('[id]')].map((node) => [node.id, node]));
  const calls = [];
  const snapshot = options.snapshot || makeSnapshot();
  jsdom.window.jennyShell = {
    usage: {
      async getSnapshot(payload) {
        calls.push({ type: 'snapshot', payload });
        if (payload.mode === 'export') return { ok: true, scope: payload.scope, rows: options.exportRows || snapshot.recent_turns };
        return typeof options.getSnapshot === 'function' ? options.getSnapshot(payload) : snapshot;
      },
      async clearHistory() {
        calls.push({ type: 'clear' });
        if (typeof options.clearHistory === 'function') return options.clearHistory();
        return { ok: true, cleared_turn_count: snapshot.retention.retained_turns, durable: true };
      },
    },
    dialog: {
      async saveFile(payload) { calls.push({ type: 'save', payload }); return { canceled: false, path: 'usage.csv' }; },
    },
  };
  const controller = createUsageController({
    window: jsdom.window,
    dom,
    inventory: { actionButton, segmentedControl },
    now: () => Date.parse('2026-08-18T13:00:00.000Z'),
    callbacks: {
      getCurrentSessionId: () => 'session-a',
      isVisible: () => options.visible !== false,
      confirmClear: typeof options.confirmClear === 'function'
        ? options.confirmClear
        : async () => options.confirmClear !== false,
      openSession: (sessionId) => calls.push({ type: 'chat', sessionId }),
      openTrace: (target) => calls.push({ type: 'trace', target }),
      appendClientLog: (level, event, details) => calls.push({ type: 'log', level, event, details }),
    },
  });
  return { jsdom, document, dom, controller, calls, snapshot };
}

test('Usage activates with a 200-row request, default Today scope, and 50-row client paging', async () => {
  const ctx = harness();
  await ctx.controller.activate();
  assert.deepEqual(ctx.calls[0], {
    type: 'snapshot',
    payload: { mode: 'interactive', sessionId: 'session-a', limit: 200 },
  });
  assert.equal(ctx.document.querySelector('[data-inv-segmented="usage-scope"] [aria-checked="true"]').dataset.value, 'today');
  assert.equal(ctx.document.querySelectorAll('[data-usage-recent-body] tr').length, 50);
  assert.match(ctx.dom.usageStats.textContent, /p10–p90 8\.0–12\.0 tok\/s/);
  assert.equal(ctx.document.querySelector('.usage-recent-table thead').textContent.includes('First token'), true);
  assert.equal(ctx.document.querySelectorAll('.usage-model-table thead .usage-cell-num').length, 5);
  assert.ok(ctx.document.querySelector('.usage-model-cell .usage-outcome'));
  const more = ctx.document.querySelector('[data-usage-action="more"]');
  more.focus();
  more.click();
  assert.equal(ctx.document.querySelectorAll('[data-usage-recent-body] tr').length, 100);
  assert.equal(ctx.document.activeElement, ctx.document.querySelector('[data-usage-action="more"]'));
  assert.equal(ctx.dom.usageActionStatus.dataset.visual, 'hidden');
  ctx.controller.dispose();
});

test('model and outcome filters combine without replacing the focused filter controls', async () => {
  const ctx = harness();
  await ctx.controller.activate();
  const modelRow = ctx.document.querySelector('[data-usage-model="qwen"]');
  const tableBody = ctx.document.querySelector('[data-usage-recent-body]');
  modelRow.focus();
  modelRow.click();
  assert.equal(ctx.document.activeElement, modelRow);
  assert.equal(modelRow.getAttribute('aria-pressed'), 'true');
  assert.equal(ctx.document.querySelector('[data-usage-recent-body]'), tableBody);
  const outcome = ctx.document.querySelector('[data-usage-outcome-filter]');
  outcome.dispatchEvent(new ctx.jsdom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(outcome.getAttribute('aria-pressed'), 'true');
  assert.match(ctx.dom.usageRecentMeta.textContent, /qwen.*failed or stopped/);
  assert.equal([...tableBody.querySelectorAll('tr')].every((row) => /failed/i.test(row.textContent)), true);
  const clearFilters = ctx.document.querySelector('[data-usage-action="clear-filters"]');
  clearFilters.focus();
  clearFilters.click();
  assert.equal(ctx.document.activeElement, modelRow);
  ctx.controller.dispose();
});

test('a model with no loaded recent rows keeps the table header and exposes filter clearing', async () => {
  const snapshot = makeSnapshot(makeRows(4));
  const orphan = {
    turn_count: 1, input_tokens: 1, output_tokens: 1, total_tokens: 2,
    duration_ms: 50, outcomes: { complete: 1 },
    speed: {
      measured_turns: 0,
      tokens_per_second: { median: 0, p10: 0, p90: 0 },
      ttft_ms: { measured_turns: 0, median: 0 },
    },
  };
  snapshot.today.models.orphan = orphan;
  snapshot.cumulative.models.orphan = orphan;
  const ctx = harness({ snapshot });
  await ctx.controller.activate();
  ctx.document.querySelector('[data-usage-model="orphan"]').click();
  assert.equal(ctx.document.querySelectorAll('.usage-recent-table thead').length, 1);
  assert.match(ctx.document.querySelector('[data-usage-recent-body]').textContent, /No turns match this filter/);
  assert.ok(ctx.document.querySelector('[data-usage-action="clear-filters"]'));
  ctx.controller.dispose();
});

test('CSV export ignores active filters, requests the full scope, and uses RFC 4180 escaping', async () => {
  const exportRows = [{ ...makeRows(1)[0], model: 'qwen, "coder"', outcome_detail: 'line_code' }];
  const ctx = harness({ exportRows });
  await ctx.controller.activate();
  ctx.document.querySelector('[data-usage-model="qwen"]').click();
  ctx.document.querySelector('[data-usage-action="export"]').click();
  await new Promise((resolve) => setImmediate(resolve));
  const exportCall = ctx.calls.find((call) => call.type === 'snapshot' && call.payload.mode === 'export');
  const saveCall = ctx.calls.find((call) => call.type === 'save');
  assert.deepEqual(exportCall.payload, { mode: 'export', scope: 'today', sessionId: 'session-a' });
  assert.match(saveCall.payload.defaultName, /^jenny-usage-today-2026-08-18\.csv$/);
  assert.equal(saveCall.payload.format, 'plain');
  assert.deepEqual(saveCall.payload.filters, [{ name: 'CSV', extensions: ['csv'] }]);
  assert.match(saveCall.payload.content, /"qwen, ""coder"""/);
  assert.match(ctx.dom.usageActionStatus.textContent, /Exported 1 turns\./);
  assert.equal(ctx.dom.usageActionStatus.dataset.visual, 'visible');
  ctx.controller.dispose();
});

test('clear history requires confirmation and reports the durable result', async () => {
  const cancelled = harness({ confirmClear: false });
  await cancelled.controller.activate();
  cancelled.document.querySelector('[data-usage-action="clear"]').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled.calls.some((call) => call.type === 'clear'), false);
  cancelled.controller.dispose();

  const cleared = harness();
  await cleared.controller.activate();
  cleared.document.querySelector('[data-usage-action="clear"]').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleared.calls.some((call) => call.type === 'clear'), true);
  assert.equal(cleared.dom.usageActionStatus.textContent, 'Cleared 120 retained turns.');
  assert.equal(cleared.dom.usageActionStatus.dataset.visual, 'visible');
  cleared.controller.dispose();
});

test('clear history does not continue after disposal while confirmation is pending', async () => {
  let resolveConfirmation;
  const ctx = harness({
    confirmClear: () => new Promise((resolve) => { resolveConfirmation = resolve; }),
  });
  await ctx.controller.activate();

  ctx.document.querySelector('[data-usage-action="clear"]').click();
  await new Promise((resolve) => setImmediate(resolve));
  ctx.controller.dispose();
  resolveConfirmation(true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(ctx.calls.some((call) => call.type === 'clear'), false);
  assert.equal(ctx.controller.getState().busyAction, '');
});

test('transport failure degrades safely and stale responses are rejected after deactivation', async () => {
  let resolveSnapshot;
  const pending = new Promise((resolve) => { resolveSnapshot = resolve; });
  const ctx = harness({ getSnapshot: () => pending });
  const activation = ctx.controller.activate();
  ctx.controller.deactivate();
  resolveSnapshot(makeSnapshot(makeRows(1)));
  await activation;
  assert.equal(ctx.controller.getState().snapshot, null);
  ctx.controller.dispose();

  const failed = harness({ getSnapshot: async () => { throw new Error('private payload'); } });
  await failed.controller.activate();
  assert.equal(failed.dom.usageBadge.textContent, 'Unavailable');
  assert.equal(failed.dom.usageActionStatus.textContent, 'Usage data is unavailable.');
  const warning = failed.calls.find((call) => call.type === 'log');
  assert.deepEqual(warning, {
    type: 'log', level: 'WARN', event: 'settings.usage_snapshot_unavailable',
    details: { reason: 'transport_failure' },
  });
  failed.controller.dispose();
});

test('empty, read-only, record-failure, retention-pressure, and unmeasured states stay explicit', async () => {
  const empty = harness({ snapshot: makeSnapshot([]) });
  await empty.controller.activate();
  assert.equal(empty.dom.usageScope.hidden, true);
  assert.match(empty.dom.usageStats.textContent, /Nothing measured yet/);
  assert.match(empty.dom.usageStats.textContent, /Numbers appear here after your first retained turn/);
  assert.equal(empty.document.querySelector('[data-usage-action="clear"]').disabled, true);
  empty.controller.dispose();

  const readOnlySnapshot = makeSnapshot(makeRows(2));
  readOnlySnapshot.available = false;
  readOnlySnapshot.persistence = {
    available: false, durable: false, read_only_reason: 'future_schema',
  };
  readOnlySnapshot.last_record_error = 'record_failed';
  const readOnly = harness({ snapshot: readOnlySnapshot });
  await readOnly.controller.activate();
  assert.equal(readOnly.dom.usageBadge.textContent, 'Unavailable');
  assert.match(readOnly.dom.usageRetentionSummary.textContent, /Existing rows are preserved/);
  assert.equal(readOnly.dom.usageRetentionSummary.dataset.tone, 'danger');
  assert.match(readOnly.dom.usageRecordWarning.textContent, /most recent turn could not be saved/);
  assert.equal(readOnly.document.querySelector('[data-usage-action="clear"]').disabled, true);
  assert.equal(readOnly.document.querySelector('[data-usage-action="export"]').disabled, false);
  readOnly.controller.dispose();

  const pressureSnapshot = makeSnapshot(makeRows(120));
  pressureSnapshot.retention.retained_turns = 500;
  pressureSnapshot.retention.oldest_at = '2026-08-14T13:00:00.000Z';
  pressureSnapshot.today.speed = {
    measured_turns: 0,
    tokens_per_second: { median: 0, p10: 0, p90: 0 },
    ttft_ms: { measured_turns: 0, median: 0 },
  };
  const pressure = harness({ snapshot: pressureSnapshot });
  await pressure.controller.activate();
  assert.match(pressure.dom.usageRetentionSummary.textContent, /Holding the newest 500 turns/);
  assert.equal(pressure.dom.usageRetentionSummary.dataset.tone, 'warning');
  assert.match(pressure.dom.usageStats.textContent, /not reported by this provider/);
  pressure.controller.dispose();
});

test('row actions route to chat and trace, and live refresh is trailing and coalesced', async () => {
  const timers = [];
  let nowMs = Date.parse('2026-08-18T13:00:00.000Z');
  const ctx = harness();
  ctx.controller.dispose();

  const controller = createUsageController({
    window: ctx.jsdom.window,
    dom: ctx.dom,
    inventory: { actionButton, segmentedControl },
    now: () => nowMs,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; },
    callbacks: {
      getCurrentSessionId: () => 'session-a',
      isVisible: () => true,
      openSession: (sessionId) => ctx.calls.push({ type: 'chat', sessionId }),
      openTrace: (target) => ctx.calls.push({ type: 'trace', target }),
    },
  });
  await controller.activate();
  assert.equal(ctx.document.querySelector('[data-usage-action="chat"]').getAttribute('title'), 'Open this turn in chat');
  assert.equal(ctx.document.querySelector('[data-usage-action="trace"]').getAttribute('title'), 'Open the diagnostics trace for this turn');
  ctx.document.querySelector('[data-usage-action="chat"]').click();
  ctx.document.querySelector('[data-usage-action="trace"]').click();
  assert.equal(ctx.calls.some((call) => call.type === 'chat' && call.sessionId), true);
  assert.equal(ctx.calls.some((call) => call.type === 'trace' && call.target.streamId), true);

  nowMs += 500;
  controller.notifyTurnSettled();
  controller.notifyTurnSettled();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 1500);
  timers[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ctx.calls.filter((call) => call.type === 'snapshot').length, 2);

  nowMs += 500;
  controller.notifyTurnSettled();
  controller.deactivate();
  assert.equal(timers[1].cleared, true);
  controller.dispose();
});
