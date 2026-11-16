'use strict';

// `team-copy-in --project <project_id> --folder <name>` (slice 3-13): copies the folder `<name>` from the setup
// service's read-only import mount into a team project, as a new top-level folder of that name, on a stopped
// headless host. Shell access to the stopped host is the owner (team-maintenance.js); no authorization function
// runs here. The actor is the local command.
//
// The copy goes through the code a member's upload ends in: the project file commands (project-files.js: the
// project gate, the 2,000-file and quota checks, the new-folder and case-fold rules), the transfer core on the
// profile's staging root (the manifest's 64 MiB a file, 512 MiB a copy, name rules and collision rule; every staged
// byte hashed again at commit), and the project folder install (one rename of a finished folder, never a merge or
// an overwrite). On a Windows host the volume probe runs first, as at the host's start.
//
// Refused first, before anything is read: a delete or restore marker (`team_delete_unfinished`,
// `team_restore_unfinished`), no member store (`team_not_deployed`), and a profile, data volume or projects root
// that is missing (`team_projects_root_missing`) or not a real directory at its own real path (`team_copy_in_links`).
//
// The source is read here with the file checks of the transfer side: the import mount and the folder are each a
// real directory at its own real path; the tree is listed by `lstat`, and anything but a regular file or a folder
// (a symlink, a junction, a device) anywhere refuses the whole copy before a byte is staged; more than 50,000
// listed entries (files and folders) refuses `team_copy_in_too_many`, a folder with no file `team_copy_in_empty`.
// Before any file is read, the listed sizes are held to the upload's caps (the manifest check with placeholder
// hashes: file count, 64 MiB a file, 512 MiB a copy, path, sensitive-name (E69) and case-fold rules, with the
// upload's own words), and the project must be active and the folder name free.
// Each file is opened without following a link and must still be the file listed (same device, file id and size).
// It is read twice in bounded chunks through one buffer (once to hash it for the manifest, once to stage it); a file
// that changes in between fails the commit's hash check and nothing is installed. Empty folders are not carried (an
// upload carries files).
//
// Audit first: once the upload is admitted, a `files_copied_in` entry (no actor, the admitted files and bytes)
// is written before any byte is staged; a log that cannot take it refuses the copy. A failure after that leaves
// the project unchanged (the install is the last step) and the entry stands for a copy that did not land.
// Output: counts only. Logs: event names, ids and counts; never a path or a name.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { assertSafeFile } = require('../../services/host/path-guard');
const { GENERAL_PROJECT_ID, normalizeProjectId } = require('../../services/projects/project-schema');
const { WINDOWS, openNoFollow, ownDirectory, probeVolumes: defaultProbe } = require('./file-checks');
const { keyPairFromSeed } = require('./ids');
const { MemberStore } = require('./member-store');
const { isSensitiveSegment, validateSegment } = require('./path-segments');
const { PROJECT_AUDIT_FILE, ProjectAudit } = require('./project-audit');
const { FILE_LIMITS, createProjectFiles } = require('./project-files');
const { TARGET_EXISTS, createProjectFolders } = require('./project-folders');
const { STAGING_DIR } = require('./team-project-files');
const { createTransferCore } = require('./transfer-core');
const { validateManifest } = require('./transfer-manifest');
const {
  mountRoot, readHostSeed, refusal, rootsReason, teamRoots, teamState, withTeamProfile,
} = require('./team-maintenance');

const READ_CHUNK = 1024 * 1024;
// Entries (files and folders) listed before the walk stops: well past the 2,000 files a copy may carry.
const ENTRY_LIMIT = 50_000;
// The upload path keys its records by these strings (project-files.js hashes and compares them), so the local
// command's actor here is a fixed string pair, not member-schema's LOCAL_COMMAND symbol; the audit entry this copy
// writes records a null actor, as LOCAL_COMMAND's entries do.
const LOCAL = Object.freeze({ member_id: 'local_command', owner: true, device_id: 'local_command' });
const PLACEHOLDER_SHA = '0'.repeat(64);
const reasonOf = (answer, fallback) => answer?.error?.reason || answer?.reason || fallback;

// The source tree as files ({ rel, abs, size, dev, ino }), or a refusal. Nothing is followed.
async function listSource(source, maxFiles, entryLimit) {
  const files = [];
  const pending = [''];
  let seen = 0;
  while (pending.length) {
    const rel = pending.pop();
    let names;
    try { names = await fs.promises.readdir(path.join(source, rel)); } catch { return refusal('team_copy_in_unreadable'); }
    for (const name of names) {
      seen += 1;
      if (seen > entryLimit) return refusal('team_copy_in_too_many');
      const childRel = rel ? `${rel}/${name}` : name;
      const abs = path.join(source, ...childRel.split('/'));
      let stat;
      try { stat = await fs.promises.lstat(abs, { bigint: true }); } catch { return refusal('team_copy_in_unreadable'); }
      if (stat.isDirectory()) { pending.push(childRel); continue; }
      if (!stat.isFile()) return refusal('team_copy_in_links');
      files.push({ rel: childRel, abs, size: Number(stat.size), dev: stat.dev, ino: stat.ino });
      // One past the cap is enough for begin to refuse it with the upload's own word.
      if (files.length > maxFiles) return { ok: true, files };
    }
  }
  return { ok: true, files };
}

