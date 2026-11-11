'use strict';

// server/cli.js: argument parsing for every command and the three team
// commands of slice 1h (team-keygen, team-init, team-recover) end to end
// through runCli and main. owner-init and import-conversations keep their
// parsing; their behaviour is covered by the host suites that call them.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { main, parseCliArgs, runCli, usage } = require('../../server/cli');
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
