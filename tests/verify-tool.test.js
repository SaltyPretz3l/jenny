'use strict';

/* Contract for the `verify` builtin — model-facing access to the Workspace IDE
 * Test Runner.
 *
 * Two things this suite exists to pin down:
 *
 * 1. The model can only CHOOSE a saved configuration, never author a command.
 *    There is no argument passthrough and no command composition, so the string
 *    that executes is always one the user wrote in their own IDE. That bound is
 *    the entire safety argument for the tool's `auto` policy default.
 *
 * 2. The load-bearing invariant: verification can never strand a turn. A
 *    refusal the turn should survive — the user's own run holding the single-run
 *    lock, or the runner rejecting outright — comes back as a NON-error
 *    "skipped" result, so the loop finalizes with an honest "unverified" instead
 *    of a failed turn. A suite that RAN and FAILED is likewise not a tool error:
 *    it is a reported verdict.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createVerifyTool,
  MAX_OUTPUT_CHARS,
} = require('../services/tools/builtin/verify-tool');
const { WORKSPACE_TEST_RUNNER_ERROR_CODES } = require('../services/backend/error-codes');

function envelope(code, message = 'refused') {
  return { error: { code, message } };
}

function stubService(overrides = {}) {
  const calls = [];
  return {
    calls,
    listConfigs() {
      calls.push(['listConfigs']);
      return overrides.listConfigs !== undefined
        ? overrides.listConfigs
        : { configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }] };
    },
    getState() {
      return overrides.state !== undefined ? overrides.state : { history: { byConfig: {} } };
    },
    async run(payload) {
      calls.push(['run', payload]);
      if (overrides.runThrows) {
        throw overrides.runThrows;
      }
      return overrides.run !== undefined
        ? overrides.run
        : { configId: payload.configId, runId: 'r1', status: 'passed', durationMs: 1200 };
    },
    ...(overrides.serviceOverrides || {}),
  };
}

describe('verify tool contract', () => {
  test('exposes only list and run, and cannot carry a command', () => {
    const tool = createVerifyTool();
    assert.equal(tool.name, 'verify');
    assert.equal(tool.readOnly, false);
    assert.equal(tool.workspaceRequired, true);
    assert.deepEqual(tool.parameters.properties.action.enum, ['list', 'run', 'gate']);
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['action', 'config_id']);
    assert.equal(tool.parameters.additionalProperties, false);
    // The absence of these is the safety argument, so assert it explicitly.
    for (const forbidden of ['command', 'cwd', 'env', 'args', 'timeout_ms', 'timeoutMs']) {
      assert.equal(
        forbidden in tool.parameters.properties,
        false,
        `verify must not accept ${forbidden}: the model may never author a command`
      );
    }
  });

  test('list reports the saved configurations and their last status', async () => {
    const service = stubService({
      listConfigs: {
        configs: [
          { id: 'unit', label: 'Unit', command: 'npm test' },
          { id: 'lint', label: 'Lint', command: 'npm run lint' },
        ],
      },
      state: { history: { byConfig: { unit: [{ status: 'passed' }, { status: 'failed' }] } } },
    });
    const result = await createVerifyTool().execute({ action: 'list' }, {
      workspaceTestRunnerService: service,
    });

    assert.equal(result.isError, false);
    assert.equal(result.metadata.status, 'ok');
    assert.deepEqual(result.metadata.configs.map((row) => row.id), ['unit', 'lint']);
    // Last status comes from the TAIL of history, not the head.
    assert.equal(result.metadata.configs[0].last_status, 'failed');
    assert.equal(result.metadata.configs[1].last_status, 'none');
    assert.match(result.content, /npm run lint/);
  });

  test('list says so plainly when the workspace has no configurations', async () => {
    const service = stubService({ listConfigs: { configs: [] } });
    const result = await createVerifyTool().execute({ action: 'list' }, {
      workspaceTestRunnerService: service,
    });

    assert.equal(result.isError, false);
    assert.deepEqual(result.metadata.configs, []);
    assert.match(result.content, /cannot create one/);
  });

  test('run forwards the config id and nothing the model supplied', async () => {
    const service = stubService();
    await createVerifyTool().execute(
      { action: 'run', config_id: 'unit', command: 'rm -rf /' },
      { workspaceTestRunnerService: service }
    );

    const runCall = service.calls.find(([name]) => name === 'run');
    // `initiator` is the TOOL's own attribution (who started the run), not
    // something the model supplied -- the model's extra `command` is gone.
    assert.deepEqual(runCall[1], { configId: 'unit', includeOutput: true, initiator: 'jenny' });
  });

  test('a passing run reports the verdict without dumping output', async () => {
    const service = stubService({
      run: {
        configId: 'unit',
        runId: 'r7',
        status: 'passed',
        durationMs: 2500,
        passedCount: 41,
        failedCount: 0,
        stdoutTail: 'ok 1\nok 2\n'.repeat(400),
      },
    });
    const result = await createVerifyTool().execute({ action: 'run', config_id: 'unit' }, {
      workspaceTestRunnerService: service,
    });

    assert.equal(result.isError, false);
    assert.equal(result.metadata.status, 'passed');
    assert.equal(result.metadata.run_id, 'r7');
    assert.match(result.content, /Verification passed/);
    assert.match(result.content, /0 failed, 41 passed/);
    // A passing parade is noise: the tails are withheld on success.
    assert.equal(result.content.includes('ok 1'), false);
  });

  test('a failing run is a reported verdict, not a tool error', async () => {
    const service = stubService({
      run: {
        configId: 'unit',
        runId: 'r8',
        status: 'failed',
        exitCode: 1,
        durationMs: 900,
        passedCount: 40,
        failedCount: 1,
        stdoutTail: 'AssertionError: expected 3 to equal 4',
        stderrTail: 'at foo.js:12',
      },
    });
    const result = await createVerifyTool().execute({ action: 'run', config_id: 'unit' }, {
      workspaceTestRunnerService: service,
    });

    // isError would make the loop treat a legitimate red suite as a broken tool.
    assert.equal(result.isError, false);
    assert.equal(result.metadata.status, 'failed');
    assert.equal(result.metadata.exit_code, 1);
    assert.match(result.content, /did NOT pass/);
    assert.match(result.content, /AssertionError: expected 3 to equal 4/);
    assert.match(result.content, /at foo\.js:12/);
  });

  test('failing output is tail-bounded so one pathological run cannot dominate', async () => {
    const service = stubService({
      run: {
        configId: 'unit',
        runId: 'r9',
        status: 'failed',
        stdoutTail: `${'x'.repeat(MAX_OUTPUT_CHARS * 3)}LAST_FAILING_LINE`,
      },
    });
    const result = await createVerifyTool().execute({ action: 'run', config_id: 'unit' }, {
      workspaceTestRunnerService: service,
    });

    assert.ok(result.content.length < MAX_OUTPUT_CHARS * 2, `content was ${result.content.length}`);
    assert.match(result.content, /earlier output omitted/);
    // The bound keeps the END of the output, where the failure actually is.
    assert.match(result.content, /LAST_FAILING_LINE/);
  });

  describe('the gate action', () => {
    test('runs whichever configuration the user designated', async () => {
      const service = stubService({
        listConfigs: {
          configs: [
            { id: 'lint', command: 'npm run lint' },
            { id: 'unit', command: 'npm test', gate: true, gateOnFailure: 'retry' },
          ],
        },
        run: { configId: 'unit', runId: 'g1', status: 'passed', durationMs: 100 },
      });
      const result = await createVerifyTool().execute({ action: 'gate' }, {
        workspaceTestRunnerService: service,
      });

      const runCall = service.calls.find(([name]) => name === 'run');
      assert.deepEqual(runCall[1], { configId: 'unit', includeOutput: true, initiator: 'jenny' });
      assert.equal(result.isError, false);
      assert.equal(result.metadata.status, 'passed');
      assert.equal(result.metadata.action, 'gate');
      // The on-failure mode rides the verdict so one round trip answers both.
      assert.equal(result.metadata.gate_on_failure, 'retry');
      assert.equal('attempt' in result.metadata, false, 'no attempt was given, none is reported');
    });

    test('the harness-only attempt travels to the service and back on the verdict', async () => {
      const service = stubService({
        listConfigs: { configs: [{ id: 'unit', command: 'npm test', gate: true, gateOnFailure: 'retry' }] },
        run: { configId: 'unit', runId: 'g3', status: 'failed', failedCount: 1, passedCount: 9 },
      });
      const result = await createVerifyTool().execute({ action: 'gate', attempt: 2 }, {
        workspaceTestRunnerService: service,
      });
      const runCall = service.calls.find(([name]) => name === 'run');
      assert.deepEqual(runCall[1], { configId: 'unit', includeOutput: true, initiator: 'jenny', gateAttempt: 2 });
      assert.equal(result.metadata.attempt, 2, 'the timeline row can say "attempt 2" without a second call');
      // The attempt is deliberately NOT in the model-facing schema.
      assert.equal('attempt' in createVerifyTool().parameters.properties, false);
    });

    test('a junk attempt is dropped rather than recorded', async () => {
      const service = stubService({
        listConfigs: { configs: [{ id: 'unit', command: 'npm test', gate: true }] },
      });
      for (const attempt of [0, -1, 1.5, 'two', 500]) {
        service.calls.length = 0;
        await createVerifyTool().execute({ action: 'gate', attempt }, { workspaceTestRunnerService: service });
        const runCall = service.calls.find(([name]) => name === 'run');
        assert.equal('gateAttempt' in runCall[1], false, `attempt ${attempt} must not reach the service`);
      }
    });

    test('a skipped gate still carries the attempt so the panel can label it', async () => {
      const service = stubService({
        listConfigs: { configs: [{ id: 'unit', command: 'npm test', gate: true, gateOnFailure: 'retry' }] },
        run: envelope(WORKSPACE_TEST_RUNNER_ERROR_CODES.ALREADY_RUNNING),
      });
      const result = await createVerifyTool().execute({ action: 'gate', attempt: 1 }, {
        workspaceTestRunnerService: service,
      });
      assert.equal(result.isError, false);
      assert.equal(result.metadata.status, 'skipped');
      assert.equal(result.metadata.attempt, 1);
      assert.equal(result.metadata.gate_on_failure, 'retry');
    });

    test('a failing gate carries the mode and the failing output', async () => {
      const service = stubService({
        listConfigs: {
          configs: [{ id: 'unit', command: 'npm test', gate: true, gateOnFailure: 'report' }],
        },
        run: {
          configId: 'unit', runId: 'g2', status: 'failed', exitCode: 1,
          failedCount: 2, stdoutTail: 'FAIL widget.test.js',
        },
      });
      const result = await createVerifyTool().execute({ action: 'gate' }, {
        workspaceTestRunnerService: service,
      });

      assert.equal(result.isError, false);
      assert.equal(result.metadata.status, 'failed');
      assert.equal(result.metadata.gate_on_failure, 'report');
      assert.match(result.content, /FAIL widget\.test\.js/);
    });

    test('no designated gate is a non-error skip, never a refusal', async () => {
      const service = stubService({
        listConfigs: { configs: [{ id: 'unit', command: 'npm test' }] },
      });
      const result = await createVerifyTool().execute({ action: 'gate' }, {
        workspaceTestRunnerService: service,
      });

      assert.equal(result.isError, false);
      assert.equal(result.metadata.status, 'skipped');
      assert.equal(result.metadata.reason, 'no_gate_configured');
      assert.equal(service.calls.some(([name]) => name === 'run'), false, 'nothing ran');
    });

    test('an unreadable config store is a non-error skip', async () => {
      const service = stubService({
        listConfigs: envelope(WORKSPACE_TEST_RUNNER_ERROR_CODES.ROOT_MISSING),
      });
      const result = await createVerifyTool().execute({ action: 'gate' }, {
        workspaceTestRunnerService: service,
      });

      assert.equal(result.isError, false);
      assert.equal(result.metadata.status, 'skipped');
      assert.equal(result.metadata.reason, 'gate_unavailable');
    });

    test('list marks the designated gate and its mode', async () => {
      const service = stubService({
        listConfigs: {
          configs: [
            { id: 'unit', command: 'npm test', gate: true, gateOnFailure: 'report' },
            { id: 'lint', command: 'npm run lint' },
          ],
        },
      });
      const result = await createVerifyTool().execute({ action: 'list' }, {
        workspaceTestRunnerService: service,
      });

      assert.equal(result.metadata.configs[0].gate, true);
      assert.equal(result.metadata.configs[0].gate_on_failure, 'report');
      assert.equal(result.metadata.configs[1].gate, false);
      assert.equal(result.metadata.configs[1].gate_on_failure, '');
      assert.match(result.content, /verification gate/);
    });
  });

  describe('the turn always survives verification', () => {
    test('a held single-run lock is skipped, not an error', async () => {
      const service = stubService({
        run: envelope(WORKSPACE_TEST_RUNNER_ERROR_CODES.ALREADY_RUNNING),
      });
      const result = await createVerifyTool().execute({ action: 'run', config_id: 'unit' }, {
        workspaceTestRunnerService: service,
      });

      assert.equal(result.isError, false);
      assert.equal(result.metadata.status, 'skipped');
      assert.equal(result.metadata.reason, 'already_running');
      assert.match(result.content, /unverified/);
    });

    test('a runner rejection is skipped, not an error', async () => {
      const service = stubService({ runThrows: new Error('spawn ENOENT') });
      const result = await createVerifyTool().execute({ action: 'run', config_id: 'unit' }, {
        workspaceTestRunnerService: service,
      });

      assert.equal(result.isError, false);
      assert.equal(result.metadata.status, 'skipped');
      assert.equal(result.metadata.reason, 'run_threw');
      assert.match(result.content, /unverified/);
    });
  });

  describe('refusals the model should correct', () => {
    test('an unknown config id points at list', async () => {
      const service = stubService({
        run: envelope(WORKSPACE_TEST_RUNNER_ERROR_CODES.CONFIG_NOT_FOUND),
      });
      const result = await createVerifyTool().execute({ action: 'run', config_id: 'nope' }, {
        workspaceTestRunnerService: service,
      });

      assert.equal(result.isError, true);
      assert.equal(result.metadata.reason, 'config_not_found');
      assert.match(result.content, /"action":"list"/);
    });

    test('a missing workspace root is reported, not crashed on', async () => {
      const service = stubService({
        listConfigs: envelope(WORKSPACE_TEST_RUNNER_ERROR_CODES.ROOT_MISSING),
      });
      const result = await createVerifyTool().execute({ action: 'list' }, {
        workspaceTestRunnerService: service,
      });

      assert.equal(result.isError, true);
      assert.equal(result.metadata.reason, 'workspace_root_missing');
    });

    test('run without a config id refuses before touching the service', async () => {
      const service = stubService();
      const result = await createVerifyTool().execute({ action: 'run' }, {
        workspaceTestRunnerService: service,
      });

      assert.equal(result.isError, true);
      assert.equal(result.metadata.reason, 'missing_config_id');
      assert.equal(service.calls.length, 0);
    });

    test('an unknown action refuses', async () => {
      const result = await createVerifyTool().execute({ action: 'delete' }, {
        workspaceTestRunnerService: stubService(),
      });

      assert.equal(result.isError, true);
      assert.equal(result.metadata.reason, 'invalid_action');
    });

    test('an absent service is reported, not thrown', async () => {
      const result = await createVerifyTool().execute({ action: 'list' }, {});

      assert.equal(result.isError, true);
      assert.equal(result.metadata.reason, 'service_unavailable');
    });
  });
});
