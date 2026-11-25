'use strict';

// new-test-file: the live run view's command store is a new surface (row 197, R1).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  RUN_COMMAND_SCHEMA_VERSION, RUN_COMMANDS_FILENAME, createRunCommandStore, normalizeRunCommand,
} = require('../services/run-view/run-command-store');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-run-commands-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const BINDING = Object.freeze({ projectId: 'proj-1', rootId: 'root-a', rootRevision: 3, worktree: null });
const COMMAND = Object.freeze({
  build: 'cargo build --release',
  program: 'target\\release\\client.exe',
  args: ['--windowed', '--size', '1280x720'],
  cwd: '',
  env: { GAME_SAVE_DIR: 'C:\\scratch\\saves' },
  watch: ['src', 'assets/maps'],
});

test('a confirmed command reads back confirmed for the same project, root, revision and worktree', (t) => {
  const store = createRunCommandStore({ userDataPath: tempDir(t), now: () => 1700000000000 });
  assert.deepEqual(store.get(BINDING), { status: 'none' });
  const saved = store.confirm({ ...BINDING, command: COMMAND });
  assert.equal(saved.ok, true);
  const read = store.get(BINDING);
  assert.equal(read.status, 'confirmed');
  assert.deepEqual(read.command, { ...COMMAND, args: [...COMMAND.args], watch: [...COMMAND.watch] });
  assert.equal(read.confirmedAt, 1700000000000);
});

test('the store survives a restart and is versioned on disk', (t) => {
  const dir = tempDir(t);
  createRunCommandStore({ userDataPath: dir }).confirm({ ...BINDING, command: COMMAND });
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, RUN_COMMANDS_FILENAME), 'utf8'));
  assert.equal(onDisk.version, RUN_COMMAND_SCHEMA_VERSION);
  assert.equal(createRunCommandStore({ userDataPath: dir }).get(BINDING).status, 'confirmed');
});

test('a rebound folder, a new root revision or another worktree asks for confirmation again', (t) => {
  const store = createRunCommandStore({ userDataPath: tempDir(t) });
  store.confirm({ ...BINDING, command: COMMAND });
  for (const [change, reason] of [
    [{ rootId: 'root-b' }, 'rebind'],
    [{ rootRevision: 4 }, 'rebind'],
    [{ worktree: 'wt-feature' }, 'worktree'],
  ]) {
    const read = store.get({ ...BINDING, ...change });
    assert.equal(read.status, 'needs_confirmation', JSON.stringify(change));
    assert.equal(read.reason, reason);
    assert.equal(read.command.program, COMMAND.program, 'the owner sees what was confirmed before');
  }
  // Confirming for the new binding moves the command there.
  store.confirm({ ...BINDING, rootId: 'root-b', command: COMMAND });
  assert.equal(store.get({ ...BINDING, rootId: 'root-b' }).status, 'confirmed');
  assert.equal(store.get(BINDING).status, 'needs_confirmation');
});

test('a profile restore asks for every command again, and that survives a restart', (t) => {
  const dir = tempDir(t);
  const store = createRunCommandStore({ userDataPath: dir });
  store.confirm({ ...BINDING, command: COMMAND });
  store.confirm({ ...BINDING, projectId: 'proj-2', command: COMMAND });
  assert.equal(store.invalidateAll('restore').ok, true);
  for (const projectId of ['proj-1', 'proj-2']) {
    const read = createRunCommandStore({ userDataPath: dir }).get({ ...BINDING, projectId });
    assert.equal(read.status, 'needs_confirmation');
    assert.equal(read.reason, 'restore');
  }
  store.confirm({ ...BINDING, command: COMMAND });
  assert.equal(store.get(BINDING).status, 'confirmed');
});

test('deleting a project deletes its command and nothing else', (t) => {
  const store = createRunCommandStore({ userDataPath: tempDir(t) });
  store.confirm({ ...BINDING, command: COMMAND });
  store.confirm({ ...BINDING, projectId: 'proj-2', command: COMMAND });
  assert.equal(store.deleteProject('proj-1').ok, true);
  assert.deepEqual(store.get(BINDING), { status: 'none' });
  assert.equal(store.get({ ...BINDING, projectId: 'proj-2' }).status, 'confirmed');
  assert.equal(store.deleteProject('never-there').ok, true);
});

test('a bad command is refused with a reason and nothing is written', (t) => {
  const dir = tempDir(t);
  const store = createRunCommandStore({ userDataPath: dir });
  const cases = [
    [{ program: '' }, 'program_invalid'],
    [{ program: 'game.exe\u0000' }, 'program_invalid'],
    [{ build: 'cargo build\nrm -rf /' }, 'build_invalid'],
    [{ args: ['ok', 7] }, 'args_invalid'],
    [{ args: ['line\nbreak'] }, 'args_invalid'],
    [{ cwd: '..\\outside' }, 'cwd_invalid'],
    [{ cwd: 'C:\\elsewhere' }, 'cwd_invalid'],
    [{ cwd: '/etc' }, 'cwd_invalid'],
    [{ env: { NODE_OPTIONS: '--inspect' } }, 'reserved_env_key'],
    [{ env: { PATH: 'C:\\evil' } }, 'reserved_env_key'],
    [{ env: { GAME_API_TOKEN: 'x' } }, 'plaintext_secret'],
    [{ watch: ['../sibling'] }, 'watch_invalid'],
    [{ watch: 'src' }, 'watch_invalid'],
    [{ extra: true }, 'command_invalid'],
  ];
  for (const [patch, reason] of cases) {
    const result = store.confirm({ ...BINDING, command: { ...COMMAND, ...patch } });
    assert.equal(result.ok, false, JSON.stringify(patch));
    assert.equal(result.reason, reason, JSON.stringify(patch));
  }
  assert.equal(fs.existsSync(path.join(dir, RUN_COMMANDS_FILENAME)), false);
  assert.equal(store.confirm({ ...BINDING, projectId: '', command: COMMAND }).reason, 'binding_invalid');
  assert.equal(store.confirm({ ...BINDING, rootRevision: -1, command: COMMAND }).reason, 'binding_invalid');
});

