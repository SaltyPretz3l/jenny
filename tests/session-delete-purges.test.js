'use strict';

// What a deleted chat leaves behind outside the session stores: sidecar repo
// anchors, finished background-job output, turn diagnostics, and the freed tally.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  beginFreedTally,
  drainTurnDiagnosticsPurges,
  isRuntimeSessionId,
  purgeJobOutputs,
  purgeRepoAnchors,
  runSessionPurges,
  scheduleTurnDiagnosticsPurge,
} = require('../services/backend/session-delete-purges');
const { createBackgroundJobTracker } = require('../services/main/background-job-tracker');
const { linkDirectory } = require('./helpers/platform-skips');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-delete-purges-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeTally() {
  const total = { files: 0, bytes: 0 };
  return {
    total,
    add(freed) {
      total.files += Number(freed?.files) || 0;
      total.bytes += Number(freed?.bytes) || 0;
    },
  };
}

function write(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

test('runtime session id grammar mirrors the sidecar parser and refuses traversal', () => {
  for (const ok of ['sess_1761000000000_abcdef012345', 'a.b-c_d', 'x'.repeat(128)]) assert.equal(isRuntimeSessionId(ok), true, ok);
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'x.', 'x'.repeat(129), 'sess id', null, 7]) {
    assert.equal(isRuntimeSessionId(bad), false, String(bad));
  }
});

test('repo anchors: removes only the deleted chat\'s folder and counts it', async (t) => {
  const userDataPath = tempRoot(t);
  const anchors = path.join(userDataPath, 'background-memory', 'repo-anchors');
  write(path.join(anchors, 'sess_gone', 'anchor.json'), '12345');
  write(path.join(anchors, 'sess_gone', 'extra.txt'), '123');
  write(path.join(anchors, 'sess_kept', 'anchor.json'), 'keep');
  const tally = makeTally();

  await purgeRepoAnchors({ options: { userDataPath } }, 'sess_gone', tally);

  assert.equal(fs.existsSync(path.join(anchors, 'sess_gone')), false);
  assert.equal(fs.readFileSync(path.join(anchors, 'sess_kept', 'anchor.json'), 'utf8'), 'keep');
  assert.deepEqual(tally.total, { files: 2, bytes: 8 });
});

test('repo anchors: uses the service\'s background runtime root and tolerates absence', async (t) => {
  const root = tempRoot(t);
  const runtimeRoot = path.join(root, 'elsewhere');
  write(path.join(runtimeRoot, 'repo-anchors', 'sess_a', 'anchor.json'), '{}');
  const service = { getBackgroundRuntimeRoot: () => runtimeRoot, options: { userDataPath: path.join(root, 'profile') } };
  const tally = makeTally();
  await purgeRepoAnchors(service, 'sess_a', tally);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'repo-anchors', 'sess_a')), false);
  await purgeRepoAnchors(service, 'sess_never_anchored', tally);
  await purgeRepoAnchors({ options: { userDataPath: path.join(root, 'empty') } }, 'sess_a', tally);
  assert.equal(tally.total.files, 1);
});

test('repo anchors: an id outside the sidecar grammar touches nothing', async (t) => {
  const userDataPath = tempRoot(t);
  const anchors = path.join(userDataPath, 'background-memory', 'repo-anchors');
  write(path.join(anchors, 'sess_kept', 'anchor.json'), 'keep');
  const tally = makeTally();
  for (const bad of ['..', '.', 'a/../sess_kept', '../repo-anchors', 'sess_kept.']) {
    await purgeRepoAnchors({ options: { userDataPath } }, bad, tally);
  }
  assert.equal(fs.existsSync(path.join(anchors, 'sess_kept', 'anchor.json')), true);
  assert.deepEqual(tally.total, { files: 0, bytes: 0 });
});

test('repo anchors: a linked session folder is refused and its target survives', async (t) => {
  const root = tempRoot(t);
  const userDataPath = path.join(root, 'profile');
  const outside = path.join(root, 'outside');
  write(path.join(outside, 'precious.txt'), 'keep');
  fs.mkdirSync(path.join(userDataPath, 'background-memory', 'repo-anchors'), { recursive: true });
  linkDirectory(outside, path.join(userDataPath, 'background-memory', 'repo-anchors', 'sess_link'));

  await assert.rejects(purgeRepoAnchors({ options: { userDataPath } }, 'sess_link', makeTally()));

  assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'keep');
});

