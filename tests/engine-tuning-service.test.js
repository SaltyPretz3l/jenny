'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { EngineTuningService } = require('../services/engine-tuning-service');
const {
  cloneEngineTuning,
  engineTuningMethods,
} = require('../services/shell-config-engine-tuning');

/* A shell-config stand-in backed by the REAL engineTuning methods, so a write
 * here goes through the same normalization production uses. */
function createShellConfig(initial = {}) {
  const host = {
    state: { engineTuning: cloneEngineTuning(initial) },
    writes: 0,
    ...engineTuningMethods,
  };
  host._writeState = (nextState) => {
    host.state = nextState;
    host.writes += 1;
    return nextState;
  };
  return host;
}

function createBackend({ refresh = async () => ({ ok: true }), activeStreams = 0 } = {}) {
  const backend = {
    refreshCalls: [],
    logs: [],
    activeStreams: new Map(),
  };
  for (let index = 0; index < activeStreams; index += 1) {
    backend.activeStreams.set(`stream-${index}`, {});
  }
  backend.refreshManagedConfig = async (reason, options) => {
    backend.refreshCalls.push(reason);
    return refresh(reason, options);
  };
  backend._emitServiceLog = (level, event, details) => {
    backend.logs.push({ level, event, details });
  };
  return backend;
}

function createService(options = {}) {
  const shellConfigService = options.shellConfigService || createShellConfig(options.initial);
  const backendService = options.backendService || createBackend(options.backend);
  return {
    service: new EngineTuningService({ shellConfigService, backendService }),
    shellConfigService,
    backendService,
  };
}

test('update applies a valid override and refreshes the runtime once', async () => {
  const { service, shellConfigService, backendService } = createService();
  const result = await service.update({ key: 'maxToolsPerTurn', value: 7 });
  assert.equal(result.status, 'applied');
  assert.equal(result.state.values.maxToolsPerTurn, 7);
  assert.deepEqual(backendService.refreshCalls, ['engine_tuning_transaction']);
  assert.equal(shellConfigService.writes, 1);
});

test('update with null resets the field', async () => {
  const { service } = createService({ initial: { maxToolsPerTurn: 7 } });
  const result = await service.update({ key: 'maxToolsPerTurn', value: null });
  assert.equal(result.status, 'applied');
  assert.ok(!('maxToolsPerTurn' in result.state.values));
});

test('update rejects an unknown field', async () => {
  const { service, backendService } = createService();
  const result = await service.update({ key: 'notAField', value: 5 });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'invalid_field');
  assert.deepEqual(backendService.refreshCalls, [], 'a rejection must not touch the runtime');
});

test('update rejects an out-of-bounds value rather than clamping it', async () => {
  const { service, shellConfigService, backendService } = createService();
  const result = await service.update({ key: 'maxToolsPerTurn', value: 5000 });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'invalid_value');
  assert.equal(shellConfigService.writes, 0);
  assert.deepEqual(backendService.refreshCalls, []);
});

test('update refuses while a stream is active', async () => {
  // These knobs govern the loop the running turn is executing; applying one
  // mid-stream would land half in this turn and half in the next.
  const { service, backendService } = createService({ backend: { activeStreams: 1 } });
  const result = await service.update({ key: 'maxToolsPerTurn', value: 7 });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'active_stream');
  assert.deepEqual(backendService.refreshCalls, []);
});

test('getState reports the active stream so the UI can disable before the user tries', async () => {
  const { service } = createService({ backend: { activeStreams: 2 } });
  assert.equal(service.getState().activeStream, true);
  const { service: idle } = createService();
  assert.equal(idle.getState().activeStream, false);
});

test('update rejects a second concurrent call', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service } = createService({ backend: { refresh: () => gate.then(() => ({ ok: true })) } });
  const first = service.update({ key: 'maxToolsPerTurn', value: 7 });
  const second = await service.update({ key: 'maxLoopIterations', value: 12 });
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason, 'update_in_progress');
  release();
  assert.equal((await first).status, 'applied');
});

test('update rejects once disposed', async () => {
  const { service } = createService();
  service.dispose();
  const result = await service.update({ key: 'maxToolsPerTurn', value: 7 });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'disposed');
});

