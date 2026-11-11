/* services/backend/backend-service-memory-methods.js - BackendService methods for memory (approved/pending memories, the Settings > Memory page and the policy epoch).
 *
 * Extracted from backend-service.js as a behavior-preserving move and installed
 * on BackendService.prototype by the install loop after the class. Each method is
 * the same thin `this` delegate it was in the class body, so tests that stub a
 * method on the prototype or an instance still intercept every internal call.
 */
const {
  acceptPendingMemory: _acceptPendingMemory,
  bumpMemoryPolicyEpoch: _bumpMemoryPolicyEpoch,
  clearMemorySuppressions: _clearMemorySuppressions,
  memoryPolicyEpoch: _memoryPolicyEpoch,
  purgeSessionMemories: _purgeSessionMemories,
  undoApprovedMemoryChange: _undoApprovedMemoryChange,
  undoMemoryOperation: _undoMemoryOperation,
  archiveProjectMemories: _archiveProjectMemories,
  getMemoryStatus: _getMemoryStatus,
  saveMemoryForSession: _saveMemoryForSession,
  listApprovedMemories: _listApprovedMemories,
  listPendingMemories: _listPendingMemories,
  updateApprovedMemory: _updateApprovedMemory,
  deleteApprovedMemory: _deleteApprovedMemory,
  deletePendingMemory: _deletePendingMemory,
  recallApprovedMemories: _recallApprovedMemories,
} = require('./backend-memory');
const memorySettings = require('./backend-memory-settings');

const memoryMethods = {
  async getMemoryStatus() {
    return _getMemoryStatus(this);
  },

  async saveMemoryForSession(sessionId, candidate) {
    return _saveMemoryForSession(this, sessionId, candidate);
  },

  async listApprovedMemories() {
    return _listApprovedMemories(this);
  },

  async listPendingMemories() {
    return _listPendingMemories(this);
  },

  async updateApprovedMemory(memoryId, patch, projectId, options) {
    return _updateApprovedMemory(this, memoryId, patch, projectId, options);
  },

  async deleteApprovedMemory(memoryId, projectId, options) {
    return _deleteApprovedMemory(this, memoryId, projectId, options);
  },

  async deletePendingMemory(sessionId, contentFingerprint, projectId) {
    return _deletePendingMemory(this, sessionId, contentFingerprint, projectId);
  },

  async acceptPendingMemory(sessionId, contentFingerprint, projectId) {
    return _acceptPendingMemory(this, sessionId, contentFingerprint, projectId);
  },

  // Settings > Memory page (row 58 W4); each takes one `{ projectId, ... }` request.
  async listArchivedMemories(request) {
    return memorySettings.listArchivedMemories(this, request);
  },

  async restoreArchivedMemory(request) {
    return memorySettings.restoreArchivedMemory(this, request);
  },

  async eraseMemory(request) {
    return memorySettings.eraseMemory(this, request);
  },

  async clearForgottenMemories(request) {
    return memorySettings.clearForgottenMemories(this, request);
  },

  async listMemoryOperations(request) {
    return memorySettings.listMemoryOperations(this, request);
  },

  async setMemoryAlwaysOn(request) {
    return memorySettings.setMemoryAlwaysOn(this, request);
  },

  async exportMemoriesMarkdown(request) {
    return memorySettings.exportMemoriesMarkdown(this, request);
  },

  async undoApprovedMemoryChange(operationId, projectId) {
    return _undoApprovedMemoryChange(this, operationId, projectId);
  },

  async undoMemoryOperation(sessionId, operationId) {
    return _undoMemoryOperation(this, sessionId, operationId);
  },

  async archiveProjectMemories(projectId) {
    return _archiveProjectMemories(this, projectId);
  },

  async purgeSessionMemories(sessionId) {
    return _purgeSessionMemories(this, sessionId);
  },

  async clearMemorySuppressions(projectId = null) {
    return _clearMemorySuppressions(this, projectId);
  },

  // Memory policy epoch (row 58 W1): in-process, monotonic, starts at 0.
  memoryPolicyEpoch() {
    return _memoryPolicyEpoch(this);
  },

  bumpMemoryPolicyEpoch(reason) {
    return _bumpMemoryPolicyEpoch(this, reason);
  },

  async recallApprovedMemories(query, limit = 3, options = {}) {
    return _recallApprovedMemories(this, query, limit, options);
  },
};

module.exports = { memoryMethods };
