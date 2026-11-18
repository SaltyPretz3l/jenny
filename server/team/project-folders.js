'use strict';

// The team host's project folders: `<projects root>/<project id>/`, and the trash they move to on
// delete, `<trash root>/<project id>-<UTC digits>`. Every function takes a project id, never a path,
// and checks it against PROJECT_ID_PATTERN first. Before every operation the root it is about to use
// is checked again: a directory, not a link, whose real path is still the configured one; otherwise
// nothing is touched. A check that cannot tell is a refusal, never "absent". Log lines carry counts,
// reason words and project ids only, never a path or a name.
//
// `create`, `locate`, `has`, `isEmpty`, `countFiles`, `list`, `trash` and `childState` are synchronous;
// `sweepTrash` and slice 3-8b's file IO (project-folder-io.js: `measure`, `listFiles`, `openListed`,
// `sweepInstalls`, `install`; row 175's `readListed`) are asynchronous.

const fs = require('node:fs');
const path = require('node:path');

const { removeTree } = require('../../services/fs-remove-no-follow');
const { sameOrWithin } = require('../config');
const { ownDirectory, samePath } = require('./file-checks');
const { utcStamp } = require('./bounded-log');
const { PROJECT_ID_PATTERN } = require('./member-schema');
const {
  DOWNLOAD_CHANGED, ENTRY_COUNT_CAP, FILE_COUNT_CAP, INSTALL_FAILED, PATH_INVALID, ROOT_UNAVAILABLE, TARGET_EXISTS,
  absentCode, createFolderTransfer, entryState, readNames, refuse, treeEntries,
} = require('./project-folder-io');
const { safeLogger } = require('./safe-logger');

const LIST_LIMIT = 4096;
// Each a call: at most this many removals and this many failed removals.
const SWEEP_LIMIT = 64;
const TRASH_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// The first group must also pass `validId`, so the sweep follows any change to the id rule.
const TRASH_NAME = /^(.+)-([0-9]{17})$/u;

const validId = (projectId) => typeof projectId === 'string' && PROJECT_ID_PATTERN.test(projectId);

// The time a stamp names, or null when it names no real instant (a month 13, a day 32).
function timeOfStamp(stamp) {
  const field = (start, end) => Number(stamp.slice(start, end));
  const ms = Date.UTC(field(0, 4), field(4, 6) - 1, field(6, 8), field(8, 10), field(10, 12), field(12, 14), field(14, 17));
  return utcStamp(ms) === stamp ? ms : null;
}

function optionalRoot(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError(`${name} must be null or an absolute path.`);
  return value;
}

/** A real directory at its own real path, the configured one (file-checks.js `ownDirectory`). Any doubt is false. */
function rootUsable(root) {
  return root !== null && ownDirectory(root) !== null;
}

