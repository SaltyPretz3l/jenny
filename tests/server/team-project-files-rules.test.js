'use strict';

// Slice 3-8b review fixes: the rules of server/team/project-files.js and its modules (project-quota.js,
// project-manifests.js, project-folder-io.js) on the team project fixture, each case written to fail without
// its fix: the audit throttle and build rate, a full project refusing only itself, the install folder and the
// final rename, the hash off the project chain, begin's second look, the three-way recheck, folded names, the
// module's own deleting gate, and the branches and quota terms the first round left untested.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { hostFailure } = require('../../server/api-contract');
const { PROJECT_ID_PATTERN } = require('../../server/team/member-schema');
const { FILE_LIMITS, createProjectFiles } = require('../../server/team/project-files');
const { createInviteService } = require('../../server/team/invites');
const { createRateLimiter } = require('../../server/team/rate-limit');
const { createTeamCommands } = require('../../server/team/team-commands');
const { dataFrames } = require('./helpers/session-scope-fixture');
const { createTeamProjectFixture } = require('./helpers/team-project-fixture');

const BOUNDED = { timeout: 60_000 };
const MIB = 1024 * 1024;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const manifestOf = (entries) => entries.map(([file, bytes]) => ({ path: file, size: bytes.length, sha256: sha(bytes) }));
// Slice 3-8c: no trailing dot (Win32 tools cannot remove such a folder); 3-8b's dotted name is still swept.
const tempName = (uploadId) => `.jenny-install-${uploadId}`;
const isTemp = (file) => path.basename(file).startsWith('.jenny-install-');

// The id of a conversation sessions.create made.
function sessionIdOf(created) {
  const id = created.session?.session_id;
  assert.equal(typeof id, 'string', JSON.stringify(created));
  return id;
}

async function until(check, what) {
  for (let tries = 0; tries < 200; tries += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}

// The fixture with spies: `counts` of the folder calls the files module makes, `hooks.install` and
// `hooks.authorize` to replace them for one case, and a clock the case moves.
async function setup(t, { files = {}, ...rest } = {}) {
  const counts = { measure: 0, openListed: 0 };
  const hooks = { install: null, authorize: null };
  const clock = { now: 1_800_000_000_000 };
  const h = await createTeamProjectFixture(t, { projectsRoot: true, clock: () => clock.now, leaseNow: () => clock.now,
    files: { statfs: () => ({ bavail: 1e15, bsize: 1 }),
      wrapFolders: (folders) => ({ ...folders,
        measure: (...args) => { counts.measure += 1; return folders.measure(...args); },
        openListed: (...args) => { counts.openListed += 1; return folders.openListed(...args); },
        install: (...args) => (hooks.install ? hooks.install(folders, ...args) : folders.install(...args)) }),
      wrapAuthorize: (authorize) => (...args) => (hooks.authorize ? hooks.authorize(authorize, ...args) : authorize(...args)),
      ...files },
    ...rest });
  const projectId = await h.sharedProject();
  const folderOf = (id) => path.join(h.roots.projectsRoot, id);
  const begin = (who, project, folder, entries) => h.send(who, 'team.project.upload.begin',
    { project_id: project, folder_name: folder, files: manifestOf(entries) });
  const upload = async (who, folder, entries, project = projectId) => {
    const begun = await h.ok(begin(who, project, folder, entries), 'begin');
    for (const [index, [, bytes]] of entries.entries()) {
      if (bytes.length > 0) assert.equal((await h.putPart(who, project, begun.upload_id, index, 0, bytes)).status, 200);
    }
    return begun.upload_id;
  };
  const op = (who, operation, params, project = projectId) => h.send(who, operation, { project_id: project, ...params });
  const stagingEmpty = () => until(() => fs.readdirSync(h.files.stagingRoot).length === 0, 'staging to empty');
  const audits = (kind) => h.approvals.audit().read({ projectId, afterSeq: 0, limit: 100 }).entries
    .filter((entry) => entry.kind === kind);
  return { h, projectId, folderOf, begin, upload, op, stagingEmpty, audits, counts, hooks, clock };
}

// ---------------------------------------------------------------- items 1 to 8, each red before its fix

test('item 1: one files_downloaded per member and project in ten minutes, one new manifest per member a minute', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h } = s;
  fs.writeFileSync(path.join(s.folderOf(s.projectId), 'a.txt'), 'abc');
  const first = await h.ok(s.op('rae', 'team.project.download.manifest', {}));
  const again = await s.op('rae', 'team.project.download.manifest', {});
  assert.deepEqual([again.error.reason, again.error.retryable], ['team_upload_limit', true]);
  // A page of the manifest already made is no new build.
  await h.ok(s.op('rae', 'team.project.download.manifest', { manifest_id: first.manifest_id }));
  s.clock.now += 60_000;
  const inside = await h.ok(s.op('rae', 'team.project.download.manifest', {}));
  assert.notEqual(inside.manifest_id, first.manifest_id);
  assert.equal(s.audits('files_downloaded').length, 1, 'a manifest made inside the window appends nothing');
  await h.ok(s.op('carl', 'team.project.download.manifest', {}));
  assert.equal(s.audits('files_downloaded').length, 2, 'another member has a window of its own');
  s.clock.now += 9 * 60_000;
  await h.ok(s.op('rae', 'team.project.download.manifest', {}));
  assert.deepEqual(s.audits('files_downloaded').map((entry) => entry.actor_member_id),
    [h.seats.rae.member_id, h.seats.carl.member_id, h.seats.rae.member_id]);
});

