'use strict';

// The team host's project folders (server/team/project-folders.js): ids only, the root checked before
// every operation, exclusive create, a three-way `has`, a bounded `list`, one-rename trash that moves a
// link as itself, and a sweep that ages entries by their names. Everything runs in a fresh temp folder.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ENTRY_COUNT_CAP, FILE_COUNT_CAP, createProjectFolders } = require('../../server/team/project-folders');
const { linkDirectory } = require('../helpers/platform-skips');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0, 0);
const ID = 'project_alpha';
const BAD_IDS = [undefined, null, 7, '', 'alpha', 'project_', '../project_a', 'project_a/b', 'project_a\\b',
  'project_..', `project_${'a'.repeat(129)}`, 'PROJECT_a', ' project_a'];
const UNAVAILABLE = { ok: false, reason: 'team_project_root_unavailable' };
const INVALID = { ok: false, reason: 'team_project_path_invalid' };
const stamp = (ms) => new Date(ms).toISOString().replace(/[^0-9]/gu, '');

function setup(t, { clock = () => NOW } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-project-root-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const projectsRoot = path.join(base, 'projects');
  const trashRoot = path.join(base, 'trash');
  fs.mkdirSync(projectsRoot);
  fs.mkdirSync(trashRoot);
  const lines = [];
  const folders = createProjectFolders({ projectsRoot, trashRoot, clock, logger: (...args) => lines.push(args) });
  return { base, projectsRoot, trashRoot, folders, lines };
}

// Every kind of link this platform lets the test make, each a fresh link at `link`.
function linkKinds() {
  return process.platform === 'win32' ? ['junction', 'dir'] : ['dir'];
}

function tryLink(target, link, kind) {
  try {
    fs.symlinkSync(target, link, kind);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return false; // a Windows directory symlink needs a privilege
    throw error;
  }
}

function assertNoPathInLogs(lines, ...paths) {
  const text = JSON.stringify(lines);
  for (const value of paths) {
    assert.equal(text.includes(value), false, 'a log line holds a path');
    assert.equal(text.includes(JSON.stringify(value).slice(1, -1)), false, 'a log line holds an escaped path');
  }
}

test('every function refuses a bad id before it looks at any root', async (t) => {
  const { folders, projectsRoot } = setup(t);
  for (const id of BAD_IDS) {
    for (const name of ['create', 'locate', 'has', 'isEmpty', 'countFiles', 'trash']) {
      assert.deepEqual(folders[name](id), INVALID, `${name}(${JSON.stringify(id)})`);
    }
  }
  assert.deepEqual(fs.readdirSync(projectsRoot), []);
  const noRoot = createProjectFolders({ projectsRoot: null, trashRoot: null });
  assert.deepEqual(noRoot.create('bad'), INVALID, 'the id is checked first');
});

test('a null projects root answers team_project_root_unavailable from every function', async () => {
  const folders = createProjectFolders({ projectsRoot: null, trashRoot: null });
  assert.deepEqual(folders.create(ID), UNAVAILABLE);
  assert.deepEqual(folders.has(ID), UNAVAILABLE);
  assert.deepEqual(folders.list(), UNAVAILABLE);
  assert.deepEqual(folders.trash(ID), UNAVAILABLE);
  assert.deepEqual(await folders.sweepTrash(), UNAVAILABLE);
  assert.throws(() => createProjectFolders({ projectsRoot: 'relative' }), TypeError);
});