test('a runtime refresh failure rolls the config back and re-refreshes', async () => {
  // The core safety property: a value the running sidecar refuses must not be
  // left persisted, or every subsequent boot re-applies the wedge.
  let calls = 0;
  const { service, shellConfigService, backendService } = createService({
    initial: { maxToolsPerTurn: 7 },
    backend: {
      refresh: async () => {
        calls += 1;
        if (calls === 1) throw new Error('sidecar refused');
        return { ok: true };
      },
    },
  });
  const result = await service.update({ key: 'maxToolsPerTurn', value: 55 });
  assert.equal(result.status, 'rolled_back');
  assert.equal(result.reason, 'runtime_refresh_failed');
  assert.equal(
    shellConfigService.getEngineTuning().maxToolsPerTurn,
    7,
    'the previous override must be restored, not left at the rejected value'
  );
  assert.deepEqual(
    backendService.refreshCalls,
    ['engine_tuning_transaction', 'engine_tuning_rollback'],
    'the rollback must itself be pushed to the runtime'
  );
});

test('a rollback that also fails reports degraded rather than success', async () => {
  const { service } = createService({
    backend: { refresh: async () => { throw new Error('runtime gone'); } },
  });
  const result = await service.update({ key: 'maxToolsPerTurn', value: 55 });
  assert.equal(result.status, 'degraded');
  assert.equal(result.reason, 'rollback_refresh_failed');
});

test('a missing managed runtime rolls back rather than reporting applied', async () => {
  const shellConfigService = createShellConfig();
  const service = new EngineTuningService({ shellConfigService, backendService: null });
  const result = await service.update({ key: 'maxToolsPerTurn', value: 7 });
  assert.equal(result.status, 'degraded');
  assert.ok(!('maxToolsPerTurn' in shellConfigService.getEngineTuning()));
});

test('a refresh returning null is saved-but-deferred, not a rollback', async () => {
  // refreshManagedConfig resolves null when no managed sidecar process is up.
  // The config write still stands and the next sidecar start reads it; rolling
  // back would leave every limit uneditable while the engine is down - including
  // the timeout that may be the reason it is down. The caller is told plainly.
  const { service, shellConfigService, backendService } = createService({
    backend: { refresh: async () => null },
  });
  const result = await service.update({ key: 'maxToolsPerTurn', value: 7 });
  assert.equal(result.status, 'applied');
  assert.equal(result.reason, 'deferred');
  assert.equal(shellConfigService.getEngineTuning().maxToolsPerTurn, 7, 'the override persisted');
  assert.equal(result.state.values.maxToolsPerTurn, 7);
  assert.deepEqual(backendService.refreshCalls, ['engine_tuning_transaction'], 'no rollback refresh');
  const applied = backendService.logs.find((entry) => entry.event === 'engine_tuning.applied');
  assert.equal(applied.details.reason, 'deferred');
});

test('a deferred reset still clears the overrides', async () => {
  const { service, shellConfigService } = createService({
    initial: { maxToolsPerTurn: 7, cloudMaxToolsPerTurn: 150 },
    backend: { refresh: async () => null },
  });
  const result = await service.reset({});
  assert.equal(result.status, 'applied');
  assert.equal(result.reason, 'deferred');
  assert.deepEqual(shellConfigService.getEngineTuning(), {});
});

test('a refresh that rejects still rolls back', async () => {
  // The deferred path is ONLY for a null result; a thrown refresh means the
  // running sidecar refused the config, which must still restore the previous value.
  const { service, shellConfigService } = createService({
    initial: { maxToolsPerTurn: 9 },
    backend: { refresh: async (reason) => { if (reason === 'engine_tuning_transaction') throw new Error('boom'); return { ok: true }; } },
  });
  const result = await service.update({ key: 'maxToolsPerTurn', value: 7 });
  assert.equal(result.status, 'rolled_back');
  assert.equal(shellConfigService.getEngineTuning().maxToolsPerTurn, 9);
});

test('reset clears every override with one write and one refresh', async () => {
  // Resetting field-by-field would reinitialise the sidecar once per field.
  const { service, shellConfigService, backendService } = createService({
    initial: { maxToolsPerTurn: 7, maxSubAgentConcurrency: 4, cloudMaxToolsPerTurn: 150 },
  });
  const result = await service.reset({});
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.state.values, {});
  assert.equal(shellConfigService.writes, 1, 'exactly one config write');
  assert.deepEqual(backendService.refreshCalls, ['engine_tuning_reset']);
});

test('reset scoped to a pane spares the other pane', async () => {
  const { service } = createService({
    initial: { maxToolsPerTurn: 7, cloudMaxToolsPerTurn: 150 },
  });
  const result = await service.reset({ scope: 'local' });
  assert.equal(result.status, 'applied');
  assert.ok(!('maxToolsPerTurn' in result.state.values));
  assert.equal(result.state.values.cloudMaxToolsPerTurn, 150);
});

