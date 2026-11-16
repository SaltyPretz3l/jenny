'use strict';

// The team host's project file transfer, wired once by team-main.js (slice 3-8b): the transfer core on its
// staging root `<profile>/team-uploads/`, the commands and part routes (project-files.js,
// project-file-routes.js), the membership subscriber, the project-change hook and the idle sweep.
//
// - The staging root is made at start if missing (one level) and checked by the core's real-path rule; the
//   core's open removes everything a previous run staged, and install folders a stopped install left under the
//   projects root are swept. A host with no projects root makes no staging root and builds no core: every
//   operation and route answers unavailable.
// - Windows (slice 3-8c, the real platform): open() first proves once on both roots what file-checks.js needs from
//   the volumes (`probeVolumes`), and a failure is logged once with its reason and no path; the host then offers no
//   file transfer. The scratch folders are named so that the core's open and the install sweep remove any a stopped
//   start leaves.
// - The project audit is the instance team-approvals.js constructs, read through its getter; none is made here.
// - Logs carry event names, ids, counts and reasons only.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { WINDOWS, probeVolumes: defaultProbe } = require('./file-checks');
const { createTransferCore } = require('./transfer-core');
const { createProjectFileRoutes } = require('./project-file-routes');
const { createProjectFiles } = require('./project-files');
const { safeLogger } = require('./safe-logger');
const { runningTurn } = require('./turn-starter');

const STAGING_DIR = 'team-uploads';
// Lapsed uploads (an hour idle) and manifests (ten minutes idle) are swept this often.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// True while a turn runs in any conversation of the project, and on any doubt (fail closed).
function projectTurnRunning(backend) {
  return (projectId) => {
    try {
      const current = backend();
      const listed = current?.sessionStore?.listSessions?.();
      if (!Array.isArray(listed)) return true;
      return listed.some((summary) => summary?.project_id === projectId && runningTurn(current, summary.id) !== null);
    } catch {
      return true;
    }
  };
}

/**
 * userDataPath: the profile. folders: project-folders.js. store: the member store. authorize: the one function.
 * serialized: the project commands' chain. audit(): the shared ProjectAudit. backend(): the backend, lazily.
 * publish(type, payload, options): the host's event publish, lazily.
 */
function createTeamProjectFiles({
  userDataPath, folders, store, authorize, serialized, audit = () => null, backend = () => null, publish = () => {},
  clock = Date.now, randomBytes = crypto.randomBytes, logger = null, statfs, limits, coreLimits,
  projectsRoot = null, probeVolumes = defaultProbe,
} = {}) {
  const log = safeLogger(logger);
  const stagingRoot = path.join(userDataPath, STAGING_DIR);
  let core = null;
  let timer = null;
  const build = (transfer) => createProjectFiles({ core: transfer, folders, store, authorize, serialized, audit,
    turnRunning: projectTurnRunning(backend), publish: (...args) => publish(...args),
    roots: [stagingRoot, projectsRoot], statfs, clock, randomBytes, logger, limits });
  // Until open() succeeds, every entry answers unavailable.
  let files = build(null);
  const routes = createProjectFileRoutes({ files: () => files, logger });

  async function open() {
    if (folders?.hasRoot !== true) return { ok: false, reason: 'team_project_files_unavailable' };
    try {
      fs.mkdirSync(stagingRoot, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        log('WARN', 'team.project_files.staging_unavailable', { reason: 'staging_mkdir_failed' });
        return { ok: false, reason: 'staging_mkdir_failed' };
      }
    }
    if (WINDOWS) {
      const volume = await probeVolumes(stagingRoot, projectsRoot, randomBytes(16).toString('base64url'));
      if (!volume.ok) {
        log('WARN', 'team.project_files.volume_unsupported', { reason: volume.reason });
        return { ok: false, reason: 'volume_unsupported' };
      }
    }
    const transfer = createTransferCore({ stagingRoot, clock, randomBytes, logger, limits: coreLimits });
    const opened = await transfer.open();
    if (!opened.ok) {
      log('WARN', 'team.project_files.staging_unavailable', { reason: 'staging_refused' });
      return { ok: false, reason: 'staging_refused' };
    }
    await folders.sweepInstalls();
    core = transfer;
    files = build(core);
    timer = setInterval(() => { files.sweep().catch(() => log('WARN', 'team.project_files.sweep_failed')); }, SWEEP_INTERVAL_MS);
    timer.unref?.();
    return { ok: true };
  }

  // Team role changes and revocations: every upload and manifest is asked about again.
  function attach() {
    return [store.onMembershipChange(() => { try { files.recheck(); } catch { log('WARN', 'team.project_files.recheck_failed'); } })];
  }

  async function close() {
    if (timer !== null) clearInterval(timer);
    timer = null;
    if (core) await core.close();
  }

  const commands = Object.freeze({
    handles: (operation) => files.handles(operation),
    isRead: (operation) => files.isRead(operation),
    dispatch: (command, call) => files.dispatch(command, call),
    // Slice 3-9: whether this host serves file transfer now (the `files_supported` of `projects.list`).
    supported: () => files.filesUnavailable() === null,
  });

  return Object.freeze({
    open, attach, close, commands, routes,
    // The project-change hook (team-project-commands.js `subscribeProjectChanges`).
    dropForProject: (event) => files.recheck(event),
    resources: () => ({ ...files.resources(), core: core ? core.resources() : null }),
    stagingRoot,
  });
}

module.exports = { STAGING_DIR, createTeamProjectFiles };
