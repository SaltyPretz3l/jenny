'use strict';

// Slice 3-9 commit 3: the member's project file transfers (services/team/project-transfer.js, transfer-upload.js,
// transfer-download.js) through team-service.js against the real in-process team host with project files
// (tests/helpers/team-client-host.js `projects: true`): an upload end to end, the refusals answered before anything is
// sent, a file that changes, a dropped part and the resume, cancel, a download end to end, a host file that changes,
// and nothing left running after stop or revoke.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { planUpload } = require('../services/team/transfer-upload');
const { createMemorySecureStore, createTeamClientHost, joinAs, tempProfile, waitUntil } = require('./helpers/team-client-host');
const { drained } = require('./helpers/team-project-client-host');

const MIB = 1024 * 1024;

function seat(host, t, name, picks) {
  const states = [];
  const pushes = [];
  const store = createMemorySecureStore();
  const service = host.createService({ userDataPath: tempProfile(t, `jenny-transfer-${name}-`), getSecureStore: () => store,
    sendState: (snapshot) => states.push(JSON.parse(JSON.stringify(snapshot))),
    sendProject: (payload) => pushes.push(JSON.parse(JSON.stringify(payload))),
    projectOptions: { transferOptions: { pickFolder: async () => picks.shift() ?? null } } });
  return { name, service, states, pushes, call: (method, value) => service.handle(method, value) };
}

async function online(one, teamId) {
  const row = () => one.states.at(-1)?.teams.find((team) => team.team_id === teamId);
  assert.ok(await waitUntil(() => row()?.state === 'online' && row()?.member_state === 'active', { attempts: 300, interval: 20 }),
    `${one.name} never online`);
}

async function transferTeam(t) {
  const host = await createTeamClientHost(t, { projects: true });
  const picks = [];
  const owner = seat(host, t, 'owner', picks);
  const me = await joinAs(host, owner.service, { name: 'Olive Owner' });
  const teamId = me.teamId;
  await online(owner, teamId);
  const seats = { owner };
  for (const name of ['writer', 'reader']) {
    seats[name] = seat(host, t, name, picks);
    seats[name].member = await joinAs(host, seats[name].service, { owner: me, name: `${name} member` });
    await online(seats[name], teamId);
  }
  const created = await owner.call('projectCreate', { team_id: teamId, name: 'Atlas' });
  const projectId = created.project_id;
  for (const name of ['writer', 'reader']) {
    assert.equal((await owner.call('projectAddMember', { team_id: teamId, project_id: projectId,
      member_id: seats[name].member.member_id, role: name })).ok, true);
  }
  const seen = [];
  host.env.commandHook = (command) => { seen.push(command); return null; };
  const ids = { team_id: teamId, project_id: projectId };
  return { host, teamId, projectId, ids, picks, seen, parts: host.env.parts, ...seats };
}

// A folder with nested files, an empty file, a two-part file and (where the platform allows) a link to elsewhere.
function sampleFolder(t, name = 'brand-assets') {
  const base = tempProfile(t, 'jenny-transfer-src-');
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, 'sub', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  fs.writeFileSync(path.join(root, 'c.md'), '# c');
  fs.writeFileSync(path.join(root, 'sub', 'b.bin'), crypto.randomBytes(5 * MIB + 123));
  fs.writeFileSync(path.join(root, 'sub', 'deep', 'empty.txt'), '');
  const outside = tempProfile(t, 'jenny-transfer-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'not mine to send');
  let linked = false;
  try { fs.symlinkSync(outside, path.join(root, 'link'), 'junction'); linked = true; } catch { /* no link here */ }
  return { root, linked };
}

const files = (root) => {
  const out = {};
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), next);
      else out[next] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, entry.name))).digest('hex');
    }
  };
  walk(root, '');
  return out;
};

const transferOf = (one, direction) => [...one.pushes].reverse().find((p) => p.kind === 'transfer' && p.direction === direction);
async function ended(one, direction, attempts = 500) {
  assert.ok(await waitUntil(() => ['done', 'failed', 'cancelled'].includes(transferOf(one, direction)?.state),
    { attempts, interval: 20 }), `${one.name} ${direction} never ended: ${JSON.stringify(transferOf(one, direction))}`);
  return transferOf(one, direction);
}
const ops = (seen) => seen.map((command) => command.operation);

