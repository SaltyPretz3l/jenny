'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const jennyStatusTool = require('../services/tools/builtin/jenny-status-tool');

function backend(status) {
  const calls = [];
  return {
    calls,
    async getJennyStatus(options) {
      calls.push(options);
      return structuredClone(status);
    },
  };
}

const STATUS = {
  schema_version: 3,
  generated_at: '2026-10-19T10:00:00.000Z',
  backend: { phase: 'ready' },
  usage: {
    session_id: 'session-a',
    recent_turns: [
      { session_id: 'session-a', stream_id: 'a1' },
      { session_id: 'session-b', stream_id: 'b1' },
      { session_id: 'session-a', stream_id: 'a2' },
    ],
  },
};

test('the session comes from the trusted context, never from the model', async () => {
  const service = backend(STATUS);
  await jennyStatusTool.execute(
    { session_id: 'session-b', sessionId: 'session-c', recent_log_limit: 99 },
    { backendService: service, sessionId: 'session-a' }
  );
  assert.equal(service.calls[0].session_id, 'session-a');
  assert.equal(service.calls[0].recent_log_limit, 50);
});

test('usage rows are narrowed to the calling chat', async () => {
  const result = await jennyStatusTool.execute({ section: 'usage' }, { backendService: backend(STATUS), sessionId: 'session-a' });
  const payload = JSON.parse(result.content);
  assert.deepEqual(payload.usage.recent_turns.map((row) => row.stream_id), ['a1', 'a2']);
  const anonymous = await jennyStatusTool.execute({ section: 'usage' }, { backendService: backend(STATUS) });
  assert.deepEqual(JSON.parse(anonymous.content).usage.recent_turns, []);
});

test('the harness facet is opt-in and the payload is compact JSON', async () => {
  const service = backend(STATUS);
  const result = await jennyStatusTool.execute({}, { backendService: service, sessionId: 'session-a' });
  await jennyStatusTool.execute({ include_harness: true }, { backendService: service, sessionId: 'session-a' });
  assert.deepEqual(service.calls.map((options) => options.include_harness), [false, true]);
  assert.equal(result.content.includes('\n'), false);
  assert.equal(result.summary, 'Jenny status: ready');
  assert.equal(result.metadata.schema_version, 3);
});

test('a missing backend or a composition failure is a structured unavailable result', async () => {
  const missing = await jennyStatusTool.execute({}, {});
  assert.equal(missing.isError, true);
  assert.equal(missing.metadata.unavailable, true);
  const failed = await jennyStatusTool.execute({}, {
    backendService: { getJennyStatus: async () => { throw new Error('secret'); } },
  });
  assert.equal(failed.isError, true);
  assert.doesNotMatch(failed.content, /secret/);
});

// ---------- row 129, C9: a short overview by default, one section on request ----------

// A status shaped like the composer's: the same section names, a few of them large.
function bigStatus() {
  const rows = (count, make) => Array.from({ length: count }, (_, index) => make(index));
  return {
    facade: 'jenny_status', schema_version: 3, generated_at: '2026-11-10T10:00:00.000Z',
    backend: { available: true, phase: 'ready', app_version: '1.6.1', credential_store: { backend: 'dpapi', detail: 'x'.repeat(200) } },
    runtime: { available: true, engine: 'llama-server', model: 'qwen3.8-35b', model_loaded: true, tools_status: { note: 'y'.repeat(1500) } },
    harness: { available: false, skipped: true, snapshot: null },
    resources: { available: true, app_memory_bytes: 1, resident_models: null },
    automations: { available: false, error: 'not wired' },
    tool_policy: { available: true, rules: rows(20, (i) => ({ id: i, text: 'z'.repeat(60) })) },
    trace_timing: { available: true, recent: rows(30, (i) => ({ id: i, ms: i, label: 'turn-'.repeat(8) })) },
    logs: { available: true, total: 90, recent: rows(50, (i) => ({ i, message: 'log line '.repeat(12) })) },
    phase_percentiles: { available: true, phases: {} },
    tool_observability: { available: true, tools: {} },
    slow_operations: { available: true, count: 0, items: [] },
    usage: { available: true, session_id: 'session-a', recent_turns: [{ session_id: 'session-a', stream_id: 'a1' }, { session_id: 'session-b', stream_id: 'b1' }] },
    schemas: { available: true, count: 3, items: rows(3, (i) => ({ id: `s${i}` })) },
    budgets: { available: true },
    memory_reflection: { available: true, state: 'idle' },
  };
}

