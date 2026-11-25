'use strict';

// new-test-file: tests/run-view-service.test.js is at its line cap; this is one start failure, the missing screen helper (row 196, C11).

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunService } = require('../services/run-view/run-service');
const { createRunCommandStore } = require('../services/run-view/run-command-store');
const { removeTreeSync } = require('../services/fs-remove-no-follow');

const settle = async () => { for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

// A service over a host whose run.start rejects with the given error code.
function harness(t, { code, isPackaged }) {
  const dir = (label) => {
    const made = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `jenny-helper-${label}-`)));
    t.after(() => removeTreeSync(made));
    return made;
  };
  const root = dir('root');
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin', 'game.exe'), 'x');
  const store = createRunCommandStore({ userDataPath: dir('store') });
  const events = new EventEmitter();
  const emitted = [];
  const host = {
    request: async () => { throw Object.assign(new Error('refused'), { code }); },
    on: (name, listener) => events.on(name, listener),
    off: (name, listener) => events.off(name, listener),
  };
  const service = createRunService({
    host, commandStore: store, armWindowCapture: async () => ({ ok: true }), isPackaged,
    getProjectBinding: () => ({ rootId: 'root-a', rootRevision: 1, rootPath: root }),
    emit: (channel, payload) => emitted.push({ channel, payload }),
    env: { PATH: 'C:\\bin' },
  });
  t.after(() => service.dispose());
  store.confirm({
    projectId: 'p1', rootId: 'root-a', rootRevision: 1, worktree: null,
    command: { build: '', program: path.join('bin', 'game.exe'), args: [], cwd: '', env: {}, watch: [] },
  });
  return { service, emitted };
}

async function startAndRead({ service, emitted }) {
  await service.start({ projectId: 'p1', chatId: 'chat-a', worktree: null });
  await settle();
  const run = (await service.getStatus({ projectId: 'p1', worktree: null })).run;
  return { run, pushed: emitted.filter((e) => e.channel === 'run-view:state').at(-1).payload };
}

test('a helper that is unavailable at start names the helper and says whether a build can fix it', async (t) => {
  for (const [isPackaged, hint] of [[undefined, true], [false, true], [true, false]]) {
    const { run, pushed } = await startAndRead(harness(t, { code: 'helper_unavailable', isPackaged }));
    assert.equal(run.state, 'ended_early');
    assert.equal(run.reason, 'helper_unavailable');
    assert.equal(run.helperBuildHint, hint, `isPackaged ${isPackaged}`);
    assert.equal(pushed.helperBuildHint, hint);
    assert.equal(pushed.reason, 'helper_unavailable');
  }
});

test('any other start failure carries its own reason and no helper hint', async (t) => {
  const { run, pushed } = await startAndRead(harness(t, { code: 'start_failed' }));
  assert.equal(run.state, 'ended_early');
  assert.equal(run.reason, 'start_failed');
  assert.equal('helperBuildHint' in run, false);
  assert.equal('helperBuildHint' in pushed, false);
});
