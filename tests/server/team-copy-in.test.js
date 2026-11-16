'use strict';

// new-test-file: slice 3-13's `team-copy-in` is a new command surface (server/team/team-copy-in.js) with its own
// fixture; no existing file covers the headless maintenance commands.
//
// The copy goes through the upload's own code (project files, transfer core, folder install) on a stopped host:
// a tree lands byte-identical as a new folder, the caps hold at the edge and refuse one past, a link or junction
// anywhere refuses the whole copy, the project gate refuses, the audit entry comes first, and a failure leaves the
// project unchanged.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { PROJECT_AUDIT_FILE } = require('../../server/team/project-audit');
const { copyFolderIn } = require('../../server/team/team-copy-in');
const { createMaintenanceFixture, snapshot } = require('./helpers/team-maintenance-fixture');

const WINDOWS = process.platform === 'win32';

function writeTree(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

async function setup(t, files = { 'a.txt': 'alpha', 'sub/b.bin': Buffer.from([0, 1, 2, 255]), 'sub/deep/c.md': '# c\n' }) {
  const fx = createMaintenanceFixture(t);
  const team = await fx.seedTeam();
  writeTree(path.join(fx.importDir, 'Drop'), files);
  const run = (extra = {}) => copyFolderIn({ configPath: fx.configPath, acquireProfileImpl: fx.acquireProfileImpl,
    logger: fx.logger, output: fx.terminal(), projectId: team.projectId, folderName: 'Drop', ...extra });
  const project = () => snapshot(path.join(fx.projects, team.projectId));
  return { fx, team, run, project };
}

// Nothing of a copy stays behind: no staged upload, no install folder.
function assertNoLeftovers(fx) {
  assert.deepEqual(fs.readdirSync(path.join(fx.profile, 'team-uploads')), [], 'staging empty');
  assert.deepEqual(fs.readdirSync(fx.projects).filter((name) => name.startsWith('.')), [], 'no install folder');
}

function auditEntries(fx) {
  try { return JSON.parse(fs.readFileSync(path.join(fx.profile, PROJECT_AUDIT_FILE), 'utf8')).entries; } catch { return []; }
}

// A link to `target` at `link`: a junction for a folder on Windows (no privilege needed), else a symlink.
function linkOrSkip(t, target, link, dir) {
  try {
    fs.symlinkSync(target, link, dir ? (WINDOWS ? 'junction' : 'dir') : 'file');
    return true;
  } catch (error) {
    if (error?.code === 'EPERM') { t.skip('symlinks need a privilege here'); return false; }
    throw error;
  }
}

test('a tree lands byte-identical as a new top-level folder, audited first with no actor', async (t) => {
  const { fx, team, run, project } = await setup(t);
  const before = project();
  const output = fx.terminal();
  const result = await run({ output });
  assert.deepEqual(result, { ok: true, files: 3, bytes: 5 + 4 + 4 });
  const after = project();
  const source = snapshot(path.join(fx.importDir, 'Drop'));
  for (const [rel, bytes] of Object.entries(source)) assert.deepEqual(after[`Drop/${rel}`], bytes, rel);
  for (const [rel, bytes] of Object.entries(before)) assert.deepEqual(after[rel], bytes, `kept ${rel}`);
  assertNoLeftovers(fx);
  const entries = auditEntries(fx);
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.project_id, entry.actor_member_id, entry.detail]),
    [['files_copied_in', team.projectId, null, { files: 3, bytes: 13 }]]);
  // Counts only: no name, path or folder on the terminal or in a log.
  for (const text of [output.text(), fx.logText()]) {
    for (const marker of ['Drop', 'a.txt', fx.root, fx.importDir]) assert.equal(text.includes(marker), false, marker);
  }
  assert.equal(fx.lock.acquired, 1);
  assert.equal(fx.lock.released, 1);
});

test('the per-copy caps hold at the edge and refuse one past', async (t) => {
  const files = { 'one.txt': '12345678', 'two.txt': '12345678', 'three.txt': '' };
  const cases = [
    [{ limits: { beginFiles: 3 } }, true], [{ limits: { beginFiles: 2 } }, 'team_upload_file_limit'],
    [{ coreLimits: { maxFileBytes: 8 } }, true], [{ coreLimits: { maxFileBytes: 7 } }, 'team_upload_size_limit'],
    [{ coreLimits: { maxUploadBytes: 16 } }, true], [{ coreLimits: { maxUploadBytes: 15 } }, 'team_upload_size_limit'],
    [{ limits: { projectFiles: 4 } }, true], [{ limits: { projectFiles: 3 } }, 'team_project_quota'],
    [{ limits: { projectBytes: 16 + 13 } }, true], [{ limits: { projectBytes: 16 + 12 } }, 'team_project_quota'],
  ];
  for (const [seam, expected] of cases) {
    await t.test(JSON.stringify(seam), async (st) => {
      const { fx, run, project } = await setup(st, files);
      const before = project();
      const result = await run(seam);
      if (expected === true) {
        assert.equal(result.ok, true, JSON.stringify(result));
      } else {
        assert.deepEqual(result, { ok: false, reason: expected });
        assert.deepEqual(project(), before);
        assert.deepEqual(auditEntries(fx), [], 'refused before the audit entry');
      }
      assertNoLeftovers(fx);
    });
  }
});