test('a root replaced by a link or by a file between two calls is refused and nothing is touched', async (t) => {
  const { base, projectsRoot, trashRoot, folders } = setup(t);
  assert.equal(folders.create(ID).ok, true);
  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.renameSync(projectsRoot, path.join(base, 'moved'));
  linkDirectory(elsewhere, projectsRoot);
  for (const call of [() => folders.create('project_beta'), () => folders.has(ID), () => folders.list(), () => folders.trash(ID)]) {
    assert.deepEqual(call(), UNAVAILABLE);
  }
  assert.deepEqual(await folders.sweepTrash(), UNAVAILABLE);
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing was made through the link');
  fs.unlinkSync(projectsRoot);
  fs.writeFileSync(projectsRoot, 'not a folder');
  assert.deepEqual(folders.create('project_beta'), UNAVAILABLE);
  assert.deepEqual(folders.list(), UNAVAILABLE);
  fs.rmSync(projectsRoot);
  fs.renameSync(path.join(base, 'moved'), projectsRoot);
  // The trash root gets the same check.
  fs.renameSync(trashRoot, path.join(base, 'trash-moved'));
  linkDirectory(elsewhere, trashRoot);
  assert.deepEqual(folders.trash(ID), UNAVAILABLE);
  assert.deepEqual(await folders.sweepTrash(), UNAVAILABLE);
  assert.equal(fs.existsSync(path.join(projectsRoot, ID)), true, 'the folder stayed');
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('a root whose real path is not the configured one (a linked parent) is refused', async (t) => {
  const { base } = setup(t);
  linkDirectory(base, path.join(base, 'via'));
  const viaProjects = path.join(base, 'via', 'projects');
  const folders = createProjectFolders({ projectsRoot: viaProjects, trashRoot: path.join(base, 'via', 'trash') });
  assert.deepEqual(folders.create(ID), UNAVAILABLE);
  assert.deepEqual(folders.list(), UNAVAILABLE);
  assert.deepEqual(await folders.sweepTrash(), UNAVAILABLE);
  assert.deepEqual(fs.readdirSync(path.join(base, 'projects')), []);
});

test('create makes the folder once and answers its real path; a second create is refused', (t) => {
  const { projectsRoot, folders, lines } = setup(t);
  const made = folders.create(ID);
  assert.deepEqual(made, { ok: true, path: path.join(projectsRoot, ID) });
  assert.equal(fs.lstatSync(made.path).isDirectory(), true);
  fs.writeFileSync(path.join(made.path, 'kept.txt'), 'x');
  assert.deepEqual(folders.create(ID), UNAVAILABLE, 'an existing folder is never adopted');
  assert.deepEqual(fs.readdirSync(made.path), ['kept.txt']);
  assertNoPathInLogs(lines, projectsRoot);
});

test('has answers present, absent and unknown', (t) => {
  const { base, projectsRoot, folders } = setup(t);
  assert.deepEqual(folders.has(ID), { ok: true, state: 'absent' });
  folders.create(ID);
  assert.deepEqual(folders.has(ID), { ok: true, state: 'present' });
  fs.writeFileSync(path.join(projectsRoot, 'project_file'), 'x');
  assert.deepEqual(folders.has('project_file'), { ok: true, state: 'unknown' }, 'a file');
  const target = path.join(base, 'target');
  fs.mkdirSync(target);
  linkDirectory(target, path.join(projectsRoot, 'project_link'));
  assert.deepEqual(folders.has('project_link'), { ok: true, state: 'unknown' }, 'a link');
  const real = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (file, ...rest) => {
    if (String(file).endsWith('project_locked')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return real(file, ...rest);
  });
  assert.deepEqual(folders.has('project_locked'), { ok: true, state: 'unknown' }, 'a check that cannot tell');
});

test('list answers the project folders and only counts files, links and other names', (t) => {
  const { base, projectsRoot, folders } = setup(t);
  folders.create('project_b');
  folders.create('project_a');
  fs.writeFileSync(path.join(projectsRoot, 'project_file'), 'x');
  const target = path.join(base, 'target');
  fs.mkdirSync(target);
  linkDirectory(target, path.join(projectsRoot, 'project_link'));
  fs.mkdirSync(path.join(projectsRoot, 'not-a-project'));
  assert.deepEqual(folders.list(), { ok: true, project_ids: ['project_a', 'project_b'], unknown: 3 });
});

test('list reads at most 4,096 entries; past that it is refused', (t) => {
  const { projectsRoot, folders } = setup(t);
  for (let index = 0; index < 4096; index += 1) fs.writeFileSync(path.join(projectsRoot, `f${index}`), '');
  assert.deepEqual(folders.list(), { ok: true, project_ids: [], unknown: 4096 });
  fs.writeFileSync(path.join(projectsRoot, 'f4096'), '');
  assert.deepEqual(folders.list(), UNAVAILABLE);
});

test('trash moves a real folder with its file in one rename, and an absent folder moves nothing', (t) => {
  const { projectsRoot, trashRoot, folders, lines } = setup(t);
  folders.create(ID);
  fs.writeFileSync(path.join(projectsRoot, ID, 'notes.md'), 'kept');
  assert.deepEqual(folders.trash(ID), { ok: true, moved: true });
  const name = `${ID}-${stamp(NOW)}`;
  assert.deepEqual(fs.readdirSync(trashRoot), [name]);
  assert.equal(fs.readFileSync(path.join(trashRoot, name, 'notes.md'), 'utf8'), 'kept');
  assert.equal(fs.existsSync(path.join(projectsRoot, ID)), false);
  assert.deepEqual(folders.trash(ID), { ok: true, moved: false });
  assertNoPathInLogs(lines, projectsRoot, trashRoot);
  assert.equal(JSON.stringify(lines).includes(name), false, 'the trash name is not logged');
});

test('trash moves a link as the link itself and leaves its target untouched', (t) => {
  const { base, projectsRoot, trashRoot } = setup(t);
  let clock = NOW;
  const timed = createProjectFolders({ projectsRoot, trashRoot, clock: () => clock });
  const target = path.join(base, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'outside.txt'), 'outside');
  let made = 0;
  for (const kind of linkKinds()) {
    const id = `project_${kind}`;
    if (!tryLink(target, path.join(projectsRoot, id), kind)) continue;
    made += 1;
    clock += 1;
    assert.deepEqual(timed.trash(id), { ok: true, moved: true }, kind);
    const moved = path.join(trashRoot, `${id}-${stamp(clock)}`);
    assert.equal(fs.lstatSync(moved).isSymbolicLink(), true, `${kind}: the link moved as a link`);
    assert.deepEqual(fs.readdirSync(target), ['outside.txt'], `${kind}: the target is untouched`);
  }
  assert.ok(made >= 1, 'at least one link kind was made');
});

test('trash refuses an existing target name and moves nothing', (t) => {
  const { projectsRoot, trashRoot, folders, lines } = setup(t);
  folders.create(ID);
  fs.mkdirSync(path.join(trashRoot, `${ID}-${stamp(NOW)}`));
  assert.deepEqual(folders.trash(ID), UNAVAILABLE);
  assert.equal(fs.existsSync(path.join(projectsRoot, ID)), true);
  assert.deepEqual(lines.map(([level, event, fields]) => [level, event, fields]),
    [['WARN', 'team.project_folder.trash_failed', { project_id: ID, reason: 'team_project_root_unavailable' }]]);
});

test('trash refuses a rename that fails (another volume) and has no copy fallback', (t) => {
  const { projectsRoot, trashRoot, folders } = setup(t);
  folders.create(ID);
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); });
  t.mock.method(fs, 'cpSync', () => assert.fail('no copy'));
  assert.deepEqual(folders.trash(ID), UNAVAILABLE);
  assert.equal(fs.existsSync(path.join(projectsRoot, ID)), true);
  assert.deepEqual(fs.readdirSync(trashRoot), []);
});

