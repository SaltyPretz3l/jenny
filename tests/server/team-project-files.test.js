'use strict';

// Slice 3-8b: the project file commands (server/team/project-files.js) through the real router on the team
// project fixture: the authorization matrix, forged and foreign ids, the caps, the install, the turn rule, a
// deleting project, the audit entries, progress, a host with no core, the byte search and single-owner parity.
// The part and read routes have their own file (team-project-file-routes.test.js).

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const os = require('node:os');

const { BackendHarness, createFixture: createSingleOwner, command } = require('../helpers/command-router-fixture');
const { ClientRegistry } = require('../../server/client-registry');
const { ControlLeases } = require('../../server/control-leases');
const { createHostCore } = require('../../server/host-core');
const { OPERATIONS, createProjectFiles } = require('../../server/team/project-files');
const { dataFrames } = require('./helpers/session-scope-fixture');
const { createTeamProjectFixture } = require('./helpers/team-project-fixture');

const BOUNDED = { timeout: 60_000 };
const MIB = 1024 * 1024;
const HUGE_DISK = () => ({ bavail: 1e15, bsize: 1 });
const SECRET_FILE = 'Zebrafish-Secret.txt';
const SECRET_FOLDER = 'Quokka-Folder';
const SECRET_CONTENT = 'CONTENT-MARKER-7731';

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const manifestOf = (entries) => entries.map(([file, bytes]) => ({ path: file, size: bytes.length, sha256: sha(bytes) }));

async function setup(t, { files = {}, ...rest } = {}) {
  const h = await createTeamProjectFixture(t, { projectsRoot: true, files: { statfs: HUGE_DISK, ...files },
    ...rest });
  const projectId = await h.sharedProject();
  const folderOf = (id) => path.join(h.roots.projectsRoot, id);
  const begin = (who, projectIdArg, folder, entries) => h.send(who, 'team.project.upload.begin',
    { project_id: projectIdArg, folder_name: folder, files: manifestOf(entries) });
  // Begin, send every part, answer the upload id.
  const upload = async (who, folder, entries, project = projectId) => {
    const begun = await h.ok(begin(who, project, folder, entries), 'begin');
    for (const [index, [, bytes]] of entries.entries()) {
      if (bytes.length === 0) continue;
      const put = await h.putPart(who, project, begun.upload_id, index, 0, bytes);
      assert.equal(put.status, 200, JSON.stringify(put.json));
    }
    return begun.upload_id;
  };
  const op = (who, operation, params) => h.send(who, operation, { project_id: projectId, ...params });
  const stagingEntries = () => fs.readdirSync(h.files.stagingRoot);
  // A dropped upload's staging goes in the background: wait for it, boundedly.
  const stagingEmpty = async () => {
    for (let tries = 0; tries < 100 && stagingEntries().length > 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(stagingEntries(), []);
  };
  return { h, projectId, folderOf, begin, upload, op, stagingEntries, stagingEmpty };
}

// A conversation in the project and a turn the session store says runs (or not).
async function conversationIn(h, projectId) {
  const created = await h.ok(h.send('alice', 'sessions.create', { title: 'Files', project_id: projectId }), 'create');
  return created.session.session_id;
}

test('the matrix: upload needs writer, download needs reader, for every principal', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  const other = await h.ok(h.send('bob', 'team.project.create', { name: 'Other' }));
  // Carl leaves the writer row: removed.
  const entries = [['a.txt', Buffer.from('a')]];
  const verdict = async (who, operation, params) => {
    const answer = await s.op(who, operation, params);
    if (answer.ok && operation === 'team.project.upload.begin') {
      await h.ok(s.op(who, 'team.project.upload.discard', { upload_id: answer.upload_id }));
    }
    return answer.ok;
  };
  const beginParams = { folder_name: 'matrix', files: manifestOf(entries) };
  const expected = { owner: [false, false], alice: [true, true], carl: [true, true], rae: [false, true], pia: [false, false],
    bob: [false, false] };
  for (const [who, [upload, download]] of Object.entries(expected)) {
    assert.equal(await verdict(who, 'team.project.upload.begin', beginParams), upload, `${who} upload`);
    assert.equal(await verdict(who, 'team.project.download.manifest', {}), download, `${who} download`);
  }
  // Bob is a writer on his own project only.
  assert.equal((await h.send('bob', 'team.project.upload.begin', { project_id: other.project_id, ...beginParams })).ok, true);
  // No actor: refused before any handler.
  const client = h.clients.register(h.seats.carl.device_id);
  const bare = await h.core.router.dispatch({ api_version: 1, operation: 'team.project.download.manifest',
    request_id: 'request_bare', client_id: client.client_id, boot_epoch: h.core.bootEpoch, params: { project_id: projectId } },
  { deviceId: h.seats.carl.device_id, clientToken: client.client_token, isAuthenticated: () => true });
  assert.equal(bare.ok, false);
  // Removed from the project: refused.
  await h.ok(h.send('alice', 'team.project.members.remove', { project_id: projectId, member_id: h.seats.carl.member_id }));
  assert.equal(await verdict('carl', 'team.project.upload.begin', beginParams), false);
  assert.equal(await verdict('carl', 'team.project.download.manifest', {}), false);
  // status, commit and discard of Carl's upload answer missing for anyone else who may upload.
  const id = (await h.ok(s.begin('alice', projectId, 'alice-upload', entries))).upload_id;
  for (const operation of ['team.project.upload.status', 'team.project.upload.commit', 'team.project.upload.discard']) {
    assert.equal(await h.reason(s.op('owner', operation, { upload_id: id })), 'team_not_found', operation);
    assert.equal((await s.op('rae', operation, { upload_id: id })).ok, false, operation);
  }
  await h.ok(s.op('alice', 'team.project.upload.status', { upload_id: id }));
});