test('item 2: a project the measure cannot finish refuses only its own begins and counts as the project limit', BOUNDED, async (t) => {
  const s = await setup(t, { countCaps: { entries: 5 }, files: { limits: { projectBytes: 100, allBytes: 150 } } });
  const { h, projectId } = s;
  for (let index = 0; index < 6; index += 1) fs.writeFileSync(path.join(s.folderOf(projectId), `f${index}`), 'x');
  const other = await h.sharedProject('Other');
  const sized = (size, folder) => h.send('carl', 'team.project.upload.begin', { project_id: other, folder_name: folder,
    files: [{ path: 'x.bin', size, sha256: 'a'.repeat(64) }] });
  // The capped project counts as 100 of the 150: 50 more fit elsewhere, 51 do not.
  assert.equal(await h.reason(sized(51, 'over')), 'team_project_quota');
  const fits = await h.ok(sized(50, 'fits'));
  assert.equal(s.counts.measure, 2, 'every project once, the begin\'s own not walked again');
  await h.ok(s.op('carl', 'team.project.upload.discard', { upload_id: fits.upload_id }, other));
  await h.ok(sized(50, 'fits'));
  assert.equal(s.counts.measure, 2, 'the failed project is not retried at another project\'s begin');
  assert.equal(await h.reason(s.begin('carl', projectId, 'own', [['a', Buffer.from('a')]])), 'team_project_quota');
  assert.equal(s.counts.measure, 3, 'it is retried at its own begin');
});

test('item 2b: a project made after the first measure counts at the next check; a failed walk is retried a minute on', BOUNDED, async (t) => {
  const failing = new Set();
  const s = await setup(t, { files: { limits: { projectBytes: 100, allBytes: 150 }, wrapFolders: (folders) => ({ ...folders,
    measure: async (id) => (failing.has(id) ? { ok: false, reason: 'team_project_root_unavailable' } : folders.measure(id)) }) } });
  const { h, projectId } = s;
  const sized = (project, size, folder) => h.send('carl', 'team.project.upload.begin', { project_id: project,
    folder_name: folder, files: [{ path: 'x.bin', size, sha256: 'a'.repeat(64) }] });
  const flaky = await h.sharedProject('Flaky');
  failing.add(flaky);
  assert.equal(await h.reason(sized(projectId, 51, 'one')), 'team_project_quota', 'a walk that failed counts as the project limit');
  failing.delete(flaky);
  assert.equal(await h.reason(sized(projectId, 51, 'two')), 'team_project_quota', 'not retried at once');
  s.clock.now += 61_000;
  await h.ok(s.op('carl', 'team.project.upload.discard', { upload_id: (await h.ok(sized(projectId, 51, 'three'))).upload_id }));
  // A project an AI turn wrote into after the host started: measured at the next check, not skipped for ever.
  const late = await h.sharedProject('Late');
  fs.writeFileSync(path.join(s.folderOf(late), 'big.bin'), Buffer.alloc(100));
  assert.equal(await h.reason(sized(projectId, 51, 'four')), 'team_project_quota', 'the late project counts as 100 of 150');
});

test('item 3: the install folder is outside every project and refused by every name rule; leftovers are swept', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  const leftovers = [tempName(`upload_${'L'.repeat(22)}`), `${tempName(`upload_${'M'.repeat(22)}`)}.`];
  for (const leftover of leftovers) {
    assert.equal(PROJECT_ID_PATTERN.test(leftover), false);
    fs.mkdirSync(path.join(h.roots.projectsRoot, leftover));
    fs.writeFileSync(path.join(h.roots.projectsRoot, leftover, 'half.bin'), 'half');
  }
  const listed = h.folders.list();
  assert.equal(listed.project_ids.some((id) => leftovers.includes(id)), false);
  await h.ok(s.begin('carl', projectId, 'Swept', [['a', Buffer.from('a')]]));
  for (const leftover of leftovers) {
    assert.equal(fs.existsSync(path.join(h.roots.projectsRoot, leftover)), false, `swept before the measure: ${leftover}`);
  }
  assert.ok(h.fx.logs.some((entry) => entry.event === 'team.project_files.install_swept'));
});

