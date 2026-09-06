const { WORKSPACE_GIT_ERROR_CODES } = require('./backend/error-codes');

class WorkspaceGitError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorkspaceGitError';
    this.code = code;
    this.error_code = code;
    this.details = details;
  }
}

function workspaceGitError(code, message, details = {}) {
  return new WorkspaceGitError(code, message, details);
}

module.exports = {
  WORKSPACE_GIT_ERROR_CODES,
  workspaceGitError,
};
