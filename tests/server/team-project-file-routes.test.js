'use strict';

// Slice 3-8b: the two raw part routes (server/team/project-file-routes.js) on the team project fixture with
// real temporary trees: the matrix, forged ids, a removal or re-role while a body arrives, containment (links,
// junctions, swaps, a hard link, the projects root, the Windows name vectors), the Content-Length rules and
// the bytes a read serves. On this Windows machine a symbolic link needs a privilege it lacks: those cases
// skip and are named in the report; the junction cases run. Since slice 3-8c the real platform runs.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const vectors = require('../fixtures/win32-segment-name-vectors.json');
const { createRouteGuard } = require('../../server/team/route-guard');
const { createTeamProjectFixture } = require('./helpers/team-project-fixture');

const BOUNDED = { timeout: 60_000 };
const MIB = 1024 * 1024;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const manifestOf = (entries) => entries.map(([file, bytes]) => ({ path: file, size: bytes.length, sha256: sha(bytes) }));

// A symbolic link, or false where this host may not make one.
function trySymlink(target, link, type) {
  try { fs.symlinkSync(target, link, type); return true; } catch (error) {
    if (error.code === 'EPERM') return false;
    throw error;
  }
}

async function setup(t, options = {}) {
  const h = await createTeamProjectFixture(t, { projectsRoot: true, files: { statfs: () => ({ bavail: 1e15, bsize: 1 }),
    ...options.files }, ...options.fixture });
  const projectId = await h.sharedProject();
  const folder = path.join(h.roots.projectsRoot, projectId);
  const begin = async (who, name, entries) => (await h.ok(h.send(who, 'team.project.upload.begin',
    { project_id: projectId, folder_name: name, files: manifestOf(entries) }), 'begin')).upload_id;
  const manifest = (who) => h.send(who, 'team.project.download.manifest', { project_id: projectId });
  return { h, projectId, folder, begin, manifest };
}

test('the matrix: the part route needs writer, the read route reader, checked before the body and after it', BOUNDED, async (t) => {
  const { h, projectId, folder, begin, manifest } = await setup(t);
  fs.writeFileSync(path.join(folder, 'read.txt'), 'readable');
  const carlUpload = await begin('carl', 'carl', [['a.txt', Buffer.from('abc')]]);
  const aliceUpload = await begin('alice', 'alice', [['a.txt', Buffer.from('abc')]]);
  const carlManifest = (await h.ok(manifest('carl'))).manifest_id;
  assert.equal((await h.putPart('alice', projectId, aliceUpload, 0, 0, Buffer.from('abc'))).status, 200);
  assert.equal((await h.putPart('carl', projectId, carlUpload, 0, 0, Buffer.from('abc'))).status, 200);
  for (const who of ['owner', 'rae', 'pia', 'bob', null]) {
    const put = await h.putPart(who, projectId, carlUpload, 0, 0, Buffer.from('abc'));
    assert.equal(put.status, 403, `${who} put`);
  }
  // One manifest per member (a member builds at most one a minute); Carl's is the one made above.
  for (const who of ['alice', 'carl', 'rae']) {
    const own = who === 'carl' ? carlManifest : (await h.ok(manifest(who))).manifest_id;
    const read = await h.getPart(who, projectId, own, 0, 0);
    assert.equal(read.status, 200, `${who} read`);
    assert.equal(read.bytes.toString(), 'readable');
  }
  for (const who of ['owner', 'pia', 'bob', null]) {
    assert.equal((await h.getPart(who, projectId, carlManifest, 0, 0)).status, 403, `${who} read`);
  }
  // A client that is no longer authorized is refused before anything.
  const unauthorized = await h.getPart('carl', projectId, carlManifest, 0, 0, { authorizedNow: () => false });
  assert.equal(unauthorized.json.error.reason, 'client_required');
  await h.ok(h.send('alice', 'team.project.members.remove', { project_id: projectId, member_id: h.seats.carl.member_id }));
  assert.equal((await h.getPart('carl', projectId, carlManifest, 0, 0)).status, 403);
  assert.equal((await h.putPart('carl', projectId, carlUpload, 0, 0, Buffer.from('abc'))).status, 403);
});

