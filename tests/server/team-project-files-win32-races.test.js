'use strict';

// Slice 3-8c: the Windows races, one guard each (TEAM_PROJECTS_SPEC "3-8c as built"). Each case swaps a folder or
// file for a junction or another file at the one moment its guard covers, by wrapping the fs call that comes right
// after the check, and each fails with that guard removed. Runs on this platform for real; skips off Windows.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { removeTreeSync } = require('../../services/fs-remove-no-follow');
const { samePath } = require('../../server/team/file-checks');
const { createProjectFolders } = require('../../server/team/project-folders');
const { createTransferCore } = require('../../server/team/transfer-core');
const { createTeamProjectFixture } = require('./helpers/team-project-fixture');

const WIN = { timeout: 60_000, skip: process.platform !== 'win32' && 'Windows host cases' };
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const isTemp = (file) => path.basename(file).startsWith('.jenny-install-');
// libuv's UV_FS_O_EXLOCK: an open that shares nothing (Node 22 does not export it).
const EXLOCK = 0x10000000;

function lockFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDWR | EXLOCK);
  return () => fs.closeSync(fd);
}

function tempRoot(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-38c-race-')));
  t.after(() => removeTreeSync(root));
  return root;
}

// Replaces `owner[name]` for the case and puts it back after; `wrap(real)` answers the replacement.
function patch(t, owner, name, wrap) {
  const real = owner[name];
  owner[name] = wrap(real);
  t.after(() => { owner[name] = real; });
  return () => { owner[name] = real; };
}

// Moves `folder` aside and puts a junction to it in its place (the files stay reachable through the junction).
function junctionFor(folder) {
  const aside = `${folder}-aside`;
  fs.renameSync(folder, aside);
  fs.symlinkSync(aside, folder, 'junction');
  return aside;
}

async function stagingCore(t) {
  const root = tempRoot(t);
  const core = createTransferCore({ stagingRoot: root, clock: Date.now, randomBytes: crypto.randomBytes,
    limits: { maxPartBytes: 4 } });
  assert.equal((await core.open()).ok, true);
  t.after(() => core.close());
  const bytes = Buffer.from('abcdefgh');
  const begun = await core.begin({ ownerId: 'owner_a', files: [{ path: 'a.bin', size: bytes.length, sha256: sha(bytes) }] });
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const part = (offset) => core.writePart({ uploadId: begun.uploadId, ownerId: 'owner_a', index: 0, offset,
    bytes: bytes.subarray(offset, offset + 4) });
  return { root, core, dir: path.join(root, begun.uploadId), part };
}

test('a staged part swapped for another file between the check and the open: the handle check refuses it', WIN, async (t) => {
  const s = await stagingCore(t);
  assert.equal((await s.part(0)).ok, true);
  const file = path.join(s.dir, '0.part');
  const restore = patch(t, fs.promises, 'open', (real) => async (target, ...rest) => {
    if (target === file) {
      fs.renameSync(file, `${file}.theirs`);
      fs.writeFileSync(file, 'abcd'); // the same length, another file id
    }
    return real(target, ...rest);
  });
  const answer = await s.part(4);
  restore();
  assert.equal(answer.error?.reason, 'team_upload_staging_failed', JSON.stringify(answer));
});

// The window the owner accepted: the swap lands between the last check and the create, so the empty part is made in
// the folder swapped in, then refused (TEAM_PROJECTS_SPEC "3-8c as built", known limits).
test('the staging folder swapped for a junction between the checks and the create: refused after; the empty part stays in the folder swapped in', WIN, async (t) => {
  const s = await stagingCore(t);
  let aside = null;
  const restore = patch(t, fs.promises, 'open', (real) => async (target, ...rest) => {
    if (aside === null && target === path.join(s.dir, '0.part')) aside = junctionFor(s.dir);
    return real(target, ...rest);
  });
  const answer = await s.part(0);
  restore();
  assert.notEqual(aside, null);
  assert.equal(answer.error?.reason, 'team_upload_staging_failed', JSON.stringify(answer));
  assert.equal(fs.existsSync(path.join(aside, '0.part')), true, 'the known limit: the create ran through the junction');
});

