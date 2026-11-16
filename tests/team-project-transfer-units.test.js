'use strict';

// new-test-file: the transfer modules against a fake host (row 123 slice 3-9 fix list), no team host: the download's
// manifest bounds and path rules, links on the way, a hash mismatch and a cancel with no partial file left, the
// folder check, the upload plan's caps and stopping walk, the first failure kept, the busy slot claimed before the
// dialog, the abort reaching a part in flight, the progress throttle and checked reason words.
// tests/team-project-transfer.test.js runs the same modules against the real host's part routes.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createProjectTransfers } = require('../services/team/project-transfer');
const { LIMITS, progressPusher } = require('../services/team/transfer-common');
const { MAX_MANIFEST_PAGES, folderRefusal, runDownload } = require('../services/team/transfer-download');
const { planUpload, runUpload, walkFolder } = require('../services/team/transfer-upload');

const MIB = 1024 * 1024;
const P = 'project_aaaaaaaaaaaa';
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const turn = () => new Promise((resolve) => setImmediate(resolve));

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function tree(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      out.push(entry.isSymbolicLink() ? `${next}@` : next);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path.join(dir, entry.name), next);
    }
  };
  walk(root, '');
  return out.sort();
}

function junction(t, at) {
  const outside = tempDir(t, 'jenny-units-outside-');
  try { fs.symlinkSync(outside, at, 'junction'); return outside; } catch { return null; }
}

// A fake host: `pages` (manifest answers in order, or a function of params), `parts[index]` (the file bytes per entry
// index, or a function of { index, n, signal }), `commands` (other command answers).
function fakeHost({ pages = [], parts = {}, commands = {}, partSize = 4 * MIB } = {}) {
  const sent = [];
  let page = 0;
  const session = {
    async getPart(client, { index, n, signal }) {
      sent.push(['getPart', index, n]);
      const source = parts[index];
      if (typeof source === 'function') return source({ index, n, signal });
      return { ok: true, bytes: source.subarray(n * partSize, Math.min(source.length, (n + 1) * partSize)) };
    },
    async putPart(client, { index, n, bytes, signal }) {
      sent.push(['putPart', index, n]);
      const handler = commands.putPart;
      if (handler) return handler({ index, n, bytes, signal });
      return { ok: true, index, received: n * partSize + bytes.length };
    },
  };
  return {
    sent,
    manager: {
      borrow: () => ({ online: true, link: { client: { client_id: 'c' }, session }, ensureClient: async () => null }),
      command: async (operation, params) => {
        sent.push([operation, params]);
        if (operation === 'team.project.download.manifest') {
          const answer = typeof pages === 'function' ? pages(params) : pages[page++];
          return answer ?? { ok: false, error: { code: 'CMP-HOST-0005', reason: 'team_not_found' } };
        }
        const answer = commands[operation];
        return typeof answer === 'function' ? answer(params) : answer ?? { ok: true };
      },
    },
  };
}

const entryOf = (index, relative, bytes) => ({ index, path: relative, size: bytes.length, sha256: sha(bytes) });
const manifest = (entries, extra = {}) => ({ ok: true, manifest_id: 'manifest_1', part_size: 4 * MIB, total_files: entries.length,
  total_bytes: entries.reduce((sum, entry) => sum + entry.size, 0), skipped: 0, capped: false, entries, next_cursor: null, ...extra });
const deps = (manager, folder, extra = {}) => ({ manager, projectId: P, folder, signal: new AbortController().signal,
  progress: () => {}, waitReconnect: async () => {}, stopped: () => false, ...extra });
const reasonOf = async (promise) => { try { await promise; return 'resolved'; } catch (error) { return error.reason ?? error.message; } };

test('download: unsafe names and fold collisions are skipped and counted; nothing lands outside the folder', async (t) => {
  const folder = tempDir(t, 'jenny-units-dest-');
  const good = Buffer.from('good');
  const names = ['../escape.txt', '/abs.txt', 'C:/drive.txt', 'con.txt', 'trail.', 'a.txt:stream', 'Same.txt', 'same.txt',
    'ok.txt'];
  const parts = Object.fromEntries(names.map((name, index) => [index, good]));
  const host = fakeHost({ pages: [manifest(names.map((name, index) => entryOf(index, name, good)))], parts });
  const parent = path.dirname(folder);
  const done = await runDownload(deps(host.manager, folder));
  assert.deepEqual([done.files, done.skipped], [2, 7], JSON.stringify(done));
  assert.deepEqual(tree(folder), ['Same.txt', 'ok.txt']);
  // The escaping names, looked for where each would land (the temp parent is shared with other test files).
  for (const landed of [path.join(parent, 'escape.txt'), path.resolve('/abs.txt'), 'C:/drive.txt']) {
    assert.equal(fs.existsSync(landed), false, `nothing written at ${landed}`);
  }
});

