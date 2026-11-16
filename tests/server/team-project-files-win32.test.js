'use strict';

// Slice 3-8c: team project upload and download on a Windows host (TEAM_PROJECTS_SPEC "3-8c as built"). Every case
// runs on this platform for real: no platform is injected. A case that needs symbolic-link privilege this host
// lacks reports a skip, never a pass. On another platform the whole file skips.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { removeTreeSync } = require('../../services/fs-remove-no-follow');
const { createDiskAdmission } = require('../../server/resource-limits');
const { probeVolumes, samePath } = require('../../server/team/file-checks');
const { PROJECT_ID_PATTERN } = require('../../server/team/member-schema');
const { installTempName } = require('../../server/team/project-folder-io');
const { createProjectFolders } = require('../../server/team/project-folders');
const { createTeamProjectFiles } = require('../../server/team/team-project-files');
const { createTransferCore } = require('../../server/team/transfer-core');
const { createTeamProjectFixture } = require('./helpers/team-project-fixture');

const WIN = { timeout: 60_000, skip: process.platform !== 'win32' && 'Windows host cases' };
// libuv's UV_FS_O_EXLOCK: an open that shares nothing, as an antivirus scan holds a file (Node 22 does not export it).
const EXLOCK = 0x10000000;
const HUGE_DISK = () => ({ bavail: 1e15, bsize: 1 });
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const manifestOf = (entries) => entries.map(([file, bytes]) => ({ path: file, size: bytes.length, sha256: sha(bytes) }));
const uploadIdOf = (letter) => `upload_${letter.repeat(22)}`;
const isTemp = (file) => path.basename(file).startsWith('.jenny-install-');

// A folder on another volume than `root` for the cross-volume cases: JENNY_TEST_OTHER_VOLUME_DIR,
// else the first `<drive>:\tmp` that is a directory on a different volume; null when there is none.
function otherVolumeDir(root) {
  const rootDev = fs.lstatSync(root).dev;
  const drives = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((letter) => `${letter}:\\tmp`);
  return [process.env.JENNY_TEST_OTHER_VOLUME_DIR, ...drives].find((dir) => {
    if (!dir) return false;
    try {
      const stat = fs.lstatSync(dir);
      return stat.isDirectory() && stat.dev !== rootDev;
    } catch {
      return false;
    }
  }) || null;
}

function tempRoot(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-38c-')));
  t.after(() => removeTreeSync(root));
  return root;
}

function trySymlink(target, link, type) {
  try { fs.symlinkSync(target, link, type); return true; } catch (error) {
    if (error.code === 'EPERM') return false;
    throw error;
  }
}

// The 8.3 alias Windows gives `long` in a fresh folder (first six letters, ~1), or null where short names are off.
function shortAlias(long) {
  const base = path.basename(long);
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/[^A-Za-z0-9]/gu, '').slice(0, 6).toUpperCase();
  const alias = path.join(path.dirname(long), `${stem}~1${dot > 0 ? base.slice(dot, dot + 4).toUpperCase() : ''}`);
  try {
    return fs.lstatSync(alias, { bigint: true }).ino === fs.lstatSync(long, { bigint: true }).ino ? alias : null;
  } catch {
    return null;
  }
}

function lockFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDWR | EXLOCK);
  return () => fs.closeSync(fd);
}

async function setup(t, { files = {}, ...rest } = {}) {
  const hooks = { install: null };
  const h = await createTeamProjectFixture(t, { projectsRoot: true, files: { statfs: HUGE_DISK,
    wrapFolders: (folders) => ({ ...folders,
      install: (...args) => (hooks.install ? hooks.install(folders, ...args) : folders.install(...args)) }),
    ...files }, ...rest });
  const projectId = await h.sharedProject();
  const folder = path.join(h.roots.projectsRoot, projectId);
  const op = (who, operation, params) => h.send(who, operation, { project_id: projectId, ...params });
  const begin = (folderName, entries) => h.ok(op('carl', 'team.project.upload.begin',
    { folder_name: folderName, files: manifestOf(entries) }), 'begin');
  const upload = async (folderName, entries) => {
    const begun = await begin(folderName, entries);
    for (const [index, [, bytes]] of entries.entries()) {
      assert.equal((await h.putPart('carl', projectId, begun.upload_id, index, 0, bytes)).status, 200);
    }
    return begun.upload_id;
  };
  const commit = (uploadId) => op('carl', 'team.project.upload.commit', { upload_id: uploadId });
  const stagingEmpty = () => assert.deepEqual(fs.readdirSync(h.files.stagingRoot), []);
  return { h, projectId, folder, op, begin, upload, commit, stagingEmpty, hooks };
}