test('a link or junction at the folder, as a child or as a parent refuses the whole copy', async (t) => {
  const outside = (fx) => {
    const dir = path.join(fx.root, 'outside');
    writeTree(dir, { 'secret.txt': 'not yours' });
    return dir;
  };
  await t.test('the named folder is a link', async (st) => {
    const { fx, run, project } = await setup(st);
    const before = project();
    if (!linkOrSkip(st, outside(fx), path.join(fx.importDir, 'Linked'), true)) return;
    assert.deepEqual(await run({ folderName: 'Linked' }), { ok: false, reason: 'team_copy_in_source_invalid' });
    assert.deepEqual(project(), before);
  });
  await t.test('a child file is a link', async (st) => {
    const { fx, run, project } = await setup(st);
    const before = project();
    if (!linkOrSkip(st, path.join(outside(fx), 'secret.txt'), path.join(fx.importDir, 'Drop', 'link.txt'), false)) return;
    assert.deepEqual(await run(), { ok: false, reason: 'team_copy_in_links' });
    assert.deepEqual(project(), before);
    assertNoLeftovers(fx);
  });
  await t.test('a parent folder is a link or junction', async (st) => {
    const { fx, run, project } = await setup(st);
    const before = project();
    if (!linkOrSkip(st, outside(fx), path.join(fx.importDir, 'Drop', 'sub', 'parent'), true)) return;
    assert.deepEqual(await run(), { ok: false, reason: 'team_copy_in_links' });
    assert.deepEqual(project(), before);
    assert.deepEqual(auditEntries(fx), []);
  });
  await t.test('the import mount itself is a link', async (st) => {
    const { fx, run } = await setup(st);
    const real = path.join(fx.root, 'import-real');
    fs.renameSync(fx.importDir, real);
    if (!linkOrSkip(st, real, fx.importDir, true)) return;
    assert.deepEqual(await run(), { ok: false, reason: 'team_import_unavailable' });
  });
});

test('the project gate, the new-folder rule and the case-fold rule refuse with nothing written', async (t) => {
  await t.test('an existing folder name', async (st) => {
    const { fx, team, run, project } = await setup(st);
    fs.mkdirSync(path.join(fx.projects, team.projectId, 'Drop'));
    const before = project();
    assert.deepEqual(await run(), { ok: false, reason: 'team_upload_target_exists' });
    assert.deepEqual(project(), before);
  });
  await t.test('an unknown project and the General project', async (st) => {
    const { run } = await setup(st);
    assert.deepEqual(await run({ projectId: 'project_nothere' }), { ok: false, reason: 'team_not_found' });
    assert.deepEqual(await run({ projectId: 'project_general' }), { ok: false, reason: 'team_not_found' });
    assert.deepEqual(await run({ projectId: '../x' }), { ok: false, reason: 'team_not_found' });
  });
  await t.test('a project being deleted', async (st) => {
    const { fx, team, run, project } = await setup(st);
    const marked = await fx.store().markProjectDeleting({ actorMemberId: team.owner.member_id, projectId: team.projectId });
    assert.equal(marked.ok, true, JSON.stringify(marked));
    const before = project();
    assert.deepEqual(await run(), { ok: false, reason: 'team_project_deleting' });
    assert.deepEqual(project(), before);
  });
  await t.test('A.txt and a.txt: the case-fold rule', async (st) => {
    if (WINDOWS) { st.skip('one folder cannot hold A.txt and a.txt on a case-insensitive file system'); return; }
    const { fx, run, project } = await setup(st, { 'A.txt': 'one', 'a.txt': 'two' });
    const before = project();
    assert.deepEqual(await run(), { ok: false, reason: 'team_upload_manifest_invalid' });
    assert.deepEqual(project(), before);
    assertNoLeftovers(fx);
    assert.deepEqual(auditEntries(fx), [], 'refused before any byte is read');
    // The control: the same pair under names that do not fold alike lands.
    fs.renameSync(path.join(fx.importDir, 'Drop', 'a.txt'), path.join(fx.importDir, 'Drop', 'b.txt'));
    assert.equal((await run()).ok, true);
  });
  await t.test('the NFC and NFD forms of one name', async (st) => {
    const { fx, run, project } = await setup(st, { 'café.txt': 'one', 'café.txt': 'two' });
    if (fs.readdirSync(path.join(fx.importDir, 'Drop')).length < 2) { st.skip('this file system folds the two forms'); return; }
    const before = project();
    assert.deepEqual(await run(), { ok: false, reason: 'team_upload_manifest_invalid' });
    assert.deepEqual(project(), before);
    assertNoLeftovers(fx);
  });
  await t.test('a folder name that is not one plain segment', async (st) => {
    const { run } = await setup(st);
    for (const name of ['..', 'a/b', 'a\\b', 'con', 'trailing.', 'a:b', 'x'.repeat(256), '']) {
      assert.deepEqual(await run({ folderName: name }), { ok: false, reason: 'team_copy_in_folder_invalid' }, name);
    }
  });
  await t.test('a folder that is missing, and a missing import mount', async (st) => {
    const { fx, run } = await setup(st);
    assert.deepEqual(await run({ folderName: 'Absent' }), { ok: false, reason: 'team_copy_in_source_invalid' });
    fs.rmSync(fx.importDir, { recursive: true });
    assert.deepEqual(await run(), { ok: false, reason: 'team_import_unavailable' });
  });
});

