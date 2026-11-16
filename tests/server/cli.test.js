'use strict';

// server/cli.js: argument parsing for every command and the three team
// commands of slice 1h (team-keygen, team-init, team-recover) end to end
// through runCli and main. owner-init and import-conversations: parsing and the
// refusal of the other mode's config or profile; the rest of their behaviour is
// covered by the host suites that call them.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const path = require('node:path');

const { loadHostConfig } = require('../../server/config');
const { initializeOwner, main, parseCliArgs, runCli, usage } = require('../../server/cli');
const { MEMBERS_FILE } = require('../../server/team/member-store');
const {
  createOutputStream: stream, createTeamHostFixture, randomKey, writeSingleOwnerConfig,
} = require('./helpers/team-host-fixture');

const NO_INTERFACES = () => ({});

test('the owner commands parse as before', () => {
  assert.deepEqual(parseCliArgs(['owner-init', '--config', '/etc/jenny/host.json']),
    { command: 'owner-init', configPath: '/etc/jenny/host.json' });
  assert.deepEqual(parseCliArgs(['owner-init', '-c', '/h.json', '--python', '/usr/bin/python3']),
    { command: 'owner-init', configPath: '/h.json', pythonExecutable: '/usr/bin/python3' });
  assert.deepEqual(parseCliArgs(['import-conversations', '--archive', '/a.archive', '--config', '/h.json']),
    { command: 'import-conversations', configPath: '/h.json', archivePath: '/a.archive' });
  assert.throws(() => parseCliArgs(['import-conversations', '--config', '/h.json']), /Import requires --archive/u);
  assert.throws(() => parseCliArgs(['owner-init', '--archive', '/a', '--config', '/h.json']), /Import requires --archive/u);
  assert.deepEqual(parseCliArgs(['--help']), { help: true });
  assert.throws(() => parseCliArgs(['--config', '/h.json']), /command is required/u);
  assert.throws(() => parseCliArgs(['owner-init']), /--config path is required/u);
  assert.throws(() => parseCliArgs(['owner-init', '--bogus']), /Unknown CLI argument/u);
  assert.throws(() => parseCliArgs('owner-init'), TypeError);
});

test('the team commands take only --config', () => {
  for (const command of ['team-keygen', 'team-init', 'team-recover']) {
    assert.deepEqual(parseCliArgs([command, '--config', '/h.json']), { command, configPath: '/h.json' });
    assert.throws(() => parseCliArgs([command]), /--config path is required/u);
    assert.throws(() => parseCliArgs([command, '--config', '/h.json', '--archive', '/a']), /only --config/u);
    assert.throws(() => parseCliArgs([command, '--config', '/h.json', '--python', '/p']), /only --config/u);
    assert.throws(() => parseCliArgs([command, 'owner-init', '--config', '/h.json']), /Only one/u);
    // No argument can carry a key or an invite: anything else is unknown.
    assert.throws(() => parseCliArgs([command, '--config', '/h.json', '--key', 'abc']), /Unknown CLI argument/u);
  }
  const text = usage();
  for (const command of ['owner-init', 'import-conversations', 'team-keygen', 'team-init', 'team-recover']) {
    assert.equal(text.includes(command), true, command);
  }
});

test('team-keygen writes the key file and prints the team id only', async (t) => {
  const fx = createTeamHostFixture(t, { writeKey: false });
  const out = stream();
  const err = stream();
  const result = await runCli(['team-keygen', '--config', fx.configPath], { confirmOutput: out, errorOutput: err });
  assert.equal(result.ok, true);
  const key = fs.readFileSync(fx.keyFile, 'utf8').trim();
  assert.match(out.text(), new RegExp(result.team_id, 'u'));
  assert.equal(out.text().includes(key), false);
  assert.equal(err.text(), '');

  const again = await runCli(['team-keygen', '--config', fx.configPath], { confirmOutput: out, errorOutput: err });
  assert.deepEqual(again, { ok: false, reason: 'team_host_key_exists' });
  assert.match(err.text(), /team_host_key_exists/u);
  assert.equal(err.text().includes(key), false);
  assert.equal(fs.readFileSync(fx.keyFile, 'utf8').trim(), key);
});