// A projects root and a staging folder on one volume, for the folder module alone.
function folderRig(t, { projectsRoot } = {}) {
  const root = tempRoot(t);
  const projects = path.join(root, 'projects');
  const staging = path.join(root, 'staging');
  fs.mkdirSync(projects);
  fs.mkdirSync(staging);
  const logs = [];
  const folders = createProjectFolders({ projectsRoot: projectsRoot ? projectsRoot(projects) : projects,
    trashRoot: path.join(root, 'trash'), logger: (level, event, fields) => logs.push({ level, event, fields }) });
  fs.mkdirSync(path.join(root, 'trash'));
  const stage = (name, bytes) => {
    const file = path.join(staging, name);
    fs.writeFileSync(file, bytes);
    return { path: name.replace(/\.part$/u, '.txt'), size: bytes.length, stagedPath: file };
  };
  return { root, projects, staging, trash: path.join(root, 'trash'), folders, logs, stage };
}

// ---------------------------------------------------------------- item 1: the platform rule and the volume

test('item 1: a Windows host offers project files end to end, and staging is empty afterwards', WIN, async (t) => {
  const s = await setup(t);
  const bytes = crypto.randomBytes(5000);
  const uploadId = await s.upload('Up', [['a/b.bin', bytes], ['c.txt', Buffer.from('see')]]);
  await s.h.ok(s.commit(uploadId), 'commit');
  assert.deepEqual(fs.readFileSync(path.join(s.folder, 'Up', 'a', 'b.bin')), bytes);
  const page = await s.h.ok(s.op('rae', 'team.project.download.manifest', {}));
  const entry = page.entries.find((row) => row.path === 'Up/a/b.bin');
  const read = await s.h.getPart('rae', s.projectId, page.manifest_id, entry.index, 0);
  assert.equal(read.status, 200);
  assert.deepEqual(read.bytes, bytes);
  s.stagingEmpty();
  assert.deepEqual(fs.readdirSync(s.h.roots.projectsRoot).filter((name) => name.startsWith('.jenny')), []);
});

test('item 1: a volume the checks do not hold on answers unavailable, logged once with a reason and no path', WIN, async (t) => {
  const s = await setup(t, { files: { probeVolumes: async () => ({ ok: false, reason: 'volume_ids' }) } });
  assert.equal(await s.h.reason(s.op('carl', 'team.project.upload.begin', { folder_name: 'w', files: manifestOf([['a', Buffer.from('a')]]) })),
    'team_project_files_unavailable');
  assert.equal(await s.h.reason(s.op('rae', 'team.project.download.manifest', {})), 'team_project_files_unavailable');
  const put = await s.h.putPart('carl', s.projectId, uploadIdOf('A'), 0, 0, Buffer.from('a'));
  assert.equal(put.json.error.reason, 'team_project_files_unavailable');
  const logged = s.h.fx.logs.filter((entry) => entry.event === 'team.project_files.volume_unsupported');
  assert.deepEqual(logged.map((entry) => entry.fields), [{ reason: 'volume_ids' }]);
  assert.equal(s.h.logText().includes(s.h.roots.projectsRoot.replaceAll('\\', '\\\\')), false);
});