test('item 3: the files land under the install folder and one rename gives the final name last', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  const uploadId = await s.upload('carl', 'Renamed', [['a/b.txt', Buffer.from('bytes')]]);
  const renames = [];
  const real = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (!isTemp(from)) return real(from, to); // the receipt store renames its own files
    renames.push({ from: path.basename(from), parent: path.dirname(from), to: path.basename(to), there: fs.existsSync(to),
      inside: fs.readFileSync(path.join(from, 'a', 'b.txt'), 'utf8') });
    return real(from, to);
  };
  try {
    await h.ok(s.op('carl', 'team.project.upload.commit', { upload_id: uploadId }));
  } finally {
    fs.renameSync = real;
  }
  // On Windows the empty file that holds the name is there (file-checks.js `renameNoReplace`).
  assert.deepEqual(renames, [{ from: tempName(uploadId), parent: h.roots.projectsRoot, to: 'Renamed', there: process.platform === 'win32',
    inside: 'bytes' }]);
  assert.equal(fs.readFileSync(path.join(s.folderOf(projectId), 'Renamed', 'a', 'b.txt'), 'utf8'), 'bytes');
  assert.equal(fs.existsSync(path.join(h.roots.projectsRoot, tempName(uploadId))), false);
});

test('item 3: a folder with files made at the name just before the rename keeps its files; nothing is merged', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  const uploadId = await s.upload('carl', 'Raced', [['a.txt', Buffer.from('new')]]);
  const real = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (!isTemp(from)) return real(from, to);
    if (fs.existsSync(to)) fs.unlinkSync(to); // Windows: the empty file that holds the name
    fs.mkdirSync(to);
    fs.writeFileSync(path.join(to, 'a.txt'), 'theirs');
    return real(from, to);
  };
  let answer;
  try {
    answer = await s.op('carl', 'team.project.upload.commit', { upload_id: uploadId });
  } finally {
    fs.renameSync = real;
  }
  // POSIX answers ENOTEMPTY (the target-exists reason); Windows refuses any directory there (EPERM).
  assert.equal(answer.error.reason, process.platform === 'win32' ? 'team_upload_install_failed' : 'team_upload_target_exists');
  assert.deepEqual(fs.readdirSync(path.join(s.folderOf(projectId), 'Raced')), ['a.txt']);
  assert.equal(fs.readFileSync(path.join(s.folderOf(projectId), 'Raced', 'a.txt'), 'utf8'), 'theirs');
  assert.equal(fs.existsSync(path.join(h.roots.projectsRoot, tempName(uploadId))), false);
  await s.stagingEmpty();
});

test('item 4: commit hashes off the project chain, then re-checks the turn rule on it; a busy answer keeps the hash', BOUNDED, async (t) => {
  let hold = null;
  const s = await setup(t, { files: { serialized: (fn) => (hold ? hold.then(fn) : Promise.resolve().then(fn)) } });
  const { h, projectId } = s;
  const created = await h.ok(h.send('alice', 'sessions.create', { title: 'Files', project_id: projectId }));
  const sessionId = sessionIdOf(created);
  let running = false;
  h.backend.sessionTurnActors = { hasActiveLifecycle: (id) => running && id === sessionId };
  const uploadId = await s.upload('carl', 'Hashed', [['a.bin', crypto.randomBytes(1000)]]);
  let release;
  hold = new Promise((resolve) => { release = resolve; });
  const committing = s.op('carl', 'team.project.upload.commit', { upload_id: uploadId });
  await until(async () => (await s.op('carl', 'team.project.upload.status', { upload_id: uploadId })).verified === true,
    'the hash while another task holds the chain');
  running = true; // a turn starts while the commit waits for the chain
  hold = null;
  release();
  assert.equal(await h.reason(committing), 'team_project_busy');
  assert.equal(fs.existsSync(path.join(s.folderOf(projectId), 'Hashed')), false);
  running = false;
  await h.ok(s.op('carl', 'team.project.upload.commit', { upload_id: uploadId }));
  assert.equal(h.fx.logs.filter((entry) => entry.event === 'team_transfer.committed').length, 1, 'hashed once');
  await s.stagingEmpty();
});

test('item 5: begin looks at the caller again after its waits; refused then, nothing stays staged', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  let calls = 0;
  s.hooks.authorize = (real, actor, action, resource) => {
    if (action === 'project.files.upload') calls += 1;
    return calls === 2 ? hostFailure('forbidden', 'role_forbidden') : real(actor, action, resource);
  };
  assert.equal(await h.reason(s.begin('carl', projectId, 'Second', [['a', Buffer.from('a')]])), 'role_forbidden');
  assert.equal(calls, 2);
  assert.equal(h.files.resources().uploads, 0);
  await s.stagingEmpty();
});