test('repo anchors: a linked repo-anchors base is refused', async (t) => {
  const root = tempRoot(t);
  const userDataPath = path.join(root, 'profile');
  const outside = path.join(root, 'outside');
  write(path.join(outside, 'sess_x', 'anchor.json'), 'keep');
  fs.mkdirSync(path.join(userDataPath, 'background-memory'), { recursive: true });
  linkDirectory(outside, path.join(userDataPath, 'background-memory', 'repo-anchors'));

  await assert.rejects(purgeRepoAnchors({ options: { userDataPath } }, 'sess_x', makeTally()));

  assert.equal(fs.existsSync(path.join(outside, 'sess_x', 'anchor.json')), true);
});

function trackerWithJobs(t, workspaceRoot, jobs) {
  const statuses = new Map();
  const tracker = createBackgroundJobTracker({
    getWorkspaceRoot: () => workspaceRoot,
    log: () => {},
    readStatusFileImpl: (statusPath) => (statuses.has(statusPath)
      ? { ok: true, text: JSON.stringify(statuses.get(statusPath)) } : { ok: false, reason: 'not_found' }),
    isPidAliveImpl: () => true,
    getProcessStartTimeImpl: () => 'g1',
    pollIntervalMs: 3_600_000,
  });
  t.after(() => tracker.dispose());
  for (const job of jobs) {
    assert.equal(tracker.registerJob({ jobId: job.jobId, sessionId: job.sessionId, command: 'x', pid: 99999 }), true);
    if (job.state) {
      statuses.set(path.join(workspaceRoot, '.jenny', 'tool-results', job.jobId, 'status.json'), { state: job.state, exit_code: 0 });
    }
  }
  tracker.pollNow();
  return tracker;
}

test('tracker getSessionJobRoots lists only the chat\'s finished jobs with their captured root', (t) => {
  const workspaceRoot = path.join(tempRoot(t), 'ws');
  const tracker = trackerWithJobs(t, workspaceRoot, [
    { jobId: 'aaaaaaaaaaaa', sessionId: 'sess_a', state: 'completed' },
    { jobId: 'bbbbbbbbbbbb', sessionId: 'sess_a' },
    { jobId: 'cccccccccccc', sessionId: 'sess_b', state: 'failed' },
  ]);
  assert.deepEqual(tracker.getSessionJobRoots('sess_a'), [{ jobId: 'aaaaaaaaaaaa', workspaceRoot }]);
  assert.deepEqual(tracker.getSessionJobRoots('sess_none'), []);
});

test('job outputs: removes the deleted chat\'s finished job directories only', async (t) => {
  const workspaceRoot = path.join(tempRoot(t), 'ws');
  const results = path.join(workspaceRoot, '.jenny', 'tool-results');
  write(path.join(results, 'aaaaaaaaaaaa', 'output.txt'), '1234567');
  write(path.join(results, 'aaaaaaaaaaaa', 'status.json'), '{}');
  write(path.join(results, 'bbbbbbbbbbbb', 'output.txt'), 'running');
  write(path.join(results, 'cccccccccccc', 'output.txt'), 'other chat');
  const service = {
    backgroundJobTracker: trackerWithJobs(t, workspaceRoot, [
      { jobId: 'aaaaaaaaaaaa', sessionId: 'sess_a', state: 'completed' },
      { jobId: 'bbbbbbbbbbbb', sessionId: 'sess_a' },
      { jobId: 'cccccccccccc', sessionId: 'sess_b', state: 'completed' },
    ]),
  };
  const tally = makeTally();

  await purgeJobOutputs(service, 'sess_a', tally);

  assert.equal(fs.existsSync(path.join(results, 'aaaaaaaaaaaa')), false);
  assert.equal(fs.existsSync(path.join(results, 'bbbbbbbbbbbb', 'output.txt')), true, 'a running job is left alone');
  assert.equal(fs.existsSync(path.join(results, 'cccccccccccc', 'output.txt')), true);
  assert.deepEqual(tally.total, { files: 2, bytes: 9 });
  await purgeJobOutputs(service, 'sess_a', tally);
  await purgeJobOutputs({}, 'sess_a', tally);
  assert.equal(tally.total.files, 2);
});