test('team-init and team-recover print the invite on the terminal through runCli', async (t) => {
  const fx = createTeamHostFixture(t);
  const deps = (extra = {}) => ({ acquireProfileImpl: fx.acquireProfileImpl, networkInterfaces: NO_INTERFACES,
    errorOutput: stream(), logger: () => {}, ...extra });

  const tty = stream({ isTTY: true });
  const init = await runCli(['team-init', '--config', fx.configPath], deps({ confirmOutput: tty }));
  assert.equal(init.ok, true);
  assert.equal((tty.text().match(/jteam1_[A-Za-z0-9_-]+/gu) ?? []).length, 1);
  assert.equal(JSON.stringify(init).includes('jteam1_'), false);

  // Nobody redeemed it, so the team is still empty and a second first-owner invite may be minted.
  assert.equal((await runCli(['team-init', '--config', fx.configPath],
    deps({ confirmOutput: stream({ isTTY: true }) }))).ok, true);

  // A team with an owner: init refuses, recovery mints.
  const other = createTeamHostFixture(t);
  await other.seedMembers(randomKey());
  const again = { ...deps({ confirmOutput: stream({ isTTY: true }) }), acquireProfileImpl: other.acquireProfileImpl };
  assert.deepEqual(await runCli(['team-init', '--config', other.configPath], again),
    { ok: false, reason: 'team_member_state_invalid' });
  assert.match(again.errorOutput.text(), /team-init refused: team_member_state_invalid/u);
  assert.equal(again.confirmOutput.text(), '');
  const recoverTty = stream({ isTTY: true });
  const recover = await runCli(['team-recover', '--config', other.configPath],
    { ...deps({ confirmOutput: recoverTty }), acquireProfileImpl: other.acquireProfileImpl });
  assert.equal(recover.ok, true);
  assert.equal((recoverTty.text().match(/jteam1_[A-Za-z0-9_-]+/gu) ?? []).length, 1);
  assert.match(recoverTty.text(), /no address hints/iu);
});

test('a piped output and a single-owner config are refused with a plain line and exit code 1', async (t) => {
  const fx = createTeamHostFixture(t);
  await fx.seedMembers(randomKey());
  const piped = stream({ isTTY: false });
  const err = stream();
  const code = await main(['team-recover', '--config', fx.configPath],
    { confirmOutput: piped, errorOutput: err, acquireProfileImpl: fx.acquireProfileImpl, logger: () => {} });
  assert.equal(code, 1);
  assert.equal(piped.text(), '');
  assert.match(err.text(), /team_tty_required/u);
  assert.equal(fx.lock.acquired, 0);

  const single = writeSingleOwnerConfig(fx.root);
  const err2 = stream();
  const refused = await main(['team-init', '--config', single],
    { confirmOutput: stream({ isTTY: true }), errorOutput: err2, acquireProfileImpl: fx.acquireProfileImpl });
  assert.equal(refused, 1);
  assert.match(err2.text(), /team_config_required/u);

  const err3 = stream();
  assert.equal(await main(['team-init'], { errorOutput: err3 }), 1);
  assert.match(err3.text(), /Usage:/u);
});

test('owner-init refuses a team config and writes no auth.json', async (t) => {
  const fx = createTeamHostFixture(t);
  const config = loadHostConfig(fx.configPath);
  let prompted = 0;
  const refused = await initializeOwner({ config, acquireProfileImpl: fx.acquireProfileImpl,
    readPasswordImpl: async () => { prompted += 1; return 'unused'; }, confirmOutput: stream() });
  assert.deepEqual(refused, { ok: false, code: 'CMP-HOST-0004', reason: 'invalid_host_profile' });
  assert.equal(prompted, 0);
  assert.equal(fx.lock.acquired, 0);
  assert.equal(fs.existsSync(path.join(fx.profile, 'auth.json')), false);
  const err = stream();
  assert.equal(await main(['owner-init', '--config', fx.configPath], { errorOutput: err,
    acquireProfileImpl: fx.acquireProfileImpl, readPasswordImpl: async () => 'unused', confirmOutput: stream() }), 1);
  assert.match(err.text(), /owner-init refused: invalid_host_profile/u);
  assert.equal(fs.existsSync(path.join(fx.profile, 'auth.json')), false);
});

