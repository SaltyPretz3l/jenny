'use strict';

// new-test-file: sketch.openFile is a new main-process surface (services/sketch/sketch-file-open.js and
// services/main/sketch-ipc-registration.js): the path check a drawing's file node goes through, on a real folder tree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { REASONS, createSketchFileOpener } = require('../services/sketch/sketch-file-open');
const { registerSketchIpc } = require('../services/main/sketch-ipc-registration');
const { JENNY_SHELL_BRIDGE_DESCRIPTORS, listBridgeMethodPaths } = require('../services/ipc-contract');

const IS_WINDOWS = process.platform === 'win32';

// <tmp>/project            the chat's project root (real path, as the project authority hands it out)
//   src/app.js             a file
//   src/deep/notes.md      a file two folders down
//   docs/                  a folder
//   into-outside           a junction to <tmp>/outside
//   into-src               a junction to <tmp>/project/src (stays inside the root)
// <tmp>/outside/secret.txt a file outside the root
function makeTree(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-sketch-open-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'));
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'console.log(1);\n');
  fs.writeFileSync(path.join(root, 'src', 'deep', 'notes.md'), '# notes\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
  fs.symlinkSync(outside, path.join(root, 'into-outside'), 'junction');
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'into-src'), 'junction');
  return { base, root, outside };
}

function notFoundError(reason) {
  const error = new Error('Session was not found.');
  error.reason = reason;
  return error;
}

function opener(tree, { enabled = true, sessions } = {}) {
  const known = sessions || {
    sess_local: { project_id: 'project_a', root_path: tree.root },
    sess_general: { project_id: 'project_general', root_path: null },
  };
  const seen = [];
  const open = createSketchFileOpener({
    isEnabled: () => enabled,
    captureSession: (id) => {
      seen.push(id);
      if (id === 'sess_folder_gone') throw notFoundError('root_unavailable');
      if (!Object.prototype.hasOwnProperty.call(known, id)) throw notFoundError('session_not_found');
      return known[id];
    },
  });
  return { open, seen };
}

const refused = (reason) => ({ ok: false, reason });

test('the reasons are the closed list of the contract', () => {
  assert.deepEqual([...REASONS].sort(), ['disabled', 'link', 'no_root', 'no_session', 'not_file', 'not_found', 'outside']);
});

test('a file inside the root opens: a relative path with forward slashes, the line passed through', async (t) => {
  const tree = makeTree(t);
  const { open } = opener(tree);
  assert.deepEqual(await open({ sessionId: 'sess_local', path: 'src/app.js', line: 12 }),
    { ok: true, relativePath: 'src/app.js', line: 12, projectId: 'project_a' });
  assert.deepEqual(await open({ sessionId: 'sess_local', path: 'src\\deep\\notes.md', line: null }),
    { ok: true, relativePath: 'src/deep/notes.md', line: null, projectId: 'project_a' });
  assert.deepEqual(await open({ sessionId: 'sess_local', path: './src//deep/../app.js' }),
    { ok: true, relativePath: 'src/app.js', line: null, projectId: 'project_a' }, 'a .. that stays inside is read as the path it names');
  for (const line of [0, -3, 2.5, '7', 10000001]) {
    assert.equal((await open({ sessionId: 'sess_local', path: 'src/app.js', line })).line, null, `line ${line}`);
  }
});

test('.. out of the root is outside', async (t) => {
  const tree = makeTree(t);
  const { open } = opener(tree);
  assert.deepEqual(await open({ sessionId: 'sess_local', path: '../outside/secret.txt' }), refused('outside'));
  assert.deepEqual(await open({ sessionId: 'sess_local', path: 'src/../../outside/secret.txt' }), refused('outside'));
  assert.deepEqual(await open({ sessionId: 'sess_local', path: '..' }), refused('outside'));
});

test('an absolute path outside the root is outside; another drive is outside', async (t) => {
  const tree = makeTree(t);
  const { open } = opener(tree);
  assert.deepEqual(await open({ sessionId: 'sess_local', path: path.join(tree.outside, 'secret.txt') }), refused('outside'));
  assert.deepEqual(await open({ sessionId: 'sess_local', path: tree.base }), refused('outside'));
  if (IS_WINDOWS) {
    const otherDrive = tree.root.slice(0, 1).toUpperCase() === 'Q' ? 'R' : 'Q';
    assert.deepEqual(await open({ sessionId: 'sess_local', path: `${otherDrive}:\\project\\src\\app.js` }), refused('outside'));
    assert.deepEqual(await open({ sessionId: 'sess_local', path: 'C:relative.txt' }), refused('outside'), 'a drive-relative path');
    assert.deepEqual(await open({ sessionId: 'sess_local', path: '/Windows/win.ini' }), refused('outside'), 'a path rooted on the current drive');
  } else {
    assert.deepEqual(await open({ sessionId: 'sess_local', path: '/etc/passwd' }), refused('outside'));
  }
});

