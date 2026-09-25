'use strict';

const crypto = require('node:crypto');
const fs = require('fs');
const path = require('path');

const { DATA_ERROR_CODES } = require('../backend/error-codes');
const {
  GENERAL_PROJECT_ID,
  GENERAL_PROJECT_NAME,
  validateProjectDocument,
} = require('../projects/project-schema');
const {
  sanitizePermissionDocumentForImport,
  validatePermissionDocument,
} = require('../tools/tool-permission-migrations');
const { archiveError } = require('./archive-format');
const runtimeLedgerArchive = require('./runtime-ledger-archive');
const runtimeCoordinationArchive = require('./runtime-coordination-archive');

const RUNTIME_PAYLOAD_SCHEMA_VERSION = 1;
const MAX_RUNTIME_PAYLOAD_BYTES = 4 * 1024 * 1024;
const RUNTIME_ARCHIVE_ENTRIES = Object.freeze({
  projects: Object.freeze({
    logicalPath: 'runtime/projects.json',
    category: 'project_state',
    payloadKind: 'project_state',
    fileName: 'projects.json',
    supported: true,
  }),
  toolPermissions: Object.freeze({
    logicalPath: 'runtime/tool-permissions.json',
    category: 'tool_permissions',
    payloadKind: 'tool_permissions',
    fileName: 'tool-permissions.json',
    supported: true,
  }),
  runtimeLedger: Object.freeze({
    logicalPath: 'runtime/runtime-ledger.json',
    category: 'runtime_state',
    payloadKind: 'runtime_state',
    fileName: 'runtime-ledger.json',
    supported: true,
  }),
  runtimeCoordination: Object.freeze({
    logicalPath: 'runtime/runtime-coordination.json',
    category: 'runtime_coordination',
    payloadKind: 'runtime_coordination',
    fileName: 'runtime-coordination.json',
    supported: true,
  }),
});

const ENTRY_BY_LOGICAL_PATH = new Map(
  Object.values(RUNTIME_ARCHIVE_ENTRIES).map((entry) => [entry.logicalPath, entry])
);
const RUNTIME_CATEGORIES = new Set(
  Object.values(RUNTIME_ARCHIVE_ENTRIES).map((entry) => entry.category)
);
const WRAPPER_KEYS = Object.freeze(['payload', 'payload_kind', 'payload_schema_version']);
const CALENDAR_LOGICAL_PATH = 'calendar/home-calendar.json';

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function runtimeArchiveError(code, reason, message, cause) {
  return archiveError(code, reason, message, cause);
}

function readBoundedJson(filePath, {
  maxBytes = MAX_RUNTIME_PAYLOAD_BYTES,
  missingAllowed = false,
  source = false,
} = {}) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (missingAllowed && error?.code === 'ENOENT') return null;
    throw runtimeArchiveError(
      source ? DATA_ERROR_CODES.SOURCE_UNREADABLE : DATA_ERROR_CODES.ARCHIVE_CORRUPT,
      source ? 'runtime_source_unreadable' : 'runtime_payload_invalid',
      source ? 'Portable runtime state could not be read.' : 'Archived runtime state is invalid.',
      error
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw runtimeArchiveError(
      source ? DATA_ERROR_CODES.SOURCE_UNREADABLE : DATA_ERROR_CODES.ARCHIVE_CORRUPT,
      source ? 'runtime_source_invalid' : 'runtime_payload_invalid',
      source ? 'Portable runtime state is unsafe or too large.' : 'Archived runtime state is unsafe or too large.'
    );
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw runtimeArchiveError(
      source ? DATA_ERROR_CODES.SOURCE_UNREADABLE : DATA_ERROR_CODES.ARCHIVE_CORRUPT,
      source ? 'runtime_source_invalid' : 'runtime_payload_invalid',
      source ? 'Portable runtime state is malformed.' : 'Archived runtime state is malformed.',
      error
    );
  }
}

function parseBoundedJson(bytes, maxBytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maxBytes) {
    throw runtimeArchiveError(
      DATA_ERROR_CODES.ARCHIVE_CORRUPT,
      'runtime_payload_invalid',
      'Archived runtime state is unsafe or too large.'
    );
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw runtimeArchiveError(
      DATA_ERROR_CODES.ARCHIVE_CORRUPT,
      'runtime_payload_invalid',
      'Archived runtime state is malformed.',
      error
    );
  }
}