test('an audit log that cannot take the entry refuses the copy before a byte is staged', async (t) => {
  const { fx, run, project } = await setup(t);
  fs.writeFileSync(path.join(fx.profile, PROJECT_AUDIT_FILE), '{ not json');
  const before = project();
  assert.deepEqual(await run(), { ok: false, reason: 'team_audit_unavailable' });
  assert.deepEqual(project(), before);
  assertNoLeftovers(fx);
});

test('a file that changes between the hash pass and the upload fails the commit and leaves the project unchanged', async (t) => {
  const { fx, run, project } = await setup(t);
  const before = project();
  const file = path.join(fx.importDir, 'Drop', 'a.txt');
  const result = await run({ afterHash: () => {
    const handle = fs.openSync(file, 'r+');
    try { fs.writeSync(handle, 'ALPHA', 0, 'utf8', 0); } finally { fs.closeSync(handle); }
  } });
  assert.deepEqual(result, { ok: false, reason: 'team_upload_hash_mismatch' });
  assert.deepEqual(project(), before);
  assertNoLeftovers(fx);
  assert.equal(auditEntries(fx).length, 1, 'the entry was written first and stands');
});

test('a held profile lock refuses before anything is read', async (t) => {
  const { fx, run, project } = await setup(t);
  const before = project();
  const busy = () => { throw Object.assign(new Error('locked'), { code: 'CMP-HOST-0003', reason: 'profile_locked' }); };
  const { HOST_ERROR_CODES } = require('../../services/backend/error-codes');
  const held = () => { throw Object.assign(new Error('locked'), { code: HOST_ERROR_CODES.CONFLICT, reason: 'profile_locked' }); };
  assert.deepEqual(await run({ acquireProfileImpl: held }), { ok: false, reason: 'team_profile_locked' });
  assert.equal((await run({ acquireProfileImpl: busy })).ok, false);
  assert.deepEqual(project(), before);
  assert.equal(fs.existsSync(path.join(fx.profile, 'team-uploads')), false, 'nothing made');
});

test('a delete or restore marker, no member store and a missing projects root refuse before anything is read', async (t) => {
  for (const [marker, reason] of [['.jenny-team-deleting', 'team_delete_unfinished'], ['.jenny-team-restoring', 'team_restore_unfinished']]) {
    await t.test(marker, async (st) => {
      const { fx, run, project } = await setup(st);
      fs.writeFileSync(path.join(fx.profile, marker), '');
      const before = project();
      const opened = countImportOpens(st, fx);
      assert.deepEqual(await run(), { ok: false, reason });
      assert.equal(opened.count, 0);
      assert.deepEqual(project(), before);
    });
  }
  await t.test('no member store', async (st) => {
    const { fx, run } = await setup(st);
    fs.rmSync(path.join(fx.profile, 'team-members.json'));
    assert.deepEqual(await run(), { ok: false, reason: 'team_not_deployed' });
  });
  await t.test('the projects root is missing', async (st) => {
    const { fx, run } = await setup(st);
    fs.rmSync(fx.projects, { recursive: true });
    assert.deepEqual(await run(), { ok: false, reason: 'team_projects_root_missing' });
  });
  await t.test('the projects root is a link or junction', async (st) => {
    const { fx, run } = await setup(st);
    const real = path.join(fx.root, 'projects-real');
    fs.renameSync(fx.projects, real);
    if (!linkOrSkip(st, real, fx.projects, true)) return;
    // The config loader refuses a linked projects root first; rootsReason covers the profile and data volume too.
    assert.deepEqual(await run(), { ok: false, reason: 'team_projects_root_symlink_invalid' });
  });
});