test('sweepTrash removes entries more than 7 days old by name and keeps the rest', async (t) => {
  const { base, trashRoot, folders, lines } = setup(t);
  const old = `project_old-${stamp(NOW - 8 * DAY)}`;
  const young = `project_young-${stamp(NOW - 6 * DAY)}`;
  for (const name of [old, young, 'stray-folder', `project_bad-${'9'.repeat(17)}`]) {
    fs.mkdirSync(path.join(trashRoot, name));
  }
  fs.writeFileSync(path.join(trashRoot, old, 'file.txt'), 'x');
  // The age comes from the name: the young entry's file times say it is old, and it stays.
  const longAgo = new Date(NOW - 30 * DAY);
  fs.utimesSync(path.join(trashRoot, young), longAgo, longAgo);
  // A link inside an old entry, and an old entry that is itself a link: each link goes, its target stays.
  const target = path.join(base, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'outside.txt'), 'outside');
  linkDirectory(target, path.join(trashRoot, old, 'inner-link'));
  const linkEntry = `project_link-${stamp(NOW - 9 * DAY)}`;
  linkDirectory(target, path.join(trashRoot, linkEntry));
  const result = await folders.sweepTrash();
  assert.deepEqual(result, { ok: true, removed: 2, kept: 1, unknown: 2, failed: 0, truncated: false });
  assert.deepEqual(fs.readdirSync(trashRoot).sort(), [`project_bad-${'9'.repeat(17)}`, young, 'stray-folder'].sort());
  assert.deepEqual(fs.readdirSync(target), ['outside.txt'], 'the targets are untouched');
  assert.deepEqual(lines, [['INFO', 'team.project_trash.swept', { removed: 2, kept: 1, unknown: 2, failed: 0, truncated: false }]]);
  assertNoPathInLogs(lines, trashRoot);
});