function buildWrapper(descriptor, payload) {
  return {
    payload_schema_version: RUNTIME_PAYLOAD_SCHEMA_VERSION,
    payload_kind: descriptor.payloadKind,
    payload,
  };
}

function validateWrapper(value, descriptor) {
  if (!hasExactKeys(value, WRAPPER_KEYS)
    || value.payload_kind !== descriptor.payloadKind
    || !Number.isSafeInteger(value.payload_schema_version)) {
    throw runtimeArchiveError(
      DATA_ERROR_CODES.ARCHIVE_CORRUPT,
      'runtime_payload_invalid',
      'Archived runtime state has an invalid payload contract.'
    );
  }
  if (value.payload_schema_version !== RUNTIME_PAYLOAD_SCHEMA_VERSION) {
    throw runtimeArchiveError(
      DATA_ERROR_CODES.UNSUPPORTED_VERSION,
      'unsupported_runtime_payload_version',
      'Archived runtime state uses an unsupported payload version.'
    );
  }
  return value.payload;
}

function validateProjectPayload(payload) {
  const validated = validateProjectDocument(payload);
  if (!validated.ok) {
    throw runtimeArchiveError(
      validated.reason === 'future_schema'
        ? DATA_ERROR_CODES.UNSUPPORTED_VERSION
        : DATA_ERROR_CODES.ARCHIVE_CORRUPT,
      validated.reason === 'future_schema' ? 'unsupported_project_payload_version' : 'project_payload_invalid',
      'Archived project state is incompatible.'
    );
  }
  return validated.document;
}

function validatePermissionPayload(payload) {
  const validated = validatePermissionDocument(payload);
  if (!validated.ok) {
    throw runtimeArchiveError(
      validated.reason === 'future_schema'
        ? DATA_ERROR_CODES.UNSUPPORTED_VERSION
        : DATA_ERROR_CODES.ARCHIVE_CORRUPT,
      validated.reason === 'future_schema' ? 'unsupported_permission_payload_version' : 'permission_payload_invalid',
      'Archived tool permission state is incompatible.'
    );
  }
  return validated.document;
}

function archiveEntryFromFile(userDataPath, descriptor) {
  const filePath = path.join(userDataPath, descriptor.fileName);
  const raw = readBoundedJson(filePath, { missingAllowed: true, source: true });
  if (raw === null) return null;
  const payload = descriptor.payloadKind === 'project_state'
    ? validateProjectPayload(raw)
    : validatePermissionPayload(raw);
  const data = Buffer.from(JSON.stringify(buildWrapper(descriptor, payload), null, 2), 'utf8');
  if (data.length > MAX_RUNTIME_PAYLOAD_BYTES) {
    throw runtimeArchiveError(
      DATA_ERROR_CODES.SOURCE_UNREADABLE,
      'runtime_source_invalid',
      'Portable runtime state exceeds its archive payload bound.'
    );
  }
  return { logicalPath: descriptor.logicalPath, category: descriptor.category, data };
}

function collectRuntimeArchiveEntries(userDataPath, { runtimeArchivePort = null } = {}) {
  const root = path.resolve(String(userDataPath || ''));
  if (!String(userDataPath || '').trim()) {
    throw new TypeError('collectRuntimeArchiveEntries requires userDataPath.');
  }
  const ledgerPayload = runtimeLedgerArchive.collectRuntimeLedgerPayload(root);
  const ledgerEntry = ledgerPayload === null ? null : {
    logicalPath: RUNTIME_ARCHIVE_ENTRIES.runtimeLedger.logicalPath,
    category: RUNTIME_ARCHIVE_ENTRIES.runtimeLedger.category,
    data: Buffer.from(JSON.stringify(buildWrapper(RUNTIME_ARCHIVE_ENTRIES.runtimeLedger, ledgerPayload), null, 2), 'utf8'),
  };
  if (!runtimeArchivePort && !runtimeCoordinationArchive.isUntouchedRuntimeCoordinationBootstrap(root)) {
    throw runtimeArchiveError(DATA_ERROR_CODES.SOURCE_UNREADABLE,
      'runtime_coordination_port_required', 'Runtime coordination state could not be archived safely.');
  }
  const coordinationPayload = runtimeCoordinationArchive.collectRuntimeCoordinationPayload(runtimeArchivePort);
  const coordinationEntry = coordinationPayload === null ? null : {
    logicalPath: RUNTIME_ARCHIVE_ENTRIES.runtimeCoordination.logicalPath,
    category: RUNTIME_ARCHIVE_ENTRIES.runtimeCoordination.category,
    data: Buffer.from(JSON.stringify(buildWrapper(
      RUNTIME_ARCHIVE_ENTRIES.runtimeCoordination, coordinationPayload), null, 2), 'utf8'),
  };
  if (coordinationEntry?.data.length > runtimeCoordinationArchive.MAX_RUNTIME_COORDINATION_BYTES) {
    throw runtimeArchiveError(DATA_ERROR_CODES.SOURCE_UNREADABLE,
      'runtime_coordination_source_capacity', 'Runtime coordination state exceeds its archive bound.');
  }
  if (ledgerEntry?.data.length > runtimeLedgerArchive.MAX_RUNTIME_LEDGER_BYTES) {
    throw runtimeArchiveError(
      DATA_ERROR_CODES.SOURCE_UNREADABLE,
      'runtime_ledger_source_capacity',
      'Durable runtime state exceeds the portable archive bound.'
    );
  }
  return [
    archiveEntryFromFile(root, RUNTIME_ARCHIVE_ENTRIES.projects),
    archiveEntryFromFile(root, RUNTIME_ARCHIVE_ENTRIES.toolPermissions),
    ledgerEntry,
    coordinationEntry,
  ].filter(Boolean);
}