test('an absolute path inside the root opens as its relative path', async (t) => {
  const tree = makeTree(t);
  const { open } = opener(tree);
  assert.deepEqual(await open({ sessionId: 'sess_local', path: path.join(tree.root, 'src', 'app.js'), line: 3 }),
    { ok: true, relativePath: 'src/app.js', line: 3, projectId: 'project_a' });
  assert.deepEqual(await open({ sessionId: 'sess_local', path: tree.root.split(path.sep).join('/') + '/src/deep/notes.md' }),
    { ok: true, relativePath: 'src/deep/notes.md', line: null, projectId: 'project_a' });
});

test('a path through a directory junction that points outside the root is a link', async (t) => {
  const tree = makeTree(t);
  const { open } = opener(tree);
  assert.deepEqual(await open({ sessionId: 'sess_local', path: 'into-outside/secret.txt' }), refused('link'));
  assert.deepEqual(await open({ sessionId: 'sess_local', path: path.join(tree.root, 'into-outside', 'secret.txt') }), refused('link'));
  assert.deepEqual(await open({ sessionId: 'sess_local', path: 'into-outside' }), refused('link'));
});

test('a path through a junction that points inside the root is a link too (fs-contained follows no link)', async (t) => {
  const tree = makeTree(t);
  const { open } = opener(tree);
  assert.deepEqual(await open({ sessionId: 'sess_local', path: 'into-src/app.js' }), refused('link'));
});

test('a symbolic link to a file is a link', async (t) => {
  const tree = makeTree(t);
  const { open } = opener(tree);
  const link = path.join(tree.root, 'secret-link.txt');
  try {
    fs.symlinkSync(path.join(tree.outside, 'secret.txt'), link, 'file');
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('this platform refuses to create a file symbolic link without privilege (Windows without Developer Mode)');
      return;
    }
    throw error;
  }
  assert.deepEqual(await open({ sessionId: 'sess_local', path: 'secret-link.txt' }), refused('link'));
  fs.symlinkSync(path.join(tree.root, 'src', 'app.js'), path.join(tree.root, 'inside-link.js'), 'file');
  assert.deepEqual(await open({ sessionId: 'sess_local', path: 'inside-link.js' }), refused('link'), 'a link that stays inside is refused too');
});

test('a folder is not a file, the root itself included', async (t) => {
  const tree = makeTree(t);
  const { open } = opener(tree);
  assert.deepEqual(await open({ sessionId: 'sess_local', path: 'docs' }), refused('not_file'));
  assert.deepEqual(await open({ sessionId: 'sess_local', path: 'src/deep/' }), refused('not_file'));
  assert.deepEqual(await open({ sessionId: 'sess_local', path: '.' }), refused('not_file'));
  assert.deepEqual(await open({ sessionId: 'sess_local', path: tree.root }), refused('not_file'));
  if (IS_WINDOWS) {
    for (const device of ['CON', 'src/nul.txt', 'COM1', 'docs/LPT9.md', 'aux']) {
      assert.deepEqual(await open({ sessionId: 'sess_local', path: device }), refused('not_file'), device);
    }
  }
});

test('a missing file, or a file used as a folder, is not found', async (t) => {
  const tree = makeTree(t);
  const { open } = opener(tree);
  assert.deepEqual(await open({ sessionId: 'sess_local', path: 'src/gone.js' }), refused('not_found'));
  assert.deepEqual(await open({ sessionId: 'sess_local', path: 'nowhere/at/all.txt' }), refused('not_found'));
  assert.deepEqual(await open({ sessionId: 'sess_local', path: 'src/app.js/inner.js' }), refused('not_found'));
});

test('a UNC path and a device path are outside, and nothing is looked up for them', async (t) => {
  const tree = makeTree(t);
  const walked = [];
  const open = createSketchFileOpener({
    captureSession: () => ({ project_id: 'project_a', root_path: tree.root }),
    resolve: (...args) => { walked.push(args); return null; },
  });
  for (const hostile of [
    '\\\\server\\share\\file.txt', '//server/share/file.txt', '\\\\?\\C:\\Windows\\win.ini', '\\\\.\\PhysicalDrive0',
    '//?/C:/Windows/win.ini', '\\\\?\\UNC\\server\\share\\x', `\\\\?\\${tree.root}\\src\\app.js`,
  ]) {
    assert.deepEqual(await open({ sessionId: 'sess_local', path: hostile }), refused('outside'), hostile);
  }
  assert.deepEqual(walked, [], 'no filesystem walk for a UNC or device path');
});