test('item 6: the recheck drops only on forbidden, missing or deleting; a doubt drops nothing', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  fs.writeFileSync(path.join(s.folderOf(projectId), 'a.txt'), 'abc');
  await h.ok(s.begin('carl', projectId, 'Kept', [['a', Buffer.from('a')]]));
  await h.ok(s.op('carl', 'team.project.download.manifest', {}));
  const held = () => [h.files.resources().uploads, h.files.resources().manifests];
  s.hooks.authorize = () => { throw new Error('directory read failed'); };
  assert.equal(h.files.dropForProject({}), 0);
  s.hooks.authorize = () => hostFailure('unavailable', 'team_unavailable', '', true);
  assert.equal(h.files.dropForProject({}), 0);
  s.hooks.authorize = null;
  const open = h.store.open;
  h.store.open = () => ({ ok: false, error: { reason: 'team_unavailable' } });
  try {
    assert.equal(h.files.dropForProject({}), 0);
  } finally {
    h.store.open = open;
  }
  assert.ok(h.fx.logs.some((entry) => entry.event === 'team.project_files.recheck_skipped'));
  assert.deepEqual(held(), [1, 1]);
  s.hooks.authorize = () => hostFailure('forbidden', 'role_forbidden');
  assert.equal(h.files.dropForProject({}), 2);
  assert.deepEqual(held(), [0, 0]);
  await s.stagingEmpty();
});

test('item 8: names are folded by foldKey: directories split by case and folder names alike by case collide', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  assert.equal(await h.reason(s.begin('carl', projectId, 'Split', [['Dir/a', Buffer.from('a')], ['dir/b', Buffer.from('b')]])),
    'team_upload_manifest_invalid');
  await h.ok(s.begin('carl', projectId, 'Same', [['Dir/a', Buffer.from('a')], ['Dir/b', Buffer.from('b')]]));
  // 'AΣ' lower-cases to a final sigma, 'aσ' to a medial one: one fold, one folder.
  await h.ok(s.begin('alice', projectId, 'AΣ', [['a', Buffer.from('a')]]));
  assert.equal(await h.reason(s.begin('alice', projectId, 'aσ', [['a', Buffer.from('a')]])), 'team_upload_target_exists');
});

// ---------------------------------------------------------------- the module's own gates

test('the files module\'s own deleting gate: every command and both routes, authorization forced open', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  fs.writeFileSync(path.join(s.folderOf(projectId), 'a.txt'), 'abc');
  const begun = await h.ok(s.begin('carl', projectId, 'Doomed', [['a', Buffer.from('a')]]));
  const manifest = await h.ok(s.op('alice', 'team.project.download.manifest', {}));
  assert.equal((await h.store.markProjectDeleting({ actorMemberId: h.seats.alice.member_id, projectId })).ok, true);
  s.hooks.authorize = () => ({ ok: true });
  const direct = (who, operation, params) => h.files.commands.dispatch({ operation }, { params: { project_id: projectId, ...params },
    actor: { member_id: h.seats[who].member_id, owner: false, device_id: h.seats[who].device_id } });
  for (const [who, operation, params] of [['carl', 'team.project.upload.begin', { folder_name: 'x', files: manifestOf([['a', Buffer.from('a')]]) }],
    ['alice', 'team.project.download.manifest', {}], ['alice', 'team.project.download.manifest', { manifest_id: manifest.manifest_id }]]) {
    assert.equal((await direct(who, operation, params)).error.reason, 'team_project_deleting', `${who} ${operation}`);
  }
  const open = () => ({ ok: true });
  const read = await h.getPart('alice', projectId, manifest.manifest_id, 0, 0, { guard: open });
  assert.deepEqual([read.status, read.json.error.reason], [403, 'team_project_deleting']);
  const put = await h.putPart('carl', projectId, begun.upload_id, 0, 0, Buffer.from('a'), { guard: open });
  assert.deepEqual([put.status, put.json.error.reason], [403, 'team_project_deleting']);
});

// ---------------------------------------------------------------- branches

test('two begins at once for one name, and a name another open upload holds, answer target exists', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  const both = await Promise.all(['carl', 'alice'].map((who) => s.begin(who, projectId, 'Both', [['a', Buffer.from('a')]])));
  assert.deepEqual(both.map((answer) => answer.ok).sort(), [false, true]);
  assert.equal(both.find((answer) => !answer.ok).error.reason, 'team_upload_target_exists');
  assert.equal(await h.reason(s.begin('alice', projectId, 'BOTH', [['a', Buffer.from('a')]])), 'team_upload_target_exists');
});