test('forged and foreign upload and manifest ids answer as missing and change nothing', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  const second = await h.sharedProject('Second');
  const begun = await h.ok(s.begin('carl', projectId, 'mine', [['a.txt', Buffer.from('abc')]]));
  const manifest = await h.ok(s.op('carl', 'team.project.download.manifest', {}));
  const before = JSON.stringify(h.files.resources());
  const forged = `upload_${'A'.repeat(22)}`;
  const direct = (memberWho, deviceId, operation, params) => h.files.commands.dispatch({ operation },
    { params, actor: { member_id: h.seats[memberWho].member_id, owner: false, device_id: deviceId } });
  for (const operation of ['team.project.upload.status', 'team.project.upload.commit', 'team.project.upload.discard']) {
    assert.equal(await h.reason(s.op('carl', operation, { upload_id: forged })), 'team_not_found');
    assert.equal(await h.reason(s.op('alice', operation, { upload_id: begun.upload_id })), 'team_not_found');
    // Carl's member on another device, and Carl's id under another project he writes.
    assert.equal((await direct('carl', 'device_other', operation, { project_id: projectId, upload_id: begun.upload_id })).error
      .reason, 'team_not_found');
    assert.equal(await h.reason(h.send('carl', operation, { project_id: second, upload_id: begun.upload_id })), 'team_not_found');
  }
  const page = (params) => s.op('carl', 'team.project.download.manifest', params);
  assert.equal(await h.reason(page({ manifest_id: `manifest_${'B'.repeat(22)}` })), 'team_not_found');
  assert.equal(await h.reason(s.op('alice', 'team.project.download.manifest', { manifest_id: manifest.manifest_id })),
    'team_not_found');
  assert.equal((await direct('carl', 'device_other', 'team.project.download.manifest',
    { project_id: projectId, manifest_id: manifest.manifest_id })).error.reason, 'team_not_found');
  assert.equal(await h.reason(h.send('carl', 'team.project.download.manifest', { project_id: second,
    manifest_id: manifest.manifest_id })), 'team_not_found');
  assert.equal(JSON.stringify(h.files.resources()), before);
  await h.ok(s.op('carl', 'team.project.upload.status', { upload_id: begun.upload_id }));
});

test('caps: files a begin, file size, upload size, open uploads, each at the limit and one over', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  const empty = (count) => Array.from({ length: count }, (_, index) => ({ path: `f${index}`, size: 0, sha256: sha(Buffer.alloc(0)) }));
  const declared = (sizes) => sizes.map((size, index) => ({ path: `d${index}`, size, sha256: 'a'.repeat(64) }));
  const tryBegin = (folder, files) => h.send('carl', 'team.project.upload.begin', { project_id: projectId, folder_name: folder, files });
  const discard = (answer) => h.ok(s.op('carl', 'team.project.upload.discard', { upload_id: answer.upload_id }));
  await discard(await h.ok(tryBegin('two-thousand', empty(2000))));
  assert.equal(await h.reason(tryBegin('two-thousand-one', empty(2001))), 'team_upload_file_limit');
  await discard(await h.ok(tryBegin('file-at', declared([64 * MIB]))));
  assert.equal(await h.reason(tryBegin('file-over', declared([64 * MIB + 1]))), 'team_upload_size_limit');
  await discard(await h.ok(tryBegin('upload-at', declared(Array(8).fill(64 * MIB)))));
  assert.equal(await h.reason(tryBegin('upload-over', declared([...Array(8).fill(64 * MIB), 1]))), 'team_upload_size_limit');
  const one = await h.ok(tryBegin('one', empty(1)));
  await h.ok(tryBegin('two', empty(1)));
  assert.equal(await h.reason(tryBegin('three', empty(1))), 'team_upload_limit');
  await discard(one);
  await h.ok(tryBegin('three', empty(1)));
  assert.equal(await h.reason(tryBegin('four', empty(1))), 'team_upload_limit');
});

