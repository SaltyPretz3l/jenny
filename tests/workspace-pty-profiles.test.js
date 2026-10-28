'use strict';

/* Row 82 slice T2: Workspace terminal shell profiles and the start folder.
 * detectProfiles is file-presence only (injected existsSync, no process probe);
 * spawnCandidates puts the requested profile first, then the platform default
 * chain, and keeps the bare-name fallback when nothing is detected;
 * resolveContainedCwd refuses absolute paths, '..' escapes, junctions that leave
 * the root, missing folders and files. The service half pins listProfiles (ids and
 * labels only, never paths), spawn's profileId and cwd, and CMP-TERMINAL-0005.
 * Uses a fake pty module - no native ConPTY is launched. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  detectProfiles,
  defaultProfileId,
  spawnCandidates,
  resolveContainedCwd,
} = require('../services/workspace-pty-profiles');
const { WorkspacePtyService } = require('../services/workspace-pty-service');
const { TERMINAL_ERROR_CODES } = require('../services/backend/error-codes');

const WIN_ENV = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  PATH: 'C:\\Tools;"C:\\Quoted Dir"',
};

function existsFrom(files) {
  const set = new Set(files.map((file) => file.toLowerCase()));
  return (file) => set.has(String(file).toLowerCase());
}

test('detectProfiles (win32) lists only the shells whose executable exists, PowerShell without -NoProfile', () => {
  const profiles = detectProfiles({
    platform: 'win32',
    env: WIN_ENV,
    existsSync: existsFrom([
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\Windows\\System32\\cmd.exe',
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Quoted Dir\\pwsh.exe',
    ]),
  });
  assert.deepEqual(profiles.map((profile) => profile.id), ['pwsh', 'powershell', 'cmd', 'git-bash']);
  const byId = Object.fromEntries(profiles.map((profile) => [profile.id, profile]));
  assert.equal(byId.pwsh.file, 'C:\\Quoted Dir\\pwsh.exe', 'a quoted PATH entry is unquoted');
  assert.deepEqual(byId.powershell.args, ['-NoLogo']);
  assert.deepEqual(byId.pwsh.args, ['-NoLogo']);
  assert.deepEqual(byId['git-bash'].args, ['--login', '-i']);
  assert.equal(defaultProfileId(profiles, 'win32'), 'powershell');
});

test('detectProfiles (posix) finds bash/zsh/fish on PATH or the standard dirs', () => {
  const profiles = detectProfiles({
    platform: 'linux',
    env: { PATH: '/home/u/.local/bin:/usr/bin' },
    existsSync: (file) => file === '/usr/bin/bash' || file === '/home/u/.local/bin/fish',
  });
  assert.deepEqual(profiles.map((profile) => [profile.id, profile.file]), [['bash', '/usr/bin/bash'], ['fish', '/home/u/.local/bin/fish']]);
  assert.equal(defaultProfileId(profiles, 'linux'), 'bash');
  assert.equal(defaultProfileId([], 'linux'), '');
});

test('detectProfiles treats a throwing existsSync as absent', () => {
  const profiles = detectProfiles({ platform: 'win32', env: WIN_ENV, existsSync: () => { throw new Error('EACCES'); } });
  assert.deepEqual(profiles, []);
});

test('T2: two spawns probe existsSync once (detection is cached per process)', async (t) => {
  const probed = [];
  const realExists = fs.existsSync;
  fs.existsSync = (file) => { probed.push(String(file)); return String(file).toLowerCase() === 'c:\\windows\\system32\\cmd.exe'; };
  t.after(() => { fs.existsSync = realExists; });
  const spawns = [];
  const service = new WorkspacePtyService({
    configService: { getToolsWorkspaceRoot: () => 'G:/fake-root' },
    sendBridgeEvent: () => {},
    ptyModuleLoader: () => ({ spawn: (shell) => { spawns.push(shell); return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} }; } }),
    env: { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe', PATH: 'C:\\Tools' },
    logger: () => {},
    platform: 'win32',
  });
  await service.spawn({ cols: 80, rows: 24, slot: 1 });
  const afterFirst = probed.length;
  assert.ok(afterFirst > 0, 'the first spawn probes the disk');
  await service.spawn({ cols: 80, rows: 24, slot: 2 });
  assert.equal(probed.length, afterFirst, 'the second spawn reuses the cached detection');
  assert.deepEqual(spawns, ['C:\\Windows\\System32\\cmd.exe', 'C:\\Windows\\System32\\cmd.exe']);
});

test('T2: the cache refreshes on request and after 60 s', () => {
  let probes = 0;
  let clock = 1000;
  const opts = { platform: 'linux', env: { PATH: '/usr/bin' }, existsSync: (file) => { probes += 1; return file === '/usr/bin/bash'; }, now: () => clock };
  assert.deepEqual(detectProfiles(opts).map((p) => p.id), ['bash']);
  const once = probes;
  detectProfiles(opts);
  assert.equal(probes, once, 'a second call inside 60 s is served from the cache');
  detectProfiles({ ...opts, refresh: true });
  assert.equal(probes, once * 2, 'refresh (the profile menu opening) probes again');
  clock += 60001;
  detectProfiles(opts);
  assert.equal(probes, once * 3, 'an entry older than 60 s probes again');
});

test('T2: a UNC PATH entry is never probed', () => {
  const probed = [];
  detectProfiles({
    platform: 'win32',
    env: { ...WIN_ENV, PATH: '\\\\server\\share\\bin;//server/other;C:\\Tools' },
    existsSync: (file) => { probed.push(String(file)); return false; },
  });
  assert.ok(probed.some((file) => file.startsWith('C:\\Tools')), 'local PATH entries are probed');
  assert.deepEqual(probed.filter((file) => /^(\\\\|\/\/)/.test(file)), [], 'no network path is touched');
});

test('spawnCandidates: requested profile first, then the default chain; unknown ids fall back', () => {
  const profiles = [
    { id: 'powershell', label: 'Windows PowerShell', file: 'C:\\ps.exe', args: ['-NoLogo'] },
    { id: 'cmd', label: 'Command Prompt', file: 'C:\\cmd.exe', args: [] },
    { id: 'git-bash', label: 'Git Bash', file: 'C:\\bash.exe', args: ['--login', '-i'] },
  ];
  assert.deepEqual(spawnCandidates(profiles, 'git-bash', 'win32').map((c) => c.profileId), ['git-bash', 'powershell', 'cmd']);
  assert.deepEqual(spawnCandidates(profiles, 'cmd', 'win32').map((c) => c.profileId), ['cmd', 'powershell']);
  assert.deepEqual(spawnCandidates(profiles, 'C:\\evil.exe', 'win32').map((c) => c.profileId), ['powershell', 'cmd']);
  assert.deepEqual(spawnCandidates(profiles, '', 'win32')[0], { profileId: 'powershell', file: 'C:\\ps.exe', args: ['-NoLogo'] });
  assert.deepEqual(spawnCandidates([], 'pwsh', 'linux'), [{ profileId: 'bash', file: 'bash', args: ['-i'] }]);
});

function makeTree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-pty-cwd-'));
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'README.md'), 'x');
  let linked = false;
  try {
    fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
    linked = true;
  } catch (_error) {
    /* no junction or symlink support on this box: the escape case is skipped */
  }
  return { base, root, outside, linked };
}