test('the guard alone: refused before the body, and again after it when it changes while the body arrives', BOUNDED, async (t) => {
  const { h, projectId, folder, begin, manifest } = await setup(t);
  fs.writeFileSync(path.join(folder, 'g.txt'), 'guarded');
  const uploadId = await begin('carl', 'guard', [['a.txt', Buffer.from('abcdef')]]);
  const manifestId = (await h.ok(manifest('carl'))).manifest_id;
  const deny = () => ({ ok: false, error: { code: 'CMP-HOST-0003', reason: 'role_forbidden', retryable: false } });
  // Refused before the body: drained, nothing written, answered at the body's end.
  const before = await h.putPart('carl', projectId, uploadId, 0, 0, Buffer.from('abcdef'), { guard: deny });
  assert.deepEqual([before.status, before.json.error.reason, before.flowing], [403, 'role_forbidden', true]);
  assert.equal((await h.getPart('carl', projectId, manifestId, 0, 0, { guard: deny })).json.error.reason, 'role_forbidden');
  let allow = true;
  const flipping = (action, resource) => (allow ? h.authorize(h.seats.carl, action, resource) : deny());
  const after = await h.putPart('carl', projectId, uploadId, 0, 0, Buffer.from('abcdef'), { guard: flipping,
    during: () => { allow = false; } });
  assert.deepEqual([after.status, after.json.error.reason, after.answeredBeforeEnd], [403, 'role_forbidden', false]);
  const status = await h.ok(h.send('carl', 'team.project.upload.status', { project_id: projectId, upload_id: uploadId }));
  assert.equal(status.files[0].received, 0);
});

test('forged ids, indexes, parts, devices and projects answer as missing and write nothing', BOUNDED, async (t) => {
  const { h, projectId, folder, begin, manifest } = await setup(t);
  const second = await h.sharedProject('Second');
  fs.writeFileSync(path.join(folder, 'one.txt'), 'one');
  const uploadId = await begin('carl', 'up', [['a.txt', Buffer.from('abc')]]);
  const manifestId = (await h.ok(manifest('carl'))).manifest_id;
  const missing = async (answer, what) => assert.equal(answer.json?.error?.reason, 'team_not_found', what);
  await missing(await h.putPart('carl', projectId, `upload_${'Z'.repeat(22)}`, 0, 0, Buffer.from('abc')), 'forged upload');
  await missing(await h.putPart('carl', projectId, 'upload_short', 0, 0, Buffer.from('abc')), 'malformed upload');
  await missing(await h.putPart('alice', projectId, uploadId, 0, 0, Buffer.from('abc')), 'another member');
  await missing(await h.putPart('carl', projectId, uploadId, 0, 0, Buffer.from('abc'), { deviceId: 'device_other' }), 'another device');
  await missing(await h.putPart('carl', second, uploadId, 0, 0, Buffer.from('abc')), 'another project');
  await missing(await h.putPart('carl', projectId, uploadId, 1, 0, Buffer.from('abc')), 'index past the manifest');
  await missing(await h.putPart('carl', projectId, uploadId, 'x', 0, Buffer.from('abc')), 'index not a number');
  await missing(await h.getPart('carl', projectId, `manifest_${'Z'.repeat(22)}`, 0, 0), 'forged manifest');
  await missing(await h.getPart('rae', projectId, manifestId, 0, 0), 'another member\'s manifest');
  await missing(await h.getPart('carl', projectId, manifestId, 0, 0, { deviceId: 'device_other' }), 'another device');
  await missing(await h.getPart('carl', second, manifestId, 0, 0), 'another project');
  await missing(await h.getPart('carl', projectId, manifestId, 1, 0), 'index past the manifest');
  await missing(await h.getPart('carl', projectId, manifestId, 0, 1), 'part past the file');
  await missing(await h.getPart('carl', projectId, manifestId, 0, '01'), 'part with a leading zero');
  const status = await h.ok(h.send('carl', 'team.project.upload.status', { project_id: projectId, upload_id: uploadId }));
  assert.deepEqual(status.files, [{ index: 0, size: 3, received: 0 }]);
});