test('quotas: project bytes and files, all projects, the disk reserve, and a measure stopped at the entry cap', BOUNDED, async (t) => {
  let free = 1e15;
  const s = await setup(t, { files: { limits: { projectBytes: 100, projectFiles: 3, allBytes: 150 },
    statfs: () => ({ bavail: free, bsize: 1 }) } });
  const { h, projectId } = s;
  fs.writeFileSync(path.join(s.folderOf(projectId), 'seed.bin'), Buffer.alloc(60));
  const other = await h.sharedProject('Other');
  fs.writeFileSync(path.join(s.folderOf(other), 'big.bin'), Buffer.alloc(30));
  const bytes = (size, folder = 'q', project = projectId) => h.send('carl', 'team.project.upload.begin', { project_id: project,
    folder_name: folder, files: [{ path: 'x.bin', size, sha256: 'a'.repeat(64) }] });
  const discard = async (answer, project = projectId) => h.ok(h.send('carl', 'team.project.upload.discard',
    { project_id: project, upload_id: answer.upload_id }));
  await discard(await h.ok(bytes(40)));
  assert.equal(await h.reason(bytes(41)), 'team_project_quota');
  const files = (count) => h.send('carl', 'team.project.upload.begin', { project_id: projectId, folder_name: 'n',
    files: Array.from({ length: count }, (_, index) => ({ path: `e${index}`, size: 0, sha256: sha(Buffer.alloc(0)) })) });
  await discard(await h.ok(files(2)));
  assert.equal(await h.reason(files(3)), 'team_project_quota');
  // All projects: 60 + 30 on disk, 150 in all (the other project's own 100 is not reached).
  await discard(await h.ok(bytes(60, 'all', other)), other);
  assert.equal(await h.reason(bytes(61, 'all', other)), 'team_project_quota');
  // An open upload's declared bytes count against the project until it ends.
  const held = await h.ok(bytes(30));
  assert.equal(await h.reason(bytes(11, 'q2')), 'team_project_quota');
  await discard(held);
  // The disk reserve: free space less what open uploads still owe stays above 256 MiB.
  free = 256 * MIB + 40;
  await discard(await h.ok(bytes(40)));
  free = 256 * MIB + 39;
  assert.equal(await h.reason(bytes(40)), 'disk_pressure');
});

test('bytes installed into one project count against the all-projects quota of the next begin elsewhere', BOUNDED, async (t) => {
  const s = await setup(t, { files: { limits: { allBytes: 100 } } });
  const { h, projectId } = s;
  const other = await h.sharedProject('Other');
  // The first begin measures every project (both empty); the install then adds 60 bytes to the first.
  const uploadId = await s.upload('carl', 'Sixty', [['a.bin', Buffer.alloc(60)]]);
  await h.ok(s.op('carl', 'team.project.upload.commit', { upload_id: uploadId }));
  const elsewhere = (size) => h.send('carl', 'team.project.upload.begin', { project_id: other, folder_name: 'b',
    files: [{ path: 'b.bin', size, sha256: 'a'.repeat(64) }] });
  assert.equal(await h.reason(elsewhere(41)), 'team_project_quota');
  const fits = await h.ok(elsewhere(40));
  await h.ok(h.send('carl', 'team.project.upload.discard', { project_id: other, upload_id: fits.upload_id }));
});

test('a project the measure cannot finish (the entry cap) is full: fail closed', BOUNDED, async (t) => {
  const s = await setup(t, { countCaps: { entries: 5 } });
  const { h, projectId } = s;
  for (let index = 0; index < 6; index += 1) fs.writeFileSync(path.join(s.folderOf(projectId), `f${index}`), 'x');
  assert.equal(await h.reason(s.begin('carl', projectId, 'cap', [['a', Buffer.from('a')]])), 'team_project_quota');
});

