'use strict';

const { hasDurableProof } = require('./conversation-store-port');
const { stableJson } = require('../session-runtime/contracts');
const { authorityFingerprint } = require('../session-runtime/root-run-start');
const { fail } = require('../session-runtime/lineage-contracts');

function executionSnapshot(service, context) {
  const { authority_revision: _revision, ...snapshot } = service.sessionExecutionAuthority.toExecutionContext(context.binding);
  return snapshot;
}
function ensureChildSession(coordinator, root, child, assertCurrent) {
  const { runtime, service } = coordinator;
  if (child.state === 'preparing') {
    if (service.sessionStore.getSessionSummary(child.session_id)) fail('runtime_child_session_ambiguous');
    const commit = runtime.conversationStore.createSession(child.session_id,
      { title: 'Child task', projectId: root.project_id }, { durable: true });
    if (!hasDurableProof(commit)) fail('runtime_child_session_not_durable');
    assertCurrent();
    const session = runtime.conversationStore.getSession(child.session_id);
    if (!session || session.project_id !== root.project_id) fail('runtime_child_session_changed');
    return runtime.lineageStore.recordSession({ rootRunId: root.root_run_id, childWorkId: child.work_id,
      sessionIncarnation: session.session_incarnation });
  }
  const session = runtime.conversationStore.getSession(child.session_id);
  if (!session || session.session_incarnation !== child.session_incarnation
    || session.project_id !== root.project_id) fail('runtime_child_session_changed');
  return child;
}
function childRequest(parent, child, task) {
  return { sessionId: child.session_id, prompt: task, visiblePrompt: task, attachments: [],
    runtimePreferredEngineType: parent.route.engine_type,
    runtimePreferredModel: parent.request.runtimePreferredModel,
    normalizedPreferences: structuredClone(parent.request.normalizedPreferences || {}),
    normalizedInteractiveResponse: null, toolPreferences: structuredClone(parent.request.toolPreferences || null),
    debugOptions: { plain_chat_mode: parent.trusted.mode === 'chat' }, runtimeChildReadOnly: true };
}
async function publishRuntimeChild(coordinator, { work, context, rootWork, root, child, task, assertCurrent }) {
  const { runtime, service } = coordinator;
  const recorded = ensureChildSession(coordinator, { ...root, project_id: rootWork.project_id }, child, assertCurrent);
  assertCurrent();
  let prepared;
  let submitted;
  try {
    prepared = await runtime.chatAdapter.prepareImmediate(childRequest(context, recorded, task),
      { getCurrentWork: () => runtime.store.get(recorded.work_id) },
      { workId: recorded.work_id, turnId: recorded.turn_id });
    prepared.started.promise.catch(() => {});
    assertCurrent();
    if (prepared.trusted.readOnly !== true || prepared.trusted.mode !== context.trusted.mode || stableJson(prepared.authority) !== stableJson(context.authority)
      || stableJson(prepared.input.route) !== stableJson(work.input.route)
      || stableJson(executionSnapshot(service, prepared)) !== stableJson(executionSnapshot(service, context))
      || stableJson(prepared.request.toolPreferences || null) !== stableJson(context.request.toolPreferences || null)) {
      fail('runtime_child_grant_expanded');
    }
    prepared.input = { ...prepared.input, kind: 'child_chat', child_run: { schema_version: 1,
      root_run_id: root.root_run_id, root_work_id: rootWork.work_id,
      parent_work_id: work.work_id, parent_turn_id: work.turn_id, spawn_call_id: child.call_id,
      args_sha256: child.args_sha256, authority_fingerprint: authorityFingerprint(service, prepared) } };
    submitted = runtime.store.submit({ idempotencyKey: child.work_id, workId: child.work_id, turnId: child.turn_id,
      projectId: rootWork.project_id, sessionId: child.session_id, purpose: 'Read-only child task',
      input: prepared.input, authority: prepared.authority });
    if (submitted.record.attempt) fail('runtime_child_uncommitted_attempt');
    assertCurrent();
    runtime.lineageStore.commitSpawn({ rootRunId: root.root_run_id, childWorkId: child.work_id,
      sessionIncarnation: recorded.session_incarnation, submissionSha256: submitted.record.submission_hash });
    assertCurrent();
    if (submitted.created && submitted.record.status === 'pending') {
      prepared.awaitingAcknowledgement = true;
      runtime.chatAdapter.register(child.work_id, prepared);
      setImmediate(() => { prepared.awaitingAcknowledgement = false; runtime.scheduler.notifyLaneAvailability(); });
    } else runtime.chatAdapter.discard(prepared);
    return submitted.record;
  } catch (error) {
    if (prepared) runtime.chatAdapter.discard(prepared);
    if (submitted?.created) {
      try { runtime.store.transition(child.work_id, { expectedRevision: submitted.record.revision,
        to: 'paused', reason: 'child_publication_incomplete' }); } catch (_error) { /* Retain unresolved evidence. */ }
    }
    throw error;
  }
}

module.exports = { publishRuntimeChild };