test('download: a junction as the picked folder or as a parent made mid-download refuses; nothing goes through it', async (t) => {
  const base = tempDir(t, 'jenny-units-base-');
  const picked = path.join(base, 'picked');
  const outside = junction(t, picked);
  if (!outside) { t.skip('this platform made no junction or link'); return; }
  assert.equal(await folderRefusal(picked), 'team_download_folder_invalid');
  // A folder that is real, then a parent swapped for a link before the file under it is written.
  const folder = tempDir(t, 'jenny-units-dest-');
  const bytes = Buffer.from('x');
  let swapped = null;
  const host = fakeHost({ pages: [manifest([entryOf(0, 'a.txt', bytes), entryOf(1, 'sub/b.txt', bytes)])], parts: {
    0: () => { swapped = junction(t, path.join(folder, 'sub')); return { ok: true, bytes }; },
    1: bytes } });
  assert.equal(await reasonOf(runDownload(deps(host.manager, folder))), 'team_download_write_failed');
  assert.ok(swapped);
  assert.deepEqual(fs.readdirSync(swapped), [], 'nothing written through the link');
  assert.deepEqual(tree(folder), ['a.txt', 'sub@']);
});

test('download: a hash mismatch of the same length leaves no partial file and nothing under the final name', async (t) => {
  const folder = tempDir(t, 'jenny-units-dest-');
  const listed = Buffer.from('the real bytes');
  const served = Buffer.from('the fake bytes');
  assert.equal(listed.length, served.length);
  const host = fakeHost({ pages: [manifest([entryOf(0, 'dir/file.txt', listed)])], parts: { 0: served } });
  assert.equal(await reasonOf(runDownload(deps(host.manager, folder))), 'team_download_changed');
  assert.deepEqual(tree(folder), ['dir'], 'no partial and no final file');
});

test('download: a cancel mid-file ends the part in flight and leaves no partial file', async (t) => {
  const folder = tempDir(t, 'jenny-units-dest-');
  const bytes = crypto.randomBytes(5 * MIB);
  const controller = new AbortController();
  let waiting = false;
  const host = fakeHost({ pages: [manifest([entryOf(0, 'big.bin', bytes)])], parts: { 0: ({ n, signal }) => {
    if (n === 0) return { ok: true, bytes: bytes.subarray(0, 4 * MIB) };
    waiting = true;
    // As the http client does: the abort ends the request at once.
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } } });
  const running = reasonOf(runDownload(deps(host.manager, folder, { signal: controller.signal })));
  while (!waiting) await turn();
  assert.equal(fs.readdirSync(folder).filter((name) => name.endsWith('.partial')).length, 1, 'a partial while it runs');
  controller.abort();
  assert.equal(await running, 'aborted');
  assert.deepEqual(tree(folder), []);
});

test('download: the manifest must advance within its own bounds (fix 4)', async (t) => {
  const folder = tempDir(t, 'jenny-units-dest-');
  const one = Buffer.from('1');
  const entries = (from, count) => Array.from({ length: count }, (_, i) => entryOf(from + i, `f${from + i}.txt`, one));
  const cases = {
    'a repeating cursor': (params) => manifest(entries(0, 1), { total_files: 5, next_cursor: 1 }),
    'a first cursor of 0': () => manifest([], { total_files: 5, next_cursor: 0 }),
    'more entries than the total': () => manifest(entries(0, 3), { total_files: 2 }),
    'a total that changes between pages': (params) => manifest(entries(params.cursor ?? 0, 1),
      { total_files: params.cursor ? 9 : 5, next_cursor: params.cursor ? null : 1 }),
    'another manifest id on a later page': (params) => manifest(entries(params.cursor ?? 0, 1),
      { total_files: 5, manifest_id: params.cursor ? 'manifest_2' : 'manifest_1', next_cursor: params.cursor ? null : 1 }),
    'too many pages': (params) => manifest([], { total_files: 10_000, next_cursor: (params.cursor ?? 0) + 1 }),
  };
  for (const [label, pages] of Object.entries(cases)) {
    const host = fakeHost({ pages });
    assert.equal(await reasonOf(runDownload(deps(host.manager, folder))), 'team_answer_invalid', label);
    assert.ok(host.sent.filter(([op]) => op === 'team.project.download.manifest').length <= MAX_MANIFEST_PAGES, label);
  }
  assert.deepEqual(tree(folder), []);
});

