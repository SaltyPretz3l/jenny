'use strict';

const { sandboxError } = require('./sandbox-errors');

const ROOT_FIELDS = Object.freeze([
  'project_id', 'root_path', 'root_id', 'root_revision', 'device_id', 'inode',
]);

// This is an internal application boundary. Only a canonical session capture
// can select a snapshot root; the shell's selected workspace is never consulted.
function captureSandboxAuthority(backend, sessionId, supplied) {
  const owner = backend?.projectAuthority;
  if (!supplied || !owner?.captureSession || !owner?.requireCurrent) {
    throw sandboxError('sandbox_authority_invalid');
  }
  const authority = Object.freeze(Object.fromEntries(ROOT_FIELDS.map(key => [key, supplied[key]])));
  const assertCurrent = () => {
    try {
      const current = owner.captureSession(sessionId);
      if (!ROOT_FIELDS.every(key => current[key] === authority[key])) throw new Error('stale');
      owner.requireCurrent(authority);
    } catch {
      throw sandboxError('sandbox_stale_authority');
    }
  };
  assertCurrent();
  if (!authority.root_path) throw sandboxError('sandbox_workspace_required');
  return Object.freeze({ authority, assertCurrent });
}

module.exports = { captureSandboxAuthority };
