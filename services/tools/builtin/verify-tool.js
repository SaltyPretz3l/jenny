'use strict';

/* services/tools/builtin/verify-tool.js — `verify`
 *
 * Model-facing access to the Workspace IDE Test Runner. The model can LIST the
 * user's own named test configurations and RUN one by id. It can never author a
 * command: there is no argument passthrough and no command composition, so the
 * executed string is always one the user wrote in their own IDE. That bounded
 * action — not an approval prompt — is the whole safety argument for this tool's
 * `auto` policy default (same shape as `home`).
 *
 * Everything else is delegated: WorkspaceTestRunnerService owns the single-run
 * lock, the cwd-inside-root check, the timeout floor, history, and summary
 * parsing. This module only shapes the model-facing result. It never touches
 * child_process, and it never relaxes a service refusal into a retry.
 *
 * A service refusal is reported as a clean, non-error outcome wherever the turn
 * should simply continue unverified (notably ALREADY_RUNNING, i.e. the user's own
 * run holds the lock). The verification gate must never be able to strand a turn.
 *
 * `action: "gate"` runs whichever configuration the user designated as the
 * verification gate. It exists so the sidecar's turn-finalization hook can ask
 * one question in one bridge round trip -- "run the gate, and tell me what the
 * user wants done on failure" -- without the gate designation having to be
 * threaded through the managed-sidecar config. A workspace with no designated
 * gate answers `no_gate_configured`, which is a non-error: the turn proceeds.
 *
 * Attribution: every run this tool starts is recorded as `initiator: 'jenny'`
 * so the Test Runner panel can say who ran what. The gate's 1-based `attempt`
 * rides along as a HARNESS-ONLY argument: the sidecar's finalization hook sets
 * it, it is deliberately absent from the model-facing schema, and a value the
 * model might invent only ever mislabels a panel row.
 */

const {
  TOOL_ERROR_CODES,
  WORKSPACE_TEST_RUNNER_ERROR_CODES,
} = require('../../backend/error-codes');

// Failure lines are what the model actually needs; a passing parade is noise.
// The sidecar's distill filters do the real reduction downstream — this is the
// transport bound so a pathological tail can never dominate the tool result.
const MAX_OUTPUT_CHARS = 4000;
const MAX_CONFIG_ROWS = 50;
const MAX_GATE_ATTEMPT = 99;
const RUN_INITIATOR = 'jenny';

function readAttempt(input) {
  const attempt = Number(input && input.attempt);
  return Number.isInteger(attempt) && attempt > 0 && attempt <= MAX_GATE_ATTEMPT ? attempt : 0;
}

function failure({ reason, errorCode, message, summary }) {
  return {
    content: message,
    summary,
    isError: true,
    errorCode,
    metadata: {
      result_kind: 'verify',
      status: 'failed',
      reason,
    },
  };
}

/**
 * A refusal the turn should survive: the model is told what happened and moves
 * on. Deliberately `isError: false` — see the module header.
 */
function skipped({ reason, message, summary, extra = {} }) {
  return {
    content: message,
    summary,
    isError: false,
    metadata: {
      result_kind: 'verify',
      status: 'skipped',
      reason,
      ...extra,
    },
  };
}

function envelopeCode(outcome) {
  return outcome && outcome.error && typeof outcome.error.code === 'string'
    ? outcome.error.code
    : '';
}

function envelopeMessage(outcome) {
  return outcome && outcome.error && typeof outcome.error.message === 'string'
    ? outcome.error.message
    : '';
}

function tail(value, limit = MAX_OUTPUT_CHARS) {
  const text = String(value == null ? '' : value);
  if (text.length <= limit) {
    return text;
  }
  return `…[earlier output omitted]\n${text.slice(text.length - limit)}`;
}

function lastRunFor(state, configId) {
  const byConfig = state && state.history && state.history.byConfig;
  const records = byConfig && Array.isArray(byConfig[configId]) ? byConfig[configId] : [];
  return records.length ? records[records.length - 1] : null;
}

function describeCounts(record) {
  if (!record) {
    return '';
  }
  const passed = Number.isFinite(Number(record.passedCount)) ? Number(record.passedCount) : null;
  const failed = Number.isFinite(Number(record.failedCount)) ? Number(record.failedCount) : null;
  if (passed === null && failed === null) {
    return '';
  }
  const parts = [];
  if (failed !== null) parts.push(`${failed} failed`);
  if (passed !== null) parts.push(`${passed} passed`);
  return parts.join(', ');
}