test('download folder: a real empty directory at its own real path, read one entry at a time (fix 7)', async (t) => {
  const folder = tempDir(t, 'jenny-units-dest-');
  assert.equal(await folderRefusal(folder), null);
  fs.writeFileSync(path.join(folder, 'one'), '');
  assert.equal(await folderRefusal(folder), 'team_download_folder_not_empty');
  assert.equal(await folderRefusal(path.join(folder, 'one')), 'team_download_folder_invalid');
  assert.equal(await folderRefusal(path.join(folder, 'missing')), 'team_download_folder_invalid');
  // Picked, then swapped for a file before the first write: refused, nothing written.
  const swap = tempDir(t, 'jenny-units-swap-');
  const target = path.join(swap, 'dest');
  fs.mkdirSync(target);
  const host = fakeHost({ pages: [manifest([entryOf(0, 'a.txt', Buffer.from('a'))])], parts: { 0: Buffer.from('a') } });
  const runner = deps(host.manager, target, { progress: (fields) => {
    if (fields.state === 'running' && fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      fs.rmSync(target, { recursive: true });
      fs.writeFileSync(target, 'not a folder');
    }
  } });
  assert.equal(await reasonOf(runDownload(runner)), 'team_download_folder_invalid');
});

test('reason words from the host are checked before they reach a push or a log (fix 3)', async (t) => {
  const folder = tempDir(t, 'jenny-units-dest-');
  const odd = 'a long host reason with spaces <marker> '.repeat(4);
  const refuse = { ok: false, error: { code: 'CMP-HOST-0003', reason: odd } };
  assert.equal(await reasonOf(runDownload(deps(fakeHost({ pages: [refuse] }).manager, folder))), 'team_unavailable');
  const bytes = Buffer.from('x');
  const partRefused = fakeHost({ pages: [manifest([entryOf(0, 'a.txt', bytes)])], parts: { 0: () => refuse } });
  assert.equal(await reasonOf(runDownload(deps(partRefused.manager, folder))), 'team_unavailable');
  const source = tempDir(t, 'jenny-units-src-');
  fs.writeFileSync(path.join(source, 'a.txt'), 'a');
  const plan = await planUpload(source);
  const begin = fakeHost({ commands: { 'team.project.upload.begin': refuse } });
  assert.equal(await reasonOf(runUpload({ manager: begin.manager, projectId: P, plan, signal: new AbortController().signal,
    progress: () => {}, waitReconnect: async () => {}, stopped: () => false })), 'team_unavailable');
});

test('upload plan: exactly 2,000 files and exactly 64 MiB are accepted; the walk stops at the first file past the cap', async () => {
  let calls = 0;
  const walkOf = (count, size) => async (root, { onFile }) => {
    for (let i = 0; i < count; i += 1) {
      calls += 1;
      if (onFile(`f${i}.bin`, path.join(root, `f${i}.bin`), size) === false) break;
    }
    return { links: 0, unreadable: 0, truncated: false };
  };
  const root = path.resolve('picked');
  assert.equal((await planUpload(root, { walk: walkOf(LIMITS.beginFiles, 1) })).ok, true, 'exactly 2,000 files');
  assert.equal((await planUpload(root, { walk: walkOf(1, LIMITS.maxFileBytes) })).ok, true, 'exactly 64 MiB');
  assert.equal((await planUpload(root, { walk: walkOf(1, LIMITS.maxFileBytes + 1) })).reason, 'team_upload_size_limit');
  calls = 0;
  assert.equal((await planUpload(root, { walk: walkOf(10_000, 1) })).reason, 'team_upload_file_limit');
  assert.equal(calls, LIMITS.beginFiles + 1, 'nothing walked past the first file over the cap');
});