test('install: one new folder with every file, staging empty, the audit entry, nothing overwritten', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  const entries = [['top.txt', Buffer.from('top')], ['deep/er/leaf.bin', crypto.randomBytes(5000)], ['empty.txt', Buffer.alloc(0)]];
  const uploadId = await s.upload('carl', 'Fresh', entries);
  const committed = await h.ok(s.op('carl', 'team.project.upload.commit', { upload_id: uploadId }));
  assert.deepEqual({ files: committed.files, bytes: committed.bytes }, { files: 3, bytes: 5003 });
  for (const [file, bytes] of entries) {
    assert.deepEqual(fs.readFileSync(path.join(s.folderOf(projectId), 'Fresh', ...file.split('/'))), bytes);
  }
  assert.deepEqual(s.stagingEntries(), []);
  const page = h.approvals.audit().read({ projectId, afterSeq: 0, limit: 100 });
  const entry = page.entries.find((row) => row.kind === 'files_uploaded');
  assert.deepEqual({ actor: entry.actor_member_id, detail: entry.detail },
    { actor: h.seats.carl.member_id, detail: { files: 3, bytes: 5003, skipped: 0 } });
  // A second commit, and a commit after a discard, answer stale.
  assert.equal(await h.reason(s.op('carl', 'team.project.upload.commit', { upload_id: uploadId })), 'team_upload_stale');
  const dropped = (await h.ok(s.begin('carl', projectId, 'Dropped', [['a', Buffer.from('a')]]))).upload_id;
  await h.ok(s.op('carl', 'team.project.upload.discard', { upload_id: dropped }));
  assert.equal(await h.reason(s.op('carl', 'team.project.upload.commit', { upload_id: dropped })), 'team_upload_stale');
  // A folder that exists is refused at begin; one made between begin and commit is refused at install.
  assert.equal(await h.reason(s.begin('carl', projectId, 'Fresh', [['a', Buffer.from('a')]])), 'team_upload_target_exists');
  const late = await s.upload('carl', 'Late', [['a.txt', Buffer.from('new')]]);
  fs.mkdirSync(path.join(s.folderOf(projectId), 'Late'));
  fs.writeFileSync(path.join(s.folderOf(projectId), 'Late', 'a.txt'), 'old');
  assert.equal(await h.reason(s.op('carl', 'team.project.upload.commit', { upload_id: late })), 'team_upload_target_exists');
  assert.equal(fs.readFileSync(path.join(s.folderOf(projectId), 'Late', 'a.txt'), 'utf8'), 'old');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(s.stagingEntries(), []);
});

test('install: a hash mismatch installs nothing; a failure part way leaves no folder', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  const begun = await h.ok(s.begin('carl', projectId, 'Mismatch', [['a.txt', Buffer.from('promised')]]));
  await h.putPart('carl', projectId, begun.upload_id, 0, 0, Buffer.from('delivers'));
  assert.equal(await h.reason(s.op('carl', 'team.project.upload.commit', { upload_id: begun.upload_id })),
    'team_upload_hash_mismatch');
  assert.equal(fs.existsSync(path.join(s.folderOf(projectId), 'Mismatch')), false);
  // The install itself: the second staged file is gone, so the install folder goes and no final folder appears.
  const staged = path.join(h.fx.root, 'staged.bin');
  fs.writeFileSync(staged, 'abc');
  const uploadId = `upload_${'P'.repeat(22)}`;
  const failed = await h.folders.install(projectId, 'Partial', uploadId, [{ path: 'one.bin', size: 3, stagedPath: staged },
    { path: 'two.bin', size: 3, stagedPath: path.join(h.fx.root, 'missing.bin') }]);
  assert.deepEqual(failed, { ok: false, reason: 'team_upload_install_failed' });
  assert.equal(fs.existsSync(path.join(s.folderOf(projectId), 'Partial')), false);
  assert.equal(fs.existsSync(path.join(h.roots.projectsRoot, `.jenny-install-${uploadId}.`)), false);
});

