'use strict';

const fs = require('fs');

const { DATA_ERROR_CODES } = require('../backend/error-codes');
const { archiveError } = require('./archive-format');
const { normalizePortablePreferences, projectPortableShellConfig } = require('./portable-preferences-store');

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
    projected = normalizePortablePreferences(readBoundedJson(sourcePath, 256 * 1024));
  } else if (entry.logical_path === 'preferences/shell-config.json') {
    projected = projectPortableShellConfig(readBoundedJson(sourcePath, 1024 * 1024));
  }
  return projected ? Buffer.from(JSON.stringify(projected, null, 2)) : null;
}

module.exports = {
  projectRestoredPreference,
  readBoundedJson,
};
