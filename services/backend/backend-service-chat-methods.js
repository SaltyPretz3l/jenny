/* services/backend/backend-service-chat-methods.js - BackendService methods for chat turns (start/regenerate/cancel, approvals, user questions, compaction and handoff).
 *
 * Extracted from backend-service.js as a behavior-preserving move and installed
 * on BackendService.prototype by the install loop after the class. Each method is
 * the same thin `this` delegate it was in the class body, so tests that stub a
 * method on the prototype or an instance still intercept every internal call.
 */
const {
  resolveModel: _resolveModel,
  cancelChatStream: _cancelChatStream,
  compactContextNow: _compactContextNow,
  approveToolCall: _approveToolCall,
  denyToolCall: _denyToolCall,
  hasPendingUserQuestions: _hasPendingUserQuestions,
  answerUserQuestions: _answerUserQuestions,
  declineUserQuestions: _declineUserQuestions,
} = require('./backend-chat-stream');
const { generateHandoffNote: _generateHandoffNote } = require('./backend-handoff');
const {
  startManagedSidecarChatStream: _startManagedSidecarChatStream,
} = require('./managed-sidecar-chat');
const { discardUnsavedReply: _discardUnsavedReply, retryUnsavedReply: _retryUnsavedReply } = require('./backend-terminal-repair-actions');
const {
  assertChatTurnAdmissible, assertLinkedFirstTurnAdmissible, assertRegenerateAnchorAdmissible,
} = require('./chat-turn-admission');
const {
  startLocalEngineChatStream: _startLocalEngineChatStream,
} = require('./local-engine-requests');
const {
  CANCEL_REASON_USER,
  normalizeCancelReason,
} = require('./chat-stream-terminal-utils');
const {
  getManagedActiveTurnState: _getManagedActiveTurnState,
} = require('./backend-active-turn-state');

const chatMethods = {
  async _resolveModel(preferredModel = '', preferredEngineType = '', ownStreamId = '') {
    return _resolveModel(this, preferredModel, preferredEngineType, ownStreamId);
  },

  async startChatStream(payload, options = {}) {
    const {
    sessionId,
    prompt,
    visiblePrompt,
    traceId,
    preferredModel,
    reasoningEffort,
    attachments,
    interactiveResponse,
    interactiveRoundCount,
    planMode,
    contextPreferences,
    activeFileContext,
    mentionContents,
    toolPreferences,
    approvalMode,
    debugOptions,
    clientTiming, skillInvocation, imagePromptPin, editedMessageId, failureRetry,
    } = payload || {};
    // Runtime admission owns routed GPU/provider checks when composed. Minimal
    // embedded hosts retain the legacy entry check.
    if (!this.sessionRuntime) assertChatTurnAdmissible(this, sessionId);
    assertLinkedFirstTurnAdmissible(this, sessionId);
    return _startLocalEngineChatStream(this, {
      sessionId,
      prompt,
      visiblePrompt,
      traceId,
      preferredModel,
      reasoningEffort,
      attachments,
      interactiveResponse,
      interactiveRoundCount,
      planMode,
      contextPreferences,
      activeFileContext,
      mentionContents,
      toolPreferences,
      approvalMode,
      debugOptions,
      clientTiming, skillInvocation, imagePromptPin, editedMessageId, failureRetry,
    }, options);
  },

  async editAndRegenerate(payload = {}) {
    const sessionId = String(payload.sessionId || '').trim();
    const editedMessageId = String(payload.editedMessageId || '').trim();
    const failureRetry = payload.failureRetry === true;
    if (!sessionId || !editedMessageId) {
      throw new TypeError('Edit-and-regenerate requires sessionId and editedMessageId.');
    }
    assertRegenerateAnchorAdmissible(this, sessionId, editedMessageId);
    return this.startChatStream({
      ...payload,
      sessionId,
      editedMessageId,
      // Normalized, not conditionally spread: `...payload` above carries the
      // caller's raw value, so an absent spread would let a truthy non-boolean
      // ride through unchanged. Every consumer tests `=== true`, but a field
      // that only LOOKS boolean is how this codebase has repeatedly turned one
      // state into another by accident.
      failureRetry,
    });
  },

  async retryUnsavedReply(payload = {}) {
    return _retryUnsavedReply(this, payload);
  },

  async discardUnsavedReply(payload = {}) {
    return _discardUnsavedReply(this, payload);
  },

  cancelChatStream(streamId, reason) {
    const normalized = normalizeCancelReason(reason, CANCEL_REASON_USER);
    return _cancelChatStream(this, streamId, normalized);
  },

  async getActiveTurnState(sessionId) {
    return _getManagedActiveTurnState(this, sessionId);
  },

  // Manual/on-demand compaction (Settings "Compact now"). Passthrough of the
  // sidecar's chat.compact result; see backend-chat-stream.js for the guard +
  // message-mapping logic (kept there to stay under the file-size cap here).
  async compactContextNow(sessionId) {
    return _compactContextNow(this, sessionId);
  },

  // /handoff: an off-transcript handoff note from the same prepared history.
  async generateHandoffNote(sessionId, options) {
    return _generateHandoffNote(this, sessionId, options);
  },

  approveToolCall(callId, options = {}) {
    return _approveToolCall(this, callId, options);
  },

  denyToolCall(callId) {
    return _denyToolCall(this, callId);
  },

  hasPendingUserQuestions(questionRef) {
    return _hasPendingUserQuestions(this, questionRef);
  },

  answerUserQuestions(questionRef, payload = {}) {
    return _answerUserQuestions(this, questionRef, payload);
  },

  declineUserQuestions(questionRef) {
    return _declineUserQuestions(this, questionRef);
  },

  async _startManagedSidecarChatStream(opts) {
    return _startManagedSidecarChatStream(this, opts);
  },
};

module.exports = { chatMethods };