test('commit waits out a running turn in the project; a deleting project refuses everything', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  await conversationIn(h, projectId);
  let running = true;
  h.backend.sessionTurnActors = { hasActiveLifecycle: () => running };
  const uploadId = await s.upload('carl', 'Turn', [['a.txt', Buffer.from('a')]]);
  assert.equal(await h.reason(s.op('carl', 'team.project.upload.commit', { upload_id: uploadId })), 'team_project_busy');
  running = false;
  await h.ok(s.op('carl', 'team.project.upload.commit', { upload_id: uploadId }));
  // Deleting: begin, status, commit, the manifest and a read are all refused, for the project's owner too.
  fs.writeFileSync(path.join(s.folderOf(projectId), 'kept.txt'), 'kept');
  const before = await h.ok(s.op('alice', 'team.project.download.manifest', {}));
  const open = await h.ok(s.begin('carl', projectId, 'Doomed', [['a', Buffer.from('a')]]));
  const marked = await h.store.markProjectDeleting({ actorMemberId: h.seats.alice.member_id, projectId });
  assert.equal(marked.ok, true, JSON.stringify(marked));
  // The router's own authorization answers a deleting project as missing; the files module's own gate is pinned
  // with authorization forced open (team-project-files-rules.test.js).
  for (const [who, operation, params, expected] of [
    ['carl', 'team.project.upload.begin', { folder_name: 'x', files: manifestOf([['a', Buffer.from('a')]]) }, 'team_not_found'],
    ['carl', 'team.project.upload.status', { upload_id: open.upload_id }, 'team_not_found'],
    ['carl', 'team.project.upload.commit', { upload_id: open.upload_id }, 'team_not_found'],
    ['rae', 'team.project.download.manifest', {}, 'team_not_found'],
    ['alice', 'team.project.download.manifest', {}, 'team_not_found'],
    ['alice', 'team.project.download.manifest', { manifest_id: before.manifest_id }, 'team_not_found']]) {
    assert.equal(await h.reason(s.op(who, operation, params)), expected, `${who} ${operation}`);
  }
  const read = await h.getPart('alice', projectId, before.manifest_id, 0, 0);
  assert.deepEqual([read.status, read.json.error.reason], [403, 'team_not_found']);
  await s.stagingEmpty();
});

test('E69: begin refuses a sensitive folder name or path segment before a byte is staged; the listing never offers one', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  const one = [['a.txt', Buffer.from('a')]];
  for (const [folder, entries] of [['.git', one], ['.GitHub', one], ['.jenny', one], ['Fine', [['.git/config', Buffer.from('x')]]],
    ['Fine', [['ok.txt', Buffer.from('o')], ['src/.VSCode/tasks.json', Buffer.from('t')]]], ['Fine', [['deep/.env', Buffer.from('e')]]]]) {
    assert.equal(await h.reason(s.begin('carl', projectId, folder, entries)), 'team_project_path_invalid', `${folder} ${entries[entries.length - 1][0]}`);
    assert.deepEqual(s.stagingEntries(), [], 'nothing staged');
  }
  assert.equal(h.files.resources().uploads, 0);
  // Other dot names travel as before.
  const dotted = await s.upload('carl', '.config', [['.gitignore', Buffer.from('node_modules\n')], ['.editorconfig', Buffer.from('root = true\n')]]);
  await h.ok(s.op('carl', 'team.project.upload.commit', { upload_id: dotted }));
  // Files an earlier build placed stay on disk; the listing skips and counts them.
  const root = s.folderOf(projectId);
  for (const rel of ['.git/config', '.GIT2/kept.txt', 'sub/.Env', '.jenny/x/y.json', '.vscode/tasks.json', 'a.txt']) {
    fs.mkdirSync(path.dirname(path.join(root, ...rel.split('/'))), { recursive: true });
    fs.writeFileSync(path.join(root, ...rel.split('/')), rel);
  }
  const manifest = await h.ok(s.op('rae', 'team.project.download.manifest', {}));
  assert.deepEqual(manifest.entries.map((entry) => entry.path).sort(),
    ['.GIT2/kept.txt', '.config/.editorconfig', '.config/.gitignore', 'a.txt']);
  assert.equal(manifest.skipped, 4);
  assert.equal(fs.readFileSync(path.join(root, '.git', 'config'), 'utf8'), '.git/config', 'not deleted');
});

