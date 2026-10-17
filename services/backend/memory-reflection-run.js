'use strict';

// One reflection run (agentic memory v2, row 58 W2; contract: W2 batch 2).
// Electron reads the sidecar cursor, builds the window over canonical history,
// and asks the chat's local engine for proposals as a preemptible,
// session-scoped auxiliary request. While the turn lease is still held it
// re-checks consent (policy epoch, capture, session identity, window
// fingerprint), then the sidecar applies atomically behind its own epoch and
// cursor fences. Receipts are appended off-turn. No memory text is logged.

const { API_VERSION } = require('./sidecar-client');
const {
  buildMemoryPolicy,
  flushMemoryPolicyEpochPush,
  memoryEpochSource,
  readMemorySettings,
  requestMemoryRpc,
} = require('./backend-memory');
const { requestRuntimeInference } = require('./backend-runtime-inference');
const { reflectionGloballyEnabled, sessionIneligibility } = require('./memory-reflection-eligibility');
const { buildReflectionWindow, windowFingerprint } = require('./memory-reflection-window');
const { appendOffTurnMessages } = require('./session-off-turn-messages');

const MAX_PROPOSALS = 5;
const REASON_TOKEN = /^[a-z_]{1,64}$/u;
// Admission errors that mean the chat moved under the run, not a failure.
const SESSION_CHANGED_REASONS = new Set(['runtime_session_stale', 'runtime_session_unavailable']);
// Admission errors that mean foreground work took the capacity first.
const BUSY_REASONS = new Set(['lane_capacity', 'session_busy', 'runtime_closing']);

function reasonToken(value, fallback) {
  const token = String(value || '').trim().toLowerCase();
  return REASON_TOKEN.test(token) ? token : fallback;
}

function sessionProjectId(service, sessionId) {
  return String(service.projectAuthority.captureSession(sessionId)?.project_id || '');
}

function readPolicy(service, session, projectId) {
  return buildMemoryPolicy(service, {
    includeMemory: true,
    memoryOptOut: session?.context_preferences?.memory_opt_out === true,
    projectId,
  });
}

// Reads the cursor and builds the window. status: ready | nothing_new | skipped.
async function prepareReflection(service, sessionId, { engineType }) {
  const state = await requestMemoryRpc(service, 'memory.reflection_state', { session_id: sessionId });
  if (state?.purged === true) return { status: 'skipped', reason: 'session_purged' };
  const session = service.sessionStore.getSession(sessionId);
  if (!session) return { status: 'skipped', reason: 'session_missing' };
  const cursor = state?.cursor && typeof state.cursor === 'object' ? state.cursor : null;
  // G4: turns sent while "Jenny takes notes" was off are never mined.
  const window = buildReflectionWindow(service.sessionStore.peekSessionMessages(sessionId), cursor,
    { notesSince: readMemorySettings(service).takeNotesSince });
  if (!window) return { status: 'nothing_new' };
  const projectId = sessionProjectId(service, sessionId);
  const policy = readPolicy(service, session, projectId);
  if (policy.capture === 'off') return { status: 'skipped', reason: 'capture_off' };
  return {
    status: 'ready',
    plan: {
      sessionId,
      projectId,
      engineType,
      window,
      policyEpoch: policy.policy_epoch,
      expectedFingerprint: typeof cursor?.window_fingerprint === 'string' ? cursor.window_fingerprint : null,
      incarnation: String(session.session_incarnation || ''),
      turnGeneration: Number.isSafeInteger(session.turn_generation) ? session.turn_generation : 0,
    },
  };
}

// The re-check under the lease: a refusal reason, or null when apply may run.
function consentRefusal(service, plan) {
  const session = service.sessionStore.getSession(plan.sessionId);
  if (!session || String(session.session_incarnation || '') !== plan.incarnation) return 'session_changed';
  // Lockdown, opt-out and the other per-chat gates can flip during inference.
  const ineligible = sessionIneligibility(service, session);
  if (ineligible) return ineligible;
  let projectId;
  try { projectId = sessionProjectId(service, plan.sessionId); } catch (_error) { return 'session_changed'; }
  if (projectId !== plan.projectId) return 'session_changed';
  const policy = readPolicy(service, session, projectId);
  if (!reflectionGloballyEnabled(service) || policy.capture === 'off'
    || policy.policy_epoch !== plan.policyEpoch) return 'policy_stale';
  const messages = service.sessionStore.peekSessionMessages(plan.sessionId);
  if (windowFingerprint(messages, plan.window.endIndex) !== plan.window.fingerprint) return 'cursor_moved';
  return null;
}

