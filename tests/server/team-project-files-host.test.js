'use strict';

// Slice 3-8b review fixes, item 20: project files in a real team host start (server/team/team-main.js with the
// fake transport and backend, project files built for the real platform since slice 3-8c),
// and the part routes behind a real loopback HTTP server, so a refusal is checked as the client reads it.
// Row 175 wave 5: the reader view's two operations (list and read) on the team project fixture, at the end.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

const { GENERAL_PROJECT_ID } = require('../../server/team/member-schema');
const { STAGING_DIR } = require('../../server/team/team-project-files');
const { createRouteGuard } = require('../../server/team/route-guard');
const { waitFor } = require('./helpers/fake-team-transport');
const { createTeamHostFixture } = require('./helpers/team-host-fixture');
const { createTeamProjectFixture } = require('./helpers/team-project-fixture');

const BOUNDED = { timeout: 30_000 };
const MIB = 1024 * 1024;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// A team host with a projects root and an in-memory application project service (as team-startup-fanout's
// projectsHost), its project files built for this platform.
function filesHost(t) {
  const fx = createTeamHostFixture(t);
  const projectsRoot = path.join(fs.realpathSync.native(fx.root), 'team-host', 'projects');
  fs.mkdirSync(projectsRoot, { recursive: true });
  // The profile by its native real path: a Windows runner's temp folder is an 8.3 alias, which the staging root refuses.
  fx.writeConfig({ team: { projects_root: projectsRoot }, extra: { user_data_path: fs.realpathSync.native(fx.profile) } });
  const records = new Map();
  let next = 0;
  const app = {
    createProject: ({ name }) => {
      const id = `project_${String(next += 1).padStart(32, '0')}`;
      records.set(id, { id, name, root_path: null, root_revision: 0 });
      return { ok: true, project: { ...records.get(id) } };
    },
    bindProjectRoot: ({ project_id: id, root_path: rootPath, expected_root_revision: expected }) => {
      const record = records.get(id);
      if (!record || record.root_revision !== expected) return { ok: false, error: { reason: 'stale_root_revision' } };
      Object.assign(record, { root_path: rootPath, root_revision: expected + 1 });
      return { ok: true, project: { ...record } };
    },
    listProjects: () => ({ ok: true, projects: [...records.values()].map((record) => ({ ...record })) }),
  };
  const projectService = { remove: (id) => (records.delete(id) ? { ok: true } : { ok: false, reason: 'project_not_found' }) };
  const createBackend = (options) => {
    const composition = fx.createBackend(options);
    Object.assign(composition.backend, { projectApplicationService: app, projectService });
    return composition;
  };
  const start = () => fx.start(null, { createBackend });
  return { fx, projectsRoot, start, staging: path.join(fx.profile, STAGING_DIR) };
}

// One command through the host's router as the seeded member.
function sendAs(context, seat, operation, params) {
  const auth = context.clients.register(seat.device_id);
  return context.router.dispatch({ api_version: 1, operation, request_id: `request_${crypto.randomUUID()}`,
    client_id: auth.client_id, boot_epoch: context.bootEpoch, params },
  { deviceId: seat.device_id, clientToken: auth.client_token, isAuthenticated: () => true,
    actor: { member_id: seat.member_id, device_id: seat.device_id } });
}

// One raw PUT (or GET, which answers the raw bytes) through the host's whole route chain (context.assetRoutes), as
// the team HTTP server hands it over.
async function putThroughHost(context, seat, pathname, body, method = 'PUT') {
  const request = Readable.from([body]);
  request.method = method;
  request.headers = { 'content-length': String(body.length) };
  const answer = { status: null, chunks: [] };
  const response = { headersSent: false, setHeader() {}, writeHead(status) { answer.status = status; response.headersSent = true; },
    end(chunk) { if (chunk) answer.chunks.push(Buffer.from(chunk)); }, destroy() {} };
  const actor = { member_id: seat.member_id, device_id: seat.device_id };
  const handled = await context.assetRoutes({ request, response, pathname, deviceId: seat.device_id, clientId: 'client_x',
    authorized: () => true, requestId: 'request_host_put', actor, guard: createRouteGuard({ authorize: context.authorize, actor,
      requestId: 'request_host_put' }) });
  const bytes = Buffer.concat(answer.chunks);
  return { handled, status: answer.status, bytes, json: method === 'GET' ? null : JSON.parse(bytes.toString('utf8') || 'null') };
}

