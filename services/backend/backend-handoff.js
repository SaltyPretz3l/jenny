'use strict';

const { API_VERSION } = require('./sidecar-client');
const { isPrimaryRole } = require('./primary-session');
const { resolvePrimaryHandoffScope } = require('./primary-handoff-scope');
const { requestRuntimeInference } = require('./backend-runtime-inference');
const { prepareSessionHistoryRequest } = require('./backend-chat-stream');

const HANDOFF_TIMEOUT_MS = 120_000;
const SIDECAR_ERROR_REASONS = new Set(['no_history', 'generation_failed', 'note_invalid']);

// /handoff: a one-shot, off-transcript local-model call that drafts a handoff
// note from the SAME prepared history chat.compact sends (sidecar guard, model
// bring-up, lockdown gate: a locked chat's transcript never reaches a remote
// engine). The note is returned to the renderer only; it never enters the
// transcript and is never logged. Never throws: every failure resolves
// { ok: false, reason, detail? }.
//
// Row 73: the primary Jenny chat hands off one project at a time. Without a
// known `options.projectId` it answers { ok: false, reason: 'project_required'
// | 'project_invalid', projects, suggestedProjectId } before any inference;
// with one, the sidecar drafts a note about that project only and the reply
// adds `projectId` and `otherNames` (other work the dialog flags).
async function generateHandoffNote(service, sessionId, options = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  const log = (level, fields) => {
    try {
      service._emitServiceLog?.(level, 'handoff.note_result', { sessionId: normalizedSessionId, ...fields });
    } catch (_logError) { /* Diagnostics cannot fail the request. */ }
  };
  try {
    service._emitServiceLog?.('INFO', 'handoff.note_requested', { sessionId: normalizedSessionId });
    let scope = null;
    if (isPrimaryRole(service.sessionStore?.getSessionSummary?.(normalizedSessionId))) {
      scope = resolvePrimaryHandoffScope(service, normalizedSessionId, options?.projectId);
      if (!scope.ok) {
        log('INFO', { status: 'scope_needed', reason: scope.reason, note_chars: 0, transcript_truncated: false });
        return scope;
      }
    }
    const prepared = await prepareSessionHistoryRequest(service, normalizedSessionId, {
      logEvent: 'handoff.note_result',
    });
    if (!prepared.ok) return { ok: false, reason: prepared.reason };
    const consumeResult = (result) => {
      const status = String(result?.status || '').trim();
      const transcriptTruncated = result?.transcript_truncated === true;
      const note = status === 'ok' ? String(result?.note ?? '').trim() : '';
      if (status === 'ok' && note) {
        log('INFO', { status, note_chars: note.length, transcript_truncated: transcriptTruncated, ...(scope ? { scoped: true } : {}) });
        return scope
          ? { ok: true, note, transcriptTruncated, projectId: scope.project.id, otherNames: scope.otherNames }
          : { ok: true, note, transcriptTruncated };
      }
      const rawReason = String(result?.reason || '').trim();
      const reason = status === 'ok' || !SIDECAR_ERROR_REASONS.has(rawReason) ? 'generation_failed' : rawReason;
      log('WARN', { status: status || 'invalid', reason, note_chars: 0, transcript_truncated: transcriptTruncated });
      return { ok: false, reason };
    };
    return await requestRuntimeInference(service, 'handoff.generate_note', {
      accept_version: API_VERSION, session_id: normalizedSessionId, messages: prepared.messages,
      ...(scope ? { focus_project: { name: scope.project.name } } : {}),
    }, { sessionId: normalizedSessionId, timeoutMs: HANDOFF_TIMEOUT_MS, consumeResult });
  } catch (error) {
    const detail = String(error?.message || error || '').slice(0, 300);
    log('WARN', { reason: 'request_failed', detail });
    return { ok: false, reason: 'request_failed', detail };
  }
}

module.exports = { generateHandoffNote };