test('reset rejects an unknown scope', async () => {
  const { service, backendService } = createService({ initial: { maxToolsPerTurn: 7 } });
  const result = await service.reset({ scope: 'sideways' });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'invalid_scope');
  assert.deepEqual(backendService.refreshCalls, []);
});

test('reset refuses while a stream is active', async () => {
  const { service } = createService({
    initial: { maxToolsPerTurn: 7 },
    backend: { activeStreams: 1 },
  });
  const result = await service.reset({});
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'active_stream');
});

test('a failed reset restores every previous override', async () => {
  let calls = 0;
  const { service, shellConfigService } = createService({
    initial: { maxToolsPerTurn: 7, maxSubAgentConcurrency: 4 },
    backend: {
      refresh: async () => {
        calls += 1;
        if (calls === 1) throw new Error('sidecar refused');
        return { ok: true };
      },
    },
  });
  const result = await service.reset({});
  assert.equal(result.status, 'rolled_back');
  assert.deepEqual(
    shellConfigService.getEngineTuning(),
    { maxToolsPerTurn: 7, maxSubAgentConcurrency: 4 },
    'every cleared override must come back'
  );
});

test('getState exposes the schema so the renderer needs no second copy', () => {
  const { service } = createService({ initial: { maxToolsPerTurn: 7 } });
  const state = service.getState();
  assert.ok(Array.isArray(state.fields) && state.fields.length > 0);
  assert.ok(Array.isArray(state.groups) && state.groups.length > 0);
  assert.equal(state.values.maxToolsPerTurn, 7);
  assert.equal(state.pending, false);
});

test('applied and failed transitions are logged with bounded detail', () => {
  // check_js_logging_contract requires bounded payloads; unbounded user values
  // in a log line are how config data leaks into diagnostics.
  const { service, backendService } = createService();
  return service.update({ key: 'maxToolsPerTurn', value: 7 }).then(() => {
    const applied = backendService.logs.find((entry) => entry.event === 'engine_tuning.applied');
    assert.ok(applied, 'an applied change must be observable in diagnostics');
    assert.equal(applied.details.key, 'maxToolsPerTurn');
    assert.equal(applied.details.status, 'applied');
    for (const value of Object.values(applied.details)) {
      if (typeof value === 'string') assert.ok(value.length <= 80);
    }
  });
});

test('a transaction result never reports pending:true (the renderer would freeze on it)', async () => {
  // Regression: the success snapshot used to be taken inside the transaction,
  // before `finally` cleared pending, so every applied result said pending:true
  // and the Advanced pane disabled every control until something else happened
  // to refresh it - which nothing did.
  const { service } = createService({ initial: { maxToolsPerTurn: 7 } });
  const applied = await service.update({ key: 'maxToolsPerTurn', value: 9 });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.state.pending, false);
  const reset = await service.reset({});
  assert.equal(reset.status, 'applied');
  assert.equal(reset.state.pending, false);

  let refreshes = 0;
  const failing = createService({
    initial: { maxToolsPerTurn: 7 },
    backend: {
      refresh: async () => {
        refreshes += 1;
        if (refreshes === 1) throw new Error('sidecar refused');
        return { ok: true };
      },
    },
  });
  const rolledBack = await failing.service.update({ key: 'maxToolsPerTurn', value: 9 });
  assert.equal(rolledBack.status, 'rolled_back');
  assert.equal(rolledBack.state.pending, false);
});

test('a failed reset rolls back with ONE config write, not one per override', async () => {
  let refreshes = 0;
  const { service, shellConfigService } = createService({
    initial: { maxToolsPerTurn: 7, maxSubAgentConcurrency: 4, maxWebToolCallsPerTurn: 3 },
    backend: {
      refresh: async () => {
        refreshes += 1;
        if (refreshes === 1) throw new Error('sidecar refused');
        return { ok: true };
      },
    },
  });
  const before = shellConfigService.writes;
  const result = await service.reset({});
  assert.equal(result.status, 'rolled_back');
  assert.deepEqual(shellConfigService.getEngineTuning(), {
    maxToolsPerTurn: 7, maxSubAgentConcurrency: 4, maxWebToolCallsPerTurn: 3,
  });
  // one write for the reset itself + one write for the whole rollback patch
  assert.equal(shellConfigService.writes - before, 2);
});