test('an upload goes end to end: walked, hashed, begun, sent in parts, committed; the folder is only read', async (t) => {
  const f = await transferTeam(t);
  const { root, linked } = sampleFolder(t);
  const before = files(root);
  const mtimes = fs.statSync(path.join(root, 'sub', 'b.bin')).mtimeMs;
  f.picks.push(root);
  const started = await f.writer.call('uploadFolder', f.ids);
  const { links_skipped: linksSkipped, ...rest } = started;
  assert.deepEqual(rest, { ok: true, started: true, folder: 'brand-assets', files: 4, bytes: 5 * MIB + 123 + 8, unreadable: 0 });
  await t.test('the link is counted and never sent', (st) => {
    if (!linked) { st.skip('no junction or link could be made on this platform'); return; }
    assert.equal(linksSkipped, 1);
  });
  const done = await ended(f.writer, 'upload');
  assert.equal(done.state, 'done', JSON.stringify(done));
  assert.deepEqual([done.files, done.bytes], [4, 5 * MIB + 131]);
  const begin = f.seen.find((c) => c.operation === 'team.project.upload.begin');
  assert.deepEqual(begin.params.files.map((entry) => entry.path), ['a.txt', 'c.md', 'sub/b.bin', 'sub/deep/empty.txt']);
  assert.equal(begin.params.folder_name, 'brand-assets');
  assert.ok(ops(f.seen).includes('team.project.upload.commit'));
  const installed = files(path.join(f.parts.projectsRoot, f.projectId, 'brand-assets'));
  assert.deepEqual(installed, Object.fromEntries(Object.entries(before).filter(([name]) => !name.startsWith('link/'))));
  assert.equal(Object.keys(installed).some((name) => name.includes('secret')), false, 'the link was not followed');
  assert.deepEqual(files(root), before, 'the member folder is unchanged');
  assert.equal(fs.statSync(path.join(root, 'sub', 'b.bin')).mtimeMs, mtimes);
  assert.equal(JSON.stringify(f.writer.pushes).includes(path.dirname(root)), false, 'no local path in an upload push');
  assert.deepEqual(f.writer.service.projectResources().transfers, 0);
});

test('refusals are answered in the call and send nothing', async (t) => {
  const f = await transferTeam(t);
  const before = f.seen.length;
  assert.deepEqual(await f.writer.call('uploadFolder', f.ids), { ok: true, started: false }, 'the dialog was cancelled');
  const empty = path.join(tempProfile(t, 'jenny-transfer-empty-'), 'empty');
  fs.mkdirSync(empty);
  f.picks.push(empty);
  assert.equal((await f.writer.call('uploadFolder', f.ids)).error.reason, 'team_upload_empty');
  const big = path.join(tempProfile(t, 'jenny-transfer-big-'), 'big');
  fs.mkdirSync(big);
  const handle = fs.openSync(path.join(big, 'huge.bin'), 'w');
  fs.ftruncateSync(handle, 64 * MIB + 1);
  fs.closeSync(handle);
  f.picks.push(big);
  assert.equal((await f.writer.call('uploadFolder', f.ids)).error.reason, 'team_upload_size_limit');
  const full = path.join(tempProfile(t, 'jenny-transfer-full-'), 'full');
  fs.mkdirSync(full);
  fs.writeFileSync(path.join(full, 'x.txt'), 'x');
  f.picks.push(full);
  assert.equal((await f.writer.call('downloadProject', f.ids)).error.reason, 'team_download_folder_not_empty');
  f.picks.push(path.join(full, 'x.txt'));
  assert.equal((await f.writer.call('downloadProject', f.ids)).error.reason, 'team_download_folder_invalid');
  await drained(f.writer, f.seen);
  assert.deepEqual(ops(f.seen.slice(before)).filter((op) => op.startsWith('team.project.')), []);
});

