'use strict';

// Which project's skills one chat may list: the seam shared by skills.getState
// (the `/` picker) and the request-time invocation check, so both agree with
// the sidecar's request-scoped skills_config (session-execution-authority.js).

const fs = require('fs');
const path = require('path');
const { normalizeString } = require('./shared/normalize');
const { GENERAL_PROJECT_ID, normalizeProjectId } = require('./projects/project-schema');
const { ensureJennyDirGitignoreSync } = require('./jenny-project-dir');

const GENERAL_SKILLS_AUTHORITY = Object.freeze({ project_id: GENERAL_PROJECT_ID, root_path: null });

// The project skill folder a captured authority grants ('' for a null root).
function authorityProjectRoot(authority) {
  if (!normalizeProjectId(authority?.project_id)
    || (authority.root_path !== null && (typeof authority.root_path !== 'string'
      || !path.isAbsolute(authority.root_path)))) {
    throw new TypeError('Invalid project authority for skills.');
  }
  return authority.root_path ? path.join(authority.root_path, '.jenny', 'skills') : '';
}

// A persisted session's canonical binding wins; a draft (not persisted yet)
// may name the project it will be created in; anything else, or any capture
// failure, is General (no project skills). Fail closed: never the open Workspace.
function resolveSkillsAuthority(projectAuthority, { sessionId = '', projectId = '' } = {}) {
  const session = normalizeString(sessionId);
  const project = normalizeString(projectId);
  if (session && typeof projectAuthority?.captureSession === 'function') {
    try { return projectAuthority.captureSession(session); } catch (error) {
      if (error?.reason !== 'session_not_found') return GENERAL_SKILLS_AUTHORITY;
    }
  }
  if (project && typeof projectAuthority?.captureProject === 'function') {
    try { return projectAuthority.captureProject(project); } catch (_error) { /* unknown project */ }
  }
  return GENERAL_SKILLS_AUTHORITY;
}

// Creates a skill scope folder. A project's lives in `.jenny/skills`, so its
// `.jenny` ignores itself for Git (best effort).
function createScopeFolder(folderPath, { project = false } = {}) {
  fs.mkdirSync(folderPath, { recursive: true });
  if (project) ensureJennyDirGitignoreSync(path.dirname(folderPath));
}

module.exports = { GENERAL_SKILLS_AUTHORITY, authorityProjectRoot, createScopeFolder, resolveSkillsAuthority };