test('job outputs: ignores forged roots and refuses a linked tool-results folder', async (t) => {
  const root = tempRoot(t);
  const outside = path.join(root, 'outside');
  write(path.join(outside, 'aaaaaaaaaaaa', 'output.txt'), 'keep');
  const linked = path.join(root, 'ws');
  fs.mkdirSync(path.join(linked, '.jenny'), { recursive: true });
  linkDirectory(outside, path.join(linked, '.jenny', 'tool-results'));
  const service = {
    backgroundJobTracker: {
      getSessionJobRoots: () => [
        { jobId: '../../etc', workspaceRoot: linked },
        { jobId: 'aaaaaaaaaaaa', workspaceRoot: 'relative/root' },
        { jobId: 'aaaaaaaaaaaa', workspaceRoot: linked },
      ],
    },
  };
  const tally = makeTally();

  await assert.rejects(purgeJobOutputs(service, 'sess_a', tally), /could not be removed/);

  assert.equal(fs.readFileSync(path.join(outside, 'aaaaaaaaaaaa', 'output.txt'), 'utf8'), 'keep');
  assert.deepEqual(tally.total, { files: 0, bytes: 0 });
});

function diagnostic(sessionId, filler = '') {
  return `${JSON.stringify({
    schema_version: 1, written_at: 'now', request_id: 'r', stream_id: 's', session_id: sessionId, filler,
  }, null, 2)}\n`;
}

function serviceFor(userDataPath, logs = []) {
  return { options: { userDataPath }, _emitServiceLog: (...args) => logs.push(args) };
}

test('turn diagnostics: one deferred sweep removes every queued chat\'s files across days and nothing else', async (t) => {
  const userDataPath = tempRoot(t);
  const diag = path.join(userDataPath, 'diagnostics');
  write(path.join(diag, '2026-10-30', 'stream_1.json'), diagnostic('sess_a'));
  write(path.join(diag, '2026-11-01', 'stream_2.json'), diagnostic('sess_a', 'x'.repeat(50_000)));
  write(path.join(diag, '2026-11-01', 'stream_6.json'), diagnostic('sess_b'));
  write(path.join(diag, '2026-11-01', 'stream_3.json'), diagnostic('sess_ab'));
  write(path.join(diag, '2026-11-01', 'stream_4.json'), diagnostic(null));
  write(path.join(diag, '2026-11-01', 'notes.txt'), diagnostic('sess_a'));
  write(path.join(diag, 'not-a-date', 'stream_5.json'), diagnostic('sess_a'));
  write(path.join(diag, '2026-11-01', 'broken.json'), '{ not json');
  const service = serviceFor(userDataPath);
  const realReaddir = fs.promises.readdir;
  let rootScans = 0;
  t.mock.method(fs.promises, 'readdir', (target, ...rest) => {
    if (path.resolve(String(target)) === path.resolve(diag)) rootScans += 1;
    return realReaddir.call(fs.promises, target, ...rest);
  });

  assert.equal(scheduleTurnDiagnosticsPurge(service, 'sess_a'), undefined);
  scheduleTurnDiagnosticsPurge(service, 'sess_b');
  assert.equal(fs.existsSync(path.join(diag, '2026-10-30', 'stream_1.json')), true, 'scheduling does no work');
  await drainTurnDiagnosticsPurges(service);

  assert.equal(rootScans, 1, 'two deleted chats cost one scan');
  for (const gone of [['2026-10-30', 'stream_1.json'], ['2026-11-01', 'stream_2.json'], ['2026-11-01', 'stream_6.json']]) {
    assert.equal(fs.existsSync(path.join(diag, ...gone)), false, gone.join('/'));
  }
  for (const kept of [['2026-11-01', 'stream_3.json'], ['2026-11-01', 'stream_4.json'], ['2026-11-01', 'notes.txt'],
    ['not-a-date', 'stream_5.json'], ['2026-11-01', 'broken.json']]) {
    assert.equal(fs.existsSync(path.join(diag, ...kept)), true, kept.join('/'));
  }
  await drainTurnDiagnosticsPurges(service);
  await drainTurnDiagnosticsPurges(serviceFor(path.join(userDataPath, 'missing')));
});