// Opens a listed file without following a link; it must still be the listed regular file.
async function openListed(entry) {
  const handle = await openNoFollow(entry.abs, fs.constants.O_RDONLY);
  try {
    const stat = await handle.stat({ bigint: true });
    if (stat.isFile() && stat.dev === entry.dev && stat.ino === entry.ino && Number(stat.size) === entry.size) return handle;
  } catch { /* refused below */ }
  await handle.close().catch(() => {});
  throw Object.assign(new Error('file_changed'), { reason: 'team_copy_in_changed' });
}

// Reads `entry` in chunks of at most `size` bytes through one buffer, handing each filled view to `each(view, n)`
// (the view is reused: `each` finishes with it before it returns).
async function readChunks(entry, size, each) {
  const handle = await openListed(entry);
  try {
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(size, entry.size)));
    let offset = 0;
    for (let n = 0; offset < entry.size; n += 1) {
      const want = Math.min(buffer.length, entry.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, want, offset);
      if (bytesRead !== want) throw Object.assign(new Error('short_read'), { reason: 'team_copy_in_changed' });
      await each(buffer.subarray(0, want), n);
      offset += bytesRead;
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

async function sha256Of(entry) {
  const hash = crypto.createHash('sha256');
  await readChunks(entry, READ_CHUNK, (buffer) => { hash.update(buffer); });
  return hash.digest('hex');
}

// The project file stack over this host's roots, as team-project-files.js builds it at start; or a refusal.
async function openStack({ config, roots, store, audit, clock, randomBytes, logger, statfs, limits, coreLimits, probeVolumes }) {
  const folders = createProjectFolders({ projectsRoot: roots.projects, trashRoot: null, clock, logger });
  const stagingRoot = path.join(config.userDataPath, STAGING_DIR);
  try { fs.mkdirSync(stagingRoot, { mode: 0o700 }); } catch (error) {
    if (error?.code !== 'EEXIST') return refusal('team_project_files_unavailable');
  }
  if (WINDOWS && !(await probeVolumes(stagingRoot, roots.projects, randomBytes(16).toString('base64url'))).ok) {
    return refusal('team_project_files_unavailable');
  }
  const core = createTransferCore({ stagingRoot, clock, randomBytes, logger, limits: coreLimits });
  if (!(await core.open()).ok) return refusal('team_project_files_unavailable');
  await folders.sweepInstalls();
  // The copy's own entry is written first (below); the upload's `files_uploaded` after the install is not this
  // copy's record, so it is taken here and dropped.
  const absorbed = Object.freeze({ append: () => ({ ok: true, seq: 0 }) });
  const files = createProjectFiles({ core, folders, store, serialized: (task) => task(), audit: () => absorbed,
    // No authorization function runs for the local command; the project gate still does.
    authorize: () => ({ ok: true }), turnRunning: () => false, roots: [stagingRoot, roots.projects], statfs, clock,
    randomBytes, logger, limits });
  return { ok: true, core, files, folders, audit };
}

// The refusals the upload would give that need no byte of the files: the caps and name rules on the listed sizes,
// the project gate and a folder name already taken. null when the copy may be hashed.
function earlyRefusal({ listed, store, folders, projectId, folderName, maxFiles, coreLimits }) {
  if (listed.length === 0) return 'team_copy_in_empty';
  if (listed.length > maxFiles) return 'team_upload_file_limit';
  const checked = validateManifest(listed.map((entry) => ({ path: entry.rel, size: entry.size, sha256: PLACEHOLDER_SHA })),
    coreLimits);
  if (!checked.ok) return reasonOf(checked, 'team_upload_manifest_invalid');
  // project-files.js `projectGate`'s answers.
  if (projectId === GENERAL_PROJECT_ID) return 'team_not_found';
  let row;
  try { row = store.getProject(projectId); } catch { return 'team_unavailable'; }
  if (row?.state === 'deleting') return 'team_project_deleting';
  if (row?.state !== 'active') return 'team_not_found';
  const child = folders.childState(projectId, folderName);
  if (child.ok && child.state !== 'absent') return TARGET_EXISTS;
  return null;
}

async function stageAndCommit({ files, listed, projectId, folderName, audit, say, afterHash }) {
  const manifest = [];
  try {
    for (const entry of listed) manifest.push({ path: entry.rel, size: entry.size, sha256: await sha256Of(entry) });
  } catch (error) {
    return refusal(typeof error?.reason === 'string' ? error.reason : 'team_copy_in_unreadable');
  }
  await afterHash();
  const begun = await files.dispatch({ operation: 'team.project.upload.begin' },
    { params: { project_id: projectId, folder_name: folderName, files: manifest }, actor: LOCAL });
  if (!begun.ok) return refusal(reasonOf(begun, 'team_copy_in_failed'));
  const discard = () => files.dispatch({ operation: 'team.project.upload.discard' },
    { params: { project_id: projectId, upload_id: begun.upload_id }, actor: LOCAL });
  const bytes = manifest.reduce((total, entry) => total + entry.size, 0);
  let written;
  try {
    written = audit.append({ kind: 'files_copied_in', project_id: projectId, detail: { files: manifest.length, bytes } });
  } catch { written = null; }
  if (written?.ok !== true) {
    await discard();
    return refusal('team_audit_unavailable');
  }
  const { record } = files.uploadFor(begun.upload_id, LOCAL.member_id, LOCAL.device_id, projectId);
  try {
    for (const [index, entry] of listed.entries()) {
      await readChunks(entry, begun.part_size, async (buffer, n) => {
        const part = await files.writePart(record, index, n, buffer);
        if (!part.ok) throw Object.assign(new Error('part_refused'), { reason: reasonOf(part, 'team_copy_in_failed') });
      });
    }
  } catch (error) {
    await discard();
    return refusal(typeof error?.reason === 'string' ? error.reason : 'team_copy_in_unreadable');
  }
  const committed = await files.dispatch({ operation: 'team.project.upload.commit' },
    { params: { project_id: projectId, upload_id: begun.upload_id }, actor: LOCAL });
  if (!committed.ok) {
    await discard();
    return refusal(reasonOf(committed, 'team_copy_in_failed'));
  }
  say('INFO', 'team.copy_in.done', { project_id: projectId, files: committed.files, bytes: committed.bytes });
  return { ok: true, files: committed.files, bytes: committed.bytes };
}

/**
 * Copies `<import mount>/<folderName>` into project `projectId` as a new folder. Answers { ok, files, bytes } or
 * { ok: false, reason }. `limits` and `coreLimits`: lower caps for tests (the project-files and transfer-core seams);
 * `afterList()` and `afterHash()`: test seams run after the listing and between the hash pass and the upload;
 * `entryLimit`: a lower entry cap for tests.
 */
async function copyFolderIn({
  configPath, projectId, folderName, output = process.stdout, acquireProfileImpl, logger = null, clock = Date.now,
  randomBytes = crypto.randomBytes, statfs, limits, coreLimits, probeVolumes = defaultProbe, afterList = () => {},
  afterHash = () => {}, entryLimit = ENTRY_LIMIT,
} = {}) {
  if (typeof projectId !== 'string' || normalizeProjectId(projectId) !== projectId) return refusal('team_not_found');
  // E69: a folder name on the sensitive list is refused as a member's upload refuses it (its paths: the manifest check).
  if (!validateSegment(folderName).ok || isSensitiveSegment(folderName)) return refusal('team_copy_in_folder_invalid');
  return withTeamProfile({ configPath, acquireProfileImpl, logger, event: 'team.copy_in' }, async (config, say) => {
    const importRoot = mountRoot(config, 'import');
    if (!importRoot) return refusal('team_import_unavailable');
    const roots = teamRoots(config);
    if (!roots.projects) return refusal('team_projects_root_missing');
    const badRoot = rootsReason(roots, 'team_copy_in_links');
    if (badRoot) return refusal(badRoot);
    const state = teamState(roots);
    if (state.deleting) return refusal('team_delete_unfinished');
    if (state.restoring) return refusal('team_restore_unfinished');
    if (!state.store) return refusal('team_not_deployed');
    const seed = readHostSeed(config);
    if (!seed) return refusal('team_host_key_invalid');
    const { publicKey } = keyPairFromSeed(seed);
    seed.fill(0);
    const store = new MemberStore({ userDataPath: config.userDataPath, hostPublicKey: publicKey,
      teamName: config.team.name, clock, randomBytes, logger, assertSafePath: assertSafeFile });
    const opened = store.open();
    if (!opened.ok) return refusal(opened.error.reason);
    const source = path.join(importRoot, folderName);
    if (!ownDirectory(source)) return refusal('team_copy_in_source_invalid');
    const maxFiles = limits?.beginFiles ?? FILE_LIMITS.beginFiles;
    const listed = await listSource(source, maxFiles, entryLimit);
    if (!listed.ok) return listed;
    await afterList();
    const audit = new ProjectAudit({ filePath: path.join(config.userDataPath, PROJECT_AUDIT_FILE), clock, logger,
      assertSafePath: assertSafeFile });
    const stack = await openStack({ config, roots, store, audit, clock, randomBytes, logger, statfs, limits, coreLimits,
      probeVolumes });
    if (!stack.ok) return stack;
    try {
      const early = earlyRefusal({ listed: listed.files, store, folders: stack.folders, projectId, folderName, maxFiles,
        coreLimits });
      if (early) return refusal(early);
      const result = await stageAndCommit({ files: stack.files, listed: listed.files, projectId, folderName, audit, say,
        afterHash });
      if (result.ok) output.write(`Copied ${result.files} files (${result.bytes} bytes) into the project as a new folder.\n`);
      return result;
    } finally {
      await stack.core.close();
    }
  });
}

module.exports = { copyFolderIn };
