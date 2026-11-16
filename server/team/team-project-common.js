'use strict';

// Small pieces the shared-project files (team-project-commands.js, team-project-delete.js,
// team-project-reconcile.js) share, so each exists once.

const { hostFailure } = require('../api-contract');
const { GENERAL_PROJECT_ID } = require('./member-schema');

function callSafely(fn) {
  try { return fn(); } catch { return null; }
}

// The reason word of a failure answer (`{ error: { reason } }` or `{ reason }`), or ''.
function reasonOf(answer) {
  const reason = answer?.error?.reason ?? answer?.reason;
  return typeof reason === 'string' ? reason : '';
}

const storeFailed = () => hostFailure('persistence', 'team_project_store_failed');

/**
 * The application project records, General left out: `{ records: Map<id, record>, readOnly }`, or null
 * when they cannot be listed. `readOnly` is the project store's own flag: a corrupt, unreadable or newer
 * `projects.json` is answered as a document holding only General, so nothing may be judged from it.
 */
function readRecords(projects) {
  const listed = callSafely(() => projects.listProjects());
  if (listed?.ok !== true || !Array.isArray(listed.projects)) return null;
  const records = new Map(listed.projects.filter((record) => record?.id !== GENERAL_PROJECT_ID)
    .map((record) => [record.id, record]));
  return { records, readOnly: listed.storage?.read_only === true };
}

module.exports = { GENERAL_PROJECT_ID, callSafely, readRecords, reasonOf, storeFailed };