function validateRuntimeManifestEntries(manifest) {
  for (const entry of manifest.entries || []) {
    const logicalPath = String(entry?.logical_path || '');
    if (logicalPath.startsWith('calendar/')
      && (logicalPath !== CALENDAR_LOGICAL_PATH || entry.category !== 'memory')) {
      throw runtimeArchiveError(
        DATA_ERROR_CODES.ARCHIVE_CORRUPT,
        'restore_entry_disallowed',
        'Archive contains data that cannot be restored here.'
      );
    }
    const descriptor = ENTRY_BY_LOGICAL_PATH.get(logicalPath);
    const runtimeRoot = logicalPath.startsWith('runtime/');
    if (!descriptor && (runtimeRoot || RUNTIME_CATEGORIES.has(entry?.category))) {
      throw runtimeArchiveError(
        DATA_ERROR_CODES.UNSUPPORTED_VERSION,
        'unsupported_runtime_payload',
        'Archive contains runtime state this build cannot restore.'
      );
    }
    if (!descriptor) continue;
    if (!descriptor.supported) {
      throw runtimeArchiveError(
        DATA_ERROR_CODES.UNSUPPORTED_VERSION,
        'unsupported_runtime_payload',
        'Archive contains runtime state this build cannot restore.'
      );
    }
    if (entry.category !== descriptor.category) {
      throw runtimeArchiveError(
        DATA_ERROR_CODES.ARCHIVE_CORRUPT,
        'runtime_payload_category_mismatch',
        'Archived runtime state has an invalid category.'
      );
    }
  }
}

function isUntouchedProjectBootstrap(userDataPath) {
  const filePath = path.join(userDataPath, RUNTIME_ARCHIVE_ENTRIES.projects.fileName);
  let document;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RUNTIME_PAYLOAD_BYTES) return false;
    document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return error?.code === 'ENOENT';
  }
  const validated = validateProjectDocument(document);
  if (!validated.ok) return false;
  const projectIds = Object.keys(validated.document.projects);
  const general = validated.document.projects[GENERAL_PROJECT_ID];
  return projectIds.length === 1
    && general.name === GENERAL_PROJECT_NAME
    && general.root_path === null
    && general.root_id === null
    && general.root_revision === 0
    && Object.keys(general.runtime_preferences).length === 0
    && general.created_at === general.updated_at;
}

function sanitizeProjectsForImport(document, now) {
  const projects = {};
  for (const [projectId, project] of Object.entries(document.projects)) {
    if (project.root_revision >= Number.MAX_SAFE_INTEGER) {
      throw runtimeArchiveError(
        DATA_ERROR_CODES.ARCHIVE_CORRUPT,
        'project_root_revision_exhausted',
        'Archived project root state cannot be invalidated safely.'
      );
    }
    projects[projectId] = {
      ...project,
      root_path: null,
      root_id: null,
      root_revision: project.root_revision + 1,
      updated_at: now,
    };
  }
  const sanitized = { schema_version: document.schema_version, projects };
  const checked = validateProjectDocument(sanitized);
  if (!checked.ok || checked.document.projects[GENERAL_PROJECT_ID].root_path !== null) {
    throw runtimeArchiveError(
      DATA_ERROR_CODES.ARCHIVE_CORRUPT,
      'project_payload_invalid',
      'Archived project state could not be made safe for import.'
    );
  }
  return checked.document;
}

