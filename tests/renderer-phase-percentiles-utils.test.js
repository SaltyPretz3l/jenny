const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildRuntimeHealthSummary,
  renderPhasePercentilesPane,
} = require('../renderer/shell/renderer-phase-percentiles-utils.js');

function createClassList() {
  const values = new Set();
  return {
    toggle(name, force) {
      if (force) {
        values.add(name);
      } else {
        values.delete(name);
      }
    },
    contains(name) {
      return values.has(name);
    },
  };
}

function createNode() {
  return {
    hidden: false,
    textContent: '',
    innerHTML: '',
    classList: createClassList(),
    dataset: {},
  };
}

test('runtime health renders as a user-facing slice outside dev mode', () => {
  const dom = {
    diagnosticsBadge: createNode(),
    diagnosticsSummary: createNode(),
    diagnosticsStatus: createNode(),
    phasePercentilesTable: createNode(),
    phasePercentilesResetButton: createNode(),
  };

  renderPhasePercentilesPane({
    phasePercentilesState: {
      loading: false,
      error: '',
      payload: {
        generated_at: '2026-04-21T15:00:00.000Z',
        phases: {
          provider_request_start_to_first_chunk: {
            count: 2,
            p50: 120,
            p95: 190,
            p99: 190,
          },
          first_chunk_to_first_visible_token: {
            count: 2,
            p50: 24,
            p95: 32,
            p99: 32,
          },
        },
        targets: {
          provider_request_start_to_first_chunk: { p50: 150, p95: 400 },
          first_chunk_to_first_visible_token: { p50: 20, p95: 100 },
        },
      },
    },
    runtimeHealthState: {
      backend: { phase: 'ready', retryable: true },
      status: { engine: 'ollama', model: 'qwen3.6:latest' },
      modelList: { available: true, active_model: 'qwen3.6:latest' },
      offline: { localChatReady: true },
    },
    dom,
  });

  assert.match(dom.diagnosticsBadge.textContent, /healthy/i);
  assert.match(dom.diagnosticsSummary.textContent, /ollama/i);
  assert.match(dom.diagnosticsSummary.textContent, /qwen3\.6/i);
  assert.match(dom.diagnosticsStatus.textContent, /first chunk/i);
  assert.match(dom.phasePercentilesTable.innerHTML, /Provider start to first chunk/);
  assert.match(dom.phasePercentilesTable.innerHTML, /scope="col"/);
  assert.equal(dom.phasePercentilesResetButton.disabled, false);
});

function buildHealthyDom() {
  return {
    diagnosticsBadge: createNode(),
    diagnosticsSummary: createNode(),
    diagnosticsStatus: createNode(),
    phasePercentilesTable: createNode(),
    phasePercentilesResetButton: createNode(),
  };
}

test('empty phase evidence collapses into a concise no-samples state', () => {
  const dom = buildHealthyDom();
  renderPhasePercentilesPane({
    ...buildHealthyState(),
    dom,
  });
  assert.match(dom.phasePercentilesTable.innerHTML, /No latency samples yet/);
  assert.doesNotMatch(dom.phasePercentilesTable.innerHTML, /<table/);
  assert.doesNotMatch(dom.phasePercentilesTable.innerHTML, /TBD|EMPTY/);
  assert.equal(dom.diagnosticsStatus.textContent, 'No latency samples recorded for this run.');
  assert.equal(dom.phasePercentilesResetButton.disabled, true);
});

test('unavailable runtime does not recommend sending a chat for latency samples', () => {
  const dom = buildHealthyDom();
  renderPhasePercentilesPane({
    phasePercentilesState: { loading: false, error: '', payload: { phases: {}, targets: {} } },
    runtimeHealthState: {
      backend: { phase: 'failed' },
      status: { engine: 'ollama', model: 'qwen3.6:latest' },
      modelList: { available: true, active_model: 'qwen3.6:latest' },
      offline: {},
    },
    dom,
  });
  assert.equal(dom.diagnosticsBadge.textContent, 'Unavailable');
  assert.equal(dom.diagnosticsBadge.dataset.tone, 'danger');
  assert.match(dom.diagnosticsSummary.textContent, /unavailable until the backend recovers/i);
  assert.match(dom.phasePercentilesTable.innerHTML, /unavailable until the backend recovers/i);
  assert.doesNotMatch(dom.diagnosticsSummary.textContent, /send a local chat/i);
  assert.doesNotMatch(dom.phasePercentilesTable.innerHTML, /send a local chat/i);
});