test('a path with a NUL, a control character, a stream name, or a trailing dot or space is outside', async (t) => {
  const tree = makeTree(t);
  const { open } = opener(tree);
  for (const hostile of [
    'src/app.js\u0000.png', 'src/\napp.js', 'src/app.js.', 'src/app.js ', 'src./app.js', 'src /app.js',
    'src/app.js:secret', 'src/app.js::$DATA', '', 'x'.repeat(1025),
  ]) {
    assert.deepEqual(await open({ sessionId: 'sess_local', path: hostile }), refused('outside'), JSON.stringify(hostile.slice(0, 40)));
  }
  for (const notText of [42, null, undefined, ['src/app.js'], { toString: () => 'src/app.js' }]) {
    assert.deepEqual(await open({ sessionId: 'sess_local', path: notText }), refused('outside'));
  }
});

test('a null root permits conversation only: a chat with no project folder opens nothing', async (t) => {
  const tree = makeTree(t);
  const { open } = opener(tree);
  assert.deepEqual(await open({ sessionId: 'sess_general', path: 'src/app.js' }), refused('no_root'));
  assert.deepEqual(await open({ sessionId: 'sess_general', path: path.join(tree.root, 'src', 'app.js') }), refused('no_root'));
  assert.deepEqual(await open({ sessionId: 'sess_folder_gone', path: 'src/app.js' }), refused('no_root'), 'a project whose folder is gone');
});

test('a team project chat has no local session: its call carries no id and opens nothing', async (t) => {
  const tree = makeTree(t);
  const { open, seen } = opener(tree);
  // The renderer sends no session id for a block outside a local chat (the Team tab, a preview, a board's viewer).
  assert.deepEqual(await open({ path: 'src/app.js', line: 2 }), refused('no_session'));
  assert.deepEqual(await open({ sessionId: '', path: 'src/app.js' }), refused('no_session'));
  // A team chat's own id, had one reached the main process, is not in the local session store.
  assert.deepEqual(await open({ sessionId: 'team:project_x:chat_1', path: 'src/app.js' }), refused('no_session'));
  assert.deepEqual(seen, ['team:project_x:chat_1'], 'a missing id is never looked up');
});

test('an unknown or malformed session id is no_session', async (t) => {
  const tree = makeTree(t);
  const { open, seen } = opener(tree);
  assert.deepEqual(await open({ sessionId: 'sess_unknown', path: 'src/app.js' }), refused('no_session'));
  for (const malformed of [42, {}, ['sess_local'], 'sess local', 's'.repeat(129), 'sess_local\u0000', '../sess_local']) {
    assert.deepEqual(await open({ sessionId: malformed, path: 'src/app.js' }), refused('no_session'), String(malformed).slice(0, 20));
  }
  assert.deepEqual(seen, ['sess_unknown'], 'a malformed id is never looked up');
  for (const notAnObject of [null, undefined, 'src/app.js', 42, ['sess_local', 'src/app.js']]) {
    assert.deepEqual(await open(notAnObject), refused('no_session'));
  }
});

test('with the sketch_blocks flag off nothing is looked up or touched', async (t) => {
  const tree = makeTree(t);
  const { open, seen } = opener(tree, { enabled: false });
  assert.deepEqual(await open({ sessionId: 'sess_local', path: 'src/app.js' }), refused('disabled'));
  assert.deepEqual(seen, []);
});

test('a session lookup that throws something unexpected is no_root, and the answer never carries a path', async (t) => {
  const tree = makeTree(t);
  const open = createSketchFileOpener({
    isEnabled: () => true,
    captureSession: () => { throw new Error(`Project store unavailable at ${tree.root}`); },
  });
  const answer = await open({ sessionId: 'sess_local', path: 'src/app.js' });
  assert.deepEqual(answer, refused('no_root'));
  assert.equal(JSON.stringify(answer).includes(tree.base), false);
});

/* ── The registration (tests/board-ipc-registration.test.js's way) ── */

function register({ allow = true, enabled = true, openFile, backendService = {} } = {}) {
  const handlers = new Map();
  const logged = [];
  const result = registerSketchIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    backendService,
    authorization: { authorize: () => allow },
    isEnabled: () => enabled,
    openFile,
    log: (...args) => logged.push(args),
  });
  return { handlers, result, logged, invoke: (payload) => handlers.get('sketch:open-file')({ sender: {} }, payload) };
}

