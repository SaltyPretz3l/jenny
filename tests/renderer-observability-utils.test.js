const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createObservabilityController } = require('../renderer/shell/renderer-observability-utils');
const {
  buildSlowOperationsMarkup,
  buildToolLatencyMarkup,
  buildTraceTimingMarkup,
} = require('../renderer/shell/renderer-observability-markup-utils');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeSnapshot(streamId, generatedAt) {
  return {
    generated_at: generatedAt,
    tool_observability: {
      available: true,
      generated_at: generatedAt,
      tools: { read_file: { count: 1, error_rate: 0, latency_ms: { p50: 20, p95: 30, p99: 40 }, error_codes: {} } },
    },
    slow_operations: {
      available: true,
      count: 1,
      items: [{
        kind: 'tool',
        id: 'read_file',
        metric: 'p95',
        observed_ms: streamId === 'stream-a' ? 1200 : 2400,
        threshold_ms: 1000,
        count: 3,
        error_count: 1,
      }],
    },
    trace_timing: {
      available: true,
      count: 1,
      recent: [{
        stream_id: streamId,
        terminal_status: 'completed',
        duration_ms: streamId === 'stream-a' ? 100 : 200,
        model: 'qwen3',
        mode: 'chat',
        provider_timing: {},
        tool_events: { total: 0 },
      }],
    },
    usage: {
      available: true,
      recent_turns: [],
    },
  };
}

function createHarness(fetcher, callbacks) {
  const dom = new JSDOM(
    '<!doctype html><body>'
      + '<div id="latency"></div>'
      + '<div id="slow"></div>'
      + '<div id="traces"></div>'
      + '<div id="usage"></div>'
      + '</body>',
    { pretendToBeVisual: true }
  );
  const { window } = dom;
  window.jennyShell = {
    diagnostics: {
      getJennyStatus: fetcher,
    },
  };
  return {
    window,
    controller: createObservabilityController({
      window,
      dom: {
        toolLatencyTable: window.document.getElementById('latency'),
        slowOperationsList: window.document.getElementById('slow'),
        recentTracesList: window.document.getElementById('traces'),
        usageRecentTurns: window.document.getElementById('usage'),
      },
      callbacks,
    }),
    traces: window.document.getElementById('traces'),
    slow: window.document.getElementById('slow'),
  };
}

test('observability controller rerenders same-size snapshots when generated_at changes', async () => {
  const snapshots = [
    makeSnapshot('stream-a', '2026-05-07T12:00:00.000Z'),
    makeSnapshot('stream-b', '2026-05-07T12:01:00.000Z'),
  ];
  const harness = createHarness(async () => snapshots.shift());

  await harness.controller.refresh({ silent: false });
  assert.match(harness.traces.innerHTML, /stream-a/);
  assert.equal(harness.traces.querySelector('[data-observability-trace]').getAttribute('data-observability-trace'), 'stream-a');
  assert.equal(harness.window.document.querySelectorAll('#latency th[scope="col"]').length, 6);

  await harness.controller.refresh({ silent: false });
  assert.match(harness.traces.innerHTML, /stream-b/);
  assert.doesNotMatch(harness.traces.innerHTML, /stream-a/);
});

test('observability controller does not retain disposed in-flight snapshots', async () => {
  const request = deferred();
  const harness = createHarness(() => request.promise);

  const refreshPromise = harness.controller.refresh({ silent: false });
  harness.controller.dispose();
  request.resolve(makeSnapshot('stream-after-dispose', '2026-05-07T12:02:00.000Z'));
  await refreshPromise;

  assert.equal(harness.controller.getSnapshot(), null);
  assert.equal(harness.traces.innerHTML, '');
});

test('observability controller coalesces concurrent refreshes', async () => {
  const request = deferred();
  let calls = 0;
  const harness = createHarness(() => {
    calls += 1;
    return request.promise;
  });
  const snapshot = makeSnapshot('stream-shared', '2026-05-07T12:02:00.000Z');

  const first = harness.controller.refresh({ silent: false });
  const second = harness.controller.refresh({ silent: true });
  assert.equal(calls, 1);
  request.resolve(snapshot);

  assert.equal(await first, snapshot);
  assert.equal(await second, snapshot);
  assert.equal(harness.controller.getSnapshot(), snapshot);
});