test('turn diagnostics: the sweep is debounced after the last delete', async (t) => {
  const userDataPath = tempRoot(t);
  const dump = path.join(userDataPath, 'diagnostics', '2026-11-01', 's.json');
  write(dump, diagnostic('sess_a'));
  const service = serviceFor(userDataPath);
  t.mock.timers.enable({ apis: ['setTimeout'] });

  scheduleTurnDiagnosticsPurge(service, 'sess_x');
  t.mock.timers.tick(1500);
  scheduleTurnDiagnosticsPurge(service, 'sess_a');
  t.mock.timers.tick(1999);
  assert.equal(fs.existsSync(dump), true, 'not before 2 s of quiet');
  t.mock.timers.tick(1);
  t.mock.timers.reset();
  await drainTurnDiagnosticsPurges(service);

  assert.equal(fs.existsSync(dump), false);
});

test('turn diagnostics: reads and removals are concurrent but bounded to 8', async (t) => {
  const userDataPath = tempRoot(t);
  const day = path.join(userDataPath, 'diagnostics', '2026-11-01');
  for (let index = 0; index < 40; index += 1) {
    write(path.join(day, `s${index}.json`), diagnostic(index % 2 ? 'sess_a' : 'sess_other'));
  }
  const realOpen = fs.promises.open;
  let live = 0;
  let peak = 0;
  t.mock.method(fs.promises, 'open', async (target, ...rest) => {
    live += 1;
    peak = Math.max(peak, live);
    try {
      await new Promise((resolve) => { setTimeout(resolve, 2); });
      return await realOpen.call(fs.promises, target, ...rest);
    } finally {
      live -= 1;
    }
  });
  const service = serviceFor(userDataPath);

  scheduleTurnDiagnosticsPurge(service, 'sess_a');
  await drainTurnDiagnosticsPurges(service);

  assert.equal(peak > 1 && peak <= 8, true, `peak ${peak}`);
  assert.equal(fs.readdirSync(day).length, 20);
});

test('turn diagnostics: a failure is logged by code only and never throws', async (t) => {
  const userDataPath = tempRoot(t);
  const day = path.join(userDataPath, 'diagnostics', '2026-11-01');
  write(path.join(day, 'locked.json'), diagnostic('sess_a'));
  write(path.join(day, 'fine.json'), diagnostic('sess_a'));
  const realOpen = fs.promises.open;
  t.mock.method(fs.promises, 'open', (target, ...rest) => {
    if (path.basename(String(target)) === 'locked.json') throw Object.assign(new Error(`C:\\secret\\${target}`), { code: 'EBUSY' });
    return realOpen.call(fs.promises, target, ...rest);
  });
  const logs = [];
  const service = serviceFor(userDataPath, logs);

  scheduleTurnDiagnosticsPurge(service, 'sess_a');
  await drainTurnDiagnosticsPurges(service);

  assert.equal(fs.existsSync(path.join(day, 'fine.json')), false);
  assert.equal(fs.existsSync(path.join(day, 'locked.json')), true);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][1], 'session.turn_diagnostics_swept');
  assert.deepEqual(logs[0][2].failed, { EBUSY: 1 });
  assert.equal(JSON.stringify(logs).includes('secret'), false);
  assert.equal(JSON.stringify(logs).includes(userDataPath), false);
});

test('turn diagnostics: a linked day folder or diagnostics folder is not entered', async (t) => {
  const root = tempRoot(t);
  const userDataPath = path.join(root, 'profile');
  const outside = path.join(root, 'outside');
  write(path.join(outside, 'stream_9.json'), diagnostic('sess_a'));
  fs.mkdirSync(path.join(userDataPath, 'diagnostics'), { recursive: true });
  linkDirectory(outside, path.join(userDataPath, 'diagnostics', '2026-11-01'));
  const service = serviceFor(userDataPath);
  scheduleTurnDiagnosticsPurge(service, 'sess_a');
  await drainTurnDiagnosticsPurges(service);
  assert.equal(fs.existsSync(path.join(outside, 'stream_9.json')), true);

  const linkedRoot = path.join(root, 'profile2');
  fs.mkdirSync(linkedRoot);
  write(path.join(outside, '2026-11-01', 'stream_8.json'), diagnostic('sess_a'));
  linkDirectory(outside, path.join(linkedRoot, 'diagnostics'));
  const second = serviceFor(linkedRoot);
  scheduleTurnDiagnosticsPurge(second, 'sess_a');
  await drainTurnDiagnosticsPurges(second);
  assert.equal(fs.existsSync(path.join(outside, '2026-11-01', 'stream_8.json')), true);
});