test('audit: the manifest writes files_downloaded with its totals; a failed append refuses it and not an upload', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  fs.writeFileSync(path.join(s.folderOf(projectId), 'a.txt'), 'hello');
  fs.mkdirSync(path.join(s.folderOf(projectId), 'sub'));
  fs.writeFileSync(path.join(s.folderOf(projectId), 'sub', 'b.txt'), 'world!');
  const manifest = await h.ok(s.op('rae', 'team.project.download.manifest', {}));
  assert.deepEqual({ files: manifest.total_files, bytes: manifest.total_bytes, skipped: manifest.skipped }, { files: 2, bytes: 11, skipped: 0 });
  const entry = h.approvals.audit().read({ projectId, afterSeq: 0, limit: 100 }).entries.find((row) => row.kind === 'files_downloaded');
  assert.deepEqual({ actor: entry.actor_member_id, detail: entry.detail },
    { actor: h.seats.rae.member_id, detail: { files: 2, bytes: 11, skipped: 0 } });

  const failing = { openAtStart() {}, floorSeq: () => 0, append: () => ({ ok: false }), read: () => ({ ok: true, entries: [] }) };
  const f = await setup(t, { createAudit: () => failing });
  fs.writeFileSync(path.join(f.folderOf(f.projectId), 'a.txt'), 'hello');
  assert.equal(await f.h.reason(f.op('rae', 'team.project.download.manifest', {})), 'team_audit_unavailable');
  assert.equal(f.h.files.resources().manifests, 0);
  const uploadId = await f.upload('carl', 'Stands', [['a.txt', Buffer.from('a')]]);
  await f.h.ok(f.op('carl', 'team.project.upload.commit', { upload_id: uploadId }));
  assert.equal(fs.existsSync(path.join(f.folderOf(f.projectId), 'Stands', 'a.txt')), true);
  assert.match(f.h.logText(), /team\.project_files\.upload_unrecorded/u);
});

test('progress reaches only the uploader, live, at most once a second and once at the end, never replayed', BOUNDED, async (t) => {
  let now = 1_000_000;
  const s = await setup(t, { clock: () => now, files: { coreLimits: { maxPartBytes: 4 } }, leaseNow: () => now });
  const { h, projectId } = s;
  const carl = h.attach('carl');
  const alice = h.attach('alice');
  const bob = h.attach('bob');
  const progress = (response) => dataFrames(response.frames).filter((frame) => frame.event_type === 'team_upload_progress');
  const begun = await h.ok(s.begin('carl', projectId, 'Progress', [['a.bin', Buffer.from('abcdefghij')]]));
  await h.putPart('carl', projectId, begun.upload_id, 0, 0, Buffer.from('abcd'));
  await h.putPart('carl', projectId, begun.upload_id, 0, 1, Buffer.from('efgh'));
  now += 1_000;
  await h.putPart('carl', projectId, begun.upload_id, 0, 2, Buffer.from('ij'));
  const seen = progress(carl).map(({ upload_id: id, files_done: filesDone, bytes_done: bytesDone }) => ({ id, filesDone, bytesDone }));
  assert.deepEqual(seen, [{ id: begun.upload_id, filesDone: 0, bytesDone: 4 }, { id: begun.upload_id, filesDone: 1, bytesDone: 10 }]);
  assert.deepEqual(Object.keys(progress(carl)[0]).filter((key) => !['event_type', 'cursor', 'boot_epoch', 'api_version'].includes(key)).sort(),
    ['bytes_done', 'files_done', 'upload_id']);
  assert.equal(progress(alice).length, 0);
  assert.equal(progress(bob).length, 0);
  assert.equal(progress(h.attach('carl', { cursor: 0 })).length, 0);
});

// Slice 3-8c: every platform serves project files, this one included (a Windows volume the probe refuses is in
// team-project-files-win32.test.js); with no transfer core every entry answers unavailable.
test('a module with a transfer core serves on this platform; with no core every entry answers unavailable', BOUNDED, async () => {
  const base = { folders: {}, store: {}, authorize: () => ({ ok: true }), serialized: (fn) => fn() };
  assert.equal(createProjectFiles({ ...base, core: { resources: () => ({}) } }).filesUnavailable(), null);
  const files = createProjectFiles({ ...base, core: null });
  for (const operation of OPERATIONS) {
    const answer = await files.dispatch({ operation }, { params: { project_id: 'project_x' },
      actor: { member_id: 'member_x', owner: false, device_id: 'device_x' } });
    assert.equal(answer.error.reason, 'team_project_files_unavailable', operation);
  }
  assert.equal(files.filesUnavailable().error.reason, 'team_project_files_unavailable');
});

