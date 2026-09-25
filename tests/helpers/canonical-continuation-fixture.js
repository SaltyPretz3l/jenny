'use strict';
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { captureRuntimeRoute } = require('../../services/session-runtime/lanes');

const attempt = Object.freeze({
  attempt_id: 'attempt_1',
  stream_id: 'stream_1',
  incarnation: 'runtime_incarnation_1',
  authority_revision: 'authority_revision_1',
});
const USER_MESSAGE_ID = `message:user:${'u'.repeat(140)}`;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function setup(t, { includeSafePrefix = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-canonical-continuation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'sessions.json');
  const store = new ElectronSessionStore(file);
  const created = store.createSessionWithId('session_1', { title: 'Continuation' });
  assert.ok(created);
  const incarnation = store.getSession('session_1').session_incarnation;
  store.updateSession('session_1', { turn_generation: 1 });
  store.setActiveTurn('session_1', {
    request_id: 'stream_1', stream_id: 'stream_1', turn_id: 'turn_1',
    session_incarnation: incarnation, generation: 1, user_message_id: USER_MESSAGE_ID,
    started_at: '2026-09-10T12:00:00.000Z', last_event_at: '2026-09-10T12:00:01.000Z',
    status: 'streaming',
  });
  store.appendMessage('session_1', {
    id: USER_MESSAGE_ID, turn_id: 'turn_1', role: 'user', kind: 'message',
    content: 'Inspect the workspace.', timestamp: '2026-09-10T12:00:00.000Z',
  });
  if (includeSafePrefix) {
    store.appendMessage('session_1', {
      id: 'assistant_stream_1', turn_id: 'turn_1', role: 'assistant', kind: 'message',
      content: 'I will inspect both files.', parent_stream_id: 'stream_1',
      timestamp: '2026-09-10T12:00:02.000Z', finalizedAt: '2026-09-10T12:00:02.000Z',
    });
    for (const [index, kind] of ['reasoning_phase', 'assistant_text_segment'].entries()) {
      store.appendTurnEvents('session_1', [{
        event_id: `stream_1:canonical:${index + 1}`, turn_id: 'turn_1',
        kind, status: 'completed', primary_message_id: 'assistant_stream_1',
        source_message_ids: ['assistant_stream_1'], tool_call_id: '',
        payload: { canonical_seq: index + 1,
          canonical_event_type: kind === 'reasoning_phase' ? 'reasoning_completed' : 'assistant_text_completed' },
      }], { durable: true });
    }
  }
  return { root, file, store, incarnation };
}

function toolCalls() {
  return [
    { call_id: 'call_1', tool_id: 'read_file',
      arguments: { label: 'Ω', path: 'alpha.txt', ratio: 1, threshold: 1e-7 },
      idempotency_key: '', coerced: false, malformed_arguments: false, argument_repairs: [] },
    { call_id: 'call_2', tool_id: 'read_file', arguments: { path: 'beta.txt' },
      idempotency_key: 'idem_2', coerced: false, malformed_arguments: false, argument_repairs: [] },
  ];
}

function work() {
  const route = captureRuntimeRoute({ engine_type: 'chatgpt', provider_id: 'chatgpt',
    configuration_revision: 'config:1', resource_class: 'cloud', requires_gpu: false });
  const authority = { project_id: 'general', root_path: null, root_id: null,
    root_revision: 0, device_id: null, inode: null };
  return {
    work_id: 'work_1', turn_id: 'turn_1', session_id: 'session_1', project_id: 'general',
    status: 'running', revision: 3, submission_hash: 'a'.repeat(64), attempt,
    authority, input: { route },
  };
}

function frozenInput() {
  const effective = {
    label: 'Ω', path: 'alpha.txt', ratio: 1, threshold: 1e-7,
    _jenny_session_id: 'session_1',
    _jenny_turn_id: 'turn_1', _jenny_tool_call_id: 'call_1',
  };
  return {
    call_id: 'call_1', tool_name: 'read_file',
    visible_tool_arguments: { label: 'Ω', path: 'alpha.txt', ratio: 1, threshold: 1e-7 },
    effective_tool_arguments: effective,
    injected_arg_keys: ['_jenny_session_id', '_jenny_tool_call_id', '_jenny_turn_id'],
    effective_args_fingerprint: hash(effective),
    execution_context_payload: {
      session_id: 'session_1', authority_revision: 'authority_revision_1',
      logical_turn_id: 'turn_1',
      project_id: 'general', root_id: null, root_revision: 0,
    },
  };
}

function frozenInputBytes() {
  const exactPythonJson = stableJson(frozenInput())
    .replace('"ratio":1,', '"ratio":1.0,')
    .replace(/Ω/gu, '\\u03a9');
  return Buffer.from(exactPythonJson, 'utf8').toString('base64');
}

function frozenInputSha256() {
  return createHash('sha256').update(Buffer.from(frozenInputBytes(), 'base64')).digest('hex');
}

function toolBatchBytes() {
  const exactPythonJson = stableJson({ calls: toolCalls() })
    .replace('"ratio":1,', '"ratio":1.0,')
    .replace(/Ω/gu, '\\u03a9');
  return Buffer.from(exactPythonJson, 'utf8').toString('base64');
}

function toolBatchSha256() {
  return createHash('sha256').update(Buffer.from(toolBatchBytes(), 'base64')).digest('hex');
}

function proposal(checkpointId = 'checkpoint_1', throughSeq = 2) {
  return {
    checkpoint_id: checkpointId, source_attempt: attempt, stream_id: 'stream_1',
    through_seq: throughSeq, tool_calls: toolCalls(), frozen_input: frozenInput(),
    tool_batch_bytes: toolBatchBytes(), tool_batch_sha256: toolBatchSha256(),
    frozen_input_bytes: frozenInputBytes(),
    frozen_input_sha256: frozenInputSha256(),
    history_selector: {
      schema_version: 1, history_scope: 'session',
      canonical_cutoff: { boundary_message_id: null, boundary_message_count: 0,
        sha256: createHash('sha256').update('[]').digest('hex') },
      compaction_ref: null,
    },
  };
}

function continuation(candidate, sourceAttempt = attempt) {
  return {
    identity: { checkpoint_id: candidate.checkpointId, session_id: 'session_1' },
    source_attempt: sourceAttempt,
    canonical_refs: candidate.canonicalRefs,
    pending_call: {
      call_id: 'call_1', tool_id: 'read_file',
      effective_args_sha256: frozenInput().effective_args_fingerprint,
      frozen_input_ref: candidate.frozenInputRef,
    },
  };
}

module.exports = { stableJson, hash, setup, toolCalls, work, frozenInput, frozenInputBytes, frozenInputSha256, toolBatchBytes, toolBatchSha256, proposal, continuation, attempt, USER_MESSAGE_ID };