test('normalising fills the optional parts and keeps the exact text the owner confirmed', () => {
  const result = normalizeRunCommand({ program: 'C:\\Games\\Engine\\engine.exe' });
  assert.deepEqual(result, {
    ok: true,
    value: { build: '', program: 'C:\\Games\\Engine\\engine.exe', args: [], cwd: '', env: {}, watch: [] },
  });
  const spaced = normalizeRunCommand({ program: ' game.exe ', args: [' two  spaces '] });
  assert.equal(spaced.value.program, ' game.exe ');
  assert.deepEqual(spaced.value.args, [' two  spaces ']);
  assert.equal(normalizeRunCommand({ program: 'g.exe', cwd: 'game/bin' }).value.cwd, 'game/bin');
});

test('correctness review 9: on Windows a program with a root but no drive or share is refused when it is confirmed', (t) => {
  const windows = createRunCommandStore({ userDataPath: tempDir(t), platform: 'win32' });
  for (const program of ['\\tools\\x.exe', '/tools/x.exe']) {
    assert.equal(windows.confirm({ ...BINDING, command: { ...COMMAND, program } }).reason, 'program_not_anchored', program);
  }
  for (const program of ['C:\\tools\\x.exe', '\\\\server\\share\\x.exe', '//server/share/x.exe', 'bin\\x.exe']) {
    assert.equal(windows.confirm({ ...BINDING, command: { ...COMMAND, program } }).ok, true, program);
  }
  const linux = createRunCommandStore({ userDataPath: tempDir(t), platform: 'linux' });
  assert.equal(linux.confirm({ ...BINDING, command: { ...COMMAND, program: '/usr/bin/x' } }).ok, true);
});

test('L2: a saved Windows program with a root but no drive or share is refused again before it starts', { skip: process.platform !== 'win32' }, (t) => {
  const { resolveLaunch } = require('../services/run-view/build-step');
  const root = tempDir(t);
  const check = (program) => resolveLaunch({ program, cwd: '' }, root, { requireProgram: false, platform: 'win32' });
  assert.deepEqual(check('\\Windows\\x.exe'), { reason: 'program_not_anchored' });
  assert.deepEqual(check('/Windows/x.exe'), { reason: 'program_not_anchored' });
  assert.equal(check('C:\\tools\\x.exe').launch.program, 'C:\\tools\\x.exe');
  assert.equal(check('\\\\server\\share\\x.exe').launch.program, '\\\\server\\share\\x.exe');
  assert.equal(check('//server/share/x.exe').reason, undefined);
});

test('a store written by a newer Jenny is read as empty and never overwritten', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, RUN_COMMANDS_FILENAME);
  const newer = `${JSON.stringify({ version: RUN_COMMAND_SCHEMA_VERSION + 1, commands: {} })}\n`;
  fs.writeFileSync(file, newer);
  const store = createRunCommandStore({ userDataPath: dir });
  assert.deepEqual(store.get(BINDING), { status: 'none' });
  assert.equal(store.confirm({ ...BINDING, command: COMMAND }).reason, 'store_newer');
  assert.equal(store.invalidateAll('restore').reason, 'store_newer');
  assert.equal(fs.readFileSync(file, 'utf8'), newer);
});

test('a damaged file reads as empty and the next confirm replaces it', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, RUN_COMMANDS_FILENAME);
  fs.writeFileSync(file, '{"version": 1, "commands": ');
  const store = createRunCommandStore({ userDataPath: dir });
  assert.deepEqual(store.get(BINDING), { status: 'none' });
  assert.equal(store.confirm({ ...BINDING, command: COMMAND }).ok, true);
  assert.equal(createRunCommandStore({ userDataPath: dir }).get(BINDING).status, 'confirmed');
  // An entry that does not validate is dropped, not trusted.
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.commands['proj-1'].command.env = { NODE_OPTIONS: '--inspect' };
  fs.writeFileSync(file, JSON.stringify(doc));
  assert.deepEqual(createRunCommandStore({ userDataPath: dir }).get(BINDING), { status: 'none' });
});

test('the store holds a bounded number of projects', (t) => {
  const store = createRunCommandStore({ userDataPath: tempDir(t), maxProjects: 2 });
  assert.equal(store.confirm({ ...BINDING, projectId: 'a', command: COMMAND }).ok, true);
  assert.equal(store.confirm({ ...BINDING, projectId: 'b', command: COMMAND }).ok, true);
  assert.equal(store.confirm({ ...BINDING, projectId: 'c', command: COMMAND }).reason, 'too_many_projects');
  assert.equal(store.confirm({ ...BINDING, projectId: 'a', command: COMMAND }).ok, true, 'replacing is fine');
});

test('the model cannot write the command: no tool or sidecar file names the store', () => {
  const root = path.join(__dirname, '..');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__pycache__' && entry.name !== 'node_modules') walk(full);
      } else if (/\.(js|py|json)$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes('run-command-store')) {
        offenders.push(path.relative(root, full));
      }
    }
  };
  for (const dir of ['services/tools', 'sidecar']) {
    if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
  }
  assert.deepEqual(offenders, []);
});