function projectRuntimeArchiveEntry(entry, sourcePath, {
  now = new Date().toISOString(), sourceBytes = null,
} = {}) {
  const descriptor = ENTRY_BY_LOGICAL_PATH.get(String(entry?.logical_path || ''));
  if (!descriptor) return null;
  if (!descriptor.supported) {
    throw runtimeArchiveError(
      DATA_ERROR_CODES.UNSUPPORTED_VERSION,
      'unsupported_runtime_payload',
      'Archive contains runtime state this build cannot restore.'
    );
  }
  const maxBytes = descriptor.payloadKind === 'runtime_state'
    ? runtimeLedgerArchive.MAX_RUNTIME_LEDGER_BYTES
    : descriptor.payloadKind === 'runtime_coordination'
      ? runtimeCoordinationArchive.MAX_RUNTIME_COORDINATION_BYTES : MAX_RUNTIME_PAYLOAD_BYTES;
  const wrapper = Buffer.isBuffer(sourceBytes)
    ? parseBoundedJson(sourceBytes, maxBytes)
    : readBoundedJson(sourcePath, { maxBytes });
  const payload = validateWrapper(wrapper, descriptor);
  let projected;
  if (descriptor.payloadKind === 'project_state') {
    projected = sanitizeProjectsForImport(validateProjectPayload(payload), now);
  } else if (descriptor.payloadKind === 'runtime_state') {
    return runtimeLedgerArchive.projectRuntimeLedgerPayload(payload, { now });
  } else if (descriptor.payloadKind === 'runtime_coordination') {
    return runtimeCoordinationArchive.projectRuntimeCoordinationPayload(payload);
  } else {
    const permissions = validatePermissionPayload(payload);
    const sanitized = sanitizePermissionDocumentForImport(permissions, { now });
    if (!sanitized.ok) {
      throw runtimeArchiveError(
        DATA_ERROR_CODES.ARCHIVE_CORRUPT,
        'permission_payload_invalid',
        'Archived tool permission state could not be made safe for import.'
      );
    }
    projected = sanitized.document;
  }
  const projectedBytes = Buffer.from(JSON.stringify(projected, null, 2), 'utf8');
  if (projectedBytes.length > MAX_RUNTIME_PAYLOAD_BYTES) {
    throw runtimeArchiveError(
      DATA_ERROR_CODES.ARCHIVE_CORRUPT,
      'runtime_payload_invalid',
      'Imported runtime state exceeds its durable storage bound.'
    );
  }
  return projectedBytes;
}

function runtimeDestinationForEntry(entry, userDataPath) {
  const descriptor = ENTRY_BY_LOGICAL_PATH.get(String(entry?.logical_path || ''));
  if (!descriptor?.supported) return null;
  return descriptor.payloadKind === 'runtime_state'
    ? path.join(userDataPath, runtimeLedgerArchive.RUNTIME_LEDGER_DIRECTORY)
    : descriptor.payloadKind === 'runtime_coordination'
      ? runtimeCoordinationArchive.runtimeCoordinationDestinations(userDataPath)[0]
    : path.join(userDataPath, descriptor.fileName);
}

function runtimeDestinationsForEntry(entry, userDataPath) {
  const descriptor = ENTRY_BY_LOGICAL_PATH.get(String(entry?.logical_path || ''));
  if (!descriptor?.supported) return [];
  return descriptor.payloadKind === 'runtime_coordination'
    ? runtimeCoordinationArchive.runtimeCoordinationDestinations(userDataPath)
    : [runtimeDestinationForEntry(entry, userDataPath)];
}

function additionalRuntimeDestinations(manifest, userDataPath) {
  return (manifest?.entries || []).flatMap(entry => runtimeDestinationsForEntry(entry, userDataPath).slice(1));
}

function runtimeArchiveEntryByteLimit(entry) {
  const descriptor = ENTRY_BY_LOGICAL_PATH.get(String(entry?.logical_path || ''));
  if (!descriptor?.supported) return null;
  return descriptor.payloadKind === 'runtime_state'
    ? runtimeLedgerArchive.MAX_RUNTIME_LEDGER_BYTES
    : descriptor.payloadKind === 'runtime_coordination'
      ? runtimeCoordinationArchive.MAX_RUNTIME_COORDINATION_BYTES : MAX_RUNTIME_PAYLOAD_BYTES;
}