test('item 1: the real volume probe holds on this PC, refuses a root that is a junction and leaves nothing', WIN, async (t) => {
  const root = tempRoot(t);
  const [staging, projects] = [path.join(root, 'staging'), path.join(root, 'projects')];
  fs.mkdirSync(staging);
  fs.mkdirSync(projects);
  assert.deepEqual(await probeVolumes(staging, projects, 'P'.repeat(22)), { ok: true, shared: true });
  assert.deepEqual([fs.readdirSync(staging), fs.readdirSync(projects)], [[], []]);
  fs.symlinkSync(projects, path.join(root, 'linked'), 'junction');
  assert.deepEqual(await probeVolumes(staging, path.join(root, 'linked'), 'Q'.repeat(22)), { ok: false, reason: 'volume_root' });
  assert.deepEqual(fs.readdirSync(projects), []);
});

// Each refusal of the probe, by its seam: a zero file id, a listing that names the junction a directory, a link
// count that stays 1 (on the projects volume always, even with the staging root on another volume).
test('item 1: the probe refuses a zero file id, a junction listed as a directory and a link count that stays 1', WIN, async (t) => {
  const root = tempRoot(t);
  const [staging, projects] = [path.join(root, 'staging'), path.join(root, 'projects')];
  fs.mkdirSync(staging);
  fs.mkdirSync(projects);
  const lstat = (file) => fs.lstatSync(file, { bigint: true });
  const zeroId = (file) => (path.basename(file) === 'f' ? Object.assign(lstat(file), { ino: 0n }) : lstat(file));
  // Both the handle and the lstat answer id 0 (they agree), so only the zero check refuses it.
  const zeroHandle = async (handle) => Object.assign(await handle.stat({ bigint: true }), { ino: 0n });
  assert.deepEqual(await probeVolumes(staging, projects, 'A'.repeat(22), { lstat: zeroId, handleStat: zeroHandle }),
    { ok: false, reason: 'volume_ids' });
  const asDirectory = (folder) => fs.readdirSync(folder, { withFileTypes: true })
    .map((entry) => (entry.name === 'j' ? Object.assign(Object.create(entry), { isSymbolicLink: () => false, isDirectory: () => true }) : entry));
  assert.deepEqual(await probeVolumes(staging, projects, 'B'.repeat(22), { readdir: asDirectory }),
    { ok: false, reason: 'volume_junctions' });
  const oneLink = (file) => (path.basename(file) === 'f' ? Object.assign(lstat(file), { nlink: 1n }) : lstat(file));
  assert.deepEqual(await probeVolumes(staging, projects, 'C'.repeat(22), { lstat: oneLink }), { ok: false, reason: 'volume_links' });
  const otherBase = otherVolumeDir(root);
  const other = otherBase ? fs.realpathSync.native(fs.mkdtempSync(path.join(otherBase, 'jenny-38c-vol-'))) : null;
  if (!other) { t.diagnostic('no second volume here: the cross-volume link-count case did not run'); return; }
  t.after(() => removeTreeSync(other));
  assert.deepEqual(await probeVolumes(staging, other, 'D'.repeat(22)), { ok: true, shared: false });
  assert.deepEqual(await probeVolumes(staging, other, 'E'.repeat(22), { lstat: oneLink }), { ok: false, reason: 'volume_links' });
  assert.deepEqual([fs.readdirSync(staging), fs.readdirSync(projects), fs.readdirSync(other)], [[], [], []]);
});

// ---------------------------------------------------------------- item 2: containment

