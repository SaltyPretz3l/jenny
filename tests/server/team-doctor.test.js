'use strict';

// new-test-file: `node server/cli.js team-doctor` is a new surface (slice 3-11, decision E4): the checks a
// headless team host can run. The Docker setup doctor (server/setup.js) does not understand a team config.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { writeReadyMarker } = require('../../server/team/ready-marker');
const { createOutputStream: sink, createTeamHostFixture, writeSingleOwnerConfig } = require('./helpers/team-host-fixture');

const doctor = (options) => require('../../server/team/team-doctor').runTeamDoctor(options);
const bridgeOk = { resolveBinary: () => '/app/build/sidecar/jenny-team-bridge',
  probeBridge: async () => ({ ok: true, line: 'jenny-team-bridge protocol 1', protocol: 1 }) };

function headless(t) {
  const fx = createTeamHostFixture(t);
  const projectsRoot = path.join(fs.realpathSync.native(fx.root), 'data', 'projects');
  fx.writeConfig({ team: { projects_root: projectsRoot } });
  return { fx, projectsRoot };
}

test('team-doctor says a team config is one, and passes when the key, the projects root and the bridge are there', async (t) => {
  const { fx, projectsRoot } = headless(t);
  fs.mkdirSync(projectsRoot, { recursive: true });
  const output = sink();
  const result = await doctor({ configPath: fx.configPath, output, ...bridgeOk, isLive: () => false });
  assert.equal(result.ok, true);
  const lines = output.text().trimEnd().split('\n');
  assert.equal(lines[0], 'Configuration: team host (key source secret_file); the Docker setup doctor does not apply to it.');
  assert.deepEqual(lines.slice(1), [
    'Host key file: present',
    'Projects root: present',
    'Team bridge: jenny-team-bridge protocol 1',
    'Team server: not running, or not ready yet',
  ]);
  // Nothing printed names a path, and the key never appears.
  const text = output.text();
  for (const secret of [fx.secrets, fx.root, fx.hostKey, projectsRoot]) assert.equal(text.includes(secret), false);
});

test('team-doctor fails with a missing key, a missing projects root or no bridge, and reports a ready server', async (t) => {
  const { fx } = headless(t);
  fs.rmSync(fx.keyFile);
  writeReadyMarker({ userDataPath: fx.profile, bootEpoch: 'boot' });
  const output = sink();
  const result = await doctor({ configPath: fx.configPath, output, resolveBinary: () => null });
  assert.deepEqual(result, { ok: false, reason: 'team_check_failed' });
  assert.deepEqual(output.text().trimEnd().split('\n').slice(1), [
    'Host key file: missing or invalid; run team-keygen with the team server stopped',
    'Projects root: missing (team_projects_root_missing); create projects/ in the data volume',
    'Team bridge: not found in this image or checkout; build it with npm run build:team-bridge',
    'Team server: running and ready',
  ]);
  const text = output.text();
  for (const secret of [fx.secrets, fx.root]) assert.equal(text.includes(secret), false);
});

test('team-doctor refuses a config that is not a team config, or one that does not load, with one reason', async (t) => {
  const fx = createTeamHostFixture(t);
  const single = writeSingleOwnerConfig(fx.root);
  assert.deepEqual(await doctor({ configPath: single, output: sink(), ...bridgeOk }), { ok: false, reason: 'team_config_required' });
  const broken = path.join(fx.root, 'broken.json');
  fs.writeFileSync(broken, '{ nope');
  assert.deepEqual(await doctor({ configPath: broken, output: sink(), ...bridgeOk }), { ok: false, reason: 'config_json_invalid' });
});

test('the CLI runs team-doctor with only --config and prints a refusal as one line', async (t) => {
  const { main, parseCliArgs } = require('../../server/cli');
  assert.deepEqual(parseCliArgs(['team-doctor', '--config', '/etc/jenny/team-host.json']),
    { command: 'team-doctor', configPath: '/etc/jenny/team-host.json' });
  assert.throws(() => parseCliArgs(['team-doctor', '--config', '/x.json', '--python', '/p']), /only --config/);
  const fx = createTeamHostFixture(t);
  const single = writeSingleOwnerConfig(fx.root);
  const errorOutput = sink();
  assert.equal(await main(['team-doctor', '--config', single], { confirmOutput: sink(), errorOutput }), 1);
  assert.equal(errorOutput.text(), 'team-doctor refused: team_config_required\n');
});

test('through main a failed check exits 1 after the rows, with one closed reason and no path', async (t) => {
  const { main } = require('../../server/cli');
  const { fx } = headless(t);
  fs.rmSync(fx.keyFile);
  const confirmOutput = sink();
  const errorOutput = sink();
  assert.equal(await main(['team-doctor', '--config', fx.configPath], { confirmOutput, errorOutput }), 1);
  const rows = confirmOutput.text().trimEnd().split('\n');
  assert.match(rows[0], /^Configuration: team host/);
  assert.equal(rows[1], 'Host key file: missing or invalid; run team-keygen with the team server stopped');
  assert.equal(rows.length, 5);
  assert.equal(errorOutput.text(), 'team-doctor refused: team_check_failed\n');
  for (const text of [confirmOutput.text(), errorOutput.text()]) {
    for (const secret of [fx.secrets, fx.root, fx.profile]) assert.equal(text.includes(secret), false);
  }
});
