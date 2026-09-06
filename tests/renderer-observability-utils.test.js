const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createObservabilityController } = require('../renderer/shell/renderer-observability-utils');
const {
  buildSlowOperationsMarkup,
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

function createHarness(fetcher) {
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
    }),
    traces: window.document.getElementById('traces'),
    slow: window.document.getElementById('slow'),
  };
}

function createTraceFocusHarness(fetcher, callbacks) {
  const harness = createHarness(fetcher);
  harness.controller.dispose();
  harness.controller = createObservabilityController({
    window: harness.window,
    dom: {
      toolLatencyTable: harness.window.document.getElementById('latency'),
      slowOperationsList: harness.window.document.getElementById('slow'),
      recentTracesList: harness.window.document.getElementById('traces'),
      usageRecentTurns: harness.window.document.getElementById('usage'),
    },
    callbacks,
  });
  return harness;
}

test('observability controller rerenders same-size snapshots when generated_at changes', async () => {
  const snapshots = [
    makeSnapshot('stream-a', '2026-05-07T12:00:00.000Z'),
    makeSnapshot('stream-b', '2026-05-07T12:01:00.000Z'),
  ];
  const harness = createHarness(async () => snapshots.shift());

  await harness.controller.refresh({ silent: false });
  assert.match(harness.traces.innerHTML, /stream-a/);
  const traceToggle = harness.traces.querySelector('[data-observability-trace-toggle]');
  const detailId = traceToggle.getAttribute('aria-controls');
  assert.ok(detailId);
  assert.ok(harness.traces.querySelector(`#${detailId}`));
  assert.equal(harness.window.document.querySelectorAll('#latency th[scope="col"]').length, 7);

  await harness.controller.refresh({ silent: false });
  assert.match(harness.traces.innerHTML, /stream-b/);
  assert.doesNotMatch(harness.traces.innerHTML, /stream-a/);
});

test('traces without stream ids expand independently using their fallback identities', async () => {
  const snapshot = makeSnapshot('', '2026-05-07T12:00:00.000Z');
  snapshot.trace_timing.count = 2;
  snapshot.trace_timing.recent = [
    { ...snapshot.trace_timing.recent[0], trace_id: 'trace-a', request_id: 'request-a' },
    { ...snapshot.trace_timing.recent[0], trace_id: 'trace-b', request_id: 'request-b' },
  ];
  const harness = createHarness(async () => snapshot);
  await harness.controller.refresh({ silent: false });

  const toggles = Array.from(harness.traces.querySelectorAll('[data-observability-trace-toggle]'));
  assert.equal(toggles.length, 2);
  toggles[0].dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true }));

  const expanded = Array.from(harness.traces.querySelectorAll('[data-observability-trace-toggle]'))
    .filter((toggle) => toggle.getAttribute('aria-expanded') === 'true');
  assert.equal(expanded.length, 1, 'one fallback-keyed row expands without opening its sibling');
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

test('observability controller keeps pending trace focus until the row exists', async () => {
  const snapshots = [
    makeSnapshot('stream-other', '2026-05-07T12:00:00.000Z'),
    makeSnapshot('stream-later', '2026-05-07T12:01:00.000Z'),
  ];
  let pending = 'stream-later';
  const cleared = [];
  const harness = createTraceFocusHarness(async () => snapshots.shift(), {
    peekPendingTraceFocus() {
      return pending;
    },
    clearPendingTraceFocus(streamId) {
      cleared.push(streamId);
      if (streamId === pending) {
        pending = '';
      }
    },
  });

  await harness.controller.refresh({ silent: false });
  assert.equal(pending, 'stream-later');
  assert.deepEqual(cleared, []);
  assert.doesNotMatch(harness.traces.innerHTML, /aria-expanded="true"/);

  await harness.controller.refresh({ silent: false });
  assert.equal(pending, '');
  assert.deepEqual(cleared, ['stream-later']);
  assert.match(harness.traces.innerHTML, /stream-later/);
  assert.match(harness.traces.innerHTML, /aria-expanded="true"/);
});