test('the byte search: no answer, event, log line or audit entry carries a file name, a path or content', BOUNDED, async (t) => {
  const s = await setup(t);
  const { h, projectId } = s;
  const carl = h.attach('carl');
  const answers = [];
  const keep = async (promise) => { const answer = await promise; answers.push(answer); return answer; };
  const entries = [[`inner/${SECRET_FILE}`, Buffer.from(SECRET_CONTENT)]];
  const begun = await keep(s.begin('carl', projectId, SECRET_FOLDER, entries));
  answers.push((await h.putPart('carl', projectId, begun.upload_id, 0, 0, entries[0][1])).json);
  await keep(s.op('carl', 'team.project.upload.status', { upload_id: begun.upload_id }));
  await keep(s.op('carl', 'team.project.upload.commit', { upload_id: begun.upload_id }));
  await keep(s.begin('carl', projectId, SECRET_FOLDER, entries));
  const mismatch = await keep(s.begin('carl', projectId, `${SECRET_FOLDER}2`, entries));
  await h.putPart('carl', projectId, mismatch.upload_id, 0, 0, Buffer.from(SECRET_CONTENT.toLowerCase()));
  await keep(s.op('carl', 'team.project.upload.commit', { upload_id: mismatch.upload_id }));
  const manifest = await h.ok(s.op('rae', 'team.project.download.manifest', {}));
  const read = await h.getPart('rae', projectId, manifest.manifest_id, 0, 0);
  assert.equal(read.bytes.toString('utf8'), SECRET_CONTENT); // the read route's body is the file, by design
  const audit = h.approvals.audit().read({ projectId, afterSeq: 0, limit: 100 }).entries;
  // Every file the host wrote in its profile (the audit file, command-receipts.json and the rest), read raw.
  const profileFiles = [];
  const collect = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (entry.isFile()) profileFiles.push(fs.readFileSync(full, 'utf8'));
    }
  };
  assert.equal(h.roots.projectsRoot.startsWith(h.config.userDataPath), false, 'the project folders are outside the profile');
  collect(h.config.userDataPath);
  assert.ok(profileFiles.some((text) => text.includes('files_uploaded')), 'the audit file was read');
  assert.ok(fs.existsSync(path.join(h.config.userDataPath, 'command-receipts.json')), 'the receipts file was read');
  assert.ok(h.fx.logs.some((entry) => entry.event === 'team.project_files.install_failed'
    || entry.event === 'team_transfer.hash_mismatch'), 'a refusal was logged');
  const haystack = JSON.stringify([answers, dataFrames(carl.frames), h.fx.logs, audit]) + profileFiles.join('\n');
  // Each path also as JSON escapes it (a Windows path's backslashes doubled).
  const escaped = (value) => JSON.stringify(value).slice(1, -1);
  for (const needle of [SECRET_FILE, SECRET_FOLDER, SECRET_CONTENT, 'inner/', h.roots.projectsRoot, h.files.stagingRoot,
    escaped(h.roots.projectsRoot), escaped(h.files.stagingRoot)]) {
    assert.equal(haystack.includes(needle), false, needle);
  }
});

test('single-owner parity: no file operation or route on a host without the team', BOUNDED, async (t) => {
  const f = createSingleOwner();
  t.after(() => f.close());
  for (const operation of ['team.project.upload.begin', 'team.project.download.manifest']) {
    const params = operation.endsWith('begin') ? { project_id: 'project_x', folder_name: 'x',
      files: [{ path: 'a', size: 0, sha256: sha(Buffer.alloc(0)) }] } : { project_id: 'project_x' };
    const answer = await f.router.dispatch(command(f.a, operation, params), f.contextA);
    const known = await f.router.dispatch(command(f.a, 'team.project.unjoined', {}), f.contextA);
    assert.equal(answer.ok, false);
    assert.deepEqual({ ...answer.error, request_id: null }, { ...known.error, request_id: null }, operation);
  }
  // The single-owner host core's own route half (its asset and artifact routes) declines both part paths.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-files-parity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const backend = new BackendHarness(root);
  backend.sidecarManager = { process: null };
  const composition = { backend, start: async () => {}, stop: async () => ({ exitConfirmed: true }),
    dispose: async () => { backend.dispose(); } };
  const core = createHostCore({ config: { userDataPath: root, workspaceRoot: null, secretsDir: null, execution: null,
    pythonExecutable: 'python' }, clients: new ClientRegistry(), leases: new ControlLeases(), logger: () => {},
  createBackend: () => composition });
  t.after(() => core.dispose().catch(() => {}));
  for (const [method, pathname] of [['PUT', '/api/v1/projects/project_x/uploads/upload_x/files/0/parts/0'],
    ['GET', '/api/v1/projects/project_x/downloads/manifest_x/files/0/parts/0']]) {
    assert.equal(await core.assetRoutes({ request: { method, headers: {} }, response: {}, pathname, authorized: () => true }),
      false, `${method} ${pathname}`);
  }
});