test('team-init refuses a single-owner profile that holds auth.json and creates no member store', async (t) => {
  const fx = createTeamHostFixture(t);
  fs.mkdirSync(fx.profile, { recursive: true });
  fs.writeFileSync(path.join(fx.profile, 'auth.json'), '{}');
  const tty = stream({ isTTY: true });
  const refused = await runCli(['team-init', '--config', fx.configPath], { acquireProfileImpl: fx.acquireProfileImpl,
    networkInterfaces: NO_INTERFACES, errorOutput: stream(), logger: () => {}, confirmOutput: tty });
  // recovery.js maps every acquisition refusal other than a busy lock to team_unavailable.
  assert.deepEqual(refused, { ok: false, reason: 'team_unavailable' });
  assert.equal(tty.text(), '');
  assert.equal(fs.existsSync(path.join(fx.profile, MEMBERS_FILE)), false);
  assert.equal(fx.lock.acquired, fx.lock.released);
});

// A single-owner config pointed at a profile a team host holds (its member store is there), with a
// counting lock.
function singleOwnerOnTeamProfile(fx) {
  const configPath = writeSingleOwnerConfig(fx.root);
  const profile = path.join(fx.root, 'single-profile');
  fs.writeFileSync(path.join(profile, MEMBERS_FILE), '{}');
  const lock = { acquired: 0, released: 0 };
  const acquireProfileImpl = () => { lock.acquired += 1; return { release() { lock.released += 1; } }; };
  return { configPath, profile, lock, acquireProfileImpl };
}

test('owner-init with a single-owner config on a team profile is refused under the lock and writes no auth.json', async (t) => {
  const single = singleOwnerOnTeamProfile(createTeamHostFixture(t));
  let prompted = 0;
  const err = stream();
  const code = await main(['owner-init', '--config', single.configPath], { errorOutput: err,
    acquireProfileImpl: single.acquireProfileImpl, confirmOutput: stream(),
    readPasswordImpl: async () => { prompted += 1; return 'unused-password'; } });
  assert.equal(code, 1);
  assert.match(err.text(), /owner-init refused: invalid_host_profile/u);
  assert.equal(prompted, 0);
  assert.deepEqual(single.lock, { acquired: 1, released: 1 });
  assert.equal(fs.existsSync(path.join(single.profile, 'auth.json')), false);
  const refused = await initializeOwner({ config: loadHostConfig(single.configPath),
    acquireProfileImpl: single.acquireProfileImpl, confirmOutput: stream() });
  assert.deepEqual(refused, { ok: false, code: 'CMP-HOST-0004', reason: 'invalid_host_profile' });
  assert.deepEqual(single.lock, { acquired: 2, released: 2 });
});

test('import-conversations refuses a team config before the lock and a team profile under it; nothing is imported', async (t) => {
  const fx = createTeamHostFixture(t);
  const archive = ['--archive', path.join(fx.root, 'none.archive')];
  let prompted = 0;
  const readPasswordImpl = async () => { prompted += 1; return ''; };
  const err = stream();
  assert.equal(await main(['import-conversations', ...archive, '--config', fx.configPath],
    { errorOutput: err, acquireProfileImpl: fx.acquireProfileImpl, readPasswordImpl, confirmOutput: stream() }), 1);
  assert.match(err.text(), /import-conversations refused: invalid_host_profile/u);
  assert.equal(fx.lock.acquired, 0, 'no lock taken, nothing composed');

  const single = singleOwnerOnTeamProfile(fx);
  const before = fs.readdirSync(single.profile).sort();
  const err2 = stream();
  const out = stream();
  const refused = await runCli(['import-conversations', ...archive, '--config', single.configPath],
    { errorOutput: err2, acquireProfileImpl: single.acquireProfileImpl, readPasswordImpl, confirmOutput: out });
  assert.deepEqual(refused, { ok: false, code: 'CMP-HOST-0004', reason: 'invalid_host_profile' });
  assert.match(err2.text(), /import-conversations refused: invalid_host_profile/u);
  assert.deepEqual(single.lock, { acquired: 1, released: 1 });
  assert.equal(prompted, 0);
  assert.equal(out.text(), '');
  assert.deepEqual(fs.readdirSync(single.profile).sort(), before, 'nothing imported');
});