test('E69: the upload plan refuses a sensitive folder or path segment before sending and says which name', async (t) => {
  const source = tempDir(t, 'jenny-units-src-');
  fs.mkdirSync(path.join(source, 'src', '.Git'), { recursive: true });
  for (const name of ['a.txt', '.gitignore', 'src/.Git/config']) fs.writeFileSync(path.join(source, ...name.split('/')), name);
  assert.deepEqual(await planUpload(source), { ok: false, reason: 'team_project_path_invalid', name: '.Git' });
  fs.rmSync(path.join(source, 'src', '.Git'), { recursive: true });
  const kept = await planUpload(source);
  assert.deepEqual(kept.ok && kept.files.map((file) => file.path), ['.gitignore', 'a.txt'], 'other dot names travel');
  const picked = path.join(tempDir(t, 'jenny-units-src-'), '.vscode');
  fs.mkdirSync(picked);
  fs.writeFileSync(path.join(picked, 'tasks.json'), '{}');
  assert.deepEqual(await planUpload(picked), { ok: false, reason: 'team_project_path_invalid', name: '.vscode' });
  // The walk stops at the first such file: a large .git is never counted against the file cap.
  let calls = 0;
  const walk = async (root, { onFile }) => {
    for (let i = 0; i < 10_000; i += 1) {
      calls += 1;
      if (onFile(path.join('.jenny', `f${i}`), path.join(root, '.jenny', `f${i}`), 1) === false) break;
    }
    return { links: 0, unreadable: 0, truncated: false };
  };
  assert.deepEqual(await planUpload(path.resolve('picked'), { walk }), { ok: false, reason: 'team_project_path_invalid', name: '.jenny' });
  assert.equal(calls, 1);
});

test('E69: a download never writes a sensitive entry a hand-made manifest lists; it is skipped and counted', async (t) => {
  const folder = tempDir(t, 'jenny-units-dest-');
  const bytes = Buffer.from('x');
  const names = ['.git/config', '.GIT/HEAD', 'sub/.Env', '.jenny/notes.json', 'a/.github/workflows/ci.yml', '.gitignore', 'ok.txt'];
  const parts = Object.fromEntries(names.map((name, index) => [index, bytes]));
  const host = fakeHost({ pages: [manifest(names.map((name, index) => entryOf(index, name, bytes)))], parts });
  const done = await runDownload(deps(host.manager, folder));
  assert.deepEqual([done.files, done.skipped], [2, 5], JSON.stringify(done));
  assert.deepEqual(tree(folder), ['.gitignore', 'ok.txt']);
  assert.deepEqual(host.sent.filter((call) => call[0] === 'getPart').map((call) => call[1]).sort(), [5, 6], 'no part read for a skipped entry');
});

test('walkFolder: links counted, never entered; onFile answering false stops it at once', async (t) => {
  const root = tempDir(t, 'jenny-units-walk-');
  fs.mkdirSync(path.join(root, 'sub'));
  for (const name of ['a.txt', 'b.txt', 'sub/c.txt']) fs.writeFileSync(path.join(root, name), name);
  const linked = junction(t, path.join(root, 'link')) !== null;
  const seen = [];
  const totals = await walkFolder(root, { onFile: (relative) => { seen.push(relative.split(path.sep).join('/')); } });
  assert.deepEqual(seen.sort(), ['a.txt', 'b.txt', 'sub/c.txt']);
  await t.test('the link is counted', (st) => {
    if (!linked) { st.skip('no junction or link could be made on this platform'); return; }
    assert.equal(totals.links, 1);
  });
  const stopped = [];
  await walkFolder(root, { onFile: (relative) => { stopped.push(relative); return false; } });
  assert.equal(stopped.length, 1);
});