test('manifests: two per member (the least recently used goes), one build at a time, a cursor past the end', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h } = s;
  for (let index = 0; index < 3; index += 1) fs.writeFileSync(path.join(s.folderOf(s.projectId), `f${index}`), `${index}`);
  const made = [];
  for (let index = 0; index < 3; index += 1) {
    made.push((await h.ok(s.op('rae', 'team.project.download.manifest', {}))).manifest_id);
    s.clock.now += 60_000;
  }
  assert.equal(await h.reason(s.op('rae', 'team.project.download.manifest', { manifest_id: made[0] })), 'team_not_found');
  await h.ok(s.op('rae', 'team.project.download.manifest', { manifest_id: made[1] }));
  assert.equal(await h.reason(s.op('rae', 'team.project.download.manifest', { manifest_id: made[2], cursor: 4 })),
    'team_cursor_invalid');
  const together = await Promise.all([s.op('carl', 'team.project.download.manifest', {}),
    s.op('carl', 'team.project.download.manifest', {})]);
  assert.deepEqual(together.map((answer) => answer.ok).sort(), [false, true]);
  assert.deepEqual([together.find((answer) => !answer.ok).error.reason, together.find((answer) => !answer.ok).error.retryable],
    ['team_upload_limit', true]);
});

test('expiry: an idle manifest after ten minutes, an idle upload after an hour, the stale answer for an hour', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  fs.writeFileSync(path.join(s.folderOf(projectId), 'a.txt'), 'abc');
  const manifest = await h.ok(s.op('rae', 'team.project.download.manifest', {}));
  const idle = await h.ok(s.begin('carl', projectId, 'Idle', [['a', Buffer.from('a')]]));
  const done = await h.ok(s.begin('carl', projectId, 'Done', [['a', Buffer.from('a')]]));
  await h.ok(s.op('carl', 'team.project.upload.discard', { upload_id: done.upload_id }));
  s.clock.now += 10 * 60_000;
  assert.equal(await h.reason(s.op('rae', 'team.project.download.manifest', { manifest_id: manifest.manifest_id })), 'team_not_found');
  s.clock.now += 49 * 60_000;
  assert.equal(await h.reason(s.op('carl', 'team.project.upload.status', { upload_id: done.upload_id })), 'team_upload_stale');
  s.clock.now += 60_000;
  assert.equal(await h.reason(s.op('carl', 'team.project.upload.status', { upload_id: done.upload_id })), 'team_not_found');
  assert.equal(await h.reason(s.op('carl', 'team.project.upload.status', { upload_id: idle.upload_id })), 'team_not_found');
  assert.equal(h.files.resources().uploads, 0);
  await s.stagingEmpty();
});

test('the sweep drops uploads the core let lapse and idle manifests', BOUNDED, async () => {
  let alive = true;
  let now = 0;
  const core = { begin: async () => ({ ok: true, uploadId: `upload_${'S'.repeat(22)}`, partSize: 4 }), alive: () => alive,
    sweep: async () => ({ ok: true }), discard: async () => ({ ok: true }), resources: () => ({ reservedBytes: 0, stagedBytes: 0 }) };
  const folders = { childState: () => ({ ok: true, state: 'absent' }), measure: async () => ({ ok: true, bytes: 0, files: 0, capped: false }),
    sweepInstalls: async () => 0, listFiles: async () => ({ ok: true, files: [], skipped: 0, capped: false }) };
  const store = { getProject: () => ({ state: 'active' }), snapshot: () => ({ projects: [] }), open: () => ({ ok: true }) };
  const files = createProjectFiles({ core, folders, store, authorize: () => ({ ok: true }), serialized: (fn) => fn(),
    audit: () => ({ append: () => ({ ok: true }) }), clock: () => now, statfs: () => ({ bavail: 1e15, bsize: 1 }),
    roots: ['/staging'] });
  const actor = { member_id: 'member_a', owner: false, device_id: 'device_a' };
  const begun = await files.dispatch({ operation: 'team.project.upload.begin' }, { params: { project_id: 'project_a', folder_name: 'a',
    files: [{ path: 'a', size: 1, sha256: 'a'.repeat(64) }] }, actor });
  assert.equal(begun.ok, true, JSON.stringify(begun));
  assert.equal((await files.dispatch({ operation: 'team.project.download.manifest' }, { params: { project_id: 'project_a' }, actor })).ok, true);
  assert.deepEqual([files.resources().uploads, files.resources().manifests], [1, 1]);
  alive = false;
  now += FILE_LIMITS.manifestIdleMs;
  await files.sweep();
  assert.deepEqual([files.resources().uploads, files.resources().manifests], [0, 0]);
});