// ---------------------------------------------------------------- slices 3-13 and 3-14: the maintenance commands

const MAINTENANCE = Object.freeze({
  'team-copy-in': ['--project', 'project_abc', '--folder', 'Drop'], 'team-export': [],
  'team-restore': ['--file', 'team.jennyteam'], 'team-delete': [],
});
const BAD_NAMES = ['a/b', 'a\\b', '..', 'con', 'aux.txt', 'x.', 'a:b', 'x'.repeat(256)];

test('3-13/3-14: each maintenance command takes exactly its closed flags, each once', () => {
  for (const [command, flags] of Object.entries(MAINTENANCE)) {
    const base = [command, '--config', '/h.json'];
    const parsed = parseCliArgs([...base, ...flags]);
    assert.equal(parsed.command, command);
    assert.throws(() => parseCliArgs([command, ...flags]), /--config path is required/u);
    assert.throws(() => parseCliArgs([...base, ...flags, '--archive', '/a']), /only --config/u, `${command} extra`);
    assert.throws(() => parseCliArgs([...base, ...flags, '--python', '/usr/bin/python3']), /only --config/u, `${command} --python`);
    assert.throws(() => parseCliArgs([...base, ...flags, '--key', 'abc']), /Unknown CLI argument/u);
    const foreign = command === 'team-restore' ? ['--folder', 'Drop'] : ['--file', 'x.jennyteam'];
    assert.throws(() => parseCliArgs([...base, ...flags, ...foreign]), /only --config/u, `${command} foreign flag`);
    if (flags.length) {
      assert.throws(() => parseCliArgs([...base, ...flags, flags[0], flags[1]]), /A single/u, `${command} repeated`);
      assert.throws(() => parseCliArgs([...base, ...flags.slice(0, -1)]), /A single/u, `${command} value missing`);
      assert.throws(() => parseCliArgs([...base, ...flags.slice(2)]), /only --config/u, `${command} flag missing`);
    }
  }
  assert.deepEqual(parseCliArgs(['team-copy-in', '--folder', 'Drop', '--project', 'project_abc', '-c', '/h.json']),
    { command: 'team-copy-in', configPath: '/h.json', project: 'project_abc', folder: 'Drop' });
  assert.deepEqual(parseCliArgs(['team-restore', '--file', 'team.jennyteam', '--config', '/h.json']),
    { command: 'team-restore', configPath: '/h.json', file: 'team.jennyteam' });
  assert.throws(() => parseCliArgs(['team-copy-in', '--project', '../p', '--folder', 'Drop', '--config', '/h.json']), /project id/u);
  // The project store's own id rule (up to 128 characters after the prefix), not a narrower copy.
  const long = `project_${'a'.repeat(128)}`;
  assert.equal(parseCliArgs(['team-copy-in', '--project', long, '--folder', 'Drop', '--config', '/h.json']).project, long);
  for (const bad of [`project_${'a'.repeat(129)}`, ' project_abc', 'project_abc ']) {
    assert.throws(() => parseCliArgs(['team-copy-in', '--project', bad, '--folder', 'Drop', '--config', '/h.json']), /project id/u);
  }
  assert.throws(() => parseCliArgs(['owner-init', '--file', 'x', '--config', '/h.json']), /Unknown CLI argument/u);
  for (const name of BAD_NAMES) {
    for (const [flag, argv] of [['--folder', ['team-copy-in', '--project', 'project_abc']], ['--file', ['team-restore']]]) {
      let message = '';
      try { parseCliArgs([...argv, flag, name, '--config', '/h.json']); } catch (error) { message = error.message; }
      assert.match(message, /one plain name/u, `${flag} ${name}`);
      assert.equal(message.includes(name), false, 'the refusal never echoes the name');
    }
  }
  const text = usage();
  for (const command of Object.keys(MAINTENANCE)) assert.equal(text.includes(command), true, command);
});

