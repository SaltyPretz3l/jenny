'use strict';

// The two files that say a restore is waiting or was just promoted. Startup
// checks them on every launch, so this module stays free of the restore graph.

const path = require('path');

const PENDING_SUFFIX = '.jenny-restore-pending.json';
const ACTIVE_RESTORE_RELATIVE_PATH = path.join('data-lifecycle', 'restore-active.json');

function restorePointerPath(userDataPath) {
  const root = path.resolve(String(userDataPath || ''));
  return path.join(path.dirname(root), `.${path.basename(root)}${PENDING_SUFFIX}`);
}

function activeRestoreMarkerPath(userDataPath) {
  return path.join(path.resolve(String(userDataPath || '')), ACTIVE_RESTORE_RELATIVE_PATH);
}

module.exports = {
  activeRestoreMarkerPath,
  restorePointerPath,
};