// Review round two, R15-F03: a turn that starts while commit waits on the chain's quota measure, or while the
// install builds its folder, stops the install before the rename.
test('R15-F03: a turn started during the commit\'s measure or the install\'s build answers busy before the rename', BOUNDED, async (t) => {
  let running = false;
  const arm = { sweep: false, install: false };
  const s = await setup(t, { files: { wrapFolders: (folders) => ({ ...folders,
    sweepInstalls: async (...args) => { if (arm.sweep) running = true; return folders.sweepInstalls(...args); },
    install: (...args) => { if (arm.install) running = true; return folders.install(...args); } }) } });
  const { h, projectId } = s;
  await conversationIn(h, projectId);
  h.backend.sessionTurnActors = { hasActiveLifecycle: () => running };
  // The measure: busy, and the upload stays verified for a later commit.
  const first = await s.upload('carl', 'During-measure', [['a.txt', Buffer.from('a')]]);
  arm.sweep = true;
  assert.equal(await h.reason(s.op('carl', 'team.project.upload.commit', { upload_id: first })), 'team_project_busy');
  arm.sweep = false;
  assert.equal(fs.existsSync(path.join(s.folderOf(projectId), 'During-measure')), false);
  assert.equal((await h.ok(s.op('carl', 'team.project.upload.status', { upload_id: first }))).verified, true);
  running = false;
  await h.ok(s.op('carl', 'team.project.upload.commit', { upload_id: first }));
  assert.equal(fs.readFileSync(path.join(s.folderOf(projectId), 'During-measure', 'a.txt'), 'utf8'), 'a');
  // The build: the staged files are already taken, so the upload ends; nothing reaches the project folder.
  const second = await s.upload('carl', 'During-build', [['b.txt', Buffer.from('b')]]);
  arm.install = true;
  assert.equal(await h.reason(s.op('carl', 'team.project.upload.commit', { upload_id: second })), 'team_project_busy');
  arm.install = false;
  running = false;
  assert.equal(fs.existsSync(path.join(s.folderOf(projectId), 'During-build')), false);
  assert.deepEqual(fs.readdirSync(h.roots.projectsRoot).filter((name) => name.startsWith('.jenny-install-')), []);
  assert.equal(await h.reason(s.op('carl', 'team.project.upload.commit', { upload_id: second })), 'team_upload_stale');
  await s.stagingEmpty();
});

// Review sweeps, second run (X4b-F01): an installed file is on disk before the install answers ok, on the link path
// (every same-volume upload) as on the copy path. Counts each FileHandle sync of a regular file, by its size.
test('X4b-F01: an install syncs every installed file before it answers ok, linked or copied', BOUNDED, async (t) => {
  const { createProjectFolders } = require('../../server/team/project-folders');
  const { createTransferIo } = require('../../server/team/transfer-io');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'x4b-f01-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const roots = { projectsRoot: path.join(base, 'projects'), trashRoot: path.join(base, 'trash') };
  const uploadId = `upload_${'A'.repeat(22)}`;
  const staging = path.join(base, 'staging', uploadId);
  for (const dir of [...Object.values(roots), staging]) fs.mkdirSync(dir, { recursive: true });
  const probe = await fs.promises.open(path.join(base, 'probe'), 'w');
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const realSync = proto.sync;
  const synced = [];
  proto.sync = async function sync(...args) {
    const stat = await this.stat();
    if (stat.isFile()) synced.push(stat.size);
    return realSync.apply(this, args);
  };
  t.after(() => { proto.sync = realSync; });
  const io = createTransferIo();
  for (const hardLinks of [false, true]) {
    const sizes = [256 * 1024, 7, 1];
    const files = sizes.map((size, index) => ({ path: `d/${index}.bin`, size, stagedPath: path.join(staging, `${hardLinks}-${index}.part`) }));
    for (const file of files) {
      await io.writeAt(file.stagedPath, 0, Buffer.alloc(file.size, 7));
      await io.hashFile(file.stagedPath, file.size);
    }
    synced.length = 0;
    const folders = createProjectFolders({ ...roots, hardLinks });
    const id = hardLinks ? 'project_linked' : 'project_copied';
    assert.equal(folders.create(id).ok, true);
    const answer = await folders.install(id, 'docs', uploadId, files);
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(answer.linked, hardLinks ? files.length : 0);
    assert.deepEqual([...synced].sort((a, b) => a - b), [...sizes].sort((a, b) => a - b),
      `hardLinks=${hardLinks}: one file sync per installed file before the ok answer`);
  }
});
