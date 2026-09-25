'use strict';

const path = require('node:path');
const { workspaceRootId } = require('../workspace-root-identity');

const AUTHORITY_FIELDS = Object.freeze([
  'project_id', 'root_path', 'root_id', 'root_revision', 'device_id', 'inode',
]);
const SESSION_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;

function sameAuthority(left, right) {
  return Boolean(left && right)
    && AUTHORITY_FIELDS.every((field) => left[field] === right[field]);
}

function comparableRoot(rootPath) {
  const resolved = path.resolve(String(rootPath || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function presentationAuthorityError(reason) {
  return Object.assign(new Error('Workspace presentation authority is stale.'), { reason });
}

class ProjectPresentationService {
  constructor({ owner, authority, sessionId, projectAuthorityProvider, getUiWorkspaceRoot }) {
    if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
      throw new TypeError('Project presentation service requires a captured authority.');
    }
    const normalizedSessionId = String(sessionId || '').trim();
    if (!SESSION_PATTERN.test(normalizedSessionId)) {
      throw new TypeError('Project presentation service requires a valid session id.');
    }
    this._owner = owner;
    this._authority = Object.freeze({ ...authority });
    this._sessionId = normalizedSessionId;
    this._projectAuthorityProvider = projectAuthorityProvider;
    this._getUiWorkspaceRoot = getUiWorkspaceRoot;
  }

  _provider() {
    const provider = typeof this._projectAuthorityProvider === 'function'
      ? this._projectAuthorityProvider()
      : this._projectAuthorityProvider;
    if (!provider || typeof provider.captureSession !== 'function'
      || typeof provider.requireCurrent !== 'function') {
      throw presentationAuthorityError('project_authority_unavailable');
    }
    return provider;
  }

  assertCurrent() {
    const provider = this._provider();
    provider.requireCurrent(this._authority);
    if (!sameAuthority(provider.captureSession(this._sessionId), this._authority)) {
      throw presentationAuthorityError('project_authority_stale');
    }
    const authorityRoot = String(this._authority.root_path || '').trim();
    const uiRoot = this.getUiWorkspaceRoot();
    if (!authorityRoot || !uiRoot
      || comparableRoot(authorityRoot) !== comparableRoot(uiRoot)
      || workspaceRootId(authorityRoot) !== this._authority.root_id) {
      throw presentationAuthorityError('workspace_root_mismatch');
    }
    return Object.freeze({
      session_id: this._sessionId,
      workspace_id: this._authority.root_id,
    });
  }

  getUiWorkspaceRoot() {
    return String(this._getUiWorkspaceRoot?.() || '').trim();
  }

  requestPresentation(payload) {
    return this._owner._requestPresentationForAuthority(payload, this);
  }
}

function createProjectPresentationService(options) {
  return new ProjectPresentationService(options);
}

module.exports = { ProjectPresentationService, createProjectPresentationService };