function createProjectFolders({
  projectsRoot = null, trashRoot = null, clock = Date.now, logger, countCaps = {}, hardLinks = true,
} = {}) {
  const projects = optionalRoot(projectsRoot, 'projectsRoot');
  const trashDir = optionalRoot(trashRoot, 'trashRoot');
  // A live project may be named `project_x-<17 digits>`: a sweep over the projects root would take it for old trash.
  if (projects !== null && trashDir !== null && (sameOrWithin(projects, trashDir) || sameOrWithin(trashDir, projects))) {
    throw new TypeError('trashRoot must be apart from projectsRoot.');
  }
  const log = safeLogger(logger);
  const now = typeof clock === 'function' ? clock : Date.now;
  // Test seam: lower caps for `countFiles`, the walk and the download listing.
  const fileCap = countCaps.files ?? FILE_COUNT_CAP;
  const entryCap = countCaps.entries ?? ENTRY_COUNT_CAP;

  // The id is checked before the roots, so a bad id answers the same with any root.
  function gate(projectId, { trash = false } = {}) {
    if (!validId(projectId)) return refuse(PATH_INVALID);
    if (!rootUsable(projects) || (trash && !rootUsable(trashDir))) return refuse(ROOT_UNAVAILABLE);
    return null;
  }

  function failed(event, projectId) {
    log('WARN', event, { project_id: projectId, reason: ROOT_UNAVAILABLE });
    return refuse(ROOT_UNAVAILABLE);
  }

  /**
   * Exclusive, non-recursive mkdir; a folder that is already there is refused, never adopted. The answer
   * is the real path, and only when its parent is still the configured root (a folder that landed
   * elsewhere is left where it is).
   */
  function create(projectId) {
    const refused = gate(projectId);
    if (refused) return refused;
    try {
      fs.mkdirSync(path.join(projects, projectId));
      const real = fs.realpathSync.native(path.join(projects, projectId));
      if (!samePath(path.dirname(real), projects)) return failed('team.project_folder.create_failed', projectId);
      return { ok: true, path: real };
    } catch {
      return failed('team.project_folder.create_failed', projectId);
    }
  }

  /**
   * The real path of a folder that is already there (a create that stopped before its bind), only when it
   * is a directory, not a link, directly under the configured root. Used by the start-up reconcile alone.
   */
  function locate(projectId) {
    const refused = gate(projectId);
    if (refused) return refused;
    const folder = path.join(projects, projectId);
    if (entryState(folder) !== 'present') return refuse(ROOT_UNAVAILABLE);
    try {
      const real = fs.realpathSync.native(folder);
      return samePath(path.dirname(real), projects) && samePath(real, folder) ? { ok: true, path: real } : refuse(ROOT_UNAVAILABLE);
    } catch {
      return refuse(ROOT_UNAVAILABLE);
    }
  }

  function has(projectId) {
    const refused = gate(projectId);
    return refused ?? { ok: true, state: entryState(path.join(projects, projectId)) };
  }

  /** `{ ok: true, empty }` for a present folder (one entry read at most); a link or a doubt is refused. */
  function isEmpty(projectId) {
    const refused = gate(projectId);
    if (refused) return refused;
    const folder = path.join(projects, projectId);
    if (entryState(folder) !== 'present') return refuse(ROOT_UNAVAILABLE);
    const read = readNames(folder, 1);
    return read === null ? refuse(ROOT_UNAVAILABLE) : { ok: true, empty: read.names.length === 0 };
  }

  /**
   * The regular files under a project folder, counted without following a link (a link is not counted
   * and never entered). It stops at FILE_COUNT_CAP files or ENTRY_COUNT_CAP entries read, whichever comes
   * first, and answers `capped: true` with the files counted so far. An absent folder counts 0; a folder
   * or subfolder that cannot be read is refused.
   */
  function countFiles(projectId) {
    const refused = gate(projectId);
    if (refused) return refused;
    const top = path.join(projects, projectId);
    const state = entryState(top);
    if (state === 'absent') return { ok: true, files: 0, capped: false };
    if (state !== 'present') return refuse(ROOT_UNAVAILABLE);
    let files = 0;
    let entries = 0;
    try {
      for (const { entry } of treeEntries(top)) {
        entries += 1;
        if (entry.isFile()) files += 1;
        if (files >= fileCap || entries >= entryCap) return { ok: true, files, capped: true };
      }
    } catch {
      return refuse(ROOT_UNAVAILABLE);
    }
    return { ok: true, files, capped: false };
  }

  /** True when both roots are usable, so a `trash` would not refuse for its roots. */
  function trashReady() {
    return rootUsable(projects) && rootUsable(trashDir);
  }

  /** True when `rootPath` is exactly this project's own folder, `<projects root>/<id>`. */
  function ownsRoot(projectId, rootPath) {
    return projects !== null && validId(projectId) && typeof rootPath === 'string' && samePath(rootPath, path.join(projects, projectId));
  }

  /** The project folders under the root; every other entry is only counted. A partial read is refused. */
  function list() {
    if (!rootUsable(projects)) return refuse(ROOT_UNAVAILABLE);
    const read = readNames(projects, LIST_LIMIT);
    if (read === null || read.truncated) return refuse(ROOT_UNAVAILABLE);
    const projectIds = read.names.filter((name) => validId(name) && entryState(path.join(projects, name)) === 'present');
    return { ok: true, project_ids: projectIds.sort(), unknown: read.names.length - projectIds.length };
  }

  /**
   * One rename into the trash. A link standing where the folder should be is moved as the link
   * itself (rename never follows it). Another volume (EXDEV) and an existing target are refused;
   * there is no copy fallback. What a caller may rely on (3-4b): the name is checked absent and then
   * renamed, so another process writing in the trash root between the two can at most lose its own
   * empty directory of that exact name on POSIX (rename replaces only an empty directory); a non-empty
   * directory or a file there fails the rename, and the project's files are never merged or lost.
   */
  function trash(projectId) {
    const refused = gate(projectId, { trash: true });
    if (refused) return refused;
    const source = path.join(projects, projectId);
    // Not entryState: a link or a file at the source is moved, and only absence means "nothing to move".
    try {
      fs.lstatSync(source);
    } catch (error) {
      if (absentCode(error)) return { ok: true, moved: false };
      return failed('team.project_folder.trash_failed', projectId);
    }
    const stamp = utcStamp(now());
    if (stamp === null) return failed('team.project_folder.trash_failed', projectId);
    const target = path.join(trashDir, `${projectId}-${stamp}`);
    if (entryState(target) !== 'absent') return failed('team.project_folder.trash_failed', projectId);
    try {
      fs.renameSync(source, target);
    } catch {
      return failed('team.project_folder.trash_failed', projectId);
    }
    log('INFO', 'team.project_folder.trashed', { project_id: projectId });
    return { ok: true, moved: true };
  }

  function sweepRefused() {
    log('WARN', 'team.project_trash.sweep_refused', { reason: ROOT_UNAVAILABLE });
    return refuse(ROOT_UNAVAILABLE);
  }

  /**
   * Removes trash entries named `<project id>-<UTC digits>` whose digits are more than 7 days before
   * `clock()`, at most 64 removals and 64 failed removals a call (the rest are kept for the next
   * sweep). The age comes from the name, never from file times. Other names are left and counted.
   * Past 4,096 entries it sweeps what it read and answers `truncated: true`.
   */
  async function sweepTrash() {
    const current = now();
    if (!Number.isFinite(current)) return sweepRefused();
    if (!rootUsable(projects) || !rootUsable(trashDir)) return sweepRefused();
    const read = readNames(trashDir, LIST_LIMIT);
    if (read === null) return sweepRefused();
    const counts = { removed: 0, kept: 0, unknown: 0, failed: 0 };
    for (const name of read.names) {
      const match = TRASH_NAME.exec(name);
      const time = match && validId(match[1]) ? timeOfStamp(match[2]) : null;
      if (time === null) {
        counts.unknown += 1;
      } else if (current - time <= TRASH_AGE_MS || counts.removed >= SWEEP_LIMIT || counts.failed >= SWEEP_LIMIT) {
        counts.kept += 1;
      } else if (!rootUsable(trashDir)) {
        // The trash root is checked again before each removal.
        counts.failed += 1;
      } else {
        try {
          await removeTree(path.join(trashDir, name));
          counts.removed += 1;
        } catch {
          counts.failed += 1;
        }
      }
    }
    log('INFO', 'team.project_trash.swept', { ...counts, truncated: read.truncated });
    return { ok: true, ...counts, truncated: read.truncated };
  }

  const transfer = createFolderTransfer({ projects, gate, rootReady: () => rootUsable(projects), log, entryCap, fileCap,
    hardLinks });

  return Object.freeze({
    hasRoot: projects !== null, create, locate, has, isEmpty, countFiles, list, trash, trashReady, ownsRoot, sweepTrash,
    ...transfer,
  });
}

module.exports = {
  DOWNLOAD_CHANGED, ENTRY_COUNT_CAP, FILE_COUNT_CAP, INSTALL_FAILED, PATH_INVALID, ROOT_UNAVAILABLE, TARGET_EXISTS,
  createProjectFolders,
};