test('resolveContainedCwd accepts folders inside the root and refuses everything else', async (t) => {
  const { base, root, linked } = makeTree();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const rootReal = fs.realpathSync(root);

  assert.deepEqual(await resolveContainedCwd(root, ''), { ok: true, cwd: rootReal });
  assert.deepEqual(await resolveContainedCwd(root, 'src/deep'), { ok: true, cwd: path.join(rootReal, 'src', 'deep') });
  assert.deepEqual(await resolveContainedCwd(root, '.\\src'), { ok: true, cwd: path.join(rootReal, 'src') });
  fs.mkdirSync(path.join(root, '..dots'));
  assert.deepEqual(await resolveContainedCwd(root, '..dots'), { ok: true, cwd: path.join(rootReal, '..dots') }, 'a folder whose name starts with .. is inside');
  assert.equal((await resolveContainedCwd(root, '../outside')).reason, 'path_outside_workspace');
  assert.equal((await resolveContainedCwd(root, 'src/../../outside')).reason, 'path_outside_workspace');
  assert.equal((await resolveContainedCwd(root, '/etc')).reason, 'path_outside_workspace');
  assert.equal((await resolveContainedCwd(root, 'C:\\Windows')).reason, 'path_outside_workspace');
  assert.equal((await resolveContainedCwd(root, 'missing')).reason, 'not_found');
  assert.equal((await resolveContainedCwd(root, 'README.md')).reason, 'not_a_directory');
  assert.equal((await resolveContainedCwd(root, 'a\0b')).reason, 'invalid_path');
  assert.equal((await resolveContainedCwd(path.join(base, 'no-root'), '')).reason, 'root_unreadable');
  if (linked) {
    assert.equal((await resolveContainedCwd(root, 'escape')).reason, 'path_outside_workspace', 'a junction out of the root is refused');
  }
});

function createService({ root, profiles = [], platform = 'win32' } = {}) {
  const spawns = [];
  const service = new WorkspacePtyService({
    configService: { getToolsWorkspaceRoot: () => root },
    sendBridgeEvent: () => {},
    ptyModuleLoader: () => ({
      spawn: (shell, args, opts) => {
        spawns.push({ shell, args, opts });
        return { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} };
      },
    }),
    env: { PATH: 'C:/windows' },
    logger: () => {},
    platform,
    detectShellProfiles: () => profiles,
  });
  return { service, spawns };
}

const PROFILES = [
  { id: 'powershell', label: 'Windows PowerShell', file: 'C:\\ps.exe', args: ['-NoLogo'] },
  { id: 'git-bash', label: 'Git Bash', file: 'C:\\Git\\bin\\bash.exe', args: ['--login', '-i'] },
];

