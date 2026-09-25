'use strict';

const { isImageAttachment, isTextAttachment } = require('../attachment-service');
const {
  createSessionWithImageAdmission,
  validateImageAttachmentsForManagedSend,
} = require('./managed-sidecar-attachments');
const {
  buildAutomaticSessionTitleCandidate,
  shouldApplyAutomaticSessionTitle,
} = require('./interactive-session-utils');
const { createSessionId, getLocalISODate, localIsoDateFromTimestamp } = require('./electron-session-store');

function getSessionSummary(store, sessionId) {
  if (typeof store?.getSessionSummary === 'function') {
    return store.getSessionSummary(sessionId);
  }
  return store?.getSession?.(sessionId) || null;
}

function prepareManagedSession(service, {
  sessionId, prompt, visiblePrompt, attachments, normalizedInteractiveResponse, normalizedPreferences,
} = {}) {
  const requestedSessionId = String(sessionId || '').trim();
  const resolvedSessionId = requestedSessionId || createSessionId();
  const transcriptPrompt = String(typeof visiblePrompt === 'string' ? visiblePrompt : prompt).trim();
  const normalizedAttachments = Array.isArray(attachments) ? attachments : [];
  const imageAttachments = normalizedAttachments.filter(entry => isImageAttachment(entry));
  const textAttachments = normalizedAttachments.filter(entry => isTextAttachment(entry));
  if (imageAttachments.length
    && typeof service.attachmentAssetStore?.resolveManagedAssetRealPath !== 'function') {
    throw new Error('Image attachments must come from the app-managed local asset store.');
  }
  const existingSession = requestedSessionId
    ? getSessionSummary(service.sessionStore, resolvedSessionId) : null;
  const sessionStartDate = String(existingSession?.session_start_date
    || localIsoDateFromTimestamp(existingSession?.created_at) || getLocalISODate()).trim();
  const automaticTitleCandidate = buildAutomaticSessionTitleCandidate(
    transcriptPrompt, normalizedInteractiveResponse
  );
  const exchangeTitle = requestedSessionId
    && shouldApplyAutomaticSessionTitle(existingSession, automaticTitleCandidate)
    ? automaticTitleCandidate : '';
  const imageAdmission = imageAttachments.length ? validateImageAttachmentsForManagedSend(
    service, imageAttachments, { requestedSessionId, resolvedSessionId }
  ) : null;
  if (!requestedSessionId) {
    const created = createSessionWithImageAdmission(imageAdmission, () => service.sessionStore.createSessionWithId(
      resolvedSessionId,
      { title: automaticTitleCandidate || 'New Chat', preferences: {
        ...normalizedPreferences, session_start_date: sessionStartDate,
      } }
    ));
    if (!created) throw new Error('Chat could not start: session storage rejected the write.');
  }
  return {
    automaticTitleCandidate, exchangeTitle, existingSession, imageAttachments,
    normalizedAttachments, requestedSessionId, resolvedSessionId, sessionStartDate,
    textAttachments, transcriptPrompt,
  };
}

// Title at send (owner gate 2026-09-20): the prompt already names a fresh
// "New Chat", and waiting for the terminal left it untitled through a long
// turn. The renderer's post-send summary refresh reads this before the turn
// streams. The terminal apply stays as the durable fallback; it checks the
// title is still the default, so it is a no-op after this.
async function applySessionTitleAtSend(service, sessionId, title) {
  if (!title || typeof service?.renameSession !== 'function') return;
  try {
    await service.renameSession(sessionId, title);
  } catch (error) {
    service._emitServiceLog?.('WARN', 'chat.session_title_update_failed', {
      sessionId,
      reason: 'send',
      title: String(title || ''),
      message: String(error?.message || error),
    });
  }
}

module.exports = { applySessionTitleAtSend, prepareManagedSession };