test('sketch.openFile is one descriptor-backed invoke channel, registered behind the authorizer', async () => {
  const { handlers, result } = register({ openFile: async () => ({ ok: false, reason: 'not_found' }) });
  assert.deepEqual([...handlers.keys()], ['sketch:open-file']);
  assert.deepEqual(result.channels, ['sketch:open-file']);
  assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS['sketch.openFile'], { kind: 'invoke', channel: 'sketch:open-file' });
  assert.deepEqual(listBridgeMethodPaths().filter((methodPath) => methodPath.startsWith('sketch.')), ['sketch.openFile']);
  const calls = [];
  const denied = register({ allow: false, openFile: async (raw) => { calls.push(raw); return { ok: true }; } });
  assert.equal((await denied.invoke({ sessionId: 'sess_local', path: 'src/app.js' })).ok, false);
  assert.deepEqual(calls, [], 'an untrusted sender reaches no check');
});

test('the handler validates its argument shape and never rejects', async () => {
  const seen = [];
  const { invoke } = register({ openFile: async (request) => { seen.push(request); return { ok: false, reason: 'not_found' }; } });
  assert.deepEqual(await invoke({ sessionId: 'sess_local', path: 'src/app.js', line: 4, extra: 'x' }), refused('not_found'));
  assert.deepEqual(seen, [{ sessionId: 'sess_local', path: 'src/app.js', line: 4 }], 'only the three known fields go on');
  for (const bad of [null, 'src/app.js', 42, ['x']]) assert.deepEqual(await invoke(bad), refused('no_session'));
  assert.equal(seen.length, 1, 'a payload that is not an object reaches no check');
  const broken = register({ openFile: async () => { throw new Error('C:\\Users\\someone\\secret path'); } });
  const answer = await broken.invoke({ sessionId: 'sess_local', path: 'src/app.js' });
  assert.deepEqual(answer, refused('not_found'));
  const odd = register({ openFile: async () => ({ ok: true, relativePath: 'C:\\abs\\path.txt', line: 1, projectId: 'p' }) });
  assert.deepEqual(await odd.invoke({ sessionId: 'sess_local', path: 'x' }), refused('not_found'), 'an absolute path never leaves the handler');
  const offList = register({ openFile: async () => ({ ok: false, reason: 'EACCES at C:\\x' }) });
  assert.deepEqual(await offList.invoke({ sessionId: 'sess_local', path: 'x' }), refused('not_found'), 'a reason off the list is not passed on');
});

test('the flag off answers disabled before any check runs', async () => {
  const calls = [];
  const { invoke } = register({ enabled: false, openFile: async (raw) => { calls.push(raw); return { ok: true }; } });
  assert.deepEqual(await invoke({ sessionId: 'sess_local', path: 'src/app.js' }), refused('disabled'));
  assert.deepEqual(calls, []);
});

test('a root or projectRoot in the call does not change the answer; the log carries the reason only', async (t) => {
  const tree = makeTree(t);
  const backendService = {
    featureFlags: { sketch_blocks: true },
    projectAuthority: {
      captureSession: (id) => {
        if (id === 'sess_local') return { project_id: 'project_a', root_path: tree.root };
        if (id === 'sess_general') return { project_id: 'project_general', root_path: null };
        throw notFoundError('session_not_found');
      },
    },
  };
  const handlers = new Map();
  const logged = [];
  registerSketchIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    backendService, authorization: { authorize: () => true }, log: (...args) => logged.push(args),
  });
  const invoke = (payload) => handlers.get('sketch:open-file')({ sender: {} }, payload);
  const secret = path.join(tree.outside, 'secret.txt');
  const cases = [
    [{ sessionId: 'sess_local', path: 'src/app.js', line: 2 }, { ok: true, relativePath: 'src/app.js', line: 2, projectId: 'project_a' }],
    [{ sessionId: 'sess_local', path: secret }, refused('outside')],
    [{ sessionId: 'sess_general', path: 'secret.txt' }, refused('no_root')],
    [{ path: 'secret.txt' }, refused('no_session')],
  ];
  for (const [payload, expected] of cases) {
    assert.deepEqual(await invoke(payload), expected);
    for (const forged of [{ root: tree.outside }, { projectRoot: tree.outside }, { root: tree.outside, projectRoot: tree.base, root_path: tree.outside }]) {
      assert.deepEqual(await invoke({ ...payload, ...forged }), expected, JSON.stringify(Object.keys(forged)));
    }
  }
  backendService.featureFlags.sketch_blocks = false;
  assert.deepEqual(await invoke({ sessionId: 'sess_local', path: 'src/app.js' }), refused('disabled'));
  delete backendService.featureFlags.sketch_blocks;
  assert.equal((await invoke({ sessionId: 'sess_local', path: 'src/app.js' })).ok, true, 'the flag defaults on');
  const text = JSON.stringify(logged);
  assert.ok(logged.length > 0);
  for (const fragment of [tree.base, 'secret', 'src/app.js', 'sess_local']) assert.equal(text.includes(fragment), false, fragment);
  assert.deepEqual(logged.map((entry) => entry[2] && Object.keys(entry[2])), logged.map(() => ['reason']));
});