test('upload: the first failure is kept and stops the other file before its next part; the folder is unchanged (fix 10)', async (t) => {
  const source = tempDir(t, 'jenny-units-src-');
  fs.writeFileSync(path.join(source, 'a.bin'), crypto.randomBytes(9 * MIB));
  fs.writeFileSync(path.join(source, 'b.bin'), crypto.randomBytes(9 * MIB));
  const before = tree(source).map((name) => [name, fs.statSync(path.join(source, name)).mtimeMs, sha(fs.readFileSync(path.join(source, name)))]);
  const plan = await planUpload(source);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const host = fakeHost({ commands: {
    'team.project.upload.begin': { ok: true, upload_id: 'upload_1', part_size: 4 * MIB },
    putPart: async ({ index, n, bytes }) => {
      if (index === 0 && n === 0) return { ok: false, error: { code: 'CMP-HOST-0003', reason: 'team_upload_hash_mismatch' } };
      if (index === 1 && n === 0) { await held; throw new Error('link lost'); } // a later lost link
      return { ok: true, index, received: n * 4 * MIB + bytes.length };
    } } });
  const running = reasonOf(runUpload({ manager: host.manager, projectId: P, plan, signal: new AbortController().signal,
    progress: () => {}, waitReconnect: async () => {}, stopped: () => false }));
  // The other file's part is in flight when the hard failure lands; the lost link comes after it.
  while (!['0', '1'].every((want) => host.sent.some(([op, index]) => op === 'putPart' && String(index) === want))) await turn();
  for (let i = 0; i < 20; i += 1) await turn();
  release();
  assert.equal(await running, 'team_upload_hash_mismatch', 'the hard failure, not a resume wait');
  assert.equal(host.sent.filter(([op, index]) => op === 'putPart' && index === 1).length, 1, 'no further part of the other file');
  assert.deepEqual(tree(source).map((name) => [name, fs.statSync(path.join(source, name)).mtimeMs, sha(fs.readFileSync(path.join(source, name)))]),
    before, 'the member\'s folder is unchanged after a failed upload');
});

function transfers(t, host, { picks = [], ...options } = {}) {
  const pushes = [];
  let dialogs = 0;
  const one = createProjectTransfers({ manager: host.manager, teamId: 'team_a', online: () => true,
    push: (payload) => pushes.push(payload), pickFolder: async () => { dialogs += 1; await turn(); return picks.shift() ?? null; },
    ...options });
  t.after(() => one.stop());
  return { one, pushes, dialogs: () => dialogs };
}

test('two quick calls open one dialog: the slot is claimed first; a second download is busy (fix 17)', async (t) => {
  const folder = tempDir(t, 'jenny-units-dest-');
  const host = fakeHost({ pages: [manifest([])] });
  const { one, dialogs } = transfers(t, host, { picks: [folder] });
  const [first, second] = await Promise.all([one.call('downloadProject', { project_id: P }),
    one.call('downloadProject', { project_id: P })]);
  assert.deepEqual(second, { ok: false, error: { code: 'invalid_request', reason: 'team_transfer_busy' } });
  assert.deepEqual(first, { ok: true, started: true });
  assert.equal(dialogs(), 1);
  await one.settled();
  // The slot is free again once the download ended; a cancelled dialog frees it too.
  assert.deepEqual(await one.call('downloadProject', { project_id: P }), { ok: true, started: false });
  assert.equal(one.resources().transfers, 0);
});

test('cancel ends the part in flight at once, not after its timeout (fix 18)', async (t) => {
  const folder = tempDir(t, 'jenny-units-dest-');
  const bytes = Buffer.from('slow');
  let signalSeen = null;
  const host = fakeHost({ pages: [manifest([entryOf(0, 'a.txt', bytes)])], parts: { 0: ({ signal }) => {
    signalSeen = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } } });
  const { one, pushes } = transfers(t, host, { picks: [folder] });
  assert.equal((await one.call('downloadProject', { project_id: P })).started, true);
  while (!signalSeen) await turn();
  const started = Date.now();
  assert.deepEqual(await one.call('downloadCancel', { project_id: P }), { ok: true });
  assert.ok(Date.now() - started < 1_000, 'within one part, not a 60 s timeout');
  assert.equal(signalSeen.aborted, true);
  assert.equal(pushes.at(-1).state, 'cancelled');
  assert.deepEqual(tree(folder), []);
});

test('progress pushes at most twice a second; every state change goes at once', () => {
  let now = 0;
  const pushes = [];
  const progress = progressPusher((payload) => pushes.push(payload), () => now, { direction: 'upload' });
  for (let i = 0; i < 10; i += 1) { progress({ state: 'running', bytes_done: i }); now += 100; }
  assert.equal(pushes.length, 2, 'two in one second');
  progress({ state: 'done' }, true);
  progress({ state: 'failed' }, true);
  assert.deepEqual(pushes.slice(-2).map((p) => p.state), ['done', 'failed']);
});