function createVerifyTool() {
  function listConfigurations(service) {
    const outcome = service.listConfigs();
    const code = envelopeCode(outcome);
    if (code) {
      if (code === WORKSPACE_TEST_RUNNER_ERROR_CODES.ROOT_MISSING) {
        return failure({
          reason: 'workspace_root_missing',
          errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
          message: 'No workspace root is configured, so there are no test configurations to run.',
          summary: 'No workspace root',
        });
      }
      return failure({
        reason: 'list_failed',
        errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
        message: envelopeMessage(outcome) || 'Could not read the test configurations.',
        summary: 'Could not list test configurations',
      });
    }

    const configs = Array.isArray(outcome.configs) ? outcome.configs.slice(0, MAX_CONFIG_ROWS) : [];
    if (!configs.length) {
      return {
        content: 'No test configurations exist in this workspace yet. The user authors them in the '
          + 'Workspace IDE bottom panel, under Test Runner; you cannot create one.',
        summary: 'No test configurations',
        isError: false,
        metadata: { result_kind: 'verify', status: 'ok', action: 'list', configs: [] },
      };
    }

    const state = typeof service.getState === 'function' ? service.getState() : null;
    const rows = configs.map((config) => {
      const last = lastRunFor(state, config.id);
      return {
        id: config.id,
        label: config.label || config.id,
        command: config.command || '',
        last_status: last ? String(last.status || '') : 'none',
        gate: config.gate === true,
        gate_on_failure: config.gate === true ? String(config.gateOnFailure || '') : '',
      };
    });
    const lines = rows.map((row) => {
      const status = row.last_status === 'none' ? 'never run' : row.last_status;
      const gate = row.gate ? ' — verification gate' : '';
      return `- ${row.id} (${row.label}) — ${row.command} — last: ${status}${gate}`;
    });
    return {
      content: `Test configurations in this workspace:\n${lines.join('\n')}\n\n`
        + 'Run one with verify {"action":"run","config_id":"<id>"}.',
      summary: `${rows.length} test configuration(s)`,
      isError: false,
      metadata: { result_kind: 'verify', status: 'ok', action: 'list', configs: rows },
    };
  }

  async function runConfiguration(service, configId, attempt = 0) {
    const outcome = await service.run({
      configId,
      includeOutput: true,
      initiator: RUN_INITIATOR,
      ...(attempt ? { gateAttempt: attempt } : {}),
    });
    const code = envelopeCode(outcome);

    if (code === WORKSPACE_TEST_RUNNER_ERROR_CODES.ALREADY_RUNNING) {
      // The user's own run owns the lock. Not an error: report and let the turn
      // finish honestly as unverified.
      return skipped({
        reason: 'already_running',
        message: 'A test run is already in progress, so this verification was skipped. '
          + 'Report the change as unverified rather than claiming the tests passed.',
        summary: 'Skipped — a run was already in progress',
        extra: { action: 'run', config_id: configId, ...(attempt ? { attempt } : {}) },
      });
    }
    if (code === WORKSPACE_TEST_RUNNER_ERROR_CODES.CONFIG_NOT_FOUND) {
      return failure({
        reason: 'config_not_found',
        errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
        message: `There is no test configuration with id "${configId}". `
          + 'Call verify {"action":"list"} to see the available ids.',
        summary: 'Unknown test configuration',
      });
    }
    if (code) {
      return failure({
        reason: 'run_refused',
        errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
        message: envelopeMessage(outcome) || 'The test run could not be started.',
        summary: 'Test run refused',
      });
    }

    const status = String(outcome.status || 'error');
    const counts = describeCounts(outcome);
    const duration = Number.isFinite(Number(outcome.durationMs))
      ? `${(Number(outcome.durationMs) / 1000).toFixed(1)}s`
      : 'unknown duration';
    const passed = status === 'passed';
    const headline = passed
      ? `Verification passed: ${configId}${counts ? ` — ${counts}` : ''} (${duration}).`
      : `Verification did NOT pass: ${configId} — status ${status}`
        + `${counts ? `, ${counts}` : ''} (${duration}).`;

    const sections = [headline];
    if (!passed) {
      const stderr = tail(outcome.stderrTail);
      const stdout = tail(outcome.stdoutTail);
      if (stderr.trim()) {
        sections.push(`stderr:\n${stderr}`);
      }
      if (stdout.trim()) {
        sections.push(`stdout:\n${stdout}`);
      }
    }

    return {
      content: sections.join('\n\n'),
      summary: passed
        ? `Verification passed: ${configId}`
        : `Verification failed: ${configId} (${status})`,
      isError: false,
      metadata: {
        result_kind: 'verify',
        status: passed ? 'passed' : 'failed',
        action: 'run',
        config_id: configId,
        run_id: outcome.runId || null,
        run_status: status,
        exit_code: outcome.exitCode ?? null,
        duration_ms: outcome.durationMs ?? null,
        passed_count: outcome.passedCount ?? null,
        failed_count: outcome.failedCount ?? null,
        error_code: outcome.errorCode || null,
        ...(attempt ? { attempt } : {}),
      },
    };
  }

  async function runGate(service, attempt) {
    const outcome = service.listConfigs();
    const code = envelopeCode(outcome);
    if (code) {
      // Cannot even read the configurations: report and let the turn continue.
      return skipped({
        reason: 'gate_unavailable',
        message: 'The verification gate could not be read, so nothing was verified. '
          + 'Report the change as unverified.',
        summary: 'Verification gate unavailable',
        extra: { action: 'gate' },
      });
    }
    const configs = Array.isArray(outcome.configs) ? outcome.configs : [];
    const gate = configs.find((config) => config && config.gate === true) || null;
    if (!gate) {
      return skipped({
        reason: 'no_gate_configured',
        message: 'No test configuration is designated as the verification gate in this '
          + 'workspace, so nothing was verified. The user designates one in the '
          + 'Workspace IDE bottom panel, under Test Runner.',
        summary: 'No verification gate configured',
        extra: { action: 'gate' },
      });
    }
    const result = await runConfiguration(service, gate.id, attempt);
    // The on-failure mode travels with the verdict so one round trip answers both
    // "did it pass?" and "what does the user want done about it?".
    result.metadata = {
      ...result.metadata,
      action: 'gate',
      gate_on_failure: String(gate.gateOnFailure || ''),
    };
    return result;
  }

  return {
    name: 'verify',
    description: 'Run one of the user\'s own saved test configurations and report the result. '
      + 'action "list" shows the available configurations and their last status; action "run" '
      + 'executes one by config_id and returns pass/fail counts plus failing output. You cannot '
      + 'create or modify a configuration, and you cannot choose the command — only which saved '
      + 'configuration to run. Prefer this over run_command for running the project\'s tests.',
    category: 'builtin',
    readOnly: false,
    workspaceRequired: true,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'run', 'gate'],
          description: '"list" to see saved test configurations, "run" to execute one by '
            + 'config_id, "gate" to run whichever one the user designated as the '
            + 'verification gate.',
        },
        config_id: {
          type: 'string',
          description: 'Required for action "run": the id of a saved test configuration.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    summarize(input) {
      const action = typeof input?.action === 'string' ? input.action.trim() : '';
      if (action === 'run') {
        const configId = typeof input?.config_id === 'string' ? input.config_id.trim() : '';
        return `Verify ${configId || 'tests'}`.slice(0, 500);
      }
      if (action === 'gate') {
        return 'Run the verification gate';
      }
      return 'List test configurations';
    },

    async execute(input, context) {
      const service = context && context.workspaceTestRunnerService;
      if (!service || typeof service.listConfigs !== 'function' || typeof service.run !== 'function') {
        return failure({
          reason: 'service_unavailable',
          errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
          message: 'The workspace test runner is unavailable.',
          summary: 'Test runner unavailable',
        });
      }

      const action = typeof input?.action === 'string' ? input.action.trim() : '';
      if (action === 'list') {
        return listConfigurations(service);
      }
      if (action === 'gate') {
        return runGate(service, readAttempt(input));
      }
      if (action !== 'run') {
        return failure({
          reason: 'invalid_action',
          errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
          message: 'verify requires action "list", "run", or "gate".',
          summary: 'Invalid verify action',
        });
      }

      const configId = typeof input?.config_id === 'string' ? input.config_id.trim() : '';
      if (!configId) {
        return failure({
          reason: 'missing_config_id',
          errorCode: TOOL_ERROR_CODES.EXECUTION_FAILED,
          message: 'verify {"action":"run"} requires config_id. '
            + 'Call verify {"action":"list"} first to see the available ids.',
          summary: 'Missing config_id',
        });
      }

      try {
        return await runConfiguration(service, configId);
      } catch (error) {
        // A runner rejection must not strand the turn: report it and let the
        // model finish with an honest "unverified".
        return skipped({
          reason: 'run_threw',
          message: `The test run for "${configId}" failed to complete: `
            + `${String(error?.message || error).slice(0, 300)}. `
            + 'Report the change as unverified.',
          summary: 'Test run did not complete',
          extra: { action: 'run', config_id: configId },
        });
      }
    },
  };
}

const verifyTool = createVerifyTool();

module.exports = Object.assign(verifyTool, {
  createVerifyTool,
  MAX_OUTPUT_CHARS,
});
