'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { SessionExecutionAuthority } = require('../../services/backend/session-execution-authority');
const { SessionRuntimeChatAdapter } = require('../../services/backend/session-runtime-chat-adapter');
const { RuntimeLaneAdmission } = require('../../services/session-runtime/lanes');
const { ResourceBroker } = require('../../services/session-runtime/resource-broker');
const { PhysicalPathResolver } = require('../../services/session-runtime/physical-paths');
const { stableJson } = require('../../services/session-runtime/contracts');

const AUTHORITY = Object.freeze({
  project_id: 'project_general', root_path: null, root_id: null,
  root_revision: 0, device_id: null, inode: null,
});

function createAdapterHarness(t, { registerTeardown = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-chat-adapter-'));
  const sessionStore = new ElectronSessionStore(path.join(root, 'sessions.json'), {
    writeDebounceMs: 0,
  });
  const sessionId = sessionStore.createSession({ title: 'Runtime adapter' }).id;
  let authoritySequence = 0;
  const projectAuthority = {
    captureSession: id => {
      assert.equal(id, sessionId);
      return AUTHORITY;
    },
    requireCurrent: authority => {
      assert.deepEqual(authority, AUTHORITY);
      return authority;
    },
  };
  const sessionExecutionAuthority = new SessionExecutionAuthority({
    projectAuthority,
    permissionStore: { getSnapshot: () => ({ version: 3, legacy_policies: {}, rules: [] }) },
    knowledgeService: {
      getSidecarConfig: () => ({ tools_knowledge_enabled: false, knowledge_roots: [] }),
    },
    resolveProjectWorkspaceServices: () => ({}),
    randomUUID: () => `authority-${++authoritySequence}`,
  });
  const service = {
    activeStreams: new Map(),
    configService: { getState: () => ({}) },
    currentEngineType: 'mock',
    featureFlags: { vision_unified_turn: true },
    projectAuthority,
    sessionExecutionAuthority,
    sessionStore,
  };
  const lanes = new RuntimeLaneAdmission();
  const adapter = new SessionRuntimeChatAdapter(service, {
    lanes,
    resourceBroker: new ResourceBroker(),
    pathResolver: new PhysicalPathResolver(),
  });
  const disposeHarness = async () => {
    const runtime = service.sessionRuntime;
    runtime?.scheduler?.beginClosing();
    await Promise.allSettled(runtime?.scheduler?.cleanupPromises?.() || []);
    sessionStore.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  };
  if (registerTeardown) t.after(disposeHarness);
  return { adapter, disposeHarness, lanes, service, sessionId };
}

function request(sessionId, overrides = {}) {
  return {
    sessionId,
    prompt: 'hello',
    visiblePrompt: 'hello',
    traceId: 'trace-1',
    attachments: [],
    runtimePreferredModel: 'fixture-model',
    runtimePreferredEngineType: 'mock',
    normalizedInteractiveResponse: null,
    normalizedPreferences: { preferred_model: 'fixture-model', plan_mode: false },
    toolPreferences: null,
    ...overrides,
  };
}

function digest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function continuationFixture(work, checkpointId, userMessageId) {
  const ref = (refId, revision = 1) => ({
    ref_id: refId,
    revision,
    sha256: 'a'.repeat(64),
  });
  return {
    schema_version: 1,
    kind: 'before_tool_dispatch',
    identity: {
      checkpoint_id: checkpointId,
      work_id: work.work_id,
      turn_id: work.turn_id,
      request_id: work.attempt.stream_id,
      trace_id: null,
      session_id: work.session_id,
    },
    source_attempt: { ...work.attempt },
    authority: {
      project_id: work.project_id,
      root_id: work.authority.root_id,
      root_revision: work.authority.root_revision,
      sha256: digest(work.authority),
    },
    route: {
      route_id: `route_${digest(work.input.route)}`,
      route_revision: work.input.route.configuration_revision,
      sha256: digest(work.input.route),
    },
    canonical_refs: {
      request_ref: { ref_id: 'request_ref_1', revision: 1, sha256: work.submission_hash },
      history_ref: ref('history_ref_1'),
      message_ref: ref('message_ref_1'),
      turn_ref: { ...ref('turn_ref_1'), stream_id: work.attempt.stream_id, through_seq: 0 },
      tool_batch_ref: ref('tool_batch_ref_1'),
    },
    position: {
      completed_iterations: 1,
      remaining_iterations: 3,
      current_iteration: 1,
      tool_call_limit: 8,
      tool_calls_consumed: 1,
      active_budget_ms_remaining: 5000,
      ordered_call_ids: ['call_1'],
    },
    pending_call: {
      call_id: 'call_1',
      tool_id: 'read_file',
      effective_args_sha256: 'b'.repeat(64),
      frozen_input_ref: ref('frozen_input_ref_1'),
    },
    wait: {
      kind: 'resource',
      resource_class: 'filesystem',
      dependency_id: null,
      operation_id: 'call_1',
    },
    eligibility: {
      pending_call_index: 0,
      prior_outcome_count: 0,
      emitted_tool_execution_count: 0,
      preview_count: 0,
      approval_pending: false,
      mutation_started: false,
    },
    _userMessageId: userMessageId,
  };
}

async function waitFor(check, message) {
  // At least 40 turns of the event loop, and up to two seconds when the host is loaded.
  const deadline = Date.now() + 2000;
  for (let index = 0; index < 40 || Date.now() < deadline; index += 1) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(message);
}

module.exports = {
  AUTHORITY,
  continuationFixture,
  createAdapterHarness,
  digest,
  request,
  waitFor,
};