test('removal and re-role while a part body arrives: refused after the body, staging gone, the slot freed', BOUNDED, async (t) => {
  const { h, projectId, begin } = await setup(t);
  const bytes = Buffer.from('abcdef');
  const removed = await begin('carl', 'removed', [['a.bin', bytes]]);
  const answer = await h.putPart('carl', projectId, removed, 0, 0, bytes, { during: () => h.ok(h.send('alice',
    'team.project.members.remove', { project_id: projectId, member_id: h.seats.carl.member_id })) });
  assert.equal(answer.status, 403);
  assert.equal(h.files.resources().uploads, 0);
  assert.equal(h.files.resources().core.stagedBytes, 0);
  await h.ok(h.send('alice', 'team.project.members.add', { project_id: projectId, member_id: h.seats.carl.member_id,
    role: 'writer' }));
  const rerole = await begin('carl', 'rerole', [['a.bin', bytes]]);
  await begin('carl', 'second-slot', [['a.bin', bytes]]);
  const refused = await h.putPart('carl', projectId, rerole, 0, 0, bytes, { during: () => h.ok(h.send('alice',
    'team.project.members.setRole', { project_id: projectId, member_id: h.seats.carl.member_id, role: 'reader' })) });
  assert.equal(refused.status, 403);
  assert.equal(h.files.resources().uploads, 0);
  for (let tries = 0; tries < 100 && fs.readdirSync(h.files.stagingRoot).length > 0; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(fs.readdirSync(h.files.stagingRoot), []);
});

test('containment: links and junctions in the tree are skipped and counted, never read through; a hard link too', BOUNDED, async (t) => {
  const { h, projectId, folder, manifest } = await setup(t);
  const outside = path.join(h.fx.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-bytes');
  fs.writeFileSync(path.join(folder, 'plain.txt'), 'plain');
  fs.symlinkSync(outside, path.join(folder, 'junction'), 'junction');
  const symlinked = trySymlink(path.join(outside, 'secret.txt'), path.join(folder, 'link.txt'), 'file');
  fs.writeFileSync(path.join(folder, 'hard.txt'), 'hard');
  fs.linkSync(path.join(folder, 'hard.txt'), path.join(outside, 'hard-twin.txt'));
  const page = await h.ok(manifest('rae'));
  assert.deepEqual(page.entries.map((entry) => entry.path), ['plain.txt']);
  // The junction, the hard-linked file, and the symbolic link where this host could make one.
  assert.equal(page.skipped, symlinked ? 3 : 2);
  t.diagnostic(symlinked ? 'symbolic link case ran' : 'symbolic link case skipped: no symlink privilege on this host');
});

test('containment: the target folder replaced by a link between begin and commit installs nothing', BOUNDED, async (t) => {
  const { h, projectId, folder, begin } = await setup(t);
  const outside = path.join(h.fx.root, 'elsewhere');
  fs.mkdirSync(outside);
  const uploadId = await begin('carl', 'Target', [['a.txt', Buffer.from('abc')]]);
  await h.putPart('carl', projectId, uploadId, 0, 0, Buffer.from('abc'));
  fs.symlinkSync(outside, path.join(folder, 'Target'), 'junction');
  assert.equal(await h.reason(h.send('carl', 'team.project.upload.commit', { project_id: projectId, upload_id: uploadId })),
    'team_upload_target_exists');
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.lstatSync(path.join(folder, 'Target')).isSymbolicLink(), true);
});

test('containment: the projects root replaced by a link refuses begin, the manifest and a read', BOUNDED, async (t) => {
  const { h, projectId, folder, begin, manifest } = await setup(t);
  fs.writeFileSync(path.join(folder, 'a.txt'), 'abc');
  const manifestId = (await h.ok(manifest('rae'))).manifest_id;
  const uploadId = await begin('carl', 'Before', [['a.txt', Buffer.from('abc')]]);
  await h.putPart('carl', projectId, uploadId, 0, 0, Buffer.from('abc'));
  const moved = `${h.roots.projectsRoot}-moved`;
  fs.renameSync(h.roots.projectsRoot, moved);
  fs.symlinkSync(moved, h.roots.projectsRoot, 'junction');
  assert.equal(await h.reason(h.send('carl', 'team.project.upload.begin', { project_id: projectId, folder_name: 'x',
    files: manifestOf([['a', Buffer.from('a')]]) })), 'team_project_root_unavailable');
  assert.equal((await manifest('rae')).ok, false);
  assert.equal((await h.getPart('rae', projectId, manifestId, 0, 0)).json.error.reason, 'team_project_root_unavailable');
  assert.equal(await h.reason(h.send('carl', 'team.project.upload.commit', { project_id: projectId, upload_id: uploadId })),
    'team_project_root_unavailable');
  assert.equal(fs.existsSync(path.join(moved, projectId, 'Before')), false);
});

test('containment: a file swapped for another file or a link between the manifest and the read is refused', BOUNDED, async (t) => {
  const { h, projectId, folder, manifest } = await setup(t);
  for (const name of ['swap-file.txt', 'swap-junction.txt', 'swap-link.txt', 'grow.txt']) fs.writeFileSync(path.join(folder, name), 'original');
  const page = await h.ok(manifest('rae'));
  const index = (name) => page.entries.find((entry) => entry.path === name).index;
  fs.rmSync(path.join(folder, 'swap-file.txt'));
  fs.writeFileSync(path.join(folder, 'swap-file.txt'), 'replaced'); // same size, another inode
  fs.rmSync(path.join(folder, 'swap-junction.txt'));
  fs.mkdirSync(path.join(h.fx.root, 'jt'));
  fs.symlinkSync(path.join(h.fx.root, 'jt'), path.join(folder, 'swap-junction.txt'), 'junction');
  fs.appendFileSync(path.join(folder, 'grow.txt'), '+more');
  const changed = async (name) => {
    const read = await h.getPart('rae', projectId, page.manifest_id, index(name), 0);
    assert.equal(read.status, 409, name);
    assert.equal(read.json.error.reason, 'team_download_changed', name);
  };
  await changed('swap-file.txt');
  await changed('swap-junction.txt');
  await changed('grow.txt');
  fs.rmSync(path.join(folder, 'swap-link.txt'));
  fs.writeFileSync(path.join(h.fx.root, 'target.txt'), 'original');
  if (trySymlink(path.join(h.fx.root, 'target.txt'), path.join(folder, 'swap-link.txt'), 'file')) await changed('swap-link.txt');
  else t.diagnostic('symbolic link swap skipped: no symlink privilege on this host');
});

test('every Windows name vector the rules refuse is refused as a folder name and as a path segment', BOUNDED, async (t) => {
  const { h, projectId } = await setup(t);
  const refused = vectors.vectors.filter((vector) => vector.verdict === 'refuse');
  assert.ok(refused.length > 100);
  for (const vector of refused) {
    const name = String.fromCharCode(...vector.units);
    const asFolder = await h.send('carl', 'team.project.upload.begin', { project_id: projectId, folder_name: name,
      files: manifestOf([['a.txt', Buffer.from('a')]]) });
    assert.equal(asFolder.ok, false, `folder ${vector.rule} ${JSON.stringify(name)}`);
    // A name holding '/' is not one segment of a path but several (the folder case above refuses it).
    if (name.includes('/')) continue;
    const asSegment = await h.send('carl', 'team.project.upload.begin', { project_id: projectId, folder_name: 'ok',
      files: [{ path: `dir/${name}`, size: 1, sha256: sha(Buffer.from('a')) }] });
    assert.equal(asSegment.ok, false, `segment ${vector.rule} ${JSON.stringify(name)}`);
  }
  assert.equal(h.files.resources().uploads, 0);
  assert.deepEqual(fs.readdirSync(h.files.stagingRoot), []);
});

test('part bodies: over 4 MiB declared, a lying Content-Length either way, and none at all are refused', BOUNDED, async (t) => {
  const { h, projectId, begin } = await setup(t);
  const bytes = Buffer.from('abcdef');
  const uploadId = await begin('carl', 'bodies', [['a.bin', bytes]]);
  const over = await h.putPart('carl', projectId, uploadId, 0, 0, bytes, { length: 4 * MIB + 1 });
  assert.deepEqual([over.status, over.json.error.reason, over.headers.Connection], [429, 'team_upload_size_limit', 'close']);
  assert.equal(over.flowing, true); // refused by its Content-Length: drained, never kept
  const more = await h.putPart('carl', projectId, uploadId, 0, 0, bytes, { length: 3 });
  assert.equal(more.json.error.reason, 'team_upload_size_limit');
  const fewer = await h.putPart('carl', projectId, uploadId, 0, 0, bytes, { length: 9 });
  assert.equal(fewer.json.error.reason, 'team_upload_size_limit');
  const none = await h.putPart('carl', projectId, uploadId, 0, 0, bytes, { length: null });
  assert.equal(none.json.error.reason, 'team_upload_manifest_invalid');
  const status = await h.ok(h.send('carl', 'team.project.upload.status', { project_id: projectId, upload_id: uploadId }));
  assert.equal(status.files[0].received, 0);
  assert.equal((await h.putPart('carl', projectId, uploadId, 0, 0, bytes)).status, 200);
  // The part at the cap is accepted by the route (the core takes it as one part of a larger file).
  const big = await begin('carl', 'big', [['b.bin', Buffer.alloc(4 * MIB + 1)]]);
  assert.equal((await h.putPart('carl', projectId, big, 0, 0, Buffer.alloc(4 * MIB))).status, 200);
});

test('a read serves exactly the listed bytes by part and never past the listed size', BOUNDED, async (t) => {
  const { h, projectId, folder, manifest } = await setup(t);
  const content = crypto.randomBytes(4 * MIB + 10);
  fs.writeFileSync(path.join(folder, 'big.bin'), content);
  fs.writeFileSync(path.join(folder, 'empty.bin'), '');
  const page = await h.ok(manifest('rae'));
  const big = page.entries.find((entry) => entry.path === 'big.bin');
  const empty = page.entries.find((entry) => entry.path === 'empty.bin');
  assert.equal(big.sha256, sha(content));
  const first = await h.getPart('rae', projectId, page.manifest_id, big.index, 0);
  const second = await h.getPart('rae', projectId, page.manifest_id, big.index, 1);
  assert.deepEqual(Buffer.concat([first.bytes, second.bytes]), content);
  assert.equal(second.headers['Content-Length'], 10);
  assert.equal((await h.getPart('rae', projectId, page.manifest_id, big.index, 2)).json.error.reason, 'team_not_found');
  const zero = await h.getPart('rae', projectId, page.manifest_id, empty.index, 0);
  assert.deepEqual([zero.status, zero.bytes.length], [200, 0]);
});

test('the manifest pages by 1,000 entries with a cursor', BOUNDED, async (t) => {
  const { h, projectId, folder, manifest } = await setup(t);
  for (let index = 0; index < 1_001; index += 1) fs.writeFileSync(path.join(folder, `f${index}.txt`), `${index}`);
  const first = await h.ok(manifest('rae'));
  assert.deepEqual([first.entries.length, first.total_files, first.next_cursor], [1_000, 1_001, 1_000]);
  const next = await h.ok(h.send('rae', 'team.project.download.manifest', { project_id: projectId,
    manifest_id: first.manifest_id, cursor: first.next_cursor }));
  assert.deepEqual([next.entries.length, next.entries[0].index, next.next_cursor], [1, 1_000, null]);
});

// ---------------------------------------------------------------- review fixes (slice 3-8b, second round)

test('item 7: every PUT refusal before the body closes; a body up to twice the cap is drained, a larger one not read', BOUNDED, async (t) => {
  const { h, projectId, begin } = await setup(t);
  const uploadId = await begin('carl', 'closing', [['a.bin', Buffer.from('abc')]]);
  const forged = `upload_${'Z'.repeat(22)}`;
  const small = await h.putPart('carl', projectId, forged, 0, 0, Buffer.from('abc'));
  assert.deepEqual([small.status, small.json.error.reason, small.headers.Connection, small.flowing, small.answeredBeforeEnd],
    [403, 'team_not_found', 'close', true, false]);
  const large = await h.putPart('carl', projectId, forged, 0, 0, Buffer.from('abc'), { length: 8 * MIB + 1 });
  assert.deepEqual([large.headers.Connection, large.flowing, large.answeredBeforeEnd], ['close', false, true]);
  const atTwice = await h.putPart('carl', projectId, forged, 0, 0, Buffer.from('abc'), { length: 8 * MIB });
  assert.deepEqual([atTwice.headers.Connection, atTwice.flowing], ['close', true]);
  for (const [what, options] of [['unauthorized', { authorizedNow: () => false }], ['guard', { guard: () => ({ ok: false,
    error: { code: 'CMP-HOST-0003', reason: 'role_forbidden', retryable: false } }) }], ['no length', { length: null }]]) {
    const answer = await h.putPart('carl', projectId, uploadId, 0, 0, Buffer.from('abc'), options);
    assert.equal(answer.headers.Connection, 'close', what);
  }
  const bad = await h.putPart('carl', projectId, uploadId, 'x', 0, Buffer.from('abc'));
  assert.equal(bad.headers.Connection, 'close');
});

test('item 12: at most four part requests per member in flight on each route; the fifth is refused, retryable', BOUNDED, async (t) => {
  let releaseReads;
  let holdReads = null;
  const { h, projectId, folder, begin, manifest } = await setup(t, { files: { wrapFolders: (folders) => ({ ...folders,
    openListed: async (...args) => { if (holdReads) await holdReads; return folders.openListed(...args); } }) } });
  fs.writeFileSync(path.join(folder, 'r.txt'), 'read');
  const manifestId = (await h.ok(manifest('carl'))).manifest_id;
  const entries = [0, 1, 2, 3].map((index) => [`f${index}.bin`, Buffer.from(`abc${index}`)]);
  const uploadId = await begin('carl', 'flight', entries);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const held = entries.map(([, bytes], index) => h.putPart('carl', projectId, uploadId, index, 0, bytes, { during: () => gate }));
  await new Promise((resolve) => setImmediate(resolve));
  const fifth = await h.putPart('carl', projectId, uploadId, 0, 0, entries[0][1]);
  assert.deepEqual([fifth.status, fifth.json.error.reason, fifth.json.error.retryable, fifth.headers.Connection],
    [429, 'team_upload_limit', true, 'close']);
  // Another member's slots are its own.
  const alice = await begin('alice', 'alice-flight', [['a.bin', Buffer.from('a')]]);
  assert.equal((await h.putPart('alice', projectId, alice, 0, 0, Buffer.from('a'))).status, 200);
  release();
  assert.deepEqual((await Promise.all(held)).map((answer) => answer.status), [200, 200, 200, 200]);
  holdReads = new Promise((resolve) => { releaseReads = resolve; });
  const reads = [0, 1, 2, 3].map(() => h.getPart('carl', projectId, manifestId, 0, 0));
  await new Promise((resolve) => setImmediate(resolve));
  const fifthRead = await h.getPart('carl', projectId, manifestId, 0, 0);
  assert.deepEqual([fifthRead.status, fifthRead.json.error.reason], [429, 'team_upload_limit']);
  holdReads = null;
  releaseReads();
  assert.deepEqual((await Promise.all(reads)).map((answer) => answer.status), [200, 200, 200, 200]);
  assert.equal((await h.getPart('carl', projectId, manifestId, 0, 0)).status, 200, 'the slots are given back');
});

test('item 17: a hard link made to a listed file after the manifest refuses its read', BOUNDED, async (t) => {
  const { h, projectId, folder, manifest } = await setup(t);
  fs.writeFileSync(path.join(folder, 'linked.txt'), 'linked');
  const page = await h.ok(manifest('rae'));
  fs.linkSync(path.join(folder, 'linked.txt'), path.join(h.fx.root, 'twin.txt'));
  const read = await h.getPart('rae', projectId, page.manifest_id, 0, 0);
  assert.deepEqual([read.status, read.json.error.reason, read.bytes.includes('linked')], [409, 'team_download_changed', false]);
});

test('item 18: the guard flipping during the write or the read, and a client unauthorized after the body, refuse', BOUNDED, async (t) => {
  const { h, projectId, folder, begin, manifest } = await setup(t);
  fs.writeFileSync(path.join(folder, 'g.txt'), 'guarded');
  const manifestId = (await h.ok(manifest('carl'))).manifest_id;
  const uploadId = await begin('carl', 'flip', [['a.bin', Buffer.from('abc')], ['b.bin', Buffer.from('def')]]);
  const deny = { ok: false, error: { code: 'CMP-HOST-0003', reason: 'role_forbidden', retryable: false } };
  const counting = (denyAt, seen) => {
    let calls = 0;
    return (action, resource) => {
      calls += 1;
      seen.push(action);
      return calls === denyAt ? deny : h.authorize(h.seats.carl, action, resource);
    };
  };
  const putActions = [];
  const lateWrite = await h.putPart('carl', projectId, uploadId, 0, 0, Buffer.from('abc'), { guard: counting(3, putActions) });
  assert.deepEqual([lateWrite.status, lateWrite.json.error.reason], [403, 'role_forbidden']);
  assert.deepEqual(putActions, ['project.files.upload', 'project.files.upload', 'project.files.upload']);
  const getActions = [];
  const lateRead = await h.getPart('carl', projectId, manifestId, 0, 0, { guard: counting(2, getActions) });
  assert.deepEqual([lateRead.status, lateRead.json.error.reason, lateRead.bytes.includes('guarded')], [403, 'role_forbidden', false]);
  assert.deepEqual(getActions, ['project.files.download', 'project.files.download']);
  let authorizedCalls = 0;
  const flipping = () => { authorizedCalls += 1; return authorizedCalls < 3; };
  const afterBody = await h.putPart('carl', projectId, uploadId, 1, 0, Buffer.from('def'), { authorizedNow: flipping });
  assert.deepEqual([afterBody.status, afterBody.json.error.reason], [403, 'client_required']);
  const status = await h.ok(h.send('carl', 'team.project.upload.status', { project_id: projectId, upload_id: uploadId }));
  assert.equal(status.files[1].received, 0, 'nothing written for the body refused after it arrived');
});

test('item 19: with the binding valid, the guard of each other principal decides', BOUNDED, async (t) => {
  const { h, projectId, folder, begin, manifest } = await setup(t);
  fs.writeFileSync(path.join(folder, 'm.txt'), 'matrix');
  const manifestId = (await h.ok(manifest('carl'))).manifest_id;
  const uploadId = await begin('carl', 'binding', [['a.bin', Buffer.from('abc')]]);
  const guardOf = (who) => createRouteGuard({ authorize: h.authorize, actor: { member_id: h.seats[who].member_id,
    device_id: h.seats[who].device_id }, requestId: 'request_matrix' });
  for (const [who, put, get] of [['owner', 403, 403], ['pia', 403, 403], ['bob', 403, 403], ['rae', 403, 200], ['alice', 200, 200]]) {
    const write = await h.putPart('carl', projectId, uploadId, 0, 0, Buffer.from('abc'), { guard: guardOf(who) });
    assert.equal(write.status, put, `${who} put`);
    const read = await h.getPart('carl', projectId, manifestId, 0, 0, { guard: guardOf(who) });
    assert.equal(read.status, get, `${who} get`);
  }
});

test('a PUT with a part number that does not follow the bytes received is refused and writes nothing', BOUNDED, async (t) => {
  const { h, projectId, begin } = await setup(t);
  const uploadId = await begin('carl', 'wrong-part', [['a.bin', Buffer.from('abc')]]);
  const wrong = await h.putPart('carl', projectId, uploadId, 0, 1, Buffer.from('abc'));
  assert.deepEqual([wrong.status, wrong.json.error.reason], [409, 'team_upload_stale']);
  const status = await h.ok(h.send('carl', 'team.project.upload.status', { project_id: projectId, upload_id: uploadId }));
  assert.equal(status.files[0].received, 0);
});
