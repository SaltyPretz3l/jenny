/* services/backend/backend-service-session-methods.js - BackendService methods for sessions (list/create/rename/delete, messages, preferences and the primary chat).
 *
 * Extracted from backend-service.js as a behavior-preserving move and installed
 * on BackendService.prototype by the install loop after the class. Each method is
 * the same thin `this` delegate it was in the class body, so tests that stub a
 * method on the prototype or an instance still intercept every internal call.
 */
const path = require('path');

const {
  listSessions: _listSessions,
  createSession: _createSession,
  createLinkedChildSession: _createLinkedChildSession,
  renameSession: _renameSession,
  getSessionMessages: _getSessionMessages,
  setSessionPreferences: _setSessionPreferences,
  pauseSessionAutoRun: _pauseSessionAutoRun,
  setSessionMeta: _setSessionMeta,
  sweepEmptySessions: _sweepEmptySessions,
  updateSessionMessage: _updateSessionMessage,
  editUserMessageAndTruncate: _editUserMessageAndTruncate,
} = require('./backend-sessions');
const {
  deleteSessionWithQuiescence: _deleteSessionWithQuiescence,
} = require('./backend-session-delete-lifecycle');
const {
  PRIMARY_PROTECTED, ensurePrimarySession: _ensurePrimarySession, isPrimarySession,
} = require('./primary-session');
const { trackMemoryOptOutChange: _trackMemoryOptOutChange } = require('./backend-memory');

const sessionMethods = {
  async listSessions() {
    return _listSessions(this);
  },

  getSessionSummariesForScheduler() {
    return this.sessionStore.listSessions();
  },

  getBackgroundRuntimeRoot() {
    return path.join(this.options.userDataPath, 'background-memory');
  },

  async createSession({
    title, preferences, sessionType, providerAuthority, initialPrompt, linkedTaskId, projectId, draftImageAttachments,
    handoffFromSessionId,
  } = {}) {
    return _createSession(this, {
      title, preferences, sessionType, providerAuthority, initialPrompt, linkedTaskId, projectId, draftImageAttachments,
      handoffFromSessionId,
    });
  },

  async renameSession(sessionId, title) {
    return _renameSession(this, sessionId, title);
  },

  async deleteSession(sessionId, options) {
    // Row 69: refuse the primary chat before the deletion lifecycle cancels its stream.
    if (isPrimarySession(this.sessionStore, sessionId)) {
      return { object: 'session', id: String(sessionId).trim(), deleted: false, reason: PRIMARY_PROTECTED };
    }
    return _deleteSessionWithQuiescence(this, sessionId, options);
  },

  // Row 69: the profile's one primary Jenny chat. Internal path only (the wiring runs it deferred after
  // the window exists); never throws, and sessions.create can never mint a primary.
  async ensurePrimarySession() {
    return _ensurePrimarySession({
      sessionStore: this.sessionStore,
      createSession: (options) => _createSession(this, options),
      featureFlags: this.featureFlags,
      log: (level, event, details) => this._emitServiceLog(level, event, details),
    });
  },

  // The session directory behind sessions_list (row 69), or null before the runtime composition
  // wires a tool executor; profile-overview-block.js reads it for the primary chat's overview.
  getSessionDirectory() {
    return this.toolExecutor?.getSessionDirectoryService?.() || null;
  },

  async getSessionMessages(sessionId) {
    return _getSessionMessages(this, sessionId);
  },

  async setSessionPreferences(sessionId, preferences = {}) {
    return _trackMemoryOptOutChange(this, sessionId, () => _setSessionPreferences(this, sessionId, preferences));
  },

  pauseSessionAutoRun(sessionId, options = {}) {
    return _pauseSessionAutoRun(this, sessionId, options);
  },

  async setSessionMeta(sessionId, meta = {}) {
    return _setSessionMeta(this, sessionId, meta);
  },

  // Row 59 cp5a: the linked child of an accepted New session proposal (never reachable from sessions.create IPC).
  createLinkedChildSession(spec = {}) {
    return _createLinkedChildSession(this, spec);
  },

  async sweepEmptySessions(options = {}) {
    return _sweepEmptySessions(this, options);
  },

  async updateSessionMessage(sessionId, messageId, patch = {}) {
    return _updateSessionMessage(this, sessionId, messageId, patch);
  },

  async editUserMessageAndTruncate(sessionId, messageId, payload = {}) {
    const normalizedSessionId = String(sessionId || '').trim();
    const normalizedMessageId = String(messageId || '').trim();
    if (!normalizedSessionId || !normalizedMessageId) return null;
    return this.sessionTurnActors.runSessionMutation(
      normalizedSessionId,
      'sessions.edit_and_truncate',
      () => null,
      () => _editUserMessageAndTruncate(this, normalizedSessionId, normalizedMessageId, payload),
      { requireIdle: true }
    );
  },
};

module.exports = { sessionMethods };