test('forced observability refresh waits for an in-flight request and fetches a fresh snapshot', async () => {
  const requests = [deferred(), deferred()];
  let calls = 0;
  const harness = createHarness(() => {
    const request = requests[calls];
    calls += 1;
    return request.promise;
  });
  const staleSnapshot = makeSnapshot('stream-before-clear', '2026-05-07T12:02:00.000Z');
  const freshSnapshot = makeSnapshot('stream-after-clear', '2026-05-07T12:03:00.000Z');

  const first = harness.controller.refresh({ silent: false });
  const forced = harness.controller.refresh({ silent: true, force: true });
  assert.equal(calls, 1);

  requests[0].resolve(staleSnapshot);
  assert.equal(await first, null, 'the superseded request must not commit its stale payload');
  assert.equal(harness.controller.getSnapshot(), null);
  assert.doesNotMatch(harness.traces.innerHTML, /stream-before-clear/);
  await Promise.resolve();
  assert.equal(calls, 2, 'the forced refresh must start a new request after the stale one settles');

  requests[1].resolve(freshSnapshot);
  assert.equal(await forced, freshSnapshot);
  assert.equal(harness.controller.getSnapshot(), freshSnapshot);
});

test('post-mutation refresh clears cached usage and keeps it cleared when the fresh fetch fails', async () => {
  const staleRequest = deferred();
  const freshRequest = deferred();
  const cachedSnapshot = makeSnapshot('stream-cached-before-clear', '2026-05-07T12:01:00.000Z');
  let calls = 0;
  const harness = createHarness(() => {
    calls += 1;
    if (calls === 1) return Promise.resolve(cachedSnapshot);
    if (calls === 2) return staleRequest.promise;
    return freshRequest.promise;
  });

  await harness.controller.refresh({ silent: false });
  assert.equal(harness.controller.getSnapshot(), cachedSnapshot);
  const preClear = harness.controller.refresh({ silent: false });
  const postClear = harness.controller.refresh({
    silent: true,
    force: true,
    invalidateSnapshot: true,
  });
  assert.equal(harness.controller.getSnapshot(), null);
  assert.doesNotMatch(harness.traces.innerHTML, /stream-cached-before-clear/);

  staleRequest.resolve(makeSnapshot('stream-stale-response', '2026-05-07T12:02:00.000Z'));
  assert.equal(await preClear, null);
  await Promise.resolve();
  freshRequest.reject(new Error('diagnostics offline'));

  assert.equal(await postClear, null);
  assert.equal(harness.controller.getSnapshot(), null);
  assert.doesNotMatch(harness.traces.innerHTML, /stream-stale-response|stream-cached-before-clear/);
});

test('post-mutation invalidation survives a missing diagnostics bridge and stale in-flight response', async () => {
  const staleRequest = deferred();
  const cachedSnapshot = makeSnapshot('stream-cached-before-bridge-loss', '2026-05-07T12:01:00.000Z');
  let calls = 0;
  const harness = createHarness(() => {
    calls += 1;
    return calls === 1 ? Promise.resolve(cachedSnapshot) : staleRequest.promise;
  });

  await harness.controller.refresh({ silent: false });
  const preClear = harness.controller.refresh({ silent: false });
  delete harness.window.jennyShell.diagnostics.getJennyStatus;

  assert.equal(await harness.controller.refresh({
    silent: true,
    force: true,
    invalidateSnapshot: true,
  }), null);
  assert.equal(harness.controller.getSnapshot(), null);

  staleRequest.resolve(makeSnapshot('stream-stale-after-bridge-loss', '2026-05-07T12:02:00.000Z'));
  assert.equal(await preClear, null);
  assert.equal(harness.controller.getSnapshot(), null);
  assert.doesNotMatch(
    harness.traces.innerHTML,
    /stream-cached-before-bridge-loss|stream-stale-after-bridge-loss/
  );
});

test('aborted observability refresh does not commit a late response', async () => {
  const request = deferred();
  const abortController = new AbortController();
  const harness = createHarness(() => request.promise);
  const refresh = harness.controller.refresh({
    silent: true,
    signal: abortController.signal,
  });

  abortController.abort('postwork_deadline');
  request.resolve(makeSnapshot('stream-after-timeout', '2026-05-07T12:04:00.000Z'));

  assert.equal(await refresh, null);
  assert.equal(harness.controller.getSnapshot(), null);
  assert.doesNotMatch(harness.traces.innerHTML, /stream-after-timeout/);
});

