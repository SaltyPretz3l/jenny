'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { RuntimeContinuationCoordinator } = require('../../services/backend/runtime-continuation-coordinator');
const { CheckpointStore } = require('../../services/session-runtime/checkpoint-store');
const { encodeContinuation } = require('../../services/session-runtime/continuation-contracts');
const { buildAdmittedContinuationContext } = require('../../services/session-runtime/continuation-context');
const { stableJson } = require('../../services/session-runtime/contracts');
const { captureRuntimeRoute } = require('../../services/session-runtime/lanes');

const SOURCE_A = Object.freeze({
  attempt_id: 'attempt_a', stream_id: 'stream_a', incarnation: 'incarnation_a',
  authority_revision: 'authority_a',
});
const SOURCE_B = Object.freeze({
  attempt_id: 'attempt_b', stream_id: 'stream_b', incarnation: 'incarnation_b',
  authority_revision: 'authority_b',
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactBytes(value) {
  return Buffer.from(stableJson(value), 'utf8');
}

function buildCheckpointFixture(t, kind = 'resource') {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-python-resume-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const workspace = path.join(profile, 'workspace');
  fs.mkdirSync(workspace);
  const store = new ElectronSessionStore(path.join(profile, 'sessions.json'));
  store.createSessionWithId('session_1', { title: 'Python resume integration' });
  const sessionIncarnation = store.getSession('session_1').session_incarnation;
  store.updateSession('session_1', { turn_generation: 1 });
  store.setActiveTurn('session_1', {
    request_id: SOURCE_A.stream_id, stream_id: SOURCE_A.stream_id, turn_id: 'turn_1',
    session_incarnation: sessionIncarnation, generation: 1, user_message_id: 'message:user:1',
    started_at: '2026-09-10T12:00:00.000Z', last_event_at: '2026-09-10T12:00:01.000Z',
    status: 'streaming',
  });
  store.appendMessage('session_1', {
    id: 'message:user:1', turn_id: 'turn_1', role: 'user', kind: 'message',
    content: 'Read the saved metric.', timestamp: '2026-09-10T12:00:00.000Z',
  });

  const authority = {
    project_id: 'project_1', root_path: workspace, root_id: 'root_1', root_revision: 4,
    device_id: null, inode: null,
  };
  const route = captureRuntimeRoute({
    engine_type: 'ollama', provider_id: 'ollama', configuration_revision: 'config:1',
    resource_class: 'local', requires_gpu: false,
  });
  const work = {
    work_id: 'work_1', turn_id: 'turn_1', session_id: 'session_1', project_id: 'project_1',
    status: 'running', revision: 3, submission_hash: 'a'.repeat(64), attempt: SOURCE_A,
    authority, input: { route },
  };
  const context = buildAdmittedContinuationContext({
    work, route, attempt: SOURCE_A,
    executionContext: { ...authority, authority_revision: SOURCE_A.authority_revision },
  });
  const calls = [{
    call_id: 'call_1', tool_id: 'read_metric', arguments: { value: 7 },
    idempotency_key: 'saved-call-1', coerced: false, malformed_arguments: false,
    argument_repairs: [],
  }];
  const frozenInput = {
    call_id: 'call_1', tool_name: 'read_metric', visible_tool_arguments: { value: 7 },
    effective_tool_arguments: { value: 7 }, injected_arg_keys: [],
    effective_args_fingerprint: sha256(stableJson({ value: 7 })),
    execution_context_payload: {
      session_id: 'session_1', logical_turn_id: 'turn_1',
      authority_revision: SOURCE_A.authority_revision,
      project_id: authority.project_id, root_id: authority.root_id,
      root_revision: authority.root_revision,
    },
  };
  const toolBatchBytes = exactBytes({ calls });
  const frozenInputBytes = exactBytes(frozenInput);
  const proposal = {
    checkpoint_id: `checkpoint_${'c'.repeat(64)}`,
    source_attempt: SOURCE_A, stream_id: SOURCE_A.stream_id,
    through_seq: 0, tool_calls: calls, frozen_input: frozenInput,
    tool_batch_bytes: toolBatchBytes.toString('base64'),
    tool_batch_sha256: sha256(toolBatchBytes),
    frozen_input_bytes: frozenInputBytes.toString('base64'),
    frozen_input_sha256: sha256(frozenInputBytes),
    history_selector: {
      schema_version: 1, history_scope: 'session',
      canonical_cutoff: {
        boundary_message_id: null, boundary_message_count: 0, sha256: sha256('[]'),
      },
      compaction_ref: null,
    },
  };
  const conversationStore = store.conversationStore;
  const checkpointStore = new CheckpointStore(path.join(profile, 'checkpoints'), {
    validateCanonical: (value, suppliedWork) => (
      conversationStore.resolvePendingContinuation(value, suppliedWork)
    ),
  });
  const coordinator = new RuntimeContinuationCoordinator({
    conversationStore, checkpointStore, context,
    getCurrentWork: () => work, assertCurrent: () => true,
  });
  const checkpointRef = coordinator.publish({
    proposal,
    position: {
      completed_iterations: 1, remaining_iterations: 3, current_iteration: 1,
      tool_call_limit: 6, tool_calls_consumed: 1, active_budget_ms_remaining: 5_000,
      ordered_call_ids: ['call_1'],
    },
    wait: {
      kind, resource_class: kind === 'resource' ? 'tool_operations' : null, dependency_id: null,
      operation_id: 'call_1',
    },
    eligibility: {
      pending_call_index: 0, prior_outcome_count: 0, emitted_tool_execution_count: 0,
      preview_count: 0, approval_pending: false, mutation_started: false,
    },
  });
  const checkpoint = checkpointStore.read(checkpointRef, work);
  const hydrated = conversationStore.resolvePendingContinuation(checkpoint, work, {
    includePayload: true,
  });
  assert.equal(hydrated.valid, true);
  return {
    legacy_quota_disabled: true,
    runtime_continuation_resume: {
      checkpoint_body: encodeContinuation(checkpoint).body.toString('base64'),
      checkpoint_sha256: checkpointRef.sha256,
      checkpoint_ref: checkpointRef,
      resolved_source_attempt: SOURCE_A,
      tool_batch_bytes: hydrated.toolBatchBytes,
      tool_batch_sha256: checkpoint.canonical_refs.tool_batch_ref.sha256,
      frozen_input_bytes: hydrated.frozenInputBytes,
      frozen_input_sha256: checkpoint.pending_call.frozen_input_ref.sha256,
    },
    fresh_request: {
      request_id: SOURCE_B.stream_id, session_id: 'session_1', logical_turn_id: 'turn_1',
      messages: hydrated.canonicalHistoryMessages.concat(hydrated.turnMessages),
      canonical_session_messages: hydrated.canonicalHistoryMessages.concat(hydrated.turnMessages),
      execution_context: {
        schema_version: 1, authority_revision: SOURCE_B.authority_revision,
        project_id: authority.project_id, root_path: authority.root_path,
        root_id: authority.root_id, root_revision: authority.root_revision,
        device_id: null, inode: null,
        tool_policy_snapshot: { version: 1, legacy_policies: {} }, knowledge_roots: [],
      },
      continuation_context: {
        schema_version: 1, work_id: work.work_id, turn_id: work.turn_id,
        source_attempt: SOURCE_B, authority: context.authority, route: context.route,
      },
    },
  };
}

for (const kind of ['resource', 'explicit_pause']) test(`${kind}: actual Python chat resume dispatches the persisted read before generation`, (t) => {
  const input = buildCheckpointFixture(t, kind);
  const repoRoot = path.resolve(__dirname, '..', '..');
  const python = process.platform === 'win32'
    ? path.join(repoRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(repoRoot, '.venv', 'bin', 'python');
  assert.equal(fs.existsSync(python), true,
    `worktree-local Python interpreter is missing: ${python}`);
  const helper = path.join(repoRoot, 'tests', 'helpers', 'session-runtime-python-resume.py');
  const run = spawnSync(python, [helper], {
    cwd: repoRoot, input: JSON.stringify(input), encoding: 'utf8',
    timeout: 90_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(run.error, undefined, run.error?.message);
  assert.equal(run.status, 0, `Python resume helper failed:\n${run.stderr}\n${run.stdout}`);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(result.events, [
    ['tool', 'read_metric', { value: 7 }], ['budget'], ['generate'],
  ]);
  assert.deepEqual(result.executions, [['read_metric', { value: 7 }]]);
  assert.equal(result.engine_calls, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.response, 'Resumed after the saved read.');
  assert.equal(result.operation_checks, 1);
});