test('commit paths: an incomplete upload stays open; a failed install answers team_upload_install_failed', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  const begun = await h.ok(s.begin('carl', projectId, 'Half', [['a.bin', Buffer.from('abcdef')]]));
  assert.equal(await h.reason(s.op('carl', 'team.project.upload.commit', { upload_id: begun.upload_id })), 'team_upload_stale');
  await h.ok(s.op('carl', 'team.project.upload.status', { upload_id: begun.upload_id }));
  const failing = await s.upload('carl', 'Failing', [['a.bin', Buffer.from('abc')]]);
  s.hooks.install = async () => ({ ok: false, reason: 'team_upload_install_failed' });
  const answer = await s.op('carl', 'team.project.upload.commit', { upload_id: failing });
  assert.deepEqual([answer.error.reason, answer.error.code], ['team_upload_install_failed',
    hostFailure('persistence', 'x').error.code]);
  assert.equal(await h.reason(s.op('carl', 'team.project.upload.status', { upload_id: failing })), 'team_upload_stale');
});

test('the turn rule: a turn in another project does not block commit; a session store that cannot answer does', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  const other = await h.sharedProject('Elsewhere');
  const created = await h.ok(h.send('alice', 'sessions.create', { title: 'Other', project_id: other }));
  const elsewhere = sessionIdOf(created);
  h.backend.sessionTurnActors = { hasActiveLifecycle: (id) => id === elsewhere };
  await h.ok(s.op('carl', 'team.project.upload.commit', { upload_id: await s.upload('carl', 'Free', [['a', Buffer.from('a')]]) }));
  const blocked = await s.upload('carl', 'Blocked', [['a', Buffer.from('a')]]);
  const list = h.backend.sessionStore.listSessions;
  h.backend.sessionStore.listSessions = () => { throw new Error('index unavailable'); };
  try {
    assert.equal(await h.reason(s.op('carl', 'team.project.upload.commit', { upload_id: blocked })), 'team_project_busy');
  } finally {
    h.backend.sessionStore.listSessions = list;
  }
});

test('revocation and replay: a team revoke drops uploads and manifests; begin and commit replay their receipt', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  fs.writeFileSync(path.join(s.folderOf(projectId), 'a.txt'), 'abc');
  const params = { project_id: projectId, folder_name: 'Replayed', files: manifestOf([['a', Buffer.from('a')]]) };
  const first = await h.ok(h.send('alice', 'team.project.upload.begin', params, { request_id: 'request_replayed_begin' }));
  const second = await h.ok(h.send('alice', 'team.project.upload.begin', params, { request_id: 'request_replayed_begin' }));
  assert.equal(second.upload_id, first.upload_id);
  await h.putPart('alice', projectId, first.upload_id, 0, 0, Buffer.from('a'));
  const commit = { project_id: projectId, upload_id: first.upload_id };
  const committed = await h.ok(h.send('alice', 'team.project.upload.commit', commit, { request_id: 'request_replayed_commit' }));
  assert.deepEqual(await h.ok(h.send('alice', 'team.project.upload.commit', commit, { request_id: 'request_replayed_commit' })),
    committed);
  assert.equal(h.files.resources().uploads, 0);
  await h.ok(s.begin('carl', projectId, 'Revoked', [['a', Buffer.from('a')]]));
  await h.ok(s.op('carl', 'team.project.download.manifest', {}));
  assert.equal((await h.store.revokeMember({ actorMemberId: h.seats.owner.member_id, memberId: h.seats.carl.member_id })).ok, true);
  assert.deepEqual([h.files.resources().uploads, h.files.resources().manifests], [0, 0]);
  await s.stagingEmpty();
});

test('limits: the command limiter covers the five commands; resolveLimits refuses a value above the caps', BOUNDED, async (t) => {
  assert.deepEqual(FILE_LIMITS, { beginFiles: 2_000, projectBytes: 2048 * MIB, projectFiles: 10_000, allBytes: 8192 * MIB,
    uploadsPerMember: 2, manifestsPerMember: 2, manifestIdleMs: 600_000, pageSize: 1_000, progressMs: 1_000 });
  const base = { folders: {}, store: {}, authorize: () => ({ ok: true }), serialized: (fn) => fn() };
  for (const [key, value] of Object.entries(FILE_LIMITS)) {
    assert.throws(() => createProjectFiles({ ...base, limits: { [key]: value + 1 } }), /invalid_project_file_limit/u, key);
  }
  assert.throws(() => createProjectFiles({ ...base, limits: { unknown: 1 } }), /invalid_project_file_limit/u);
  const s = await setup(t);
  const { h, projectId } = s;
  const context = { deviceId: h.seats.carl.device_id };
  const runReceipt = (_command, _context, run) => run();
  for (const operation of ['team.project.upload.begin', 'team.project.upload.status', 'team.project.upload.commit',
    'team.project.upload.discard', 'team.project.download.manifest']) {
    const commandsFor = createTeamCommands({ store: h.store, invites: createInviteService({ store: h.store }), directory: h.store.directory,
      limiter: createRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 8 }), files: h.files.commands });
    const command = { operation, request_id: 'request_limited', params: { project_id: projectId, upload_id: `upload_${'Q'.repeat(22)}` } };
    await commandsFor.dispatch(command, context, { runReceipt });
    assert.equal((await commandsFor.dispatch(command, context, { runReceipt })).error.reason, 'team_rate_limit', operation);
  }
});