test('stale observability continuation guard does not commit a late response', async () => {
  const request = deferred();
  let current = true;
  const harness = createHarness(() => request.promise);
  const refresh = harness.controller.refresh({
    silent: true,
    guard: { isCurrent: () => current },
  });

  current = false;
  request.resolve(makeSnapshot('stream-after-session-delete', '2026-05-07T12:05:00.000Z'));

  assert.equal(await refresh, null);
  assert.equal(harness.controller.getSnapshot(), null);
  assert.doesNotMatch(harness.traces.innerHTML, /stream-after-session-delete/);
});


function traceFacet(...streams) {
  return {
    available: true,
    count: streams.length,
    recent: streams.map((stream) => ({
      stream_id: stream, terminal_status: 'completed', duration_ms: 100, model: 'qwen3', provider_timing: {}, tool_events: { total: 0 },
    })),
  };
}

function rowsOf(markup) {
  const doc = new JSDOM(markup).window.document;
  return Array.from(doc.querySelectorAll('tbody tr'));
}

test('every group builds no markup when its facet has no rows', () => {
  for (const facet of [null, undefined, {}, { available: false }, { available: true }, { available: true, tools: {}, items: [], recent: [] }]) {
    assert.equal(buildToolLatencyMarkup(facet), '');
    assert.equal(buildSlowOperationsMarkup(facet), '');
    assert.equal(buildTraceTimingMarkup(facet), '');
  }
  assert.equal(buildToolLatencyMarkup({ available: true, tools: { idle: { count: 0 } } }), '', 'a tool with no calls is not a row');
});

test('slow operations markup renders the jenny_status slow-operation contract', () => {
  const html = buildSlowOperationsMarkup({
    available: true,
    count: 2,
    items: [
      { kind: 'tool', id: 'read_file', metric: 'p95', observed_ms: 2400, threshold_ms: 1000, count: 3, error_count: 1 },
      { kind: 'phase', id: 'provider_start', observed_ms: 5000, threshold_ms: null, count: 1 },
    ],
  });
  const rows = rowsOf(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].cells[0].querySelector('code').textContent, 'provider_start', 'the slowest comes first');
  assert.equal(rows[0].cells[1].textContent, '5.0 s');
  assert.equal(rows[0].cells[2].textContent, 'target —', 'a missing threshold is an unknown, not a number');
  assert.equal(rows[0].cells[3].textContent, '1 time');
  assert.equal(rows[1].cells[0].textContent, 'read_file tool');
  assert.equal(rows[1].cells[1].textContent, '2.4 s');
  assert.equal(rows[1].cells[2].textContent, 'target 1.0 s');
  assert.equal(rows[1].cells[3].textContent, '3 times');
});

test('Last error is the most recent error code, not the most frequent one', () => {
  const stats = (extra) => ({ count: 9, error_count: 6, error_rate: 6 / 9, latency_ms: { p50: 1, p95: 2, p99: 3 }, ...extra });
  const rows = rowsOf(buildToolLatencyMarkup({ available: true, tools: {
    frequent_then_recent: stats({
      error_codes: { CMP_TOOL_IO_FAILED: 5, CMP_TOOL_TIMEOUT: 1 },
      recent_errors: [{ error_code: 'CMP_TOOL_IO_FAILED' }, { error_code: 'CMP_TOOL_IO_FAILED' }, { error_code: 'CMP_TOOL_TIMEOUT' }],
    }),
    one_code_only: stats({ error_codes: { CMP_TOOL_DENIED: 4 } }),
    no_recency: stats({ error_codes: { A: 3, B: 2 } }),
    never_failed: stats({ error_count: 0, error_rate: 0, error_codes: {} }),
  } }));
  const lastError = (name) => rows.find((row) => row.cells[0].textContent === name).cells[5].textContent;
  assert.equal(lastError('frequent_then_recent'), 'CMP_TOOL_TIMEOUT');
  assert.equal(lastError('one_code_only'), 'CMP_TOOL_DENIED', 'a single code is necessarily the last');
  assert.equal(lastError('no_recency'), '—', 'two codes and no recency: nothing honest to name');
  assert.equal(lastError('never_failed'), '—');
});