test('item 2: what lstat and a directory listing answer here for a junction, symbolic links and an app link', WIN, (t) => {
  const root = tempRoot(t);
  fs.mkdirSync(path.join(root, 'd'));
  fs.writeFileSync(path.join(root, 'f.txt'), 'f');
  fs.symlinkSync(path.join(root, 'd'), path.join(root, 'junction'), 'junction');
  const made = ['junction'];
  if (trySymlink(path.join(root, 'd'), path.join(root, 'dirlink'), 'dir')) made.push('dirlink');
  else t.diagnostic('directory symbolic link: skipped, no symlink privilege on this host (owed)');
  if (trySymlink(path.join(root, 'f.txt'), path.join(root, 'filelink'), 'file')) made.push('filelink');
  else t.diagnostic('file symbolic link: skipped, no symlink privilege on this host (owed)');
  const listed = new Map(fs.readdirSync(root, { withFileTypes: true }).map((entry) => [entry.name, entry]));
  for (const name of made) {
    const stat = fs.lstatSync(path.join(root, name));
    assert.deepEqual([stat.isSymbolicLink(), stat.isDirectory(), stat.isFile()], [true, false, false], name);
    const entry = listed.get(name);
    assert.deepEqual([entry.isSymbolicLink(), entry.isDirectory(), entry.isFile()], [true, false, false], name);
  }
  const apps = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps');
  const appLink = fs.existsSync(apps) ? fs.readdirSync(apps, { withFileTypes: true }).find((entry) => entry.name.endsWith('.exe')) : null;
  if (!appLink) { t.diagnostic('app execution link: none on this host'); return; }
  assert.deepEqual([appLink.isSymbolicLink(), appLink.isFile()], [true, false]);
  assert.equal(fs.lstatSync(path.join(apps, appLink.name)).isSymbolicLink(), true);
});

test('item 2: a junction as the project folder, a subfolder and the upload target is never entered', WIN, async (t) => {
  const s = await setup(t);
  const outside = path.join(s.h.fx.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(s.folder, 'sub'), 'junction');
  fs.symlinkSync(outside, path.join(s.folder, 'Target'), 'junction');
  fs.writeFileSync(path.join(s.folder, 'plain.txt'), 'plain');
  const page = await s.h.ok(s.op('rae', 'team.project.download.manifest', {}));
  assert.deepEqual([page.entries.map((entry) => entry.path), page.skipped], [['plain.txt'], 2]);
  assert.equal(await s.h.reason(s.op('carl', 'team.project.upload.begin', { folder_name: 'Target',
    files: manifestOf([['a.txt', Buffer.from('a')]]) })), 'team_upload_target_exists');
  // A junction put at the final name between begin and commit: target exists, nothing written through it.
  const later = await s.upload('Later', [['a.txt', Buffer.from('a')]]);
  fs.symlinkSync(outside, path.join(s.folder, 'Later'), 'junction');
  assert.equal(await s.h.reason(s.commit(later)), 'team_upload_target_exists');
  // The project folder itself swapped for a junction, here between begin and commit: every use refused.
  const pending = await s.upload('Pending', [['a.txt', Buffer.from('a')]]);
  fs.renameSync(s.folder, `${s.folder}-moved`);
  fs.symlinkSync(outside, s.folder, 'junction');
  assert.equal(await s.h.reason(s.commit(pending)), 'team_project_root_unavailable');
  // Alice: Rae's one new manifest a minute and Carl's two open uploads are spent above.
  assert.equal(await s.h.reason(s.op('alice', 'team.project.download.manifest', {})), 'team_project_root_unavailable');
  assert.equal(await s.h.reason(s.op('alice', 'team.project.upload.begin', { folder_name: 'New',
    files: manifestOf([['a.txt', Buffer.from('a')]]) })), 'team_project_root_unavailable');
  assert.deepEqual(fs.readdirSync(outside), ['secret.txt']);
});