test('item 20: a real host start: a part reaches the route, a removed member\'s upload goes, a restart leaves staging empty', BOUNDED, async (t) => {
  const p = filesHost(t);
  const seeded = await p.fx.seedMembers(p.fx.client().deviceKey);
  const host = await p.start();
  const context = p.fx.context();
  const member = seeded.member;
  const created = await sendAs(context, member, 'team.project.create', { name: 'Shared' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const projectId = created.project_id;
  const bytes = Buffer.from('through the host');
  const begun = await sendAs(context, member, 'team.project.upload.begin', { project_id: projectId, folder_name: 'Hosted',
    files: [{ path: 'a.txt', size: bytes.length, sha256: sha(bytes) }] });
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const put = await putThroughHost(context, member, `/api/v1/projects/${projectId}/uploads/${begun.upload_id}/files/0/parts/0`, bytes);
  assert.deepEqual([put.handled, put.status, put.json.complete], [true, 200, true]);
  assert.equal(fs.readdirSync(p.staging).length, 1, 'one upload staged');
  // A second upload, then the member is removed from the team: the membership subscriber drops both.
  const second = await sendAs(context, member, 'team.project.upload.begin', { project_id: projectId, folder_name: 'Second',
    files: [{ path: 'b.txt', size: 1, sha256: sha(Buffer.from('b')) }] });
  assert.equal(second.ok, true);
  assert.equal((await context.store.revokeMember({ actorMemberId: seeded.owner.member_id, memberId: member.member_id })).ok, true);
  await waitFor(() => fs.readdirSync(p.staging).length === 0);
  // A stop and a start: what a crash left staged, and a stopped install's folder, are gone before anyone connects.
  await host.stop();
  fs.mkdirSync(path.join(p.staging, `upload_${'C'.repeat(22)}`));
  fs.writeFileSync(path.join(p.staging, `upload_${'C'.repeat(22)}`, '0.part'), 'crash');
  // Slice 3-8c's install folder name, and 3-8b's with its trailing dot.
  const leftovers = [`.jenny-install-upload_${'D'.repeat(22)}`, `.jenny-install-upload_${'E'.repeat(22)}.`]
    .map((name) => path.join(p.projectsRoot, name));
  for (const leftover of leftovers) fs.mkdirSync(leftover);
  const restarted = await p.start();
  assert.deepEqual(fs.readdirSync(p.staging), []);
  for (const leftover of leftovers) assert.equal(fs.existsSync(leftover), false);
  assert.equal(p.fx.logText().includes(p.projectsRoot), false);
  await restarted.stop();
});

test('slice 3-8c: a real host start on this platform: begin, part, commit, manifest and part read; staging empty after', BOUNDED, async (t) => {
  const p = filesHost(t);
  const seeded = await p.fx.seedMembers(p.fx.client().deviceKey);
  const host = await p.start();
  t.after(() => host.stop());
  const context = p.fx.context();
  const member = seeded.member;
  const created = await sendAs(context, member, 'team.project.create', { name: 'Shared' });
  assert.equal(created.ok, true, JSON.stringify(created));
  const projectId = created.project_id;
  const bytes = crypto.randomBytes(3000);
  const begun = await sendAs(context, member, 'team.project.upload.begin', { project_id: projectId, folder_name: 'Hosted',
    files: [{ path: 'dir/a.bin', size: bytes.length, sha256: sha(bytes) }] });
  assert.equal(begun.ok, true, JSON.stringify(begun));
  const put = await putThroughHost(context, member, `/api/v1/projects/${projectId}/uploads/${begun.upload_id}/files/0/parts/0`, bytes);
  assert.deepEqual([put.status, put.json.complete], [200, true]);
  const committed = await sendAs(context, member, 'team.project.upload.commit', { project_id: projectId, upload_id: begun.upload_id });
  assert.equal(committed.ok, true, JSON.stringify(committed));
  const manifest = await sendAs(context, member, 'team.project.download.manifest', { project_id: projectId });
  assert.equal(manifest.ok, true, JSON.stringify(manifest));
  const entry = manifest.entries.find((row) => row.path === 'Hosted/dir/a.bin');
  const read = await putThroughHost(context, member,
    `/api/v1/projects/${projectId}/downloads/${manifest.manifest_id}/files/${entry.index}/parts/0`, Buffer.alloc(0), 'GET');
  assert.equal(read.status, 200);
  assert.deepEqual(read.bytes, bytes);
  await waitFor(() => fs.readdirSync(p.staging).length === 0);
  assert.deepEqual(fs.readdirSync(p.projectsRoot).filter((name) => name.startsWith('.jenny')), []);
});

// The files routes of the team project fixture behind a real loopback HTTP server, as Carl.
async function realServer(t) {
  const h = await createTeamProjectFixture(t, { projectsRoot: true, files: { statfs: () => ({ bavail: 1e15, bsize: 1 }) } });
  const projectId = await h.sharedProject();
  const actor = { member_id: h.seats.carl.member_id, device_id: h.seats.carl.device_id };
  const server = http.createServer(async (request, response) => {
    const ctx = { request, response, pathname: new URL(request.url, 'http://team.local').pathname, deviceId: actor.device_id,
      requestId: 'request_socket', actor, authorized: () => true,
      guard: createRouteGuard({ authorize: h.authorize, actor, requestId: 'request_socket' }) };
    if (!await h.files.routes(ctx)) { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  // One PUT; `declared` the Content-Length, `body` what is actually written. Resolves the answer or the error.
  const put = (pathname, { declared, body }) => new Promise((resolve) => {
    const request = http.request({ host: '127.0.0.1', port: server.address().port, method: 'PUT', path: pathname, agent: false,
      headers: { 'Content-Length': String(declared) } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, connection: response.headers.connection,
        json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      response.on('error', (error) => resolve({ error: error.code }));
    });
    request.on('error', (error) => resolve({ error: error.code }));
    setTimeout(() => { request.destroy(); resolve({ error: 'client_timeout' }); }, 5000).unref();
    if (body.length > 0) request.write(body);
    else request.flushHeaders();
    if (body.length === declared) request.end();
  });
  return { h, projectId, put };
}

test('item 20: over a real socket a refused part answers the client and closes; the client reads it, not a reset', BOUNDED, async (t) => {
  const { h, projectId, put } = await realServer(t);
  const begun = await h.ok(h.send('carl', 'team.project.upload.begin', { project_id: projectId, folder_name: 'Socket',
    files: [{ path: 'a.bin', size: 3, sha256: sha(Buffer.from('abc')) }] }));
  const part = `/api/v1/projects/${projectId}/uploads/${begun.upload_id}/files/0/parts/0`;
  // Over the 4 MiB cap and under twice it, sent whole: drained, then answered.
  const over = await put(part, { declared: 4 * MIB + 1, body: Buffer.alloc(4 * MIB + 1) });
  assert.deepEqual([over.status, over.json?.error?.reason, over.connection], [429, 'team_upload_size_limit', 'close']);
  // A forged id with a small body: refused before the body, drained, answered.
  const forged = await put(`/api/v1/projects/${projectId}/uploads/upload_${'F'.repeat(22)}/files/0/parts/0`,
    { declared: 3, body: Buffer.from('abc') });
  assert.deepEqual([forged.status, forged.json?.error?.reason, forged.connection], [403, 'team_not_found', 'close']);
  // Past twice the cap, the body never sent: answered at once without reading.
  const huge = await put(part, { declared: 9 * MIB, body: Buffer.alloc(0) });
  assert.deepEqual([huge.status, huge.json?.error?.reason], [429, 'team_upload_size_limit'], JSON.stringify(huge));
  // The upload is still whole and takes its part.
  const good = await put(part, { declared: 3, body: Buffer.from('abc') });
  assert.deepEqual([good.status, good.json.complete], [200, true]);
});

// ---- Row 175 wave 5: the reader view, team.project.files.list and team.project.files.read ----
// The two reader operations on the team project fixture through the real router: the matrix (the team owner with and
// without a row, a member, read-only, pending, revoked, outside the project, General), the listing's filters and
// pages, the read's bounds, every escape refused, and that no log line or audit entry carries a file name.

const SECRET_NAME = 'Pangolin-Notes.md';
const SECRET_TEXT = 'READER-MARKER-5521';
const READ_BYTES = 256 * 1024;

async function readerView(t, files = {}) {
  const h = await createTeamProjectFixture(t, { projectsRoot: true, files: { statfs: () => ({ bavail: 1e15, bsize: 1 }), ...files } });
  const projectId = await h.sharedProject();
  const folder = path.join(h.roots.projectsRoot, projectId);
  const write = (relative, bytes) => {
    const full = path.join(folder, ...relative.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bytes);
    return full;
  };
  const op = (who, operation, params = {}) => h.send(who, operation, { project_id: projectId, ...params });
  const outcome = async (who, operation, params) => {
    const answer = await op(who, operation, params);
    return answer.ok ? 'ok' : answer.error.reason;
  };
  return { h, projectId, folder, write, op, outcome };
}

// A link at `at` to `target` (a junction for a folder on Windows); false when this platform refuses to make one.
function linked(target, at, kind) {
  try {
    fs.symlinkSync(target, at, kind === 'dir' && process.platform === 'win32' ? 'junction' : kind);
    return true;
  } catch {
    return false;
  }
}

const shown = ({ path: relative, size, text, truncated, binary }) => ({ path: relative, size, text, truncated, binary });

test('row 175 wave 5: list and read need a reader row on an active team project, for every principal', BOUNDED, async (t) => {
  const v = await readerView(t);
  const { h, projectId } = v;
  v.write(`notes/${SECRET_NAME}`, SECRET_TEXT);
  const other = await h.ok(h.send('bob', 'team.project.create', { name: 'Other' }));
  const read = { path: `notes/${SECRET_NAME}` };
  const expected = { owner: 'team_not_found', alice: 'ok', carl: 'ok', rae: 'ok', pia: 'member_pending', bob: 'team_not_found' };
  for (const [who, want] of Object.entries(expected)) {
    assert.equal(await v.outcome(who, 'team.project.files.list', {}), want, `${who} list`);
    assert.equal(await v.outcome(who, 'team.project.files.read', read), want, `${who} read`);
  }
  assert.equal(shown(await h.ok(v.op('rae', 'team.project.files.read', read))).text, SECRET_TEXT);
  // The team owner with a row reads like anyone with one.
  await h.ok(h.send('owner', 'team.project.join', { project_id: projectId, role: 'reader' }));
  assert.equal(await v.outcome('owner', 'team.project.files.read', read), 'ok');
  // General and a project id with no team row: not found for everyone, the owner included.
  for (const id of [GENERAL_PROJECT_ID, `project_${'z'.repeat(32)}`]) {
    assert.equal(await h.reason(h.send('alice', 'team.project.files.list', { project_id: id })), 'team_not_found', id);
    assert.equal(await h.reason(h.send('owner', 'team.project.files.read', { project_id: id, ...read })), 'team_not_found', id);
  }
  // Bob reads his own project, which does not hold this one's file.
  assert.equal((await h.ok(h.send('bob', 'team.project.files.list', { project_id: other.project_id }))).total, 0);
  assert.equal(await h.reason(h.send('bob', 'team.project.files.read', { project_id: other.project_id, ...read })), 'team_not_found');
  // Removed from the project, then revoked from the team: refused.
  await h.ok(h.send('alice', 'team.project.members.remove', { project_id: projectId, member_id: h.seats.rae.member_id }));
  assert.equal(await v.outcome('rae', 'team.project.files.list', {}), 'team_not_found');
  assert.equal(await v.outcome('rae', 'team.project.files.read', read), 'team_not_found');
  assert.equal((await h.store.revokeMember({ actorMemberId: h.seats.owner.member_id, memberId: h.seats.carl.member_id })).ok, true);
  assert.equal((await v.op('carl', 'team.project.files.list', {})).ok, false, 'revoked list');
  assert.equal((await v.op('carl', 'team.project.files.read', read)).ok, false, 'revoked read');
});

test('row 175 wave 5: the listing: files and the folders on their way by path, the filters, pages and one folder', BOUNDED, async (t) => {
  const v = await readerView(t, { viewLimits: { pageSize: 3 } });
  const { h } = v;
  v.write('b.txt', 'bb');
  v.write('docs/a.md', 'a');
  v.write('docs/deep/c.txt', 'ccc');
  // Skipped as the download listing skips them: the sensitive list and a hard-linked file (both names).
  v.write('.git/config', 'x');
  v.write('docs/.env', 'x');
  const original = v.write('original.txt', 'o');
  try { fs.linkSync(original, path.join(v.folder, 'hard.txt')); } catch { fs.rmSync(original); }
  const list = (params) => v.op('rae', 'team.project.files.list', params);
  const first = await h.ok(list({}));
  assert.deepEqual([first.entries, first.next_cursor, first.total, first.capped], [[
    { path: 'b.txt', size: 2, kind: 'file' }, { path: 'docs', size: 0, kind: 'dir' }, { path: 'docs/a.md', size: 1, kind: 'file' },
  ], 3, 5, false]);
  const second = await h.ok(list({ cursor: 3 }));
  assert.deepEqual([second.entries, second.next_cursor, second.total], [[
    { path: 'docs/deep', size: 0, kind: 'dir' }, { path: 'docs/deep/c.txt', size: 3, kind: 'file' }], null, 5]);
  assert.deepEqual((await h.ok(list({ cursor: 5 }))).entries, []);
  assert.equal(await h.reason(list({ cursor: 6 })), 'team_cursor_invalid');
  const docs = await h.ok(list({ dir: 'docs' }));
  assert.deepEqual([docs.entries.map((entry) => entry.path), docs.next_cursor, docs.total],
    [['docs/a.md', 'docs/deep', 'docs/deep/c.txt'], null, 3]);
  assert.deepEqual((await h.ok(list({ dir: 'docs/deep' }))).entries, [{ path: 'docs/deep/c.txt', size: 3, kind: 'file' }]);
  assert.equal((await h.ok(list({ dir: 'missing' }))).total, 0);
  for (const dir of ['..', 'docs/..', '/docs', 'C:/docs', 'docs\\deep', 'a\u0000b', '.git', 'docs/.env', 'docs/']) {
    assert.equal(await h.reason(list({ dir })), 'team_project_path_invalid', JSON.stringify(dir));
  }
});

test('row 175 wave 5: the read: text, its bound, binary, replacement, and every escape refused', BOUNDED, async (t) => {
  const v = await readerView(t);
  const { h } = v;
  const read = (relative) => v.op('rae', 'team.project.files.read', { path: relative });
  v.write('docs/a.md', '# Title\nline');
  assert.deepEqual(shown(await h.ok(read('docs/a.md'))),
    { path: 'docs/a.md', size: 12, text: '# Title\nline', truncated: false, binary: false });
  v.write('empty.txt', '');
  assert.deepEqual(shown(await h.ok(read('empty.txt'))), { path: 'empty.txt', size: 0, text: '', truncated: false, binary: false });
  // Past 256 KiB: the first 256 KiB, a character the cut splits left out rather than replaced.
  v.write('big.txt', `${'a'.repeat(READ_BYTES - 1)}\u00e9tail`);
  const big = await h.ok(read('big.txt'));
  assert.deepEqual([big.size, big.text.length, big.text.endsWith('a'), big.truncated, big.binary], [READ_BYTES + 5, READ_BYTES - 1, true, true, false]);
  // A NUL in the first 8 KiB is binary; one after it is text; invalid UTF-8 is replaced.
  v.write('blob.bin', Buffer.from('abc\u0000def'));
  assert.deepEqual(shown(await h.ok(read('blob.bin'))), { path: 'blob.bin', size: 7, text: '', truncated: false, binary: true });
  v.write('late.txt', `${'a'.repeat(9000)}\u0000`);
  assert.equal((await h.ok(read('late.txt'))).binary, false);
  v.write('latin.txt', Buffer.from([0x61, 0xff, 0x62]));
  assert.equal((await h.ok(read('latin.txt'))).text, 'a\ufffdb');
  // Not a file a listing would offer: missing, a folder, a hard-linked file, a name on the sensitive list.
  assert.equal(await h.reason(read('missing.txt')), 'team_not_found');
  assert.equal(await h.reason(read('docs')), 'team_not_found');
  const original = v.write('h1.txt', 'one');
  let hardLinked = true;
  try { fs.linkSync(original, path.join(v.folder, 'h2.txt')); } catch { hardLinked = false; }
  if (hardLinked) for (const name of ['h1.txt', 'h2.txt']) assert.equal(await h.reason(read(name)), 'team_not_found', name);
  v.write('.env', 'x');
  v.write('docs/.git/HEAD', 'x');
  for (const relative of ['.env', 'docs/.git/HEAD', '../outside.txt', 'docs/../../outside.txt', '/etc/passwd',
    'C:/Windows/win.ini', 'docs\\a.md', 'docs/./a.md', 'docs/a.md\u0000']) {
    assert.equal(await h.reason(read(relative)), 'team_project_path_invalid', JSON.stringify(relative));
  }
  // A link to a file outside, and a junction (a directory link elsewhere) to a folder outside: never followed.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-reader-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret.txt'), SECRET_TEXT);
  const fileLink = linked(path.join(outside, 'secret.txt'), path.join(v.folder, 'link.txt'), 'file');
  await t.test('a link to a file outside the project', { skip: !fileLink && 'this platform refused to make a file link' }, async () => {
    assert.equal(await h.reason(read('link.txt')), 'team_not_found');
  });
  const dirLink = linked(outside, path.join(v.folder, 'jump'), 'dir');
  await t.test('a junction to a folder outside the project', { skip: !dirLink && 'this platform refused to make a folder link' }, async () => {
    assert.equal(await h.reason(read('jump/secret.txt')), 'team_not_found');
  });
  const listed = (await h.ok(v.op('rae', 'team.project.files.list', {}))).entries.map((entry) => entry.path);
  assert.deepEqual(listed.filter((entry) => ['link.txt', 'jump', 'jump/secret.txt', '.env', 'h1.txt', 'h2.txt'].includes(entry)),
    hardLinked ? [] : ['h1.txt']);
});

test('row 175 wave 5: no log line or audit entry carries a file name, a path or content, and neither op is audited', BOUNDED, async (t) => {
  const v = await readerView(t);
  const { h, projectId } = v;
  v.write(`inner/${SECRET_NAME}`, SECRET_TEXT);
  const auditBefore = h.approvals.audit().read({ projectId, afterSeq: 0, limit: 100 }).entries.length;
  const logsBefore = h.fx.logs.length;
  await h.ok(v.op('rae', 'team.project.files.list', {}));
  await h.ok(v.op('rae', 'team.project.files.list', { dir: 'inner' }));
  assert.equal((await h.ok(v.op('rae', 'team.project.files.read', { path: `inner/${SECRET_NAME}` }))).text, SECRET_TEXT);
  await h.reason(v.op('rae', 'team.project.files.read', { path: `inner/gone-${SECRET_NAME}` }));
  await h.reason(v.op('rae', 'team.project.files.read', { path: `../inner/${SECRET_NAME}` }));
  await h.reason(v.op('rae', 'team.project.files.list', { dir: `../inner` }));
  await h.reason(v.op('bob', 'team.project.files.read', { path: `inner/${SECRET_NAME}` }));
  const audit = h.approvals.audit().read({ projectId, afterSeq: 0, limit: 100 }).entries;
  assert.equal(audit.length, auditBefore, 'a list or a read appends no audit entry');
  const logs = h.fx.logs.slice(logsBefore);
  assert.ok(logs.some((entry) => JSON.stringify(entry).includes('team.project.files.read')), 'the reads were logged');
  const haystack = JSON.stringify([h.fx.logs, audit]);
  const escaped = (value) => JSON.stringify(value).slice(1, -1);
  for (const needle of [SECRET_NAME, SECRET_TEXT, 'inner/', h.roots.projectsRoot, escaped(h.roots.projectsRoot)]) {
    assert.equal(haystack.includes(needle), false, needle);
  }
});

test('row 175 wave 5: after the walk or the read the caller is asked again; a refusal then answers nothing', BOUNDED, async (t) => {
  let refuseAfter = false;
  const asked = [];
  const v = await readerView(t, { wrapAuthorize: (authorize) => (actor, action, resource) => {
    asked.push(action);
    return refuseAfter ? { ok: false } : authorize(actor, action, resource);
  } });
  v.write('a.txt', SECRET_TEXT);
  await v.h.ok(v.op('rae', 'team.project.files.read', { path: 'a.txt' }));
  assert.deepEqual(asked, ['project.files.read']);
  refuseAfter = true;
  assert.equal(await v.outcome('rae', 'team.project.files.list', {}), 'team_not_found');
  assert.equal(await v.outcome('rae', 'team.project.files.read', { path: 'a.txt' }), 'team_not_found');
});

// ---- Row 175 round 2 (D13): the read's image answer, and the listing's short cache ----

const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16le = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
// The smallest headers each type's signature and declared size read from (the host checks the signature only).
const PICTURES = Object.freeze({
  'pic.png': ['image/png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32be(13), Buffer.from('IHDR'),
    u32be(2), u32be(3), Buffer.from([8, 6, 0, 0, 0, 0, 0, 0, 0])])],
  'photo.JPG': ['image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x03, 0x00, 0x02, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01])],
  'anim.gif': ['image/gif', Buffer.concat([Buffer.from('GIF89a'), u16le(2), u16le(3), Buffer.from([0, 0, 0, 0x3b])])],
  'shot.webp': ['image/webp', Buffer.concat([Buffer.from('RIFF'), Buffer.from([22, 0, 0, 0]), Buffer.from('WEBPVP8L'), Buffer.from([5, 0, 0, 0, 0x2f]),
    Buffer.from([1, 0x80, 0, 0]), Buffer.from([0, 0, 0])])],
});

test('row 175 round 2: a picture whose first bytes match its type answers as an image; a mislabelled one as text or binary', BOUNDED, async (t) => {
  const v = await readerView(t, { viewLimits: { imageBytes: 64 } });
  const { h } = v;
  const read = (relative) => v.op('rae', 'team.project.files.read', { path: relative });
  for (const [name, [mime, bytes]] of Object.entries(PICTURES)) {
    v.write(`pics/${name}`, bytes);
    const answer = await h.ok(read(`pics/${name}`));
    assert.deepEqual([answer.path, answer.size, answer.image], [`pics/${name}`, bytes.length, { mime, data_base64: bytes.toString('base64') }], name);
    for (const key of ['text', 'truncated', 'binary', 'too_large']) assert.equal(Object.hasOwn(answer, key), false, `${name} ${key}`);
  }
  // The extension alone never makes a picture: text bytes under .png read as text; PNG bytes under .jpg are binary.
  v.write('fake.png', 'just some text');
  assert.deepEqual(shown(await h.ok(read('fake.png'))), { path: 'fake.png', size: 14, text: 'just some text', truncated: false, binary: false });
  v.write('wrong.jpg', PICTURES['pic.png'][1]);
  const wrong = await h.ok(read('wrong.jpg'));
  assert.deepEqual([wrong.binary, wrong.image], [true, undefined]);
  // A picture over the cap (64 bytes here, 4 MiB by default) answers too_large and no bytes.
  const big = Buffer.concat([PICTURES['pic.png'][1], Buffer.alloc(100, 1)]);
  v.write('big.png', big);
  const over = await h.ok(read('big.png'));
  assert.deepEqual([over.path, over.size, over.too_large, over.image, over.text], ['big.png', big.length, true, undefined, undefined]);
  // An SVG is text, never an image answer.
  v.write('icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.equal((await h.ok(read('icon.svg'))).binary, false);
});

test('row 175 round 2: the image answer keeps the read\'s authorization matrix and escape refusals', BOUNDED, async (t) => {
  const v = await readerView(t);
  const { h } = v;
  v.write('notes/pic.png', PICTURES['pic.png'][1]);
  const expected = { owner: 'team_not_found', alice: 'ok', carl: 'ok', rae: 'ok', pia: 'member_pending', bob: 'team_not_found' };
  for (const [who, want] of Object.entries(expected)) {
    assert.equal(await v.outcome(who, 'team.project.files.read', { path: 'notes/pic.png' }), want, who);
  }
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-reader-pic-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret.png'), PICTURES['pic.png'][1]);
  const fileLink = linked(path.join(outside, 'secret.png'), path.join(v.folder, 'link.png'), 'file');
  await t.test('a link to a picture outside the project', { skip: !fileLink && 'this platform refused to make a file link' }, async () => {
    assert.equal(await h.reason(v.op('rae', 'team.project.files.read', { path: 'link.png' })), 'team_not_found');
  });
  assert.equal(await h.reason(v.op('rae', 'team.project.files.read', { path: '../pic.png' })), 'team_project_path_invalid');
});

test('row 175 round 2: later pages reuse one walk for 30 seconds; a first page takes a walk no older than 2 seconds', BOUNDED, async (t) => {
  let now = Date.now();
  const v = await readerView(t, { clock: () => now, viewLimits: { pageSize: 2 } });
  const { h } = v;
  const list = (params) => v.op('rae', 'team.project.files.list', params);
  v.write('a.txt', 'a');
  v.write('b.txt', 'b');
  v.write('c.txt', 'c');
  const first = await h.ok(list({}));
  assert.deepEqual([first.total, first.next_cursor], [3, 2]);
  // Written between two pages: the next page comes from the same walk, so the cursor stays stable.
  v.write('aa.txt', 'x');
  const second = await h.ok(list({ cursor: 2 }));
  assert.deepEqual([second.entries.map((entry) => entry.path), second.total], [['c.txt'], 3]);
  assert.equal((await h.ok(list({}))).total, 3, 'a first page inside 2 s shares the walk (a burst of folder reads)');
  now += 2_500; // live run 2026-11-25: the reload after a turn wrote a file showed the old list
  assert.equal((await h.ok(list({}))).total, 4, 'a new read sees the file a tool wrote');
  v.write('ab.txt', 'y');
  now += 2_500;
  assert.equal((await h.ok(list({ cursor: 2 }))).total, 4, 'a later page keeps its walk');
  now += 31_000; // past the 30 s listing cache
  assert.equal((await h.ok(list({ cursor: 2 }))).total, 5);
});

test('row 175 round 2: an installed upload drops the kept listing at once', BOUNDED, async (t) => {
  const { h, projectId, put } = await realServer(t);
  const list = () => h.ok(h.send('carl', 'team.project.files.list', { project_id: projectId }));
  assert.equal((await list()).total, 0);
  const bytes = Buffer.from('fresh');
  const begun = await h.ok(h.send('carl', 'team.project.upload.begin', { project_id: projectId, folder_name: 'Fresh',
    files: [{ path: 'a.txt', size: bytes.length, sha256: sha(bytes) }] }));
  const part = await put(`/api/v1/projects/${projectId}/uploads/${begun.upload_id}/files/0/parts/0`, { declared: bytes.length, body: bytes });
  assert.equal(part.status, 200, JSON.stringify(part));
  await h.ok(h.send('carl', 'team.project.upload.commit', { project_id: projectId, upload_id: begun.upload_id }));
  assert.deepEqual((await list()).entries.map((entry) => entry.path), ['Fresh', 'Fresh/a.txt']);
});