test('tool rows sort by slow time, count failures and show an em dash for none', () => {
  const rows = rowsOf(buildToolLatencyMarkup({ available: true, tools: {
    quick: { count: 10, error_count: 0, error_rate: 0, latency_ms: { p50: 5, p95: 12, p99: 20 } },
    slow: { count: 4, error_count: 1, error_rate: 0.25, latency_ms: { p50: 500, p95: 1500, p99: 2000 }, error_codes: { X: 1 } },
    unmeasured: { count: 2, error_rate: 1, latency_ms: {} },
  } }));
  assert.deepEqual(rows.map((row) => row.cells[0].textContent), ['slow', 'quick', 'unmeasured']);
  assert.deepEqual(Array.from(rows[0].cells).slice(1, 5).map((cell) => cell.textContent), ['4', '1', '500 ms', '1.5 s']);
  assert.equal(rows[1].cells[2].textContent, '—');
  assert.equal(rows[2].cells[2].textContent, '2', 'failures derive from the rate when no count is reported');
  assert.equal(rows[2].cells[3].textContent, '—');
  const headers = Array.from(new JSDOM(buildToolLatencyMarkup({ available: true, tools: { quick: { count: 1 } } })).window.document.querySelectorAll('th'));
  assert.deepEqual(headers.map((th) => th.textContent), ['Tool', 'Calls', 'Failed', 'Typical', 'Slow', 'Last error']);
  assert.equal(headers[5].classList.contains('diagnostics-col-wide'), true);
});

test('recent chats list newest first with a Result button that names the chat to open', () => {
  const doc = new JSDOM(buildTraceTimingMarkup({ available: true, recent: [
    { stream_id: 'old', terminal_status: 'completed', duration_ms: 1200, model: 'qwen3', provider_timing: { time_to_first_visible_token_ms: 150 }, tool_events: { total: 2 } },
    { stream_id: 'new', terminal_status: 'error', duration_ms: 90, model: '', provider_timing: {}, tool_events: { total: 0 } },
    { stream_id: '', terminal_status: 'cancelled', duration_ms: 10, model: 'qwen3', provider_timing: {}, tool_events: {} },
  ] })).window.document;
  const rows = Array.from(doc.querySelectorAll('tbody tr'));
  assert.equal(rows.length, 3);
  const button = rows[1].querySelector('button[data-observability-trace]');
  assert.equal(button.getAttribute('data-observability-trace'), 'new');
  // The visible result names the button (no aria-label override); what it does is the tooltip.
  assert.equal(button.hasAttribute('aria-label'), false);
  assert.equal(button.getAttribute('title'), "Show this chat's records");
  assert.equal(button.type, 'button');
  assert.equal(button.textContent, 'Failed');
  assert.ok(button.querySelector('svg.inv-state-icon--error'));
  assert.equal(rows[2].querySelector('[data-observability-trace]').textContent, 'Completed');
  assert.equal(rows[2].querySelector('svg'), null, 'completed carries no icon');
  assert.equal(rows[0].querySelector('button'), null, 'a chat without a stream id has nothing to open');
  assert.equal(rows[0].cells[0].textContent, 'Cancelled');
  assert.deepEqual(Array.from(rows[2].cells).slice(1).map((cell) => cell.textContent), ['qwen3', '150 ms', '1.2 s', '2']);
  assert.deepEqual(Array.from(rows[1].cells).slice(1).map((cell) => cell.textContent), ['—', '—', '90 ms', '—']);
});

test('recent chats keep unknown durations as an em dash while a real zero stays zero', () => {
  const rows = rowsOf(buildTraceTimingMarkup({ available: true, recent: [
    { stream_id: 'zero', duration_ms: 0, provider_timing: { time_to_first_visible_token_ms: 0 } },
    { stream_id: 'unknown', duration_ms: null, provider_timing: { time_to_first_visible_token_ms: null } },
  ] }));
  assert.deepEqual(Array.from(rows[0].cells).slice(2, 4).map((cell) => cell.textContent), ['—', '—']);
  assert.deepEqual(Array.from(rows[1].cells).slice(2, 4).map((cell) => cell.textContent), ['0 ms', '0 ms']);
  assert.doesNotMatch(rows[0].textContent, /\b0 ?ms\b|TBD|--/);
});