test('observability controller resets pending trace misses for a new focus target', async () => {
  const snapshots = [
    makeSnapshot('stream-other', '2026-05-07T12:00:00.000Z'),
    makeSnapshot('stream-other', '2026-05-07T12:01:00.000Z'),
    makeSnapshot('stream-other', '2026-05-07T12:02:00.000Z'),
    makeSnapshot('stream-other', '2026-05-07T12:03:00.000Z'),
    makeSnapshot('stream-other', '2026-05-07T12:04:00.000Z'),
  ];
  const longPending = 'stream-apiKey=sk-tracesecret123456789-' + 'x'.repeat(120);
  let pending = 'stream-first';
  const cleared = [];
  const harness = createTraceFocusHarness(async () => snapshots.shift(), {
    peekPendingTraceFocus() {
      return pending;
    },
    clearPendingTraceFocus(streamId) {
      cleared.push(streamId);
      if (streamId === pending) {
        pending = '';
      }
    },
  });

  await harness.controller.refresh({ silent: false });
  await harness.controller.refresh({ silent: false });
  assert.equal(harness.traces.textContent.includes('has not appeared'), false);
  assert.deepEqual(cleared, []);

  pending = longPending;
  await harness.controller.refresh({ silent: false });
  assert.equal(harness.traces.textContent.includes('has not appeared'), false);
  assert.deepEqual(cleared, []);

  await harness.controller.refresh({ silent: false });
  await harness.controller.refresh({ silent: false });
  assert.deepEqual(cleared, [longPending]);
  assert.match(harness.traces.textContent, /has not appeared in recent Runtime Health rows yet/);
  assert.equal(harness.traces.textContent.includes('sk-tracesecret123456789'), false);
  assert.equal(harness.traces.textContent.includes(longPending), false);
});

// ---- UIUX-030: both scrollIntoView call sites must honor prefers-reduced-motion ----
//
// renderAll() rebuilds the traces list via innerHTML both on refresh() and on
// a trace-link click, so any row reference queried before the triggering
// action is stale by the time scrollIntoView actually fires. Patch the
// window's Element.prototype once per test instead of stubbing an instance.

function captureScrollIntoView(win) {
  const calls = [];
  win.Element.prototype.scrollIntoView = function scrollIntoView(opts) {
    calls.push({ streamId: this.getAttribute && this.getAttribute('data-trace-stream'), opts });
  };
  return calls;
}

test('pending-trace-focus auto-scroll is smooth when the OS does not prefer reduced motion', async () => {
  const harness = createTraceFocusHarness(
    async () => makeSnapshot('stream-later', '2026-05-07T12:01:00.000Z'),
    { peekPendingTraceFocus: () => 'stream-later', clearPendingTraceFocus: () => {} }
  );
  harness.window.matchMedia = () => ({ matches: false });
  harness.window.requestAnimationFrame = (cb) => cb();
  const calls = captureScrollIntoView(harness.window);

  await harness.controller.refresh({ silent: false });

  assert.equal(calls.length, 1, 'expected scrollIntoView to be called once');
  assert.equal(calls[0].streamId, 'stream-later');
  assert.equal(calls[0].opts.behavior, 'smooth');
});

test('pending-trace-focus auto-scroll degrades to instant under OS prefers-reduced-motion', async () => {
  const harness = createTraceFocusHarness(
    async () => makeSnapshot('stream-later', '2026-05-07T12:01:00.000Z'),
    { peekPendingTraceFocus: () => 'stream-later', clearPendingTraceFocus: () => {} }
  );
  harness.window.matchMedia = () => ({ matches: true });
  harness.window.requestAnimationFrame = (cb) => cb();
  const calls = captureScrollIntoView(harness.window);

  await harness.controller.refresh({ silent: false });

  assert.equal(calls.length, 1, 'expected scrollIntoView to be called once');
  assert.equal(calls[0].streamId, 'stream-later');
  assert.equal(calls[0].opts.behavior, 'auto', 'reduced motion must degrade the pending-trace-focus scroll to instant');
});

test('slow operations markup renders the jenny_status slow-operation contract', () => {
  const html = buildSlowOperationsMarkup({
    available: true,
    count: 1,
    items: [{
      kind: 'tool',
      id: 'read_file',
      metric: 'p95',
      observed_ms: 2400,
      threshold_ms: 1000,
      count: 3,
      error_count: 1,
    }],
  });

  assert.match(html, /read_file/);
  assert.match(html, /2\.40s/);
  assert.match(html, /threshold 1\.00s/);
  assert.match(html, /3 samples/);
  assert.match(html, /1 error/);
});