test('the plan refuses with the host words: path, collision, count, total and folder name', async () => {
  const walkOf = (names, size = 1) => async (root, { onFile }) => {
    for (const name of names) onFile(name, path.join(root, name), size);
    return { links: 0, unreadable: 0, truncated: false };
  };
  const plan = (names, size, root = path.resolve('picked')) => planUpload(root, { walk: walkOf(names, size) });
  assert.equal((await plan(['ok.txt', 'con.txt'])).reason, 'team_project_path_invalid');
  assert.equal((await plan(['Dir/a.txt', 'dir/b.txt'])).reason, 'team_upload_manifest_invalid');
  assert.equal((await plan(['A.txt', 'a.txt'])).reason, 'team_upload_manifest_invalid');
  assert.equal((await plan(Array.from({ length: 2001 }, (_, i) => `f${i}.txt`))).reason, 'team_upload_file_limit');
  assert.equal((await plan(Array.from({ length: 9 }, (_, i) => `f${i}.bin`), 60 * MIB)).reason, 'team_upload_size_limit');
  assert.equal((await plan(['ok.txt'], 1, path.resolve('trailing.'))).reason, 'team_project_path_invalid');
  assert.equal((await plan(['b.txt', 'a.txt'])).files[0].path, 'a.txt', 'sorted');
});

test('a file that changes after begin ends the upload and the upload is discarded', async (t) => {
  const f = await transferTeam(t);
  const { root } = sampleFolder(t);
  f.host.env.commandHook = (command) => {
    f.seen.push(command);
    if (command.operation === 'team.project.upload.begin') {
      const target = path.join(root, 'sub', 'b.bin');
      const bytes = fs.readFileSync(target);
      bytes[0] ^= 0xff;
      fs.writeFileSync(target, bytes);
      fs.utimesSync(target, new Date(), new Date(Date.now() + 5000));
    }
    return null;
  };
  f.picks.push(root);
  assert.equal((await f.writer.call('uploadFolder', f.ids)).started, true);
  const end = await ended(f.writer, 'upload');
  assert.deepEqual([end.state, end.reason], ['failed', 'team_upload_changed']);
  assert.ok(await waitUntil(() => ops(f.seen).includes('team.project.upload.discard')), 'discarded');
  assert.equal(fs.existsSync(path.join(f.parts.projectsRoot, f.projectId, 'brand-assets')), false);
});

test('a dropped part resumes from the host status and the upload completes', async (t) => {
  const f = await transferTeam(t);
  const { root } = sampleFolder(t);
  let puts = 0;
  f.parts.partHook = (ctx) => {
    puts += 1;
    if (puts !== 2) return false;
    ctx.response.socket.destroy();
    return true;
  };
  f.picks.push(root);
  await f.writer.call('uploadFolder', f.ids);
  const end = await ended(f.writer, 'upload');
  assert.equal(end.state, 'done', JSON.stringify(end));
  assert.ok(ops(f.seen).includes('team.project.upload.status'), 'resumed from status');
  assert.deepEqual(files(path.join(f.parts.projectsRoot, f.projectId, 'brand-assets'))['sub/b.bin'],
    files(root)['sub/b.bin']);
});