test('selecting a chat asks to open its records, and a result without a handler does nothing', async () => {
  const opened = [];
  const harness = createHarness(async () => ({ ...makeSnapshot('stream-a', 'g1'), trace_timing: traceFacet('stream-a', 'stream-b') }), { onTraceLink: (stream) => opened.push(stream) });
  await harness.controller.refresh({ silent: false });
  harness.traces.querySelector('[data-observability-trace="stream-a"]').click();
  assert.deepEqual(opened, ['stream-a']);
  harness.traces.querySelector('tbody td').dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(opened, ['stream-a'], 'a click outside a Result button opens nothing');
  const bare = createHarness(async () => makeSnapshot('stream-a', 'g1'));
  await bare.controller.refresh({ silent: false });
  assert.doesNotThrow(() => bare.traces.querySelector('[data-observability-trace]').click());
});

test('a repaint keeps keyboard focus on the same chat, found by its stream id', async () => {
  let facet = traceFacet('stream-a', 'stream-b');
  let generated = 1;
  const harness = createHarness(async () => ({ ...makeSnapshot('x', 'g' + generated), trace_timing: facet }));
  await harness.controller.refresh({ silent: false });
  const before = harness.traces.querySelector('[data-observability-trace="stream-a"]');
  before.focus();
  assert.equal(harness.window.document.activeElement, before);
  generated += 1;
  facet = traceFacet('stream-a', 'stream-b', 'stream-c');
  await harness.controller.refresh({ silent: false });
  const after = harness.traces.querySelector('[data-observability-trace="stream-a"]');
  assert.notEqual(after, before, 'the pane really was repainted');
  assert.equal(harness.window.document.activeElement, after, 'focus returns to the same chat');
  assert.equal(harness.traces.querySelectorAll('[data-observability-trace]').length, 3);
});

test('a repaint that drops the focused chat moves focus to the nearest remaining chat', async () => {
  let facet = traceFacet('stream-a', 'stream-b');
  let generated = 1;
  const harness = createHarness(async () => ({ ...makeSnapshot('x', 'g' + generated), trace_timing: facet }));
  await harness.controller.refresh({ silent: false });
  harness.traces.querySelector('[data-observability-trace="stream-a"]').focus();
  generated += 1;
  facet = traceFacet('stream-b');
  await harness.controller.refresh({ silent: false });
  assert.equal(harness.traces.querySelectorAll('[data-observability-trace]').length, 1);
  assert.equal(harness.window.document.activeElement?.getAttribute('data-observability-trace'), 'stream-b');
});

test('an unchanged pane is not repainted when only the snapshot stamp moves', async () => {
  let generated = 1;
  const harness = createHarness(async () => makeSnapshot('stream-a', 'g' + generated));
  await harness.controller.refresh({ silent: false });
  const table = harness.traces.querySelector('table');
  generated += 1;
  await harness.controller.refresh({ silent: false });
  assert.equal(harness.traces.querySelector('table'), table);
});

test('the controller reports every new snapshot to the Overview', async () => {
  const seen = [];
  const snapshots = [makeSnapshot('stream-a', 'g1'), makeSnapshot('stream-b', 'g2')];
  const harness = createHarness(async () => snapshots.shift(), { onSnapshot: (snapshot) => seen.push(snapshot) });
  const first = await harness.controller.refresh({ silent: false });
  const second = await harness.controller.refresh({ silent: false });
  assert.deepEqual(seen, [first, second]);
});

test('a snapshot that changes only whether a facet is available still reaches the Overview', async () => {
  const seen = [];
  const facets = (available) => ({ tool_observability: { available }, slow_operations: { available }, trace_timing: { available } });
  const snapshots = [facets(true), facets(false)];
  const harness = createHarness(async () => snapshots.shift(), { onSnapshot: (snapshot) => seen.push(snapshot) });
  await harness.controller.refresh({ silent: false });
  await harness.controller.refresh({ silent: false });
  assert.deepEqual(seen.map((snapshot) => snapshot.trace_timing.available), [true, false]);
});
