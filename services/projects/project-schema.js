'use strict';

const path = require('path');
const { isDeepStrictEqual } = require('util');
const { normalizeWorkspaceRootPath, workspaceRootId } = require('../workspace-root-identity');

const PROJECT_STORE_SCHEMA_VERSION = 1;
const GENERAL_PROJECT_ID = 'project_general';
const GENERAL_PROJECT_NAME = 'General';
const MAX_PROJECTS = 256;
const MAX_PROJECT_NAME_CHARS = 80;
const MAX_RUNTIME_PREFERENCES_BYTES = 16 * 1024;
const PROJECT_ID_RE = /^project_[A-Za-z0-9_-]{1,128}$/u;
const PROJECT_DOCUMENT_KEYS = Object.freeze(['projects', 'schema_version']);
const PROJECT_RECORD_KEYS = Object.freeze([
  'created_at',
  'id',
  'name',
  'root_id',
  'root_path',
  'root_revision',
  'runtime_preferences',
  'updated_at',
]);

function normalizeProjectId(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  return PROJECT_ID_RE.test(id) ? id : '';
}

function normalizeProjectName(value) {
  const name = String(value ?? '')
    // eslint-disable-next-line no-control-regex -- project labels must not persist control characters.
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return name ? name.slice(0, MAX_PROJECT_NAME_CHARS) : '';
}

function normalizeRuntimePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_RUNTIME_PREFERENCES_BYTES) return {};
    const parsed = JSON.parse(serialized);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function normalizeStoredRootPath(value) {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate || !path.isAbsolute(candidate)) return null;
  return normalizeWorkspaceRootPath(candidate) || null;
}

function normalizeRootRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

function normalizeIsoTimestamp(value, fallback = '') {
  const candidate = String(value || '').trim();
  if (candidate) {
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return String(fallback || '');
}

function normalizeProjectRecord(value, { projectId = '', now = '' } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const id = normalizeProjectId(source.id || projectId);
  const name = normalizeProjectName(source.name);
  if (!id || !name) return null;
  const rootPath = normalizeStoredRootPath(source.root_path);
  const createdAt = normalizeIsoTimestamp(source.created_at, now);
  return {
    id,
    name,
    root_path: rootPath,
    root_id: rootPath ? workspaceRootId(rootPath) : null,
    root_revision: normalizeRootRevision(source.root_revision),
    runtime_preferences: normalizeRuntimePreferences(source.runtime_preferences),
    created_at: createdAt,
    updated_at: normalizeIsoTimestamp(source.updated_at, createdAt || now),
  };
}

function createGeneralProject(now = new Date().toISOString()) {
  return {
    id: GENERAL_PROJECT_ID,
    name: GENERAL_PROJECT_NAME,
    root_path: null,
    root_id: null,
    root_revision: 0,
    runtime_preferences: {},
    created_at: now,
    updated_at: now,
  };
}

function hasExactKeys(value, expectedKeys) {
  const keys = Object.keys(value).sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index]);
}

function validateProjectDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'invalid_schema' };
  }
  if (Number.isSafeInteger(value.schema_version)
    && value.schema_version > PROJECT_STORE_SCHEMA_VERSION) {
    return { ok: false, reason: 'future_schema' };
  }
  if (value.schema_version !== PROJECT_STORE_SCHEMA_VERSION
    || !hasExactKeys(value, PROJECT_DOCUMENT_KEYS)
    || !value.projects
    || typeof value.projects !== 'object'
    || Array.isArray(value.projects)) {
    return { ok: false, reason: 'invalid_schema' };
  }
  const entries = Object.entries(value.projects);
  if (entries.length > MAX_PROJECTS
    || !Object.prototype.hasOwnProperty.call(value.projects, GENERAL_PROJECT_ID)) {
    return { ok: false, reason: 'invalid_schema' };
  }
  for (const [projectId, project] of entries) {
    if (!project || typeof project !== 'object' || Array.isArray(project)
      || !hasExactKeys(project, PROJECT_RECORD_KEYS)
      || normalizeProjectId(projectId) !== projectId
      || project.id !== projectId) {
      return { ok: false, reason: 'invalid_schema' };
    }
    const normalized = normalizeProjectRecord(project, { projectId });
    if (!normalized || !isDeepStrictEqual(normalized, project)) {
      return { ok: false, reason: 'invalid_schema' };
    }
  }
  return { ok: true, document: structuredClone(value) };
}

module.exports = {
  GENERAL_PROJECT_ID,
  GENERAL_PROJECT_NAME,
  MAX_PROJECTS,
  MAX_RUNTIME_PREFERENCES_BYTES,
  PROJECT_STORE_SCHEMA_VERSION,
  createGeneralProject,
  normalizeProjectId,
  normalizeProjectName,
  normalizeProjectRecord,
  normalizeRootRevision,
  normalizeRuntimePreferences,
  validateProjectDocument,
};
