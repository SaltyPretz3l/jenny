'use strict';

// Row 103 (owner, 2026-11-02): ~/.companion/skills holds the user's own skills.
// Removal keeps it unless the uninstall assistant's "Also remove my skills"
// option is checked, and even then the cleanup never follows a link out of it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { cleanupJennyData, validateCleanupTarget } = require('../services/data-lifecycle/cleanup-service');
const { DataLifecycleService } = require('../services/data-lifecycle/data-lifecycle-service');
const { createRemovalPreparation } = require('../services/main/data-lifecycle-ipc-registration');
const { linkDirectory } = require('./helpers/platform-skips');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimePath = path.join(root, '.companion');
  const skillsPath = path.join(runtimePath, 'skills');
  fs.mkdirSync(path.join(skillsPath, 'my-skill'), { recursive: true });
  fs.writeFileSync(path.join(skillsPath, 'my-skill', 'SKILL.md'), '# mine');
  fs.writeFileSync(path.join(runtimePath, 'sidecar.log'), 'log');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  return { root, runtimePath, skillsPath, outside };
}

test('cleanup keeps ~/.companion/skills unless removeSkills is set', async (t) => {
  const fx = fixture(t);
  const kept = await cleanupJennyData({ runtimePath: fx.runtimePath, includeUserData: false });
  assert.equal(kept.ok, true);
  assert.equal(fs.existsSync(path.join(fx.runtimePath, 'sidecar.log')), false, 'known runtime data still goes');
  assert.equal(fs.readFileSync(path.join(fx.skillsPath, 'my-skill', 'SKILL.md'), 'utf8'), '# mine');
  assert.deepEqual(kept.unknownRuntimeChildren, ['skills']);
  assert.equal(kept.results.some((entry) => entry.name === 'skills'), false);

  for (const value of ['true', 1, {}]) {
    await cleanupJennyData({ runtimePath: fx.runtimePath, includeUserData: false, removeSkills: value });
    assert.equal(fs.existsSync(fx.skillsPath), true, `removeSkills=${JSON.stringify(value)} keeps skills`);
  }

  const removed = await cleanupJennyData({ runtimePath: fx.runtimePath, includeUserData: false, removeSkills: true });
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(fx.skillsPath), false);
  assert.deepEqual(removed.unknownRuntimeChildren, []);
  assert.deepEqual(removed.results.find((entry) => entry.name === 'skills'),
    { kind: 'runtime_skills', name: 'skills', status: 'removed' });
  assert.equal(fs.existsSync(fx.runtimePath), true, 'the .companion root itself stays');
});

test('a junction inside skills that points outside is never followed', async (t) => {
  const fx = fixture(t);
  linkDirectory(fx.outside, path.join(fx.skillsPath, 'linked'));
  const result = await cleanupJennyData({ runtimePath: fx.runtimePath, includeUserData: false, removeSkills: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.results.find((entry) => entry.name === 'skills'),
    { kind: 'runtime_skills', name: 'skills', status: 'retained', reason: 'reparse_or_symlink' });
  assert.equal(fs.readFileSync(path.join(fx.outside, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(fx.skillsPath, 'my-skill', 'SKILL.md'), 'utf8'), '# mine');
});

test('a skills folder that is itself a junction is retained and its target untouched', async (t) => {
  const fx = fixture(t);
  fs.rmSync(fx.skillsPath, { recursive: true, force: true });
  linkDirectory(fx.outside, fx.skillsPath);
  const result = await cleanupJennyData({ runtimePath: fx.runtimePath, includeUserData: false, removeSkills: true });
  assert.equal(result.ok, false);
  assert.equal(result.results.find((entry) => entry.name === 'skills').reason, 'reparse_or_symlink');
  assert.equal(fs.readFileSync(path.join(fx.outside, 'keep.txt'), 'utf8'), 'keep');
});

test('forged skills targets fail validation', () => {
  const root = path.join(os.tmpdir(), 'jenny-skills-forged', '.companion');
  const valid = { kind: 'runtime_skills', root, name: 'skills', path: path.join(root, 'skills') };
  assert.equal(validateCleanupTarget(valid), true);
  assert.equal(validateCleanupTarget({ ...valid, name: 'logs', path: path.join(root, 'logs') }), false);
  assert.equal(validateCleanupTarget({ ...valid, path: path.join(root, 'skills', 'my-skill') }), false);
  assert.equal(validateCleanupTarget({ ...valid, path: path.dirname(root) }), false);
  assert.equal(validateCleanupTarget({ ...valid, path: path.join(root, '..', 'skills') }), false);
});

test('removal preparation forwards removeSkills and app-only never cleans', async () => {
  const received = [];
  const prepare = createRemovalPreparation({
    cleanupOptions: { runtimePath: 'runtime' },
    cleanupData: async (options) => { received.push(options); return { ok: true }; },
  });
  await prepare({ choice: 'permanent', removeSkills: true, workspaceRoot: '' });
  await prepare({ choice: 'archive_and_remove', workspaceRoot: '' });
  await prepare({ choice: 'app_only', removeSkills: true, workspaceRoot: '' });
  assert.deepEqual(received.map((options) => options.removeSkills), [true, false]);
});

test('prepareRemoval hands the skills choice to cleanup only for a data removal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const handed = [];
  const service = new DataLifecycleService({
    userDataPath: path.join(root, 'profile'),
    documentsPath: path.join(root, 'documents'),
    runtimePath: path.join(root, '.companion'),
    prepareForRemoval: async (options) => { handed.push(options); return { ok: true, results: [] }; },
  });
  for (const [options, expected] of [
    [{ choice: 'permanent', confirmation: 'REMOVE JENNY', removeSkills: true }, true],
    [{ choice: 'permanent', confirmation: 'REMOVE JENNY' }, false],
    [{ choice: 'permanent', confirmation: 'REMOVE JENNY', removeSkills: 'yes' }, false],
    [{ choice: 'app_only', removeSkills: true }, false],
  ]) {
    const result = await service.prepareRemoval(options);
    assert.equal(result.ok, true, JSON.stringify(options));
    assert.equal(handed.at(-1).removeSkills, expected, JSON.stringify(options));
  }
});

test('an archive destination inside skills is refused only when skills will be removed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-skills-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimePath = path.join(root, '.companion');
  const service = new DataLifecycleService({
    userDataPath: path.join(root, 'profile'), documentsPath: path.join(root, 'documents'), runtimePath,
  });
  const destination = path.join(runtimePath, 'skills', 'archives');
  assert.throws(() => service._assertArchiveDestinationRetained(destination, false, true),
    (error) => error.reason === 'archive_destination_removed_by_cleanup');
  assert.doesNotThrow(() => service._assertArchiveDestinationRetained(destination, false, false));
});