function publishRuntimeProjection(projection, targetPath, ownerRoot, options = {}) {
  if (runtimeCoordinationArchive.isRuntimeCoordinationProjection(projection)) {
    runtimeCoordinationArchive.publishRuntimeCoordinationProjection(ownerRoot, projection, options);
    return true;
  }
  if (!runtimeLedgerArchive.isRuntimeLedgerProjection(projection)) return false;
  runtimeLedgerArchive.publishRuntimeLedgerProjection(targetPath, projection, { ownerRoot });
  return true;
}

function isRuntimeCoordinationEntry(entry) {
  return ENTRY_BY_LOGICAL_PATH.get(String(entry?.logical_path || ''))?.payloadKind === 'runtime_coordination';
}

function parseRuntimeArchiveEntryPayload(entry, sourceBytes) {
  const descriptor = ENTRY_BY_LOGICAL_PATH.get(String(entry?.logical_path || ''));
  if (!descriptor?.supported) return null;
  const maxBytes = runtimeArchiveEntryByteLimit(entry);
  return validateWrapper(parseBoundedJson(sourceBytes, maxBytes), descriptor);
}

async function verifyRuntimeArchiveEntryBytes(entry, sourcePath) {
  const maxBytes = runtimeArchiveEntryByteLimit(entry);
  if (maxBytes === null) return null;
  if (entry.size > maxBytes) {
    throw runtimeArchiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'runtime_payload_invalid',
      'Archived runtime state is too large.');
  }
  let descriptor;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
      | (fs.constants.O_NONBLOCK || 0);
    descriptor = fs.openSync(sourcePath, flags);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size !== entry.size) {
      throw runtimeArchiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'restore_state_invalid',
        'Staged runtime state is unsafe.');
    }
    const chunks = [];
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(sourcePath, { fd: descriptor, autoClose: false })) {
      chunks.push(chunk);
      hash.update(chunk);
    }
    const after = fs.fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1
      || String(after.dev) !== String(before.dev) || String(after.ino) !== String(before.ino)) {
      throw runtimeArchiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'restore_state_invalid',
        'Staged runtime state changed during verification.');
    }
    if (hash.digest('hex') !== entry.sha256) {
      throw runtimeArchiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_checksum_failed',
        'Staged runtime state failed verification.');
    }
    return Buffer.concat(chunks, before.size);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function validateStagedRuntimeEntries(manifest, dataRoot) {
  const root = path.resolve(dataRoot);
  for (const entry of manifest.entries || []) {
    if (!String(entry?.logical_path || '').startsWith('runtime/')) continue;
    const sourcePath = path.resolve(root, ...entry.logical_path.split('/'));
    const relative = path.relative(root, sourcePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw runtimeArchiveError(
        DATA_ERROR_CODES.UNSAFE_PATH,
        'unsafe_restore_path',
        'Staged runtime state escapes its owner root.'
      );
    }
    projectRuntimeArchiveEntry(entry, sourcePath);
  }
}

module.exports = {
  MAX_RUNTIME_PAYLOAD_BYTES,
  additionalRuntimeDestinations,
  RUNTIME_ARCHIVE_ENTRIES,
  RUNTIME_PAYLOAD_SCHEMA_VERSION,
  collectRuntimeArchiveEntries,
  isRuntimeLedgerProjection: runtimeLedgerArchive.isRuntimeLedgerProjection,
  isRuntimeCoordinationEntry,
  isUntouchedRuntimeCoordinationBootstrap: runtimeCoordinationArchive.isUntouchedRuntimeCoordinationBootstrap,
  isUntouchedRuntimeBootstrap: runtimeLedgerArchive.isUntouchedRuntimeBootstrap,
  isUntouchedProjectBootstrap,
  projectRuntimeArchiveEntry,
  parseRuntimeArchiveEntryPayload,
  publishRuntimeProjection,
  publishRuntimeLedgerProjection: runtimeLedgerArchive.publishRuntimeLedgerProjection,
  runtimeArchiveEntryByteLimit,
  runtimeDestinationForEntry,
  runtimeDestinationsForEntry,
  sanitizeProjectsForImport,
  validateRuntimeManifestEntries,
  validateStagedRuntimeEntries,
  verifyRuntimeArchiveEntryBytes,
};
