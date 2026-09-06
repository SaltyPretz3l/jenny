const { ARTIFACT_ERROR_CODES } = require('./backend/error-codes');

class ArtifactWorkspaceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ArtifactWorkspaceError';
    this.code = code;
    this.error_code = code;
    this.details = details;
  }
}

function artifactError(code, message, details = {}) {
  return new ArtifactWorkspaceError(code, message, details);
}

module.exports = {
  ARTIFACT_ERROR_CODES,
  ArtifactWorkspaceError,
  artifactError,
};
