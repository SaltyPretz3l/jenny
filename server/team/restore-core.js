'use strict';

// The steps the desktop restore (services/team/host/host-restore.js) and the headless restore
// (server/team/team-restore.js) share, so one file restores alike on both:
//
// - the profile entries a backup never brings in (`movable`): the profile's own lock and owner marker, the two
//   maintenance markers, the ready marker and staging-shaped names;
// - the check that the backup's key is the member store's host key (`hostKeyMatches`);
// - the project roots (`rewriteProjectRoots`): a backup's `projects.json` records each team project's absolute
//   folder on the PC that made it. The host keeps a project record's non-null root as it is at start
//   (team-project-reconcile.js binds only a null root), and on Linux a Windows path is not absolute, so the project
//   store would refuse the whole file as invalid and turn read only. Each team project whose stored root ends in
//   its own id is pointed at `<projects root>/<id>`;
// - the modes of what a restore writes (`DIR_MODE`, `FILE_MODE`; POSIX only, harmless on Windows).
//
// No Electron; nothing here logs.

const fs = require('node:fs');
const path = require('node:path');

const { writeJson } = require('../../services/host/durable-json');
const { readJsonFile } = require('../../services/team/host/host-files');
const { PROJECT_STORE_SCHEMA_VERSION, normalizeProjectRecord } = require('../../services/projects/project-schema');
const { keyPairFromSeed } = require('./ids');
const { DELETE_MARKER, RESTORE_MARKER } = require('./maintenance-markers');
const { GENERAL_PROJECT_ID } = require('./member-schema');
const { MEMBERS_FILE } = require('./member-store');

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const PROJECTS_FILE = 'projects.json';
// Profile entries a backup may carry that are never moved in. A test pins these to team-maintenance.js's own
// KEPT_IN_PROFILE and STAGING.
const NOT_MOVED = new Set(['.host.lock', 'profile-owner.json', DELETE_MARKER, RESTORE_MARKER, 'team-ready.json']);
const STAGING_NAME = /^\.jenny-restoring-[a-f0-9]{12}$/u;

/** True for a profile entry a restore moves in (not one of the kept names, not a staging folder). */
const movable = (name) => !NOT_MOVED.has(name) && !STAGING_NAME.test(name);

/** True when the member store in `profileDir` names the public key of `seed` as the host key. */
function hostKeyMatches(profileDir, seed) {
  try {
    return readJsonFile(path.join(profileDir, MEMBERS_FILE))?.team?.host_public_key === keyPairFromSeed(seed).publicKey;
  } catch {
    return false;
  }
}

/** Removes the entries of `profileDir` a restore never brings in (the desktop restore writes the whole tree first). */
function dropNotMoved(profileDir) {
  let names;
  try { names = fs.readdirSync(profileDir); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
  for (const name of names) {
    if (!movable(name)) fs.rmSync(path.join(profileDir, name), { recursive: true, force: true });
  }
}

/**
 * Points each team project whose stored root ends in its own id at `<projectsRoot>/<id>` in `profileDir`'s
 * `projects.json`. Answers the count, or null for a file of a newer schema than this build's project store (never
 * rewritten: the restore refuses). A file of any other schema is left byte for byte (the store judges it at start).
 */
function rewriteProjectRoots(profileDir, projectsRoot) {
  const file = path.join(profileDir, PROJECTS_FILE);
  let doc;
  try { doc = readJsonFile(file); } catch { return 0; }
  const schema = doc?.schema_version;
  if (Number.isSafeInteger(schema) && schema > PROJECT_STORE_SCHEMA_VERSION) return null;
  if (schema !== PROJECT_STORE_SCHEMA_VERSION) return 0;
  let changed = 0;
  for (const [id, record] of Object.entries(doc?.projects ?? {})) {
    if (id === GENERAL_PROJECT_ID || typeof record?.root_path !== 'string') continue;
    const own = path.join(projectsRoot, id);
    if (record.root_path.split(/[\\/]/u).filter(Boolean).at(-1) !== id || record.root_path === own) continue;
    // The record again through the project store's own normalizer: its root id is derived from the root.
    const moved = normalizeProjectRecord({ ...record, root_path: own }, { projectId: id });
    if (!moved) continue;
    doc.projects[id] = moved;
    changed += 1;
  }
  if (changed) writeJson(file, doc);
  return changed;
}

module.exports = { DIR_MODE, FILE_MODE, NOT_MOVED, dropNotMoved, hostKeyMatches, movable, rewriteProjectRoots };
