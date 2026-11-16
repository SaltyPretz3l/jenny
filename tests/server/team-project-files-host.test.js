'use strict';

// Slice 3-8b review fixes, item 20: project files in a real team host start (server/team/team-main.js with the
// fake transport and backend, project files built for the real platform since slice 3-8c),
// and the part routes behind a real loopback HTTP server, so a refusal is checked as the client reads it.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');

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