test('the listing stops at the file cap seam and says so', BOUNDED, async (t) => {
  const s = await setup(t, { countCaps: { files: 3 } });
  for (let index = 0; index < 5; index += 1) fs.writeFileSync(path.join(s.folderOf(s.projectId), `f${index}`), 'x');
  const page = await s.h.ok(s.op('rae', 'team.project.download.manifest', {}));
  assert.deepEqual([page.total_files, page.capped], [3, true]);
});

// ---------------------------------------------------------------- quota terms, the install, progress

test('quota terms: open uploads elsewhere, reserved less staged, each root, a deleted project leaving the total', BOUNDED, async (t) => {
  const free = { staging: 1e15, projects: 1e15 };
  let stagingRoot = null;
  const s = await setup(t, { files: { limits: { allBytes: 100 },
    statfs: (root) => ({ bavail: root === stagingRoot ? free.staging : free.projects, bsize: 1 }) } });
  const { h, projectId } = s;
  stagingRoot = h.files.stagingRoot;
  const other = await h.sharedProject('Other');
  const sized = (size, folder, project, who = 'carl') => h.send(who, 'team.project.upload.begin', { project_id: project,
    folder_name: folder, files: [{ path: 'x.bin', size, sha256: sha(Buffer.alloc(size)) }] });
  const held = await h.ok(sized(60, 'held', other));
  assert.equal(await h.reason(sized(41, 'here', projectId)), 'team_project_quota', 'an open upload in another project counts');
  const here = await h.ok(sized(40, 'here', projectId));
  await h.ok(s.op('carl', 'team.project.upload.discard', { upload_id: here.upload_id }));
  // The reserve: 256 MiB plus what open uploads still owe (60 declared, none staged) plus the new 30.
  free.staging = 256 * MIB + 89;
  assert.equal(await h.reason(sized(30, 'reserve', projectId)), 'disk_pressure', 'the staging root');
  free.staging = 1e15;
  free.projects = 256 * MIB + 89;
  assert.equal(await h.reason(sized(30, 'reserve', projectId)), 'disk_pressure', 'the projects root');
  free.projects = 256 * MIB + 90;
  await h.ok(s.op('carl', 'team.project.upload.discard', { upload_id: (await h.ok(sized(30, 'reserve', projectId))).upload_id }));
  // Staged bytes are no longer owed: 60 staged leaves only the new 30 on top of the reserve.
  assert.equal((await h.putPart('carl', other, held.upload_id, 0, 0, Buffer.alloc(60))).status, 200);
  free.projects = 256 * MIB + 30;
  await h.ok(s.op('carl', 'team.project.upload.discard', { upload_id: (await h.ok(sized(30, 'staged', projectId))).upload_id }));
  free.projects = 1e15;
  await h.ok(h.send('carl', 'team.project.upload.commit', { project_id: other, upload_id: held.upload_id }));
  assert.equal(await h.reason(sized(41, 'after', projectId)), 'team_project_quota', 'the installed 60 count');
  assert.equal((await h.store.markProjectDeleting({ actorMemberId: h.seats.alice.member_id, projectId: other })).ok, true);
  await h.ok(sized(41, 'after', projectId));
});