test('warning harness evidence cannot downgrade an unavailable backend', () => {
  const summary = buildRuntimeHealthSummary({
    phasePercentilesState: { loading: false, error: '', payload: { phases: {}, targets: {} } },
    runtimeHealthState: {
      backend: { phase: 'failed' },
      status: { engine: 'ollama', model: 'qwen3.6:latest' },
      modelList: { available: true, active_model: 'qwen3.6:latest' },
      offline: {},
    },
    harnessSnapshot: { runtime: {} },
    deriveRuntimeHealthState() {
      return { tone: 'warning', summary: 'Degraded: stale capability profile' };
    },
  });
  assert.equal(summary.badge, 'Unavailable');
  assert.match(summary.summary, /stale capability profile/i);
});

function buildHealthyState() {
  return {
    phasePercentilesState: { loading: false, error: '', payload: { phases: {}, targets: {} } },
    runtimeHealthState: {
      backend: { phase: 'ready' },
      status: { engine: 'ollama', model: 'qwen3.6:latest' },
      modelList: { available: true, active_model: 'qwen3.6:latest' },
      offline: { localChatReady: true },
    },
  };
}

test('Phase 7 harnessSnapshot override switches badge to Blocked when tone is danger', () => {
  const dom = buildHealthyDom();
  renderPhasePercentilesPane({
    ...buildHealthyState(),
    harnessSnapshot: { runtime: {} },
    deriveRuntimeHealthState() {
      return { tone: 'danger', label: 'Blocked', summary: 'Blocked: probe failed for qwen3.6:latest' };
    },
    dom,
  });
  assert.equal(dom.diagnosticsBadge.textContent, 'Blocked');
  assert.match(dom.diagnosticsSummary.textContent, /Blocked: probe failed for qwen3\.6:latest/);
});

test('Phase 7 harnessSnapshot override switches badge to Degraded when tone is warning', () => {
  const dom = buildHealthyDom();
  renderPhasePercentilesPane({
    ...buildHealthyState(),
    harnessSnapshot: { runtime: {} },
    deriveRuntimeHealthState() {
      return { tone: 'warning', label: 'Degraded', summary: 'Degraded: tools disabled for qwen3.6:latest' };
    },
    dom,
  });
  assert.equal(dom.diagnosticsBadge.textContent, 'Degraded');
  assert.match(dom.diagnosticsSummary.textContent, /Degraded: tools disabled for qwen3\.6:latest/);
});

test('Phase 7 override does not fire when tone is success', () => {
  const dom = buildHealthyDom();
  renderPhasePercentilesPane({
    ...buildHealthyState(),
    harnessSnapshot: { runtime: {} },
    deriveRuntimeHealthState() {
      return { tone: 'success', label: 'Healthy', summary: 'Healthy' };
    },
    dom,
  });
  assert.match(dom.diagnosticsBadge.textContent, /healthy/i);
  assert.doesNotMatch(dom.diagnosticsSummary.textContent, /Blocked|Degraded/);
});

test('Phase 7 override is skipped while phase percentiles are loading', () => {
  const dom = buildHealthyDom();
  renderPhasePercentilesPane({
    phasePercentilesState: { loading: true, error: '', payload: null },
    runtimeHealthState: { backend: { phase: 'ready' }, status: {}, modelList: {}, offline: {} },
    harnessSnapshot: { runtime: {} },
    deriveRuntimeHealthState() {
      return { tone: 'danger', label: 'Blocked', summary: 'Blocked: ignored' };
    },
    dom,
  });
  assert.equal(dom.diagnosticsBadge.textContent, 'Refreshing');
  assert.doesNotMatch(dom.diagnosticsSummary.textContent, /Blocked: ignored/);
});

test('Phase 7 override is silent when deriveRuntimeHealthState throws', () => {
  const dom = buildHealthyDom();
  renderPhasePercentilesPane({
    ...buildHealthyState(),
    harnessSnapshot: { runtime: {} },
    deriveRuntimeHealthState() {
      throw new Error('boom');
    },
    dom,
  });
  assert.match(dom.diagnosticsBadge.textContent, /healthy/i);
});

test('Phase 7 override is skipped when deriveRuntimeHealthState is not provided', () => {
  const dom = buildHealthyDom();
  renderPhasePercentilesPane({
    ...buildHealthyState(),
    harnessSnapshot: { runtime: {} },
    dom,
  });
  assert.match(dom.diagnosticsBadge.textContent, /healthy/i);
});