test('a subfolder swapped for a junction after it is listed and before it is opened: the walk refuses', WIN, async (t) => {
  const root = tempRoot(t);
  const projects = path.join(root, 'projects');
  fs.mkdirSync(projects);
  const folders = createProjectFolders({ projectsRoot: projects });
  assert.equal(folders.create('project_walk').ok, true);
  const top = path.join(projects, 'project_walk');
  fs.mkdirSync(path.join(top, 'sub'));
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  patch(t, fs, 'opendirSync', (real) => (folder, ...rest) => {
    const dir = real(folder, ...rest);
    if (folder !== top) return dir;
    const read = dir.readSync.bind(dir);
    dir.readSync = () => {
      const entry = read();
      if (entry?.name === 'sub') {
        fs.rmdirSync(path.join(top, 'sub'));
        fs.symlinkSync(outside, path.join(top, 'sub'), 'junction');
      }
      return entry;
    };
    return dir;
  });
  const listed = await folders.listFiles('project_walk');
  assert.deepEqual(listed, { ok: false, reason: 'team_project_root_unavailable' });
});

async function project(t, options = {}) {
  const hooks = { install: null };
  const h = await createTeamProjectFixture(t, { projectsRoot: true, files: { statfs: () => ({ bavail: 1e15, bsize: 1 }),
    wrapFolders: (folders) => ({ ...folders,
      install: (...args) => (hooks.install ? hooks.install(folders, ...args) : folders.install(...args)) }),
    ...options } });
  const projectId = await h.sharedProject();
  const folder = path.join(h.roots.projectsRoot, projectId);
  const upload = async (folderName, entries) => {
    const begun = await h.ok(h.send('carl', 'team.project.upload.begin', { project_id: projectId, folder_name: folderName,
      files: entries.map(([file, bytes]) => ({ path: file, size: bytes.length, sha256: sha(bytes) })) }));
    for (const [index, [, bytes]] of entries.entries()) {
      assert.equal((await h.putPart('carl', projectId, begun.upload_id, index, 0, bytes)).status, 200);
    }
    return begun.upload_id;
  };
  const commit = (uploadId) => h.send('carl', 'team.project.upload.commit', { project_id: projectId, upload_id: uploadId });
  const temps = () => fs.readdirSync(h.roots.projectsRoot).filter((name) => isTemp(name));
  return { h, projectId, folder, upload, commit, temps, hooks };
}

test('staging swapped for a junction after the hash and before the install: the staged name check refuses it', WIN, async (t) => {
  const s = await project(t);
  const bytes = Buffer.from('payload');
  const uploadId = await s.upload('Up', [['a.bin', bytes]]);
  let aside = null;
  s.hooks.install = (folders, ...args) => {
    aside = junctionFor(path.join(s.h.files.stagingRoot, uploadId));
    return folders.install(...args);
  };
  const answer = await s.commit(uploadId);
  assert.equal(answer.error?.reason, 'team_upload_install_failed', JSON.stringify(answer));
  assert.equal(fs.existsSync(path.join(s.folder, 'Up')), false);
  assert.deepEqual(fs.readFileSync(path.join(aside, '0.part')), bytes, 'the file outside is neither linked nor unlinked');
});

// Swaps that land after a check: right after a folder's mkdir (its name check refuses before anything is made in it),
// and inside the link call itself (the window the owner accepted: the link is made through the junction, then refused).
test('an install subfolder swapped after its mkdir is refused with nothing outside; swapped inside the link, the link stays outside', WIN, async (t) => {
  for (const when of ['mkdirSync', 'linkSync']) {
    const s = await project(t);
    const uploadId = await s.upload(`Up-${when}`, [['a/b.txt', Buffer.from('b')]]);
    const outside = path.join(s.h.fx.root, `outside-${when}`);
    fs.mkdirSync(outside);
    let swapped = false;
    const restore = patch(t, fs, when, (real) => (...args) => {
      const result = when === 'mkdirSync' ? real(...args) : undefined;
      const sub = when === 'mkdirSync' ? args[0] : path.dirname(args[1]);
      if (!swapped && isTemp(path.dirname(sub))) {
        swapped = true;
        fs.rmdirSync(sub);
        fs.symlinkSync(outside, sub, 'junction');
      }
      return when === 'mkdirSync' ? result : real(...args);
    });
    const answer = await s.commit(uploadId);
    restore();
    assert.equal(swapped, true, when);
    assert.equal(answer.error?.reason, 'team_upload_install_failed', `${when}: ${JSON.stringify(answer)}`);
    assert.deepEqual(fs.readdirSync(outside), when === 'mkdirSync' ? [] : ['b.txt'], when);
    assert.equal(fs.existsSync(path.join(s.folder, `Up-${when}`)), false, when);
  }
});