// A prompt stream that types the next answer once a prompt (text ending in ": ") is written.
function autoTyper(input, answers) {
  const prompt = stream({ isTTY: true });
  const write = prompt.write.bind(prompt);
  prompt.write = (text) => {
    write(text);
    if (/: $/u.test(String(text)) && answers.length) setImmediate(() => input.write(`${answers.shift()}\r`));
    return true;
  };
  return prompt;
}

test('3-13/3-14: no terminal refuses export, restore and delete before the lock; a held lock refuses all four', async (t) => {
  const { createMaintenanceFixture, ttyInput } = require('./helpers/team-maintenance-fixture');
  const { HOST_ERROR_CODES } = require('../../services/backend/error-codes');
  const fx = createMaintenanceFixture(t);
  for (const command of ['team-export', 'team-restore', 'team-delete']) {
    const err = stream();
    const result = await runCli([command, ...MAINTENANCE[command], '--config', fx.configPath],
      { input: { isTTY: false }, promptOutput: stream({ isTTY: true }), errorOutput: err, confirmOutput: stream(),
        acquireProfileImpl: fx.acquireProfileImpl, logger: () => {} });
    assert.deepEqual(result, { ok: false, reason: 'team_tty_required' }, command);
    assert.equal(err.text(), `${command} refused: team_tty_required\n`);
  }
  assert.equal(fx.lock.acquired, 0);
  const held = () => { throw Object.assign(new Error('locked'), { code: HOST_ERROR_CODES.CONFLICT, reason: 'profile_locked' }); };
  for (const [command, flags] of Object.entries(MAINTENANCE)) {
    const result = await runCli([command, ...flags, '--config', fx.configPath], { input: ttyInput(),
      promptOutput: stream({ isTTY: true }), errorOutput: stream(), confirmOutput: stream(), acquireProfileImpl: held,
      logger: () => {} });
    assert.deepEqual(result, { ok: false, reason: 'team_profile_locked' }, command);
  }
});

test('3-13/3-14: copy-in, export, delete and restore through runCli print no path, name, key or password', async (t) => {
  const { PASSWORD, createMaintenanceFixture, ttyInput } = require('./helpers/team-maintenance-fixture');
  const fx = createMaintenanceFixture(t);
  const team = await fx.seedTeam();
  const folder = 'Folder-Marker-7c1';
  fs.mkdirSync(path.join(fx.importDir, folder));
  fs.writeFileSync(path.join(fx.importDir, folder, 'file-marker-3d9.txt'), 'body');
  const out = stream();
  const err = stream();
  const logs = [];
  const prompts = [];
  const deps = (answers) => {
    const input = ttyInput();
    const promptOutput = autoTyper(input, answers);
    prompts.push(promptOutput);
    return { input, promptOutput, confirmOutput: out, errorOutput: err, acquireProfileImpl: fx.acquireProfileImpl,
      logger: (...entry) => logs.push(entry) };
  };
  const ok = async (argv, answers = []) => {
    const result = await runCli([...argv, '--config', fx.configPath], deps(answers));
    assert.equal(result.ok, true, `${argv[0]} ${JSON.stringify(result)}`);
  };
  await ok(['team-copy-in', '--project', team.projectId, '--folder', folder]);
  await ok(['team-export'], [PASSWORD, PASSWORD]);
  const [file] = fs.readdirSync(fx.exchangeDir);
  await ok(['team-delete'], [fx.teamName]);
  await ok(['team-restore', '--file', file], [PASSWORD]);
  assert.equal(fs.readFileSync(fx.keyFile, 'utf8'), `${fx.hostKey}\n`);
  assert.equal(fs.existsSync(path.join(fx.projects, team.projectId, folder, 'file-marker-3d9.txt')), true);
  const markers = [folder, 'file-marker-3d9', file, PASSWORD, fx.hostKey, fx.root, 'jteam1_'];
  for (const [where, text] of [['stdout', out.text()], ['stderr', err.text()], ['log', JSON.stringify(logs)]]) {
    for (const marker of markers) assert.equal(text.includes(marker), false, `${where} ${marker}`);
    assert.equal(text.includes(fx.teamName), false, `${where} team name`);
  }
  // The prompt stream (standard error on a terminal) shows the prompts and the typed team name only.
  const promptText = prompts.map((prompt) => prompt.text()).join('');
  for (const marker of markers) assert.equal(promptText.includes(marker), false, `prompt ${marker}`);
});