test('cancel stops within one part and discards; a second upload meanwhile is busy', async (t) => {
  const f = await transferTeam(t);
  const { root } = sampleFolder(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let entered = false;
  f.parts.partHook = async () => { entered = true; await held; return false; };
  f.picks.push(root);
  await f.writer.call('uploadFolder', f.ids);
  assert.ok(await waitUntil(() => entered), 'a part is in flight');
  f.picks.push(root);
  assert.equal((await f.writer.call('uploadFolder', f.ids)).error.reason, 'team_transfer_busy');
  const cancelled = f.writer.call('uploadCancel', { team_id: f.teamId });
  release();
  assert.deepEqual(await cancelled, { ok: true });
  assert.equal(transferOf(f.writer, 'upload').state, 'cancelled');
  assert.ok(ops(f.seen).includes('team.project.upload.discard'));
  assert.equal(f.writer.service.projectResources().transfers, 0);
});

test('a download goes end to end into an empty folder the member picked', async (t) => {
  const f = await transferTeam(t);
  const { root } = sampleFolder(t);
  f.picks.push(root);
  await f.writer.call('uploadFolder', f.ids);
  assert.equal((await ended(f.writer, 'upload')).state, 'done');
  const target = tempProfile(t, 'jenny-transfer-dest-');
  f.picks.push(target);
  assert.deepEqual(await f.reader.call('downloadProject', f.ids), { ok: true, started: true });
  const end = await ended(f.reader, 'download');
  assert.equal(end.state, 'done', JSON.stringify(end));
  assert.deepEqual([end.files, end.path], [4, target]);
  const expected = Object.fromEntries(Object.entries(files(root)).filter(([name]) => !name.startsWith('link/'))
    .map(([name, hash]) => [`brand-assets/${name}`, hash]));
  assert.deepEqual(files(target), expected);
  assert.ok(ops(f.seen).includes('team.project.download.manifest'));
});

test('a host file that changes after its listing ends the download with no partial file', async (t) => {
  const f = await transferTeam(t);
  const { root } = sampleFolder(t);
  f.picks.push(root);
  await f.writer.call('uploadFolder', f.ids);
  assert.equal((await ended(f.writer, 'upload')).state, 'done');
  const hostFile = path.join(f.parts.projectsRoot, f.projectId, 'brand-assets', 'sub', 'b.bin');
  f.parts.partHook = (ctx) => {
    if (ctx.pathname.includes('/downloads/') && fs.statSync(hostFile).size === 5 * MIB + 123) {
      fs.appendFileSync(hostFile, 'more');
    }
    return false;
  };
  const target = tempProfile(t, 'jenny-transfer-dest-');
  f.picks.push(target);
  await f.reader.call('downloadProject', f.ids);
  const end = await ended(f.reader, 'download');
  assert.deepEqual([end.state, end.reason], ['failed', 'team_download_changed']);
  assert.equal(Object.keys(files(target)).some((name) => name.endsWith('b.bin')), false, 'no partial file');
});

// A part held at the host while the member is revoked, or leaves: the transfer ends at once, nothing more is sent.
async function endedInFlight(t, end) {
  const f = await transferTeam(t);
  const { root } = sampleFolder(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let entered = 0;
  f.parts.partHook = async () => { entered += 1; await held; return false; };
  f.picks.push(root);
  assert.equal((await f.writer.call('uploadFolder', f.ids)).started, true);
  assert.ok(await waitUntil(() => entered >= 1), 'a part is in flight');
  await end(f);
  assert.ok(await waitUntil(() => f.writer.service.projectResources().transfers === 0, { attempts: 300, interval: 20 }),
    'the transfer ended');
  const sent = f.seen.length;
  release();
  assert.ok(await waitUntil(() => f.parts.partsInFlight === 0, { attempts: 300, interval: 20 }), 'the held part finished');
  assert.deepEqual(ops(f.seen.slice(sent)).filter((op) => op.startsWith('team.project.')), [], 'nothing sent after the end');
  return f;
}

test('a revoke ends a transfer in flight', async (t) => {
  const f = await endedInFlight(t, async (team) => {
    assert.equal((await team.owner.call('memberRevoke', { team_id: team.teamId, member_id: team.writer.member.member_id })).ok, true);
  });
  assert.ok(await waitUntil(() => f.writer.pushes.some((p) => p.kind === 'team_gone'), { attempts: 300, interval: 20 }));
});

test('leaving the team ends a transfer in flight', async (t) => {
  const f = await endedInFlight(t, async (team) => {
    assert.equal((await team.writer.call('leave', { team_id: team.teamId })).ok, true);
  });
  assert.equal(f.writer.service.projectResources().teams, 0);
});

test('stopAll and revoke end every transfer at once and send nothing more', async (t) => {
  const f = await transferTeam(t);
  const { root } = sampleFolder(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let entered = 0;
  f.parts.partHook = async () => { entered += 1; await held; return false; };
  f.picks.push(root);
  await f.writer.call('uploadFolder', f.ids);
  f.picks.push(root);
  await f.reader.call('uploadFolder', f.ids);
  assert.ok(await waitUntil(() => entered >= 1), 'a part is in flight');
  // Revoke the reader (its upload is refused at begin anyway); the writer's app stops.
  assert.equal((await f.owner.call('memberRevoke', { team_id: f.teamId, member_id: f.reader.member.member_id })).ok, true);
  const stopping = f.writer.service.stopAll();
  release();
  await stopping;
  // The host finishes the parts it was holding before the test's teardown removes its folders.
  assert.ok(await waitUntil(() => f.parts.partsInFlight === 0, { attempts: 300, interval: 20 }), 'the held parts finished');
  assert.deepEqual(f.writer.service.projectResources(), { teams: 0, conversations: 0, timers: 0, reads: 0, transfers: 0 });
  assert.equal(ops(f.seen).includes('team.project.upload.discard'), false, 'nothing sent after stop');
  assert.ok(await waitUntil(() => f.reader.pushes.some((p) => p.kind === 'team_gone'), { attempts: 300, interval: 20 }));
  assert.equal(f.reader.service.projectResources().transfers, 0);
});