test('install: a swapped install folder stops it and nothing is removed; every path passes the rules', BOUNDED, async (t) => {
  const s = await setup(t, { files: { hardLinks: false } });
  const { h, projectId } = s;
  const uploadId = await s.upload('carl', 'Swapped', [['a.txt', Buffer.from('a')], ['b.txt', Buffer.from('b')]]);
  const temp = path.join(h.roots.projectsRoot, tempName(uploadId));
  const realOpen = fs.promises.open;
  let swapped = false;
  fs.promises.open = async (file, flags, mode) => {
    if (!swapped && typeof file === 'string' && file.startsWith(temp)) {
      swapped = true;
      fs.renameSync(temp, `${temp}moved`);
      fs.mkdirSync(temp);
      fs.writeFileSync(path.join(temp, 'theirs.txt'), 'theirs');
    }
    return realOpen(file, flags, mode);
  };
  let answer;
  try {
    answer = await s.op('carl', 'team.project.upload.commit', { upload_id: uploadId });
  } finally {
    fs.promises.open = realOpen;
  }
  assert.equal(answer.error.reason, 'team_upload_install_failed');
  // The file being written when the swap came lands in the folder swapped in (the folder is re-identified before
  // each file); the next check stops the install, and that folder is never removed.
  assert.equal(fs.readdirSync(temp).includes('theirs.txt'), true, 'the folder swapped in is left');
  assert.equal(fs.existsSync(path.join(s.folderOf(projectId), 'Swapped')), false);
  fs.rmSync(temp, { recursive: true });
  fs.rmSync(`${temp}moved`, { recursive: true });
  const refused = await h.folders.install(projectId, 'Bad', `upload_${'B'.repeat(22)}`, [{ path: '../escape', size: 0, stagedPath: temp }]);
  assert.deepEqual(refused, { ok: false, reason: 'team_project_path_invalid' });
  assert.equal(fs.existsSync(path.join(h.roots.projectsRoot, tempName(`upload_${'B'.repeat(22)}`))), false);
});

test('install links on one device and copies otherwise; the installed file has one link either way', BOUNDED, async (t) => {
  for (const hardLinks of [true, false]) {
    const s = await setup(t, { files: { hardLinks } });
    const { h, projectId } = s;
    const bytes = crypto.randomBytes(3000);
    await h.ok(s.op('carl', 'team.project.upload.commit', { upload_id: await s.upload('carl', 'Placed', [['a.bin', bytes]]) }));
    const installed = path.join(s.folderOf(projectId), 'Placed', 'a.bin');
    assert.deepEqual(fs.readFileSync(installed), bytes);
    assert.equal(fs.lstatSync(installed).nlink, 1);
    const line = h.fx.logs.find((entry) => entry.event === 'team.project_files.installed');
    assert.equal(line.fields.linked, hardLinks ? 1 : 0, `hardLinks ${hardLinks}`);
    await s.stagingEmpty();
  }
});

test('measures: the first begin walks each project once; a fresh one is not walked again; ten minutes old is', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  await h.sharedProject('Other');
  const discard = async (answer) => h.ok(s.op('carl', 'team.project.upload.discard', { upload_id: answer.upload_id }));
  await discard(await h.ok(s.begin('carl', projectId, 'one', [['a', Buffer.from('a')]])));
  assert.equal(s.counts.measure, 2);
  await discard(await h.ok(s.begin('carl', projectId, 'two', [['a', Buffer.from('a')]])));
  assert.equal(s.counts.measure, 2);
  s.clock.now += 10 * 60_000;
  await discard(await h.ok(s.begin('carl', projectId, 'three', [['a', Buffer.from('a')]])));
  assert.equal(s.counts.measure, 3);
});

test('hashes are cached by device, inode, size and time: an unchanged file is not read again, a changed one is', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  fs.writeFileSync(path.join(s.folderOf(projectId), 'same.txt'), 'same');
  fs.writeFileSync(path.join(s.folderOf(projectId), 'changed.txt'), 'before');
  const first = await h.ok(s.op('rae', 'team.project.download.manifest', {}));
  assert.equal(s.counts.openListed, 2);
  fs.writeFileSync(path.join(s.folderOf(projectId), 'changed.txt'), 'after!');
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(s.folderOf(projectId), 'changed.txt'), future, future);
  s.clock.now += 60_000;
  const second = await h.ok(s.op('rae', 'team.project.download.manifest', {}));
  assert.equal(s.counts.openListed, 3, 'only the changed file is read');
  const hashOf = (page, name) => page.entries.find((entry) => entry.path === name).sha256;
  assert.equal(hashOf(second, 'same.txt'), hashOf(first, 'same.txt'));
  assert.equal(hashOf(second, 'changed.txt'), sha(Buffer.from('after!')));
});

test('progress: the final event goes out inside the same second as the one before it', BOUNDED, async (t) => {
  const s = await setup(t, { files: { coreLimits: { maxPartBytes: 4 } } });
  const { h, projectId } = s;
  const carl = h.attach('carl');
  const begun = await h.ok(s.begin('carl', projectId, 'Quick', [['a.bin', Buffer.from('abcdef')]]));
  await h.putPart('carl', projectId, begun.upload_id, 0, 0, Buffer.from('abcd'));
  await h.putPart('carl', projectId, begun.upload_id, 0, 1, Buffer.from('ef'));
  const seen = dataFrames(carl.frames).filter((frame) => frame.event_type === 'team_upload_progress')
    .map((frame) => [frame.files_done, frame.bytes_done]);
  assert.deepEqual(seen, [[0, 4], [1, 6]]);
});