// Counts files opened under the import folder: zero opened means zero bytes read.
function countImportOpens(t, fx) {
  const opened = { count: 0 };
  const realOpen = fs.promises.open;
  t.mock.method(fs.promises, 'open', function open(file, ...rest) {
    if (String(file).startsWith(fx.importDir)) opened.count += 1;
    return realOpen.call(this, file, ...rest);
  });
  return opened;
}

test('the refusals that need no file content read no byte of the source', async (t) => {
  const cases = {
    unknown_project: [{ projectId: 'project_nothere' }, 'team_not_found'],
    existing_folder: [{}, 'team_upload_target_exists', (fx, team) => fs.mkdirSync(path.join(fx.projects, team.projectId, 'Drop'))],
    file_too_big: [{ coreLimits: { maxFileBytes: 4 } }, 'team_upload_size_limit'],
    copy_too_big: [{ coreLimits: { maxUploadBytes: 12 } }, 'team_upload_size_limit'],
    too_many_files: [{ limits: { beginFiles: 2 } }, 'team_upload_file_limit'],
    deleting_project: [{}, 'team_project_deleting', (fx, team) => fx.store().markProjectDeleting({
      actorMemberId: team.owner.member_id, projectId: team.projectId })],
    // E69: a sensitive folder name or path segment, as a member's upload refuses it.
    sensitive_path: [{}, 'team_project_path_invalid', (fx) => writeTree(path.join(fx.importDir, 'Drop'), { 'src/.Git/config': 'x' })],
    sensitive_folder: [{ folderName: '.vscode' }, 'team_copy_in_folder_invalid',
      (fx) => writeTree(path.join(fx.importDir, '.vscode'), { 'tasks.json': '{}' })],
  };
  for (const [label, [seam, reason, plant]] of Object.entries(cases)) {
    await t.test(label, async (st) => {
      const { fx, team, run } = await setup(st);
      if (plant) await plant(fx, team);
      const opened = countImportOpens(st, fx);
      assert.deepEqual(await run(seam), { ok: false, reason });
      assert.equal(opened.count, 0, 'no source file opened');
      assert.deepEqual(auditEntries(fx), []);
    });
  }
});

test('the guide\'s caps are the default constants of the modules that own them', () => {
  const { FILE_LIMITS } = require('../../server/team/project-files');
  const { TRANSFER_LIMITS } = require('../../server/team/transfer-manifest');
  const MIB = 1024 * 1024;
  assert.equal(FILE_LIMITS.beginFiles, 2_000);
  assert.equal(FILE_LIMITS.projectFiles, 10_000);
  assert.equal(FILE_LIMITS.projectBytes, 2 * 1024 * MIB);
  assert.equal(FILE_LIMITS.allBytes, 8 * 1024 * MIB);
  assert.equal(TRANSFER_LIMITS.maxFileBytes, 64 * MIB);
  assert.equal(TRANSFER_LIMITS.maxUploadBytes, 512 * MIB);
});

test('the all-projects limit, a size change after the listing, an empty folder and too many entries refuse', async (t) => {
  await t.test('all projects together', async (st) => {
    const { run, project } = await setup(st);
    const before = project();
    const result = await run({ limits: { allBytes: 13 } });
    assert.equal(result.ok, false);
    assert.match(result.reason, /quota|storage|limit/u);
    assert.deepEqual(project(), before);
  });
  await t.test('a file that grows between the listing and the hash', async (st) => {
    const { fx, run, project } = await setup(st);
    const before = project();
    const result = await run({ afterList: () => fs.appendFileSync(path.join(fx.importDir, 'Drop', 'a.txt'), 'more') });
    assert.deepEqual(result, { ok: false, reason: 'team_copy_in_changed' });
    assert.deepEqual(project(), before);
    assert.deepEqual(auditEntries(fx), []);
  });
  await t.test('an empty source folder', async (st) => {
    const { fx, run, project } = await setup(st, {});
    fs.mkdirSync(path.join(fx.importDir, 'Drop', 'only-folders', 'deeper'), { recursive: true });
    const before = project();
    assert.deepEqual(await run(), { ok: false, reason: 'team_copy_in_empty' });
    assert.deepEqual(project(), before);
  });
  await t.test('a tree of folders past the entry cap', async (st) => {
    const { fx, run } = await setup(st);
    for (const name of ['e1', 'e2', 'e3']) fs.mkdirSync(path.join(fx.importDir, 'Drop', name));
    assert.deepEqual(await run({ entryLimit: 5 }), { ok: false, reason: 'team_copy_in_too_many' });
  });
});
