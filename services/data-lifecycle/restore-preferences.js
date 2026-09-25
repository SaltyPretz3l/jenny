'use strict';

const fs = require('fs');

const { DATA_ERROR_CODES } = require('../backend/error-codes');
const { archiveError } = require('./archive-format');
const { validateSessionImportPayload } = require('../backend/session-export-import');
const {
  PORTABLE_PREFERENCES_VERSION,
  PORTABLE_SHELL_CONFIG_VERSION,
  normalizePortablePreferences,
  projectPortableShellConfig,
} = require('./portable-preferences-store');
const runtimeArchive = require('./runtime-archive');
const runtimeCoordinationArchive = require('./runtime-coordination-archive');

function readBoundedJson(filePath, maxBytes = 64 * 1024) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'restore_state_invalid', 'Restore state is invalid.');
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'restore_state_invalid', 'Restore state is unreadable.', error);
  }
}

function projectRestoredPreference(entry, sourcePath) {
  let projected = null;
  if (entry.logical_path === 'preferences/portable-preferences.json') {
    const source = readBoundedJson(sourcePath, 256 * 1024);
    if (Number(source?.schema_version) > PORTABLE_PREFERENCES_VERSION) {
      throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'restore_state_invalid', 'Portable preferences use a newer schema version.');
    }
    projected = normalizePortablePreferences(source);
  } else if (entry.logical_path === 'preferences/shell-config.json') {
    const source = readBoundedJson(sourcePath, 1024 * 1024);
    if (Number(source?.version) > PORTABLE_SHELL_CONFIG_VERSION) {
      throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'restore_state_invalid', 'Shell preferences use a newer schema version.');
    }
    projected = projectPortableShellConfig(source);
  }
  return projected ? Buffer.from(JSON.stringify(projected, null, 2)) : null;
}

async function collectRestoredProjections(entries, sourceForEntry) {
  const projections = new Map();
  const sessions = new Map();
  let runtimeLedger = null;
  let coordination = null;
  for (const entry of entries) {
    const source = await sourceForEntry(entry);
    const sourcePath = typeof source === 'string' ? source : source.path;
    const sourceBytes = typeof source === 'string' ? null : source.verifiedBytes;
    if (entry.logical_path.startsWith('sessions/')) {
      const parsed = validateSessionImportPayload(fs.readFileSync(sourcePath, 'utf8'));
      sessions.set(String(entry.restore_metadata?.session_id || ''), parsed.session);
    }
    if (entry.logical_path === 'runtime/runtime-ledger.json') {
      runtimeLedger = runtimeArchive.parseRuntimeArchiveEntryPayload(entry, sourceBytes);
    } else if (runtimeArchive.isRuntimeCoordinationEntry(entry)) {
      coordination = { entry, sourcePath, sourceBytes,
        payload: runtimeArchive.parseRuntimeArchiveEntryPayload(entry, sourceBytes) };
      continue;
    }
    const projected = projectRestoredPreference(entry, sourcePath)
      || runtimeArchive.projectRuntimeArchiveEntry(entry, sourcePath, { sourceBytes });
    if (projected) projections.set(entry.logical_path, projected);
  }
  if (coordination) {
    projections.set(coordination.entry.logical_path,
      runtimeCoordinationArchive.projectRuntimeCoordinationPayload(coordination.payload,
        { runtimeLedger, sessions, ledgerProjection: projections.get('runtime/runtime-ledger.json') }));
  }
  return projections;
}

module.exports = {
  collectRestoredProjections,
  projectRestoredPreference,
  readBoundedJson,
};