test('listProfiles returns ids and labels only, with the platform default', () => {
  const { service } = createService({ root: 'G:/fake-root', profiles: PROFILES });
  assert.deepEqual(service.listProfiles(), {
    ok: true,
    profiles: [{ id: 'powershell', label: 'Windows PowerShell' }, { id: 'git-bash', label: 'Git Bash' }],
    defaultId: 'powershell',
  });
  const failing = new WorkspacePtyService({
    configService: { getToolsWorkspaceRoot: () => '' },
    sendBridgeEvent: () => {},
    logger: () => {},
    detectShellProfiles: () => { throw new Error('boom'); },
  });
  assert.deepEqual(failing.listProfiles().profiles, []);
});

// Row 82 cleanup T2 (S4 wiring): the profile menu's listProfiles re-probes the disk; a
// spawn reads the per-process cache.
test('listProfiles asks the detector to refresh; spawn does not', async () => {
  const asks = [];
  const service = new WorkspacePtyService({
    configService: { getToolsWorkspaceRoot: () => '' },
    sendBridgeEvent: () => {},
    logger: () => {},
    detectShellProfiles: (opts) => { asks.push(opts || null); return PROFILES; },
  });
  service.listProfiles();
  assert.deepEqual(asks, [{ refresh: true }]);
  await service.spawn({ cols: 80, rows: 24, slot: 0 }).catch(() => null);
  assert.ok(asks.slice(1).every((opts) => !opts || opts.refresh !== true), JSON.stringify(asks));
});

test('spawn honours profileId and reports it; an unknown id uses the default', async () => {
  const { service, spawns } = createService({ root: 'G:/fake-root', profiles: PROFILES });
  const result = await service.spawn({ cols: 80, rows: 24, slot: 1, profileId: 'git-bash' });
  assert.equal(result.ok, true);
  assert.equal(result.profileId, 'git-bash');
  assert.deepEqual(spawns[0], { shell: 'C:\\Git\\bin\\bash.exe', args: ['--login', '-i'], opts: spawns[0].opts });
  const second = await service.spawn({ cols: 80, rows: 24, slot: 2, profileId: 'not-a-shell' });
  assert.equal(second.profileId, 'powershell');
  const reused = await service.spawn({ cols: 80, rows: 24, slot: 1 });
  assert.equal(reused.alreadyRunning, true);
  assert.equal(reused.profileId, 'git-bash');
});

test('spawn starts in a contained cwd and refuses an escaping one with CMP-TERMINAL-0005', async (t) => {
  const { base, root, linked } = makeTree();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { service, spawns } = createService({ root, profiles: PROFILES });

  const inside = await service.spawn({ cols: 80, rows: 24, slot: 1, cwd: 'src' });
  assert.equal(inside.ok, true);
  assert.equal(inside.cwd, path.join(fs.realpathSync(root), 'src'));
  assert.equal(spawns[0].opts.cwd, inside.cwd);

  const refused = await service.spawn({ cols: 80, rows: 24, slot: 2, cwd: '../outside' });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, TERMINAL_ERROR_CODES.CWD_OUTSIDE_ROOT);
  assert.equal(refused.code, 'CMP-TERMINAL-0005');
  assert.equal(refused.reason, 'path_outside_workspace');
  if (linked) {
    const viaJunction = await service.spawn({ cols: 80, rows: 24, slot: 3, cwd: 'escape' });
    assert.equal(viaJunction.code, 'CMP-TERMINAL-0005');
  }
  assert.equal(spawns.length, 1, 'a refused cwd never reaches the pty module');

  const plain = await service.spawn({ cols: 80, rows: 24, slot: 4 });
  assert.equal(plain.cwd, root, 'no cwd keeps the configured root');
});

test('two quick cwd spawns on one slot start one shell; a root switch mid-resolve refuses', async (t) => {
  const { base, root } = makeTree();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { service, spawns } = createService({ root, profiles: PROFILES });
  const [a, b] = await Promise.all([
    service.spawn({ cols: 80, rows: 24, slot: 1, cwd: 'src' }),
    service.spawn({ cols: 80, rows: 24, slot: 1, cwd: 'src' }),
  ]);
  assert.equal(spawns.length, 1);
  assert.equal([a, b].filter((result) => result.alreadyRunning).length, 1);

  let currentRoot = root;
  const switching = new WorkspacePtyService({
    configService: { getToolsWorkspaceRoot: () => currentRoot },
    sendBridgeEvent: () => {},
    ptyModuleLoader: () => ({ spawn: () => { throw new Error('must not spawn'); } }),
    logger: () => {},
    detectShellProfiles: () => PROFILES,
    fsPromises: {
      realpath: async (target) => { currentRoot = path.join(base, 'outside'); return fs.promises.realpath(target); },
      stat: (target) => fs.promises.stat(target),
    },
  });
  const stale = await switching.spawn({ cols: 80, rows: 24, slot: 1, cwd: 'src' });
  assert.equal(stale.code, 'CMP-TERMINAL-0005');
  assert.equal(stale.reason, 'root_changed');
});