test('turn diagnostics: ids that are not strings or are oversized are never queued', async (t) => {
  const userDataPath = tempRoot(t);
  const dump = path.join(userDataPath, 'diagnostics', '2026-11-01', 's.json');
  write(dump, diagnostic(null));
  const service = serviceFor(userDataPath);
  for (const bad of ['', null, 7, 'x'.repeat(257)]) scheduleTurnDiagnosticsPurge(service, bad);
  scheduleTurnDiagnosticsPurge({ options: {} }, 'sess_a');
  await drainTurnDiagnosticsPurges(service);
  assert.equal(fs.existsSync(dump), true);
});

test('freed tally counts candidate files that disappear and ignores ones that stay', async (t) => {
  const userDataPath = tempRoot(t);
  const gone = path.join(userDataPath, 'gone.bin');
  const stays = path.join(userDataPath, 'stays.bin');
  write(gone, '1234');
  write(stays, '12345678');
  const payloadRoot = path.join(userDataPath, 'payloads');
  write(path.join(payloadRoot, 'p1'), '123456');
  const todoFile = require('../services/backend/session-todo-list-purge').todoListFileName('sess_t');
  write(path.join(userDataPath, 'todo-lists', todoFile), '12');
  const service = { options: { userDataPath }, ipcPayloadStore: { rootDir: payloadRoot } };

  const tally = await beginFreedTally(service, 'sess_t', {
    assetPaths: [gone, stays, path.join(userDataPath, 'never-existed.bin'), null],
    payloadPaths: ['p1'],
  });
  fs.unlinkSync(gone);
  fs.unlinkSync(path.join(payloadRoot, 'p1'));
  fs.unlinkSync(path.join(userDataPath, 'todo-lists', todoFile));
  tally.add({ files: 3, bytes: 100 });

  assert.deepEqual(await tally.settle(), { files: 6, bytes: 112 });
  assert.deepEqual(await tally.settle(), { files: 6, bytes: 112 }, 'settling twice does not double count');
});

test('freed tally stats candidates asynchronously and never blocks on a big set', async (t) => {
  const userDataPath = tempRoot(t);
  const paths = [];
  for (let index = 0; index < 100; index += 1) {
    const filePath = path.join(userDataPath, `f${index}.bin`);
    write(filePath, '12');
    paths.push(filePath);
  }
  const realLstatSync = fs.lstatSync;
  let syncStats = 0;
  t.mock.method(fs, 'lstatSync', (...args) => { syncStats += 1; return realLstatSync(...args); });

  const tally = await beginFreedTally({ options: { userDataPath } }, 'sess_t', { assetPaths: paths });
  for (const filePath of paths.slice(0, 60)) fs.unlinkSync(filePath);

  assert.deepEqual(await tally.settle(), { files: 60, bytes: 120 });
  assert.equal(syncStats, 0);
});

test('runSessionPurges records each failing step as degraded and keeps going', async (t) => {
  const root = tempRoot(t);
  const userDataPath = path.join(root, 'profile');
  const outside = path.join(root, 'outside');
  write(path.join(outside, 'sess_a', 'anchor.json'), 'keep');
  fs.mkdirSync(path.join(userDataPath, 'background-memory'), { recursive: true });
  linkDirectory(outside, path.join(userDataPath, 'background-memory', 'repo-anchors'));
  const errors = [];
  const runStep = async (_service, _sessionId, cleanupErrors, step, cleanup) => {
    try { await cleanup(); } catch (_error) { cleanupErrors.push({ step, code: 'cleanup_failed' }); }
  };
  const tally = makeTally();

  await runSessionPurges({ options: { userDataPath } }, 'sess_a', errors, runStep, tally);

  assert.deepEqual(errors, [{ step: 'repo_anchors', code: 'cleanup_failed' }]);
  assert.equal(fs.existsSync(path.join(outside, 'sess_a', 'anchor.json')), true);
});