test('sweepTrash age boundary: exactly 7 days old is kept, one millisecond older is removed', async (t) => {
  const { trashRoot, folders } = setup(t);
  const edge = `project_edge-${stamp(NOW - 7 * DAY)}`;
  const past = `project_past-${stamp(NOW - 7 * DAY - 1)}`;
  for (const name of [edge, past]) fs.mkdirSync(path.join(trashRoot, name));
  assert.deepEqual(await folders.sweepTrash(), { ok: true, removed: 1, kept: 1, unknown: 0, failed: 0, truncated: false });
  assert.deepEqual(fs.readdirSync(trashRoot), [edge]);
});

test('countFiles stops at its file cap and at its entry cap (a tree of empty folders), answering capped', async (t) => {
  const { projectsRoot } = setup(t);
  const folders = createProjectFolders({ projectsRoot, trashRoot: null, countCaps: { files: 2, entries: 4 } });
  fs.mkdirSync(path.join(projectsRoot, 'project_files'));
  for (const name of ['a', 'b', 'c']) fs.writeFileSync(path.join(projectsRoot, 'project_files', name), name);
  assert.deepEqual(folders.countFiles('project_files'), { ok: true, files: 2, capped: true });
  let deep = path.join(projectsRoot, 'project_dirs');
  for (let level = 0; level < 6; level += 1) { fs.mkdirSync(deep); deep = path.join(deep, 'd'); }
  assert.deepEqual(folders.countFiles('project_dirs'), { ok: true, files: 0, capped: true });
  const uncapped = createProjectFolders({ projectsRoot, trashRoot: null });
  assert.deepEqual(uncapped.countFiles('project_dirs'), { ok: true, files: 0, capped: false });
  assert.deepEqual(uncapped.countFiles('project_files'), { ok: true, files: 3, capped: false });
  assert.deepEqual([FILE_COUNT_CAP, ENTRY_COUNT_CAP], [10_000, 50_000]);
});

test('sweepTrash removes at most 64 entries a call and keeps the rest for the next', async (t) => {
  const { trashRoot, folders } = setup(t);
  for (let index = 0; index < 70; index += 1) fs.mkdirSync(path.join(trashRoot, `project_p${index}-${stamp(NOW - 8 * DAY)}`));
  assert.deepEqual(await folders.sweepTrash(), { ok: true, removed: 64, kept: 6, unknown: 0, failed: 0, truncated: false });
  assert.equal(fs.readdirSync(trashRoot).length, 6);
  assert.deepEqual(await folders.sweepTrash(), { ok: true, removed: 6, kept: 0, unknown: 0, failed: 0, truncated: false });
});

test('a clock that is not a finite number refuses the sweep and removes nothing', async (t) => {
  for (const clock of [() => undefined, () => Number.NaN, () => Number.POSITIVE_INFINITY, () => '2026']) {
    const { trashRoot, folders, lines } = setup(t, { clock });
    const fresh = `project_fresh-${stamp(NOW)}`;
    const old = `project_old-${stamp(NOW - 30 * DAY)}`;
    for (const name of [fresh, old]) fs.mkdirSync(path.join(trashRoot, name));
    assert.deepEqual(await folders.sweepTrash(), UNAVAILABLE, String(clock()));
    assert.deepEqual(fs.readdirSync(trashRoot).sort(), [fresh, old].sort(), 'nothing touched');
    assert.deepEqual(lines, [['WARN', 'team.project_trash.sweep_refused', { reason: 'team_project_root_unavailable' }]]);
  }
});