// One standalone `memory_note` message per run, not a tool result: no model
// call made it, so it must not pair with a tool call, reach the model's history
// or read as an interrupted turn. It belongs to no turn and carries one memory
// chip per saved note (never the memory text beyond the bounded preview); the
// transcript folds two or more under one "Jenny took N notes" row.
function noteChip(item) {
  return {
    result_kind: 'memory', action: 'remember', status: 'saved',
    ...(Number.isSafeInteger(item?.memory_id) ? { memory_id: item.memory_id } : {}),
    operation_id: String(item?.operation_id || ''), scope: item?.scope === 'chat' ? 'chat' : 'project', kind: item?.kind,
    undoable: item?.undoable === true, text_preview: String(item?.text_preview || ''), origin: 'reflection',
  };
}

function buildReceipt(saved, timestamp) {
  const notes = saved.map(noteChip);
  return {
    id: `memory_note_${notes[0].operation_id.replace(/[^A-Za-z0-9_-]/gu, '_')}`,
    role: 'assistant',
    kind: 'memory_note',
    content: '',
    status: 'complete',
    timestamp,
    finalizedAt: timestamp,
    memory_notes: notes,
  };
}

function countOf(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

async function applyReflection(service, plan, result, { now, assertNotPreempted = () => {} }) {
  if (!result || result.window_fingerprint !== plan.window.fingerprint) {
    return { outcome: 'refused', reason: 'cursor_moved' };
  }
  const refusal = consentRefusal(service, plan);
  if (refusal) return { outcome: 'refused', reason: refusal };
  const policy = readPolicy(service, service.sessionStore.getSession(plan.sessionId), plan.projectId);
  // The sidecar's epoch fence must have seen every bump before this apply.
  await flushMemoryPolicyEpochPush(service);
  // A foreground send that arrived after the proposals came back wins: no apply.
  assertNotPreempted();
  const proposals = (Array.isArray(result.proposals) ? result.proposals : []).slice(0, MAX_PROPOSALS)
    .map(({ text, kind, scope, source_message_id: sourceMessageId }) => ({ text, kind, source_message_id: sourceMessageId, ...(scope ? { scope } : {}) }));
  const { window } = plan;
  const applied = await requestMemoryRpc(service, 'memory.apply', {
    session_id: plan.sessionId,
    project_id: plan.projectId,
    policy_epoch: plan.policyEpoch,
    epoch_source: memoryEpochSource(service),
    capture: policy.capture,
    expected_fingerprint: plan.expectedFingerprint,
    cursor: { message_count: window.endIndex + 1, last_message_id: window.lastMessageId,
      window_fingerprint: window.fingerprint, session_incarnation: plan.incarnation,
      turn_generation: plan.turnGeneration },
    proposals,
    recap: typeof result.recap === 'string' ? result.recap : '',
  });
  if (applied?.status !== 'applied') {
    return { outcome: 'refused', reason: reasonToken(applied?.reason, 'unspecified') };
  }
  const saved = Array.isArray(applied.saved) ? applied.saved : [];
  if (saved.length) {
    const timestamp = new Date(now()).toISOString();
    appendOffTurnMessages(service.sessionStore, plan.sessionId, [buildReceipt(saved, timestamp)]);
  }
  return { outcome: 'applied', saved: saved.length, queued: countOf(applied.queued), skipped: countOf(applied.skipped) };
}

function mapRunError(error) {
  if (error?.reason === 'auxiliary_preempted') return { outcome: 'preempted' };
  if (SESSION_CHANGED_REASONS.has(error?.reason)) return { outcome: 'refused', reason: 'session_changed' };
  if (BUSY_REASONS.has(error?.reason)) return { outcome: 'skipped', reason: 'busy' };
  return { outcome: 'failed', reason: reasonToken(error?.reason || error?.rpc?.data?.reason || error?.code, 'error') };
}

// Runs one prepared plan. Never throws; the outcome is one of
// applied | refused | preempted | failed | skipped.
async function executeReflection(service, plan, {
  requestInference = requestRuntimeInference, signal = null, now = Date.now,
} = {}) {
  const params = {
    accept_version: API_VERSION,
    session_id: plan.sessionId,
    project_id: plan.projectId,
    messages: plan.window.messages,
    new_user_ids: plan.window.newUserIds,
    window_fingerprint: plan.window.fingerprint,
  };
  try {
    return await requestInference(service, 'memory.reflect', params, {
      sessionId: plan.sessionId,
      engineType: plan.engineType,
      preemptible: true,
      ...(signal ? { signal } : {}),
      consumeResult: (result, control) => applyReflection(service, plan, result,
        { now, assertNotPreempted: control?.assertNotPreempted }),
    });
  } catch (error) {
    return mapRunError(error);
  }
}

module.exports = { executeReflection, prepareReflection };