const NAMES = ['backend', 'runtime', 'harness', 'resources', 'automations', 'tool_policy', 'trace_timing', 'logs',
  'phase_percentiles', 'tool_observability', 'slow_operations', 'usage', 'schemas', 'budgets', 'memory_reflection'];

test('the default result is a short overview that lists the section names', async () => {
  const full = JSON.stringify(bigStatus());
  const result = await jennyStatusTool.execute({}, { backendService: backend(bigStatus()), sessionId: 'session-a' });
  const payload = JSON.parse(result.content);
  assert.deepEqual(payload.sections, NAMES);
  assert.equal(payload.backend.phase, 'ready');
  assert.equal(payload.runtime.model, 'qwen3.8-35b');
  assert.deepEqual(payload.unavailable, ['automations']);
  assert.match(payload.how, /section/u);
  assert.equal(payload.logs, undefined);
  assert.ok(result.content.length < full.length / 5, `${result.content.length} vs ${full.length}`);
  assert.equal(result.summary, 'Jenny status: ready (qwen3.8-35b)');
  assert.equal(result.metadata.schema_version, 3);
  assert.equal(result.metadata.generated_at, '2026-11-10T10:00:00.000Z');
});

test('section returns that part alone, and usage stays narrowed to the calling chat', async () => {
  const service = backend(bigStatus());
  const logs = await jennyStatusTool.execute({ section: 'logs' }, { backendService: service, sessionId: 'session-a' });
  const payload = JSON.parse(logs.content);
  assert.deepEqual(Object.keys(payload).sort(), ['facade', 'generated_at', 'logs', 'section', 'schema_version'].sort());
  assert.equal(payload.logs.recent.length, 50);
  const usage = JSON.parse((await jennyStatusTool.execute({ section: 'usage' }, { backendService: service, sessionId: 'session-a' })).content);
  assert.deepEqual(usage.usage.recent_turns.map((row) => row.stream_id), ['a1']);
  await jennyStatusTool.execute({ section: 'harness' }, { backendService: service, sessionId: 'session-a' });
  assert.equal(service.calls.at(-1).include_harness, true, 'asking for the harness section composes the harness');
});

test('an unknown section is a plain sentence naming the real ones', async () => {
  const result = await jennyStatusTool.execute({ section: 'everything' }, { backendService: backend(bigStatus()), sessionId: 'session-a' });
  assert.equal(result.isError, true);
  assert.match(result.content, /section/u);
  for (const name of NAMES) assert.ok(result.content.includes(name), name);
  const wrongType = await jennyStatusTool.execute({ section: 7 }, { backendService: backend(bigStatus()) });
  assert.equal(wrongType.isError, true);
});

test('the section names in the manifest are the parts the real composer produces', async () => {
  const { getJennyStatus } = require('../services/backend/jenny-status-composer');
  const manifest = require('../services/tools/tool-manifest.json');
  const real = await getJennyStatus({ getBackendStatus: () => ({ phase: 'ready' }) }, {});
  const listed = manifest.tools.find((entry) => entry.name === 'jenny_status').parameters.properties.section.enum;
  assert.deepEqual(listed, Object.keys(real).filter((key) => !['facade', 'schema_version', 'generated_at'].includes(key)));
  const service = { async getJennyStatus() { return real; } };
  const overview = JSON.parse((await jennyStatusTool.execute({}, { backendService: service, sessionId: 's' })).content);
  assert.deepEqual(overview.sections, listed);
  assert.ok(JSON.stringify(overview).length < JSON.stringify(real).length / 3);
});