test('create answers only a folder whose parent is still the configured root', (t) => {
  const { base, projectsRoot, folders, lines } = setup(t);
  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(elsewhere);
  const realMkdir = fs.mkdirSync;
  // The root is swapped for a link after the gate checked it and before the mkdir.
  t.mock.method(fs, 'mkdirSync', (target, ...rest) => {
    if (String(target).endsWith(ID)) {
      fs.renameSync(projectsRoot, path.join(base, 'moved'));
      linkDirectory(elsewhere, projectsRoot);
    }
    return realMkdir(target, ...rest);
  });
  assert.deepEqual(folders.create(ID), UNAVAILABLE);
  assert.deepEqual(fs.readdirSync(elsewhere), [ID], 'the folder is left where it landed');
  assert.deepEqual(lines, [['WARN', 'team.project_folder.create_failed', { project_id: ID, reason: 'team_project_root_unavailable' }]]);
});

test('a trash root that is the projects root, inside it or holding it is refused at construction', (t) => {
  const { base, projectsRoot } = setup(t);
  for (const trashRoot of [projectsRoot, path.join(projectsRoot, 'trash'), base]) {
    assert.throws(() => createProjectFolders({ projectsRoot, trashRoot }), TypeError, trashRoot);
  }
  assert.doesNotThrow(() => createProjectFolders({ projectsRoot, trashRoot: path.join(base, 'trash') }));
});

test('a trash past 4,096 entries is swept as far as it was read and answers truncated', async (t) => {
  const { trashRoot, folders, lines } = setup(t);
  for (let index = 0; index < 4097; index += 1) fs.writeFileSync(path.join(trashRoot, `project_p${index}-${stamp(NOW - 8 * DAY)}`), '');
  const result = await folders.sweepTrash();
  assert.deepEqual(result, { ok: true, removed: 64, kept: 4032, unknown: 0, failed: 0, truncated: true });
  assert.equal(fs.readdirSync(trashRoot).length, 4097 - 64);
  assert.equal(lines.length, 1);
});

test('failed removals have their own cap and do not starve later removals', async (t) => {
  const { trashRoot, folders } = setup(t);
  const old = stamp(NOW - 8 * DAY);
  // Named to come first in a sorted listing.
  for (let index = 0; index < 3; index += 1) fs.mkdirSync(path.join(trashRoot, `project_a_locked${index}-${old}`));
  for (let index = 0; index < 64; index += 1) fs.mkdirSync(path.join(trashRoot, `project_z${index}-${old}`));
  const realLstat = fs.promises.lstat;
  t.mock.method(fs.promises, 'lstat', (file, ...rest) => (String(file).includes('locked')
    ? Promise.reject(Object.assign(new Error('io'), { code: 'EIO' })) : realLstat(file, ...rest)));
  assert.deepEqual(await folders.sweepTrash(), { ok: true, removed: 64, kept: 0, unknown: 0, failed: 3, truncated: false });
  assert.deepEqual(fs.readdirSync(trashRoot).sort(), [0, 1, 2].map((index) => `project_a_locked${index}-${old}`));
});

test('the trash root is checked again before each removal; once it is a link nothing more is removed', async (t) => {
  const { base, trashRoot, folders } = setup(t);
  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.writeFileSync(path.join(elsewhere, 'outside.txt'), 'outside');
  for (let index = 0; index < 3; index += 1) fs.mkdirSync(path.join(trashRoot, `project_p${index}-${stamp(NOW - 8 * DAY)}`));
  const realLstat = fs.lstatSync;
  let rootChecks = 0;
  t.mock.method(fs, 'lstatSync', (file, ...rest) => {
    // The start's check, the first removal's check, then the swap before the second removal.
    if (file === trashRoot && (rootChecks += 1) === 3) {
      fs.renameSync(trashRoot, path.join(base, 'trash-moved'));
      linkDirectory(elsewhere, trashRoot);
    }
    return realLstat(file, ...rest);
  });
  assert.deepEqual(await folders.sweepTrash(), { ok: true, removed: 1, kept: 0, unknown: 0, failed: 2, truncated: false });
  assert.equal(fs.readdirSync(path.join(base, 'trash-moved')).length, 2);
  assert.deepEqual(fs.readdirSync(elsewhere), ['outside.txt']);
});

