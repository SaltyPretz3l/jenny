'use strict';

// The quotas of team project files (TEAM_PROJECTS_SPEC "Upload and download", slice 3-8b): 2 GiB and 10,000
// files a project, 8 GiB over every project, and the disk reserve on the staging and projects roots. Checked at
// begin and again at commit, both on the host's one project chain, so no install runs during a measure.
//
// - The byte measure (project-folder-io.js `measure`) is held per project. A check measures its own project when
//   its measure is missing, failed, capped or ten minutes old, and every other active project the member store
//   lists when it has none (so a project made after the start counts from its first check), when its walk failed
//   a minute ago or more, or when its measure is an hour old (not what that check just measured). An install adds
//   its bytes and files to the held measure.
// - A project whose walk fails or stops at the entry cap is full: it refuses only its own begins and counts as the
//   project byte limit in the all-projects total. A capped one is measured again only at its own next check; a
//   failed walk (a root that could not be read) is tried again after a minute at any check.
// - Install folders a stopped install left are swept before a measure.
// - Open uploads count their declared bytes and files against their project and the total until they finish.

const { hostFailure } = require('../api-contract');
const { createDiskAdmission } = require('../resource-limits');
const { GENERAL_PROJECT_ID } = require('./member-schema');

const MEASURE_AGE_MS = 10 * 60 * 1000;
// Another project's measure counts in the total: refreshed when this old, and a failed walk sooner.
const OTHER_AGE_MS = 60 * 60 * 1000;
const FAILED_RETRY_MS = 60 * 1000;

const quotaFull = () => hostFailure('limit', 'team_project_quota');

/**
 * folders: project-folders.js. store: the member store. limits: { projectBytes, projectFiles, allBytes }.
 * openUploads(): the open upload records ({ projectId, totalBytes, fileCount }). held(): the core's
 * { reservedBytes, stagedBytes }. roots, statfs: the disk reserve.
 */
function createProjectQuota({ folders, store, limits, openUploads, held, roots = [], statfs, clock, log }) {
  const measures = new Map();
  let diskExtra = 0;
  const admitDisk = createDiskAdmission(roots, { ...(statfs ? { statfs } : {}), logger: log, extraBytes: () => diskExtra });

  async function measureOne(projectId) {
    const result = await folders.measure(projectId);
    const value = result.ok && !result.capped
      ? { bytes: result.bytes, files: result.files, full: false, failed: false, at: clock() }
      : { bytes: limits.projectBytes, files: 0, full: true, failed: !result.ok, at: clock() };
    measures.set(projectId, value);
    return value;
  }

  function activeProjects() {
    try {
      return (store.snapshot()?.projects ?? [])
        .filter((row) => row.state === 'active' && row.project_id !== GENERAL_PROJECT_ID).map((row) => row.project_id);
    } catch {
      return [];
    }
  }

  // Another project's held measure is missing, or too old to trust in the total.
  function staleElsewhere(value) {
    if (!value) return true;
    const age = clock() - value.at;
    return age >= OTHER_AGE_MS || (value.failed && age >= FAILED_RETRY_MS);
  }

  // The held measures, brought up to date for a check on `projectId`; the set of projects measured just now.
  async function refresh(projectId) {
    await folders.sweepInstalls();
    const done = new Set();
    for (const id of activeProjects()) {
      if (!staleElsewhere(measures.get(id))) continue;
      await measureOne(id);
      done.add(id);
    }
    const own = measures.get(projectId);
    if (!done.has(projectId) && (!own || own.full || clock() - own.at >= MEASURE_AGE_MS)) {
      await measureOne(projectId);
    }
  }

  /**
   * null when `files` more files and `bytes` more bytes fit in `projectId` and in every project together (open
   * uploads included, so a commit, whose upload is open, passes 0 and 0), else the quota refusal.
   */
  async function refusal(projectId, files, bytes) {
    const started = clock();
    await refresh(projectId);
    log('INFO', 'team.project_files.measured', { project_id: projectId, ms: Math.max(0, clock() - started) });
    const own = measures.get(projectId);
    if (!own || own.full) return quotaFull();
    const open = openUploads();
    const here = open.filter((record) => record.projectId === projectId);
    const sum = (list, key) => list.reduce((total, record) => total + record[key], 0);
    if (own.bytes + sum(here, 'totalBytes') + bytes > limits.projectBytes) return quotaFull();
    if (own.files + sum(here, 'fileCount') + files > limits.projectFiles) return quotaFull();
    const measured = [...measures.values()].reduce((total, value) => total + value.bytes, 0);
    if (measured + sum(open, 'totalBytes') + bytes > limits.allBytes) return quotaFull();
    return null;
  }

  /** null when the two roots keep their reserve with `bytes` more staged, else the retryable refusal. */
  function diskRefusal(bytes) {
    const core = held();
    diskExtra = Math.max(0, core.reservedBytes - core.stagedBytes) + bytes;
    return admitDisk() ? null : hostFailure('unavailable', 'disk_pressure', '', true);
  }

  function installed(projectId, bytes, files) {
    const value = measures.get(projectId);
    if (value && !value.full) measures.set(projectId, { ...value, bytes: value.bytes + bytes, files: value.files + files });
  }

  return Object.freeze({
    refusal, diskRefusal, installed,
    forget: (projectId) => measures.delete(projectId),
    size: () => measures.size,
  });
}

module.exports = { MEASURE_AGE_MS, createProjectQuota };
