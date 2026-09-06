const { WORKSPACE_FS_ERROR_CODES } = require('./backend/error-codes');

class WorkspaceFsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorkspaceFsError';
    this.code = code;
    this.error_code = code;
    this.details = details;
  }
}

function workspaceFsError(code, message, details = {}) {
  return new WorkspaceFsError(code, message, details);
}

module.exports = {
  WORKSPACE_FS_ERROR_CODES,
  workspaceFsError,
};
