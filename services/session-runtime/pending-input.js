'use strict';

const { stableJson, submissionHash, validateWorkRecord, MAX_PENDING_INPUT_BYTES } = require('./contracts');
const { isoNow } = require('./store-control');
function fail(code) { throw Object.assign(new Error(code), { code }); }
function editable(work) {
  return Boolean(work && ['pending', 'paused'].includes(work.status) && !work.attempt && !work.checkpoint_ref
    && !work.control_request && work.input?.schema_version === 1
    && ['immediate_chat', 'root_chat'].includes(work.input.kind));
}
function withoutPrompt(input) {
  return { ...input, request: { ...input.request, prompt: null, visiblePrompt: null } };
}
// The only journal exception to immutable submission hashes is this exact,
// unattempted prompt revision. Old Send retries conflict after an explicit edit;
// neither identity, authority, route nor existing root grants can change.
function isPendingInputRevision(previous, next) {
  const repaired = previous && next && next.revision === previous.revision + 2
    && ((next.recovery?.kind === 'transition_repaired' && next.recovery.previous_status === previous.status)
      || (previous.recovery?.kind === 'restart_paused' && stableJson(previous.recovery) === stableJson(next.recovery)));
  if (repaired) next = { ...next, revision: next.revision - 1, recovery: previous.recovery };
  if (!editable(previous) || !editable(next) || next.revision !== previous.revision + 1
    || next.transition?.reason !== 'pending_input_updated' || next.transition.from !== previous.status
    || next.transition.to !== previous.status || next.status !== previous.status
    || stableJson(withoutPrompt(previous.input)) !== stableJson(withoutPrompt(next.input))) return false;
  const stable = work => {
    const { input: _input, input_bytes: _bytes, submission_hash: _hash, revision: _revision,
      updated_at: _at, transition: _transition, ...identity } = work;
    return identity;
  };
  return stableJson(stable(previous)) === stableJson(stable(next));
}
function updatePendingInput(store, workId, { expectedRevision, prompt } = {}) {
  store._assertWritable();
  const current = store.get(workId);
  if (!current) fail('work_not_found');
  if (current.revision !== expectedRevision) fail('revision_conflict');
  if (!editable(current)) fail('pending_update_state_conflict');
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt, 'utf8') > MAX_PENDING_INPUT_BYTES) {
    fail('pending_update_invalid');
  }
  const input = { ...current.input, request: { ...current.input.request, prompt, visiblePrompt: prompt } };
  if (stableJson(input) === stableJson(current.input)) return { changed: false, record: current };
  const at = isoNow(store.now);
  const next = { ...current, input, input_bytes: Buffer.byteLength(JSON.stringify(input), 'utf8'),
    submission_hash: submissionHash({ authority: current.authority, input,
      project_id: current.project_id, purpose: current.purpose, session_id: current.session_id }),
    revision: current.revision + 1, updated_at: at, transition: { transition_id: store.createId('transition'),
      from: current.status, to: current.status, reason: 'pending_input_updated', at } };
  const checked = validateWorkRecord(next);
  if (!checked.ok || !isPendingInputRevision(current, next)) fail(checked.reason || 'pending_update_invalid');
  store._commit(checked.record);
  return { changed: true, record: checked.record };
}
async function updateRuntimePending(runtime, workId, { expectedRevision, prompt, beforeCommit } = {}) {
  if (runtime.scheduler.closing) fail('runtime_closing');
  const source = runtime.store.get(workId);
  if (source?.revision !== expectedRevision) fail('revision_conflict');
  if (!editable(source)) fail('pending_update_state_conflict');
  const request = { ...source.input.request, prompt, visiblePrompt: prompt };
  const adapter = runtime.chatAdapter;
  const previous = adapter.contexts.get(workId);
  const prepared = await adapter.prepareSubmission(request, { getCurrentWork: () => runtime.store.get(workId) },
    { workId, turnId: source.turn_id });
  try {
    if (runtime.scheduler.closing) fail('runtime_closing');
    adapter.validateSubmission(prepared);
    if (stableJson(prepared.authority) !== stableJson(source.authority)
      || stableJson(prepared.route) !== stableJson(source.input.route)) fail('pending_update_authority_changed');
    if (source.input.kind === 'root_chat') {
      const { assertRootStart } = require('./root-run-start');
      assertRootStart(runtime.budgetStore, adapter.service, source, prepared);
    }
    beforeCommit?.();
    const result = updatePendingInput(runtime.store, workId, { expectedRevision, prompt });
    // Publication is synchronous after the final CAS. No actor or producer is
    // allocated here; a paused edit remains paused until explicit resume.
    if (previous) adapter.discard(previous);
    if (result.record.status === 'pending') {
      prepared.input = result.record.input;
      prepared.request = request;
      prepared.awaitingAcknowledgement = true;
      adapter.register(workId, prepared);
      setImmediate(() => { prepared.awaitingAcknowledgement = false; runtime.scheduler.notifyLaneAvailability(); });
    } else adapter.discard(prepared);
    return { ok: true, work_id: workId, revision: result.record.revision, status: result.record.status };
  } catch (error) { adapter.discard(prepared); throw error; }
}
module.exports = { editable, isPendingInputRevision, updatePendingInput, updateRuntimePending };