test('3-4b: locate, isEmpty and countFiles take an id, never follow a link, and answer no path in a log', async (t) => {
  const { folders, projectsRoot, base, lines } = setup(t);
  assert.equal(folders.hasRoot, true);
  assert.equal(createProjectFolders({ projectsRoot: null }).hasRoot, false);
  assert.deepEqual(folders.locate(ID), UNAVAILABLE, 'absent: nothing to find');
  assert.deepEqual(folders.countFiles(ID), { ok: true, files: 0, capped: false }, 'absent counts nothing');
  const made = folders.create(ID);
  assert.deepEqual(folders.locate(ID), { ok: true, path: made.path });
  assert.deepEqual(folders.isEmpty(ID), { ok: true, empty: true });
  fs.mkdirSync(path.join(made.path, 'a', 'b'), { recursive: true });
  assert.deepEqual(folders.isEmpty(ID), { ok: true, empty: false });
  fs.writeFileSync(path.join(made.path, 'one.txt'), '1');
  fs.writeFileSync(path.join(made.path, 'a', 'b', 'two.txt'), '2');
  // A link inside the folder is neither counted nor entered.
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
  linkDirectory(outside, path.join(made.path, 'link'));
  assert.deepEqual(folders.countFiles(ID), { ok: true, files: 2, capped: false });
  // A link standing where the project folder should be is refused by each.
  linkDirectory(outside, path.join(projectsRoot, 'project_linked'));
  for (const name of ['locate', 'isEmpty', 'countFiles']) assert.deepEqual(folders[name]('project_linked'), UNAVAILABLE, name);
  assertNoPathInLogs(lines, projectsRoot, base);
});

test('3-4b: the trash stamp is the shared one from bounded-log', async (t) => {
  const { utcStamp } = require('../../server/team/bounded-log');
  const { folders, trashRoot } = setup(t);
  folders.create(ID);
  folders.trash(ID);
  assert.deepEqual(fs.readdirSync(trashRoot), [`${ID}-${utcStamp(NOW)}`]);
  assert.equal(utcStamp(NOW), stamp(NOW));
  assert.equal(utcStamp(Number.NaN), null);
  assert.equal(require('node:fs').readFileSync(require.resolve('../../server/team/project-folders'), 'utf8')
    .includes('toISOString'), false, 'no second copy of the stamp');
});

test('readListed walks every folder on the way before it looks at the leaf: a link is never probed', async (t) => {
  const { base, projectsRoot, folders } = setup(t);
  const project = path.join(projectsRoot, 'project_files');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(project, 'real'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'private');
  fs.writeFileSync(path.join(project, 'real', 'note.txt'), 'note');
  const answer = await folders.readListed('project_files', 'real/note.txt', 100);
  assert.deepEqual([answer.ok, answer.size, answer.bytes.toString()], [true, 4, 'note'], 'a plain nested file still reads');
  for (const kind of linkKinds()) {
    const link = path.join(project, `via-${kind}`);
    if (!tryLink(outside, link, kind)) continue;
    const probed = [];
    const real = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (file, ...rest) => { probed.push(String(file)); return real(file, ...rest); });
    const refused = await folders.readListed('project_files', `via-${kind}/secret.txt`, 100);
    t.mock.restoreAll();
    assert.deepEqual(refused, { ok: false, reason: 'team_download_changed' }, kind);
    assert.deepEqual(probed.filter((file) => file.endsWith('secret.txt')), [], `${kind}: the external leaf was probed`);
  }
});

test('a file that vanishes between the listing and its lstat is skipped by the measure, not a failed walk', async (t) => {
  const { projectsRoot, folders } = setup(t);
  const project = path.join(projectsRoot, 'project_files');
  fs.mkdirSync(project);
  for (const name of ['keep.txt', 'gone.txt']) fs.writeFileSync(path.join(project, name), 'abc');
  const real = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (file, ...rest) => {
    if (String(file).endsWith('gone.txt')) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return real(file, ...rest);
  });
  const measured = await folders.measure('project_files');
  t.mock.restoreAll();
  assert.deepEqual([measured.ok, measured.bytes, measured.files], [true, 3, 1]);
});