test('3-13/3-14: every new command module loads with electron unresolvable and never loads the secure store', () => {
  const { spawnSync } = require('node:child_process');
  const script = [
    "const Module = require('node:module');",
    'const resolve = Module._resolveFilename;',
    'Module._resolveFilename = function (request, ...rest) {',
    "  if (request === 'electron') throw Object.assign(new Error('no electron'), { code: 'MODULE_NOT_FOUND' });",
    '  return resolve.call(this, request, ...rest);',
    '};',
    "for (const name of ['team-copy-in', 'team-export', 'team-restore', 'team-delete', 'team-maintenance', 'tty-input']) {",
    "  require('./server/team/' + name);",
    '}',
    "const loaded = Object.keys(require.cache).map((file) => file.split(require('node:path').sep).join('/'));",
    'const banned = loaded.filter((file) => /secure-store|safe-storage|host-key-store|host-launch|host-controller|host-lifecycle/.test(file));',
    // The CLI itself loads too (its owner commands' composition brings the store module, never electron).
    "require('./server/cli');",
    'process.stdout.write(JSON.stringify({ banned }));',
  ].join('\n');
  const child = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { banned: [] });
});

test('3-13/3-14: the maintenance lock gives host-core acquireConfiguredProfile\'s answers and awaits the release', async (t) => {
  const { acquireConfiguredProfile } = require('../../server/host-core');
  const { lockProfile } = require('../../server/team/team-maintenance');
  const { createMaintenanceFixture } = require('./helpers/team-maintenance-fixture');
  const fx = createMaintenanceFixture(t);
  const answers = async (acquire) => {
    const seen = [];
    let released = false;
    const acquireProfileImpl = (input) => {
      seen.push({ userDataPath: input.userDataPath, pythonExecutable: input.pythonExecutable });
      // An asynchronous release, as the Windows pipe lock's is.
      return { release: () => new Promise((resolve) => setImmediate(() => { released = true; resolve(); })) };
    };
    try {
      const { config } = await acquire(acquireProfileImpl);
      return { ok: true, profile: config.userDataPath, seen };
    } catch (error) {
      return { ok: false, reason: error.reason ?? error.message, seen, released };
    }
  };
  const viaCore = (impl) => acquireConfiguredProfile(fx.configPath, { acquireProfileImpl: impl });
  const viaMaintenance = (impl) => lockProfile(fx.configPath, impl);
  assert.deepEqual(await answers(viaMaintenance), await answers(viaCore), 'a team profile');
  fs.writeFileSync(path.join(fx.profile, 'auth.json'), '{}');
  const core = await answers(viaCore);
  const maintenance = await answers(viaMaintenance);
  assert.equal(maintenance.reason, 'invalid_host_profile');
  assert.deepEqual({ ...maintenance, released: undefined }, { ...core, released: undefined }, 'a single-owner profile');
  assert.equal(maintenance.released, true, 'the release finished before the refusal returned');
});