test('item 2: a junction put in place of the upload\'s staging folder refuses the part; nothing lands outside', WIN, async (t) => {
  const s = await setup(t);
  const begun = await s.begin('Up', [['a.bin', Buffer.from('abc')]]);
  const staged = path.join(s.h.files.stagingRoot, begun.upload_id);
  const outside = path.join(s.h.fx.root, 'planted');
  fs.mkdirSync(outside);
  fs.rmdirSync(staged);
  fs.symlinkSync(outside, staged, 'junction');
  const put = await s.h.putPart('carl', s.projectId, begun.upload_id, 0, 0, Buffer.from('abc'));
  assert.equal(put.json.error.reason, 'team_upload_staging_failed');
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('item 2: staging swapped for a junction between the parts and the install installs nothing and unlinks nothing', WIN, async (t) => {
  const s = await setup(t);
  const bytes = Buffer.from('payload');
  const uploadId = await s.upload('Up', [['a.bin', bytes]]);
  const staged = path.join(s.h.files.stagingRoot, uploadId);
  const outside = path.join(s.h.fx.root, 'elsewhere');
  fs.renameSync(staged, outside);
  fs.symlinkSync(outside, staged, 'junction');
  const answer = await s.commit(uploadId);
  assert.equal(answer.error?.reason, 'team_upload_staging_failed', JSON.stringify(answer));
  assert.equal(fs.existsSync(path.join(s.folder, 'Up')), false);
  assert.deepEqual(fs.readFileSync(path.join(outside, '0.part')), bytes, 'the file outside is neither moved nor unlinked');
});

test('item 2: a file or folder swapped between the listing and the read is refused; a hard link is skipped', WIN, async (t) => {
  const s = await setup(t);
  fs.mkdirSync(path.join(s.folder, 'sub'));
  fs.writeFileSync(path.join(s.folder, 'sub', 'a.txt'), 'same');
  fs.writeFileSync(path.join(s.folder, 'b.txt'), 'bbbb');
  fs.writeFileSync(path.join(s.folder, 'linked.txt'), 'twice');
  fs.linkSync(path.join(s.folder, 'linked.txt'), path.join(s.h.fx.root, 'second-name.txt'));
  const page = await s.h.ok(s.op('rae', 'team.project.download.manifest', {}));
  assert.deepEqual([page.entries.map((entry) => entry.path).sort(), page.skipped], [['b.txt', 'sub/a.txt'], 1]);
  const index = (name) => page.entries.find((entry) => entry.path === name).index;
  const elsewhere = path.join(s.h.fx.root, 'sub-elsewhere');
  fs.renameSync(path.join(s.folder, 'sub'), elsewhere);
  fs.symlinkSync(elsewhere, path.join(s.folder, 'sub'), 'junction');
  fs.linkSync(path.join(s.folder, 'b.txt'), path.join(s.h.fx.root, 'b-second.txt'));
  for (const name of ['sub/a.txt', 'b.txt']) {
    const read = await s.h.getPart('rae', s.projectId, page.manifest_id, index(name), 0);
    assert.deepEqual([read.status, read.json.error.reason], [409, 'team_download_changed'], name);
  }
});

test('item 2: symbolic links in the project and in staging, where this host may make them', WIN, async (t) => {
  const s = await setup(t);
  fs.writeFileSync(path.join(s.h.fx.root, 'target.txt'), 'target');
  fs.mkdirSync(path.join(s.h.fx.root, 'target-dir'));
  if (!trySymlink(path.join(s.h.fx.root, 'target.txt'), path.join(s.folder, 'file-link.txt'), 'file')) {
    t.skip('symbolic links need privilege on this host: the file and directory symbolic-link cases are owed');
    return;
  }
  trySymlink(path.join(s.h.fx.root, 'target-dir'), path.join(s.folder, 'dir-link'), 'dir');
  const page = await s.h.ok(s.op('rae', 'team.project.download.manifest', {}));
  assert.deepEqual([page.entries.length, page.skipped], [0, 2]);
  const begun = await s.begin('Up', [['a.bin', Buffer.from('abc')]]);
  fs.symlinkSync(path.join(s.h.fx.root, 'target.txt'), path.join(s.h.files.stagingRoot, begun.upload_id, '0.part'), 'file');
  const put = await s.h.putPart('carl', s.projectId, begun.upload_id, 0, 0, Buffer.from('abc'));
  assert.equal(put.json.error.reason, 'team_upload_staging_failed');
  assert.equal(fs.readFileSync(path.join(s.h.fx.root, 'target.txt'), 'utf8'), 'target');
});

test('item 2: a root typed in another case is the same folder; an 8.3 alias of a root or a file is refused', WIN, async (t) => {
  const lower = (projects) => `${projects[0].toLowerCase()}${projects.slice(1).toLowerCase()}`;
  const rig = folderRig(t, { projectsRoot: lower });
  const projectId = 'project_case';
  const created = rig.folders.create(projectId);
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(rig.folders.ownsRoot(projectId, created.path), true);
  assert.deepEqual(rig.folders.list().project_ids, [projectId]);
  const installed = await rig.folders.install(projectId, 'Up', uploadIdOf('C'), [rig.stage('0.part', Buffer.from('case'))]);
  assert.equal(installed.ok, true, JSON.stringify(installed));
  const listed = await rig.folders.listFiles(projectId);
  assert.deepEqual(listed.files.map((file) => file.path), ['Up/0.txt']);
  const opened = await rig.folders.openListed(projectId, 'Up/0.txt', listed.files[0]);
  assert.equal(opened.ok, true);
  await opened.handle.close();
  assert.equal(samePath('C:\\K', 'C:\\\u212a'), false, 'a Kelvin sign is not K');

  const longFile = path.join(rig.projects, projectId, 'averyverylongfilename.txt');
  fs.writeFileSync(longFile, 'long');
  const alias = shortAlias(longFile);
  // The CI windows-host step sets JENNY_REQUIRE_SHORT_NAMES, so a runner without short names fails here, never skips.
  if (!alias && process.env.JENNY_REQUIRE_SHORT_NAMES === '1') assert.fail('8.3 names are off on the test volume');
  if (!alias) { t.skip('8.3 names are off on this volume: the alias cases are owed'); return; }
  const file = (await rig.folders.listFiles(projectId)).files.find((entry) => entry.path === 'averyverylongfilename.txt');
  const viaAlias = await rig.folders.openListed(projectId, path.basename(alias), file);
  assert.deepEqual(viaAlias, { ok: false, reason: 'team_download_changed' });
  const longDir = path.join(rig.projects, projectId, 'averyverylongfoldername');
  fs.mkdirSync(longDir);
  fs.writeFileSync(path.join(longDir, 'x.txt'), 'x');
  const inner = (await rig.folders.listFiles(projectId)).files.find((entry) => entry.path === 'averyverylongfoldername/x.txt');
  const viaFolderAlias = await rig.folders.openListed(projectId, `${path.basename(shortAlias(longDir))}/x.txt`, inner);
  assert.deepEqual(viaFolderAlias, { ok: false, reason: 'team_download_changed' }, 'an 8.3 alias of a folder on the way');
  const longRoot = path.join(rig.root, 'averyverylongstagingroot');
  fs.mkdirSync(longRoot);
  const rootAlias = shortAlias(longRoot);
  const core = createTransferCore({ stagingRoot: rootAlias, clock: Date.now, randomBytes: crypto.randomBytes });
  assert.equal((await core.open()).ok, false, 'a staging root named by its 8.3 alias');
  const typedLower = createTransferCore({ stagingRoot: lower(longRoot), clock: Date.now, randomBytes: crypto.randomBytes });
  assert.equal((await typedLower.open()).ok, true, 'a staging root typed in another case');
  await typedLower.close();
});

// ---------------------------------------------------------------- items 3 to 5: the install folder and the last step

test('item 3: the install folder keeps its name on Windows and no project rule takes it; old names are swept too', WIN, async (t) => {
  const rig = folderRig(t);
  const name = installTempName(uploadIdOf('N'));
  assert.equal(name, `.jenny-install-${uploadIdOf('N')}`);
  assert.equal(/[. ]$/u.test(name), false);
  assert.equal(PROJECT_ID_PATTERN.test(name), false);
  fs.mkdirSync(path.join(rig.projects, name));
  assert.deepEqual(fs.readdirSync(rig.projects), [name], 'Windows keeps the name as made');
  fs.writeFileSync(path.join(rig.projects, name, 'half.bin'), 'half');
  // Node writes through \\?\ paths, so the old trailing-dot name exists here too; Win32 tools cannot remove it.
  fs.mkdirSync(path.join(rig.projects, `.jenny-install-${uploadIdOf('O')}.`));
  fs.mkdirSync(path.join(rig.trash, name));
  assert.equal(rig.folders.create('project_live').ok, true);
  assert.deepEqual(rig.folders.list(), { ok: true, project_ids: ['project_live'], unknown: 2 });
  assert.deepEqual((await rig.folders.measure('project_live')).bytes, 0);
  const trashed = await rig.folders.sweepTrash();
  assert.equal(trashed.unknown, 1);
  assert.equal(await rig.folders.sweepInstalls(), 2);
  assert.deepEqual(fs.readdirSync(rig.projects), ['project_live']);
});

test('item 4: a file made at the final name before the install holds it keeps its bytes; nothing is written over', WIN, async (t) => {
  const s = await setup(t);
  const uploadId = await s.upload('Raced', [['a.txt', Buffer.from('new')]]);
  const target = path.join(s.folder, 'Raced');
  const real = fs.lstatSync;
  let raced = false;
  fs.lstatSync = (file, ...rest) => {
    try {
      return real(file, ...rest);
    } catch (error) {
      // The install's last absent check: a local program writes a file at the name right after it.
      if (!raced && file === target && error.code === 'ENOENT' && fs.readdirSync(s.h.roots.projectsRoot).some((n) => n.startsWith('.jenny-install-'))) {
        raced = true;
        fs.writeFileSync(target, 'theirs');
      }
      throw error;
    }
  };
  let answer;
  try {
    answer = await s.commit(uploadId);
  } finally {
    fs.lstatSync = real;
  }
  assert.equal(raced, true);
  assert.equal(answer.error.reason, 'team_upload_target_exists');
  assert.equal(fs.readFileSync(target, 'utf8'), 'theirs');
  assert.deepEqual(fs.readdirSync(s.h.roots.projectsRoot).filter((name) => isTemp(name)), []);
});

test('item 4: a directory raced in after the name was held fails the install and removes only its own folder', WIN, async (t) => {
  const s = await setup(t);
  const uploadId = await s.upload('Raced', [['a.txt', Buffer.from('new')]]);
  const real = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (!isTemp(from)) return real(from, to);
    fs.unlinkSync(to); // the empty file that held the name
    fs.mkdirSync(to);
    fs.writeFileSync(path.join(to, 'a.txt'), 'theirs');
    return real(from, to);
  };
  let answer;
  try {
    answer = await s.commit(uploadId);
  } finally {
    fs.renameSync = real;
  }
  assert.equal(answer.error.reason, 'team_upload_install_failed');
  assert.equal(fs.readFileSync(path.join(s.folder, 'Raced', 'a.txt'), 'utf8'), 'theirs');
  assert.deepEqual(fs.readdirSync(s.h.roots.projectsRoot).filter((name) => isTemp(name)), []);
});

test('item 4: a staged file locked during the install fails it; the leftover goes once the lock is gone', WIN, async (t) => {
  const s = await setup(t);
  const uploadId = await s.upload('Locked', [['a.txt', Buffer.from('locked')]]);
  let unlock = null;
  s.hooks.install = (folders, projectId, folderName, id, files) => {
    unlock = lockFile(files[0].stagedPath);
    return folders.install(projectId, folderName, id, files);
  };
  const answer = await s.commit(uploadId);
  unlock();
  assert.equal(answer.error.reason, 'team_upload_install_failed');
  assert.equal(fs.existsSync(path.join(s.folder, 'Locked')), false);
  await s.h.folders.sweepInstalls();
  assert.deepEqual(fs.readdirSync(s.h.roots.projectsRoot).filter((name) => isTemp(name)), []);
});

test('item 5: leftovers a crash can leave are swept at start; a locked one waits for the next sweep', WIN, async (t) => {
  const rig = folderRig(t);
  const profile = path.join(rig.root, 'profile');
  fs.mkdirSync(path.join(profile, 'team-uploads'), { recursive: true });
  fs.mkdirSync(path.join(profile, 'team-uploads', uploadIdOf('S')));
  fs.writeFileSync(path.join(profile, 'team-uploads', uploadIdOf('S'), '0.part'), 'staged');
  for (const name of [installTempName(uploadIdOf('A')), `.jenny-install-${uploadIdOf('B')}.`, installTempName(uploadIdOf('L'))]) {
    fs.mkdirSync(path.join(rig.projects, name));
    fs.writeFileSync(path.join(rig.projects, name, 'half.bin'), 'half');
  }
  const unlock = lockFile(path.join(rig.projects, installTempName(uploadIdOf('L')), 'half.bin'));
  const files = createTeamProjectFiles({ userDataPath: profile, folders: rig.folders, store: { onMembershipChange: () => () => {} },
    authorize: () => ({ ok: true }), serialized: (fn) => fn(), projectsRoot: rig.projects, statfs: HUGE_DISK,
    logger: (level, event, fields) => rig.logs.push({ level, event, fields }) });
  t.after(() => files.close());
  try {
    assert.deepEqual(await files.open(), { ok: true });
    assert.deepEqual(fs.readdirSync(path.join(profile, 'team-uploads')), []);
    assert.deepEqual(fs.readdirSync(rig.projects), [installTempName(uploadIdOf('L'))]);
    assert.ok(rig.logs.some((entry) => entry.event === 'team.project_files.install_sweep_failed'));
  } finally {
    unlock();
  }
  assert.equal(await rig.folders.sweepInstalls(), 1);
  assert.deepEqual(fs.readdirSync(rig.projects), []);
});

test('item 5: a directory\'s fsync is refused here (EPERM) and an install, which syncs two folders, still succeeds', WIN, async (t) => {
  const rig = folderRig(t);
  const fd = fs.openSync(rig.projects, fs.constants.O_RDONLY);
  try {
    assert.throws(() => fs.fsyncSync(fd), { code: 'EPERM' });
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(rig.folders.create('project_sync').ok, true);
  const installed = await rig.folders.install('project_sync', 'Up', uploadIdOf('Y'), [rig.stage('0.part', Buffer.from('sync'))]);
  assert.deepEqual(installed, { ok: true, files: 1, bytes: 4, linked: 1 });
});

test('item 14: with the projects root on another volume the install copies; each copy has one link', WIN, async (t) => {
  const rig = folderRig(t);
  const otherBase = otherVolumeDir(rig.root);
  if (!otherBase) {
    t.skip('no second volume on this host: the copy path across volumes is owed');
    return;
  }
  const other = fs.realpathSync.native(fs.mkdtempSync(path.join(otherBase, 'jenny-38c-copy-')));
  t.after(() => removeTreeSync(other));
  const folders = createProjectFolders({ projectsRoot: other });
  assert.equal(folders.create('project_copy').ok, true);
  const files = [rig.stage('0.part', Buffer.from('zero')), { ...rig.stage('1.part', Buffer.from('one')), path: 'sub/1.txt' }];
  const installed = await folders.install('project_copy', 'Up', uploadIdOf('Z'), files);
  assert.deepEqual(installed, { ok: true, files: 2, bytes: 7, linked: 0 });
  for (const [name, bytes] of [['0.txt', 'zero'], [path.join('sub', '1.txt'), 'one']]) {
    const file = path.join(other, 'project_copy', 'Up', name);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.equal(fs.lstatSync(file).nlink, 1);
  }
});

test('item 6: the disk reserve reads this Windows volume for real and fails closed on a path it cannot read', WIN, (t) => {
  const root = tempRoot(t);
  const stats = fs.statfsSync(root);
  assert.ok(Number(stats.bavail) > 0 && Number(stats.bsize) > 0);
  const logs = [];
  const logger = (level, event) => logs.push(event);
  assert.equal(createDiskAdmission([root], { reserveBytes: 1, logger })(), true);
  assert.equal(createDiskAdmission([root], { reserveBytes: Number.MAX_SAFE_INTEGER, logger })(), false);
  assert.equal(createDiskAdmission([path.join(root, 'missing')], { reserveBytes: 1, logger })(), false);
  assert.deepEqual(logs, ['host.disk_pressure', 'host.disk_status_unavailable']);
});
