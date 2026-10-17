'use strict';

const { resolveSessionToolDenyList } = require('./backend-service-utils');
const { randomUUID } = require('node:crypto');
const { API_VERSION } = require('./sidecar-client');
const { buildPreparedContextHistory } = require('./chat-stream-reasoning');
const { applyCompactionSnapshotToHistory, isCompactionSnapshotEnabled } = require('./session-compaction-snapshot');
const { normalizeContextPreferences } = require('./context-preferences');

const unavailable = (reason) => ({ status: 'unavailable', reason });
const inFlight = new WeakMap(); // service -> Map(sessionId -> { key, promise })

// What a preview depends on: callers asking with equal inputs share one sidecar call.
function previewInputsKey(session) {
  return JSON.stringify([session.project_id, session.updated_at, session.messages?.length || 0,
    session.run_mode, session.preferred_model, session.context_preferences]);
}

// Ephemeral, content-free projection. No chat admission, inference or session writes.
function previewContext(service, sessionId) {
  let session;
  try {
    session = service.sessionStore?.peekSession?.(sessionId);
  } catch (_error) {
    return Promise.resolve(unavailable('preview_unavailable'));
  }
  if (!session) return Promise.resolve(unavailable('session_not_found'));
  if (!inFlight.has(service)) inFlight.set(service, new Map());
  const pending = inFlight.get(service);
  const key = previewInputsKey(session);
  const joined = pending.get(sessionId);
  if (joined?.key === key) return joined.promise;
  const promise = runPreview(service, sessionId, session).finally(() => {
    if (pending.get(sessionId)?.promise === promise) pending.delete(sessionId);
  });
  pending.set(sessionId, { key, promise });
  return promise;
}

async function runPreview(service, sessionId, session) {
  let binding;
  try {
    if (!service.sidecarClient?.process || !service.sessionExecutionAuthority) return unavailable('backend_not_ready');
    const preferences = normalizeContextPreferences(session.context_preferences);
    const requestId = randomUUID();
    binding = service.sessionExecutionAuthority.captureSession(sessionId, { requestId, mode: 'assist' });
    const executionContext = service.sessionExecutionAuthority.toExecutionContext(binding);
    const snapshot = isCompactionSnapshotEnabled(service.featureFlags, session.compaction_snapshot) ? session.compaction_snapshot : null;
    const substituted = applyCompactionSnapshotToHistory(snapshot, session.messages || []);
    const messages = buildPreparedContextHistory(substituted?.applied ? substituted.messages : session.messages || [], preferences);
    const contextBlocks = [];
    if (preferences.include_personality !== false && service.personalityWorkspace?.getCompiledContext) {
      const compiled = await service.personalityWorkspace.getCompiledContext({ projectId: executionContext.project_id, ensure: false });
      if (compiled) contextBlocks.push({ kind: 'personality', content: String(compiled) });
    }
    const params = {
      accept_version: API_VERSION, session_id: sessionId, request_id: requestId,
      execution_context: executionContext, messages, context_blocks: contextBlocks,
      run_mode: session.run_mode || 'ask', session_start_date: session.session_start_date || null,
      preferred_model: session.preferred_model || null,
      tool_preferences: { disabled_tools: resolveSessionToolDenyList(session, service.currentStatus?.tools_status) },
    };
    if (Buffer.byteLength(JSON.stringify(params), 'utf8') > 8 * 1024 * 1024) return unavailable('preview_too_large');
    const result = await service.sidecarClient.request('context.preview', params, { timeoutMs: 5000 });
    service.sessionExecutionAuthority.requireCurrent(binding);
    return result?.status === 'estimated' ? { ...result, sampled_at: new Date().toISOString() } : unavailable(result?.reason || 'preview_unavailable');
  } catch (_error) {
    return unavailable('preview_unavailable');
  } finally {
    if (binding) service.sessionExecutionAuthority.close(binding);
  }
}

module.exports = { previewContext };