test('the file holding the final name swapped for another empty file: target exists, and theirs is not replaced', WIN, async (t) => {
  const s = await project(t);
  const uploadId = await s.upload('Held', [['a.txt', Buffer.from('new')]]);
  const target = path.join(s.folder, 'Held');
  let swapped = false;
  patch(t, fs, 'lstatSync', (real) => (file, ...rest) => {
    if (!swapped && file === target && s.temps().length > 0) {
      let held = false;
      try { held = real(file).isFile(); } catch { /* not held yet */ }
      if (held) {
        swapped = true;
        fs.unlinkSync(target);
        fs.writeFileSync(target, '');
      }
    }
    return real(file, ...rest);
  });
  const answer = await s.commit(uploadId);
  assert.equal(swapped, true);
  assert.equal(answer.error?.reason, 'team_upload_target_exists', JSON.stringify(answer));
  assert.equal(fs.lstatSync(target).isFile(), true, 'their file is not replaced by the folder');
  assert.deepEqual(s.temps(), []);
});

test('a rename that fails while the name is still held removes the holder only', WIN, async (t) => {
  const s = await project(t);
  const uploadId = await s.upload('Fails', [['a.txt', Buffer.from('a')]]);
  patch(t, fs, 'renameSync', (real) => (from, to) => {
    if (isTemp(from)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return real(from, to);
  });
  const answer = await s.commit(uploadId);
  assert.equal(answer.error?.reason, 'team_upload_install_failed');
  assert.equal(fs.existsSync(path.join(s.folder, 'Fails')), false, 'the empty holder is gone');
  assert.deepEqual(s.temps(), []);
});

test('a staging leftover holding a junction is removed at start without emptying the junction\'s target', WIN, async (t) => {
  const root = tempRoot(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  const leftover = path.join(root, 'staging', `upload_${'J'.repeat(22)}`);
  fs.mkdirSync(leftover, { recursive: true });
  fs.symlinkSync(outside, path.join(leftover, 'planted'), 'junction');
  const core = createTransferCore({ stagingRoot: path.join(root, 'staging'), clock: Date.now, randomBytes: crypto.randomBytes });
  assert.equal((await core.open()).removed, 1);
  await core.close();
  assert.deepEqual(fs.readdirSync(path.join(root, 'staging')), []);
  assert.deepEqual(fs.readdirSync(outside), ['keep.txt']);
});

// ---------------------------------------------------------------- review round: items 1 to 4, each red before its fix

test('item 1: only ASCII letters fold; two folders NTFS keeps apart are never one root', WIN, (t) => {
  assert.equal(samePath('C:\\Projects\\a', 'c:\\PROJECTS\\A'), true);
  assert.equal(samePath('C:\\\u10d0', 'C:\\\u1c90'), false, 'Georgian an and its Mtavruli capital');
  assert.equal(samePath('C:\\@', 'C:\\`'), false);
  assert.equal(samePath('C:\\\u00e9', 'C:\\\u00c9'), false, 'a non-ASCII case pair is refused (fail closed)');
  const root = tempRoot(t);
  const small = path.join(root, '\u10d0');
  const capital = path.join(root, '\u1c90');
  fs.mkdirSync(small);
  fs.mkdirSync(capital);
  assert.equal(fs.readdirSync(root).length, 2, 'two folders on this volume');
  const folders = createProjectFolders({ projectsRoot: small });
  assert.equal(folders.create('project_geo').ok, true);
  fs.mkdirSync(path.join(capital, 'project_geo'));
  assert.equal(folders.ownsRoot('project_geo', path.join(small, 'project_geo')), true);
  assert.equal(folders.ownsRoot('project_geo', path.join(capital, 'project_geo')), false);
});

test('item 2: a dangling junction where a part is created refuses it and makes nothing at its target', WIN, async (t) => {
  const s = await stagingCore(t);
  const gone = path.join(tempRoot(t), 'gone');
  fs.mkdirSync(gone);
  fs.symlinkSync(gone, path.join(s.dir, '0.part'), 'junction');
  fs.rmdirSync(gone);
  const answer = await s.part(0);
  assert.equal(answer.error?.reason, 'team_upload_staging_failed', JSON.stringify(answer));
  assert.equal(fs.existsSync(gone), false, 'nothing made at the junction\'s target');
});

test('item 2: a dangling junction raced in at the final name answers target exists and makes nothing at its target', WIN, async (t) => {
  const s = await project(t);
  const uploadId = await s.upload('Dangling', [['a.txt', Buffer.from('a')]]);
  const target = path.join(s.folder, 'Dangling');
  const gone = path.join(s.h.fx.root, 'dangling-target');
  let raced = false;
  patch(t, fs, 'lstatSync', (real) => (file, ...rest) => {
    try {
      return real(file, ...rest);
    } catch (error) {
      if (!raced && file === target && error.code === 'ENOENT' && s.temps().length > 0) {
        raced = true;
        fs.mkdirSync(gone);
        fs.symlinkSync(gone, target, 'junction');
        fs.rmdirSync(gone);
      }
      throw error;
    }
  });
  const answer = await s.commit(uploadId);
  assert.equal(raced, true);
  assert.equal(answer.error?.reason, 'team_upload_target_exists', JSON.stringify(answer));
  assert.equal(fs.existsSync(gone), false, 'nothing made at the junction\'s target');
  assert.deepEqual(s.temps(), []);
});

test('item 2: a folder swapped for a junction before the link, a mkdir or the unlink stops that call from running', WIN, async (t) => {
  for (const when of ['link', 'mkdir', 'unlink']) {
    const s = await project(t);
    const uploadId = await s.upload(`Up-${when}`, [['a/b/c.txt', Buffer.from('c')]]);
    const outside = path.join(s.h.fx.root, `outside-${when}`);
    fs.mkdirSync(outside);
    const staged = path.join(s.h.files.stagingRoot, uploadId);
    let aside = null;
    const swap = (folder) => {
      if (aside !== null) return;
      if (when === 'unlink') { aside = junctionFor(folder); return; }
      aside = folder;
      fs.rmdirSync(folder);
      fs.symlinkSync(outside, folder, 'junction');
    };
    // Each swap lands right after the last check before the call it targets, at a call the code already makes.
    const restore = when === 'unlink'
      ? patch(t, fs, 'linkSync', (real) => (...args) => { const result = real(...args); swap(staged); return result; })
      : patch(t, fs.realpathSync, 'native', (real) => (file, ...rest) => {
        const answer = real(file, ...rest);
        const temp = s.temps()[0];
        if (temp && when === 'mkdir' && file === path.join(s.h.roots.projectsRoot, temp, 'a')) swap(file);
        if (temp && when === 'link' && file === path.join(staged, '0.part')) swap(path.join(s.h.roots.projectsRoot, temp, 'a', 'b'));
        return answer;
      });
    const answer = await s.commit(uploadId);
    restore();
    assert.notEqual(aside, null, when);
    assert.equal(answer.error?.reason, 'team_upload_install_failed', `${when}: ${JSON.stringify(answer)}`);
    assert.deepEqual(fs.readdirSync(outside), [], `${when}: nothing made outside`);
    if (when === 'unlink') assert.equal(fs.existsSync(path.join(aside, '0.part')), true, 'the staged file is not unlinked through the junction');
    assert.equal(fs.existsSync(path.join(s.folder, `Up-${when}`)), false, when);
  }
});

test('item 3: a holder the install could not remove is logged once and removed by the next sweep', WIN, async (t) => {
  const s = await project(t);
  const uploadId = await s.upload('Stuck', [['a.txt', Buffer.from('a')]]);
  const holder = path.join(s.folder, 'Stuck');
  let unlock = null;
  patch(t, fs, 'renameSync', (real) => (from, to) => {
    if (!isTemp(from)) return real(from, to);
    unlock = lockFile(to);
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  });
  const answer = await s.commit(uploadId);
  assert.equal(answer.error?.reason, 'team_upload_install_failed');
  assert.equal(fs.existsSync(holder), true, 'locked, so still there');
  unlock();
  assert.deepEqual(s.h.fx.logs.filter((entry) => entry.event === 'team.project_files.holder_left').map((entry) => entry.fields),
    [{ project_id: s.projectId }]);
  await s.h.folders.sweepInstalls();
  assert.equal(fs.existsSync(holder), false, 'the sweep removed the holder this process made');
});

test('item 4: an install folder whose identity cannot be read right after it is made is removed', WIN, async (t) => {
  const s = await project(t);
  const uploadId = await s.upload('Unread', [['a.txt', Buffer.from('a')]]);
  let failed = false;
  patch(t, fs.realpathSync, 'native', (real) => (file, ...rest) => {
    if (!failed && isTemp(file)) {
      failed = true;
      throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    }
    return real(file, ...rest);
  });
  const answer = await s.commit(uploadId);
  assert.equal(failed, true);
  assert.equal(answer.error?.reason, 'team_upload_install_failed');
  assert.deepEqual(s.temps(), []);
});
