'use strict';

// Jenny CLI S7: the noun-verb commands. `config` reads and writes <profile>/cli.json with the
// flags' own validation and reports origins; `sessions` lists, shows and removes sessions inside
// the workspace project through the real composition (no sidecar start); `completion` prints the
// grammar; every --json line validates against cli/schemas/commands-v1.json.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');

const { parseArguments, resolveSettings } = require('../../cli/arguments');
const { validateCommandOutput } = require('../../cli/command-output');
const { words } = require('../../cli/completion');
const { EXIT_CODES } = require('../../cli/exit-codes');
const { main } = require('../../cli/main');
const { windowsOnly } = require('../helpers/platform-skips');

const ROOT = path.resolve(__dirname, '../..');
const MAIN = path.join(ROOT, 'cli/main.js');
const PYTHON = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const LOCK_CHILD = path.join(ROOT, 'tests/helpers/cli-profile-lock-child.js');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-cli-commands-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  return { root, workspace, profile: path.join(root, 'profile') };
}

function captureStreams() {
  const out = { stdout: '', stderr: '' };
  const stream = (key) => ({ write(chunk) { out[key] += String(chunk); return true; }, isTTY: false });
  return { out, stdout: stream('stdout'), stderr: stream('stderr') };
}

function runCli(args, { dirs, replay, cwd, stdin = 'ignore' } = {}) {
  const child = spawn(process.execPath, [MAIN, ...args], {
    cwd: cwd || dirs.workspace,
    env: { ...process.env, JENNY_PROFILE: dirs.profile, JENNY_REPLAY_SCRIPT: replay || '', JENNY_BACKEND_PYTHON: PYTHON, NO_COLOR: '1' },
    stdio: [stdin, 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, done: new Promise((resolve) => child.once('exit', (code) => resolve({ code, stdout, stderr }))) };
}

// One validated object per --json invocation.
function jsonOf(stdout) {
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  assert.equal(lines.length, 1, `exactly one json line: ${stdout.slice(0, 300)}`);
  const payload = JSON.parse(lines[0]);
  assert.deepEqual(validateCommandOutput(payload), { ok: true }, JSON.stringify(payload).slice(0, 400));
  return payload;
}

async function inProcess(args, env, extra = {}) {
  const streams = captureStreams();
  const code = await main(args, { env, stdin: { isTTY: false }, ...streams, ...extra });
  return { code, ...streams.out };
}

test('arguments: nouns, verbs, the command flags and origins', () => {
  const list = parseArguments(['sessions', 'list', '--all', '--limit', '5', '--json']);
  assert.deepEqual([list.command, [...list.commandArgs], list.flags.all, list.flags.limit, list.json, list.prompt], ['sessions', ['list'], true, 5, true, '']);
  assert.deepEqual([...parseArguments(['config', 'set', 'model', 'qwen3:8b']).commandArgs], ['set', 'model', 'qwen3:8b']);
  assert.equal(parseArguments(['config', 'list', '--show-origin']).flags.showOrigin, true);
  assert.deepEqual([...parseArguments(['help', 'sessions']).commandArgs], ['sessions']);
  for (const bad of [['sessions', 'purge'], ['config'], ['completion', 'fish'], ['doctor', 'x'], ['sessions', 'list', '--limit', '0'], ['mcp', 'stop']]) {
    assert.throws(() => parseArguments(bad), (error) => error.usage === true, bad.join(' '));
  }
  const settings = resolveSettings({ flags: parseArguments(['-p', '--model', 'flag-model', '--disallowed-tools', 'write_file', 'x']).flags,
    env: { JENNY_ENGINE: 'vllm', JENNY_DISALLOWED_TOOLS: 'edit_file' }, profileConfig: { output_format: 'json', disallowed_tools: ['memory:forget'] } });
  assert.deepEqual(settings.origins, { model: 'flag', engine: 'env', output_format: 'file', permission_mode: 'default', allowed_tools: 'default',
    disallowed_tools: 'flag+env+file', timeout_seconds: 'default', profile: 'default', cwd: 'default' });
  assert.equal(resolveSettings({ flags: parseArguments(['-p', 'x']).flags, env: { JENNY_PROFILE: 'C:/p' } }).origins.profile, 'env');
});

test('config: list, get and set go through cli.json with the flags\' own validation and never claim the profile', async (t) => {
  const dirs = tempRoot(t);
  const env = { JENNY_PROFILE: dirs.profile, JENNY_ENGINE: 'vllm' };
  const file = path.join(dirs.profile, 'cli.json');

  let run = await inProcess(['config', 'set', 'model', 'qwen3:8b', '--json'], env);
  assert.equal(run.code, EXIT_CODES.OK, run.stderr);
  assert.deepEqual(jsonOf(run.stdout), { v: 1, kind: 'config_set', key: 'model', value: 'qwen3:8b', file });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'qwen3:8b' });
  assert.equal(fs.existsSync(path.join(dirs.profile, 'profile-owner.json')), false, 'config never claims the profile');

  run = await inProcess(['config', 'set', 'allowed_tools', 'read_file, memory:recall', '--json'], env);
  assert.equal(run.code, EXIT_CODES.OK, run.stderr);
  assert.deepEqual(jsonOf(run.stdout).value, ['read_file', 'memory:recall']);
  run = await inProcess(['config', 'set', 'timeout_seconds', '30'], env);
  assert.equal(run.code, EXIT_CODES.OK, run.stderr);
  assert.match(run.stdout, /timeout_seconds = 30 \(written to/u);

  run = await inProcess(['config', 'get', 'model', '--json'], env);
  assert.deepEqual(jsonOf(run.stdout), { v: 1, kind: 'config_value', key: 'model', value: 'qwen3:8b', origin: 'file' });
  run = await inProcess(['config', 'get', 'engine'], env);
  assert.equal(run.stdout, 'vllm\n');
  run = await inProcess(['config', 'list', '--show-origin'], env);
  assert.equal(run.code, EXIT_CODES.OK, run.stderr);
  assert.match(run.stdout, /^model = qwen3:8b {2}\[file\]$/mu);
  assert.match(run.stdout, /^engine = vllm {2}\[env\]$/mu);
  assert.match(run.stdout, /^permission_mode = ask {2}\[default\]$/mu);
  assert.match(run.stdout, /^allowed_tools = read_file,memory:recall {2}\[file\]$/mu);
  assert.match(run.stdout, /^timeout_seconds = 30 {2}\[file\]$/mu);
  run = await inProcess(['config', 'list', '--json', '--model', 'flag-model'], env);
  const listed = jsonOf(run.stdout);
  assert.equal(listed.kind, 'config');
  assert.deepEqual(listed.entries.find((entry) => entry.key === 'model'), { key: 'model', value: 'flag-model', origin: 'flag', settable: true });
  assert.deepEqual(listed.entries.find((entry) => entry.key === 'profile'), { key: 'profile', value: path.resolve(dirs.profile), origin: 'env', settable: false });

  // Validation is the flag's own: auto is refused, a desktop-only tool cannot be pre-allowed from the file, a bad number is a usage error.
  for (const [args, pattern] of [
    [['config', 'set', 'permission_mode', 'auto'], /not available yet/u],
    [['config', 'set', 'allowed_tools', 'run_command'], /desktop-only|may not pre-allow/u],
    [['config', 'set', 'timeout_seconds', 'soon'], /timeout/u],
    [['config', 'set', 'engine', 'chatgpt', '--json'], /./u],
    [['config', 'set', 'profile', 'C:/x'], /cannot be set/u],
    [['config', 'get', 'bogus', '--json'], /Unknown config key/u],
  ]) {
    run = await inProcess(args, env);
    assert.equal(run.code, EXIT_CODES.USAGE, args.join(' '));
    assert.match(run.stderr, pattern, args.join(' '));
    if (args.includes('--json')) assert.equal(jsonOf(run.stdout).exit_code, EXIT_CODES.USAGE);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'qwen3:8b', allowed_tools: ['read_file', 'memory:recall'], timeout_seconds: 30 }, 'a refused set writes nothing');

  // An empty value removes the key.
  run = await inProcess(['config', 'set', 'model', '', '--json'], env);
  assert.equal(run.code, EXIT_CODES.OK, run.stderr);
  assert.equal(jsonOf(run.stdout).value, null);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')), 'model'), false);
  run = await inProcess(['config', 'get', 'model', '--json'], env);
  assert.deepEqual(jsonOf(run.stdout), { v: 1, kind: 'config_value', key: 'model', value: '', origin: 'default' });

  // -V and doctor share the versioned command schema.
  run = await inProcess(['-V', '--json'], env);
  assert.equal(jsonOf(run.stdout).kind, 'version');
});

test('completion scripts carry every command, verb and flag', async () => {
  const list = words();
  for (const word of ['sessions', 'config', 'completion', 'doctor', 'list', 'show', 'rm', 'get', 'set', 'serve', '--allowed-tools', '--cancel-on-stdin-close', '--show-origin', '-p', '-V']) {
    assert.ok(list.includes(word), word);
  }
  for (const shell of ['bash', 'zsh', 'powershell']) {
    const run = await inProcess(['completion', shell], {});
    assert.equal(run.code, EXIT_CODES.OK, run.stderr);
    assert.match(run.stdout, /--permission-mode/u);
    assert.match(run.stdout, shell === 'powershell' ? /Register-ArgumentCompleter/u : /jenny/u);
  }
  const bad = await inProcess(['completion'], {});
  assert.equal(bad.code, EXIT_CODES.USAGE);
});

// S9: an installed copy (the CLI entry inside resources/app.asar) checks the packaged sidecar
// binary instead of a Python and a module, and on Windows says why there is no console input.
function packagedRuntime(dirs, launch) {
  const resources = path.join(dirs.root, 'resources');
  return Object.freeze({
    mode: 'packaged', root: path.join(resources, 'app.asar'), resourcesPath: resources, pythonExecutable: '',
    // POSIX tests lock through the tree's helper and venv; the Windows pipe needs neither.
    lockPythonExecutable: process.platform === 'win32' ? '' : PYTHON,
    lockHelperPath: path.join(ROOT, 'services', 'host', 'profile_lock.py'),
    sidecarCwd: resources, pythonRuntimeBundleRoot: resources, packagedManifestPresent: true,
    resolvePackagedLaunch: async () => launch,
  });
}

test('doctor: the packaged route reports one sidecar_binary check from the resolver', async (t) => {
  const dirs = tempRoot(t);
  const env = { JENNY_PROFILE: dirs.profile };
  const binary = path.join(dirs.root, 'resources', 'sidecar', process.platform === 'win32' ? 'sidecar.exe' : 'sidecar');
  let run = await inProcess(['doctor', '--json', '--cwd', dirs.workspace], env,
    { runtime: packagedRuntime(dirs, { ok: true, launchCommand: binary, launchArgs: [], launchSource: 'packaged-binary' }) });
  let report = jsonOf(run.stdout);
  const names = report.checks.map((entry) => entry.name);
  assert.equal(names.includes('sidecar_python'), false);
  assert.equal(names.includes('sidecar_module'), false);
  assert.deepEqual(report.checks.find((entry) => entry.name === 'sidecar_binary'), { name: 'sidecar_binary', ok: true, detail: binary });
  assert.deepEqual(report.checks.find((entry) => entry.name === 'runtime'), { name: 'runtime', ok: true, detail: `packaged ${path.join(dirs.root, 'resources')}` });
  assert.equal(report.checks.find((entry) => entry.name === 'profile').ok, true, JSON.stringify(report.checks));
  assert.equal(run.code, EXIT_CODES.OK, run.stdout);

  const reason = 'Packaged sidecar artifact sha256 does not match manifest.';
  run = await inProcess(['doctor', '--json', '--cwd', dirs.workspace], env,
    { runtime: packagedRuntime(dirs, { ok: false, launchCommand: '', launchArgs: [], launchSource: 'packaged-binary', failureReason: reason }) });
  report = jsonOf(run.stdout);
  assert.equal(run.code, EXIT_CODES.RUNTIME_ERROR);
  assert.equal(report.ok, false);
  assert.deepEqual(report.checks.find((entry) => entry.name === 'sidecar_binary'), { name: 'sidecar_binary', ok: false, detail: reason });
  run = await inProcess(['doctor', '--cwd', dirs.workspace], env,
    { runtime: packagedRuntime(dirs, { ok: false, failureReason: reason }) });
  assert.match(run.stdout, /^FAIL sidecar_binary +Packaged sidecar artifact sha256/mu);

  // The source route keeps its two checks.
  run = await inProcess(['doctor', '--json', '--cwd', dirs.workspace], { ...env, JENNY_BACKEND_PYTHON: PYTHON });
  report = jsonOf(run.stdout);
  assert.deepEqual(report.checks.filter((entry) => /^sidecar_/u.test(entry.name)).map((entry) => entry.name), ['sidecar_python', 'sidecar_module']);
  assert.match(report.checks.find((entry) => entry.name === 'runtime').detail, /^source /u);
});

const quietStdin = () => { const stream = new PassThrough(); stream.isTTY = false; stream.end(); return stream; };

test('a prompt-less source run keeps the plain usage text', async (t) => {
  const dirs = tempRoot(t);
  const source = await inProcess([], { JENNY_PROFILE: dirs.profile }, { stdin: quietStdin() });
  assert.equal(source.code, EXIT_CODES.USAGE);
  assert.match(source.stderr, /^A prompt is required\.\n\n/u, 'the source route keeps its text');
});

test('a prompt-less installed run on Windows explains the missing console input', { skip: windowsOnly('GUI-subsystem exe console-input split') }, async (t) => {
  const dirs = tempRoot(t);
  const env = { JENNY_PROFILE: dirs.profile };
  const packaged = await inProcess([], env, { stdin: quietStdin(), runtime: packagedRuntime(dirs, { ok: true }) });
  assert.equal(packaged.code, EXIT_CODES.USAGE);
  assert.ok(packaged.stderr.startsWith('A prompt is required. The installed jenny.cmd found no console input: pass the prompt as an argument (jenny -p "...") or pipe it (echo ... | jenny -p). The interactive session needs a terminal on stdin and stdout.\n\n'),
    packaged.stderr);
  assert.match(packaged.stderr, /Usage: jenny /u);
});

test('sessions: list, show and rm through the real composition, scoped to the workspace project', { timeout: 120_000 }, async (t) => {
  const dirs = tempRoot(t);
  const other = path.join(dirs.root, 'other-workspace');
  fs.mkdirSync(other);
  const replay = path.join(dirs.root, 'replay.json');
  fs.writeFileSync(replay, JSON.stringify({ version: 1, calls: [{ text: 'The answer is 4f2c.' }] }));
  const made = await runCli(['-p', '--engine', 'replay', '--output-format', 'stream-json', 'What is the code?'], { dirs, replay }).done;
  assert.equal(made.code, EXIT_CODES.OK, made.stderr);
  const sessionId = JSON.parse(made.stdout.split(/\r?\n/u)[0]).session_id;

  let run = await runCli(['sessions', 'list', '--json'], { dirs }).done;
  assert.equal(run.code, EXIT_CODES.OK, run.stderr);
  let listed = jsonOf(run.stdout);
  assert.equal(listed.total, 1);
  assert.equal(listed.all, false);
  assert.equal(listed.sessions[0].id, sessionId);
  assert.equal(listed.sessions[0].current_workspace, true);
  assert.equal(listed.sessions[0].project_id, listed.project_id);
  assert.ok(listed.sessions[0].message_count >= 2, JSON.stringify(listed.sessions[0]));
  run = await runCli(['sessions', 'list'], { dirs }).done;
  assert.match(run.stdout, new RegExp(`^${sessionId} .* msgs  `, 'mu'));

  run = await runCli(['sessions', 'show', sessionId, '--json'], { dirs }).done;
  assert.equal(run.code, EXIT_CODES.OK, run.stderr);
  const shown = jsonOf(run.stdout);
  assert.equal(shown.session.id, sessionId);
  assert.deepEqual(shown.messages.map((message) => message.role), ['user', 'assistant']);
  assert.match(shown.messages[1].content, /4f2c/u);
  assert.equal(shown.truncated, false);
  run = await runCli(['sessions', 'show', sessionId, '--limit', '1', '--json'], { dirs }).done;
  const last = jsonOf(run.stdout);
  assert.deepEqual([last.messages.length, last.message_total, last.truncated], [1, 2, true]);
  run = await runCli(['sessions', 'show', sessionId], { dirs }).done;
  assert.match(run.stdout, /\[user\] What is the code\?/u);
  assert.match(run.stdout, /\[assistant\] The answer is 4f2c\./u);

  // Another workspace sees nothing unless asked for everything, and may not remove.
  run = await runCli(['sessions', 'list', '--json'], { dirs, cwd: other }).done;
  assert.equal(jsonOf(run.stdout).total, 0);
  run = await runCli(['sessions', 'list', '--all', '--json'], { dirs, cwd: other }).done;
  listed = jsonOf(run.stdout);
  assert.deepEqual([listed.total, listed.all, listed.sessions[0].current_workspace], [1, true, false]);
  run = await runCli(['sessions', 'show', sessionId, '--json'], { dirs, cwd: other }).done;
  assert.equal(jsonOf(run.stdout).session.current_workspace, false);
  run = await runCli(['sessions', 'rm', sessionId, '--json'], { dirs, cwd: other }).done;
  assert.equal(run.code, EXIT_CODES.USAGE, run.stderr);
  assert.match(jsonOf(run.stdout).message, /another workspace/u);

  run = await runCli(['sessions', 'rm', sessionId, '--json'], { dirs }).done;
  assert.equal(run.code, EXIT_CODES.OK, run.stderr);
  assert.deepEqual(jsonOf(run.stdout), { v: 1, kind: 'session_removed', id: sessionId, deleted: true });
  run = await runCli(['sessions', 'list', '--all', '--json'], { dirs }).done;
  assert.equal(jsonOf(run.stdout).total, 0);
  run = await runCli(['sessions', 'show', sessionId, '--json'], { dirs }).done;
  assert.equal(run.code, EXIT_CODES.USAGE);
  assert.equal(jsonOf(run.stdout).kind, 'error');
  run = await runCli(['sessions', 'rm'], { dirs }).done;
  assert.equal(run.code, EXIT_CODES.USAGE);

  // The profile lock holds for commands too.
  const holder = spawn(process.execPath, [LOCK_CHILD, dirs.profile, PYTHON], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  t.after(() => { if (holder.exitCode === null) holder.kill(); });
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  run = await runCli(['sessions', 'list', '--json'], { dirs }).done;
  assert.equal(run.code, EXIT_CODES.PROFILE_BUSY, run.stderr);
  assert.equal(jsonOf(run.stdout).code, 'CMP-CLI-0005');
  holder.stdin.end();
  await new Promise((resolve) => holder.once('exit', resolve));

  // doctor shares the command schema.
  run = await runCli(['doctor', '--json'], { dirs }).done;
  assert.equal(run.code, EXIT_CODES.OK, run.stderr + run.stdout);
  assert.equal(jsonOf(run.stdout).kind, 'doctor');
});

// Second-PC readiness: `doctor --team`. The team effects are fakes handed through main
// (tests/helpers/doctor-team-fakes.js); only the profile-write test composes a real CLI host.
const doctorTeam = require('../../cli/doctor-team');
const { PROBE_TIMEOUT_MS, probeBridgeVersion } = require('../../server/team/transport/bridge-binary');
const { createCliHost } = require('../../services/cli-host/host');
const { acquireCliProfile } = require('../../services/cli-host/profile-lock');
const { hostLaunchOptions, lockOptions, resolveCliRuntime } = require('../../services/cli-host/runtime-layout');
const { FAKE_BRIDGE, fakeChild, fakeCliHost, fakeTimers, snapshot, teamFakes } = require('../helpers/doctor-team-fakes');

const TEAM_ROWS = ['team_flag', 'team_bridge', 'team_versions', 'team_free_disk', 'team_engine_model'];
const row = (report, name) => report.checks.find((entry) => entry.name === name);

async function teamDoctor(t, args, { env = {}, ...overrides } = {}) {
  const dirs = tempRoot(t);
  const fakes = teamFakes(overrides);
  const binary = path.join(dirs.root, 'resources', 'sidecar', process.platform === 'win32' ? 'sidecar.exe' : 'sidecar');
  const runtime = packagedRuntime(dirs, { ok: true, launchCommand: binary, launchArgs: [], launchSource: 'packaged-binary' });
  const run = await inProcess(['doctor', '--cwd', dirs.workspace, ...args], { JENNY_PROFILE: dirs.profile, JENNY_ENABLE_TEAM: '1', ...env },
    { runtime, doctorTeamDeps: fakes.deps });
  return { run, dirs, runtime, ...fakes };
}

test('doctor --team: every team row passes, the manual rows carry their own instruction, --team is doctor\'s alone', async (t) => {
  assert.equal(parseArguments(['doctor', '--team']).flags.team, true);
  assert.equal(parseArguments(['doctor']).flags.team, false);
  for (const bad of [['sessions', 'list', '--team'], ['--team', '-p', 'x'], ['config', 'list', '--team']]) {
    assert.throws(() => parseArguments(bad), (error) => error.usage === true && /--team works only with jenny doctor/u.test(error.message), bad.join(' '));
  }
  assert.ok(words().includes('--team'), 'completion offers --team');

  const { run, seen, runtime } = await teamDoctor(t, ['--team', '--json']);
  assert.equal(run.code, EXIT_CODES.OK, run.stdout);
  const report = jsonOf(run.stdout);
  assert.equal(report.ok, true);
  const names = report.checks.map((entry) => entry.name);
  assert.deepEqual(names.slice(-TEAM_ROWS.length), TEAM_ROWS, 'the team rows come after the existing ones');
  assert.deepEqual(names.slice(0, 3), ['node', 'versions', 'runtime']);
  for (const name of TEAM_ROWS) assert.equal(row(report, name).ok, true, name);
  assert.equal(row(report, 'team_bridge').detail, 'jenny-team-bridge protocol 1');
  assert.match(row(report, 'team_versions').detail, /^app \d\S*, team protocol 1, bridge protocol 1$/u);
  assert.equal(row(report, 'team_free_disk').detail, '50.0 GiB free on the profile\'s drive (needs 20 GiB)');
  assert.match(row(report, 'team_engine_model').detail, /^\S+, 2 models$/u);
  assert.deepEqual(report.manual.map((entry) => entry.name), ['team_firewall', 'team_port_mapping']);
  assert.match(report.manual[0].detail, /^when Windows asks, allow Jenny on Private networks only \(checklist "Team: getting a second PC ready", Firewall\)$/u);
  assert.match(report.manual[1].detail, /^a member PC needs no port mapping; .*\(checklist "Team: getting a second PC ready", Port mapping\)$/u);
  for (const entry of [...report.checks.slice(-TEAM_ROWS.length), ...report.manual]) {
    assert.doesNotMatch(entry.detail, /fake-install|\.md\b|[\\/]docs[\\/]/u, `${entry.name} names no path`);
  }

  // The bridge is resolved from the install, run once with no window and no environment.
  assert.deepEqual(seen.resolved, [{ resourcesPath: runtime.resourcesPath, root: runtime.root }]);
  assert.equal(seen.spawned.length, 1);
  assert.deepEqual([seen.spawned[0].file, seen.spawned[0].args, seen.spawned[0].options.windowsHide], [FAKE_BRIDGE, ['--version'], true]);
  assert.deepEqual(Object.keys(seen.spawned[0].options.env).filter((key) => key !== 'SystemRoot'), [], 'the probe passes no environment');
  assert.deepEqual([seen.probes, seen.stops], [1, 1]);

  const text = await teamDoctor(t, ['--team']);
  assert.equal(text.run.code, EXIT_CODES.OK, text.run.stdout);
  const lines = text.run.stdout.trimEnd().split('\n');
  assert.match(lines.at(-2), /^manual {2}team_firewall {2}when Windows asks/u);
  assert.match(lines.at(-1), /^manual {2}team_port_mapping {2}a member PC/u);
  assert.match(lines.at(-3), /^ok {3}team_engine_model /u);
});

test('doctor without --team prints no team row and no manual key, validates, and loads no team module', async (t) => {
  // A fresh main and doctor, with no team module cached, run a plain doctor.
  const teamModule = (key) => /[\\/]server[\\/]team[\\/]transport[\\/]|[\\/]cli[\\/]doctor-team\.js$/u.test(key);
  for (const key of Object.keys(require.cache).filter((entry) => teamModule(entry) || /[\\/]cli[\\/](main|doctor)\.js$/u.test(entry))) {
    delete require.cache[key];
  }
  const fresh = captureStreams();
  const freshDirs = tempRoot(t);
  await require('../../cli/main').main(['doctor', '--json', '--cwd', freshDirs.workspace], { env: { JENNY_PROFILE: freshDirs.profile },
    stdin: { isTTY: false }, ...fresh, runtime: packagedRuntime(freshDirs, { ok: true, launchCommand: 'x', launchArgs: [] }) });
  assert.equal(jsonOf(fresh.out.stdout).kind, 'doctor');
  assert.deepEqual(Object.keys(require.cache).filter(teamModule), [], 'a plain doctor loads no team module');
  const { run, seen } = await teamDoctor(t, ['--json']);
  const report = jsonOf(run.stdout);
  assert.equal(Object.hasOwn(report, 'manual'), false);
  assert.equal(report.checks.some((entry) => entry.name.startsWith('team_')), false);
  assert.deepEqual([seen.resolved.length, seen.spawned.length, seen.statfs.length, seen.probes], [0, 0, 0, 0]);
  const text = await teamDoctor(t, []);
  assert.doesNotMatch(text.run.stdout, /team_|manual/u);
});

test('doctor --team: each failure fails its rows and the exit code, and the manual rows stay out of it', async (t) => {
  const cases = [
    { label: 'flag off', env: { JENNY_ENABLE_TEAM: '0' }, failed: ['team_flag'], detail: /JENNY_ENABLE_TEAM=0.*app/u },
    { label: 'no binary', noBinary: true, failed: ['team_bridge', 'team_versions'], detail: /not found/u },
    { label: 'non-zero exit', child: { code: 3 }, failed: ['team_bridge', 'team_versions'], detail: /exited with code 3/u },
    { label: 'another line', child: { stdout: 'jenny-team-bridge 0.1.0\n' }, failed: ['team_bridge', 'team_versions'], detail: /something other/u },
    { label: 'never answers', child: { hang: true }, fire: [PROBE_TIMEOUT_MS], failed: ['team_bridge', 'team_versions'], detail: /within 5 s and was stopped/u },
    { label: 'other protocol', child: { stdout: 'jenny-team-bridge protocol 2\n' }, failed: ['team_bridge', 'team_versions'], detail: /speaks protocol 2; this build expects 1/u },
    { label: 'statfs throws', statfsThrows: true, failed: ['team_free_disk'], detail: /could not be read/u },
    { label: 'under 20 GiB', freeBlocks: 19 * 262_144, failed: ['team_free_disk'], detail: /^19\.0 GiB free/u },
    { label: 'no model', models: 0, failed: ['team_engine_model'], detail: /, 0 models$/u },
    { label: 'model question times out', probeHangs: true, fire: [doctorTeam.MODEL_TIMEOUT_MS], failed: ['team_engine_model'],
      detail: /no answer within 30 s \(a first sidecar start on a new PC can take that long, or the engine is silent\)/u },
  ];
  for (const { label, failed, detail, ...overrides } of cases) {
    const { run, seen } = await teamDoctor(t, ['--team', '--json'], overrides);
    seen.events.push('returned');
    assert.equal(run.code, EXIT_CODES.RUNTIME_ERROR, label);
    const report = jsonOf(run.stdout);
    assert.equal(report.ok, false, label);
    assert.deepEqual(report.checks.filter((entry) => !entry.ok).map((entry) => entry.name), failed,
      `${label}: ${JSON.stringify(report.checks.slice(-TEAM_ROWS.length))}`);
    assert.match(row(report, failed[0]).detail, detail, label);
    assert.equal(report.manual.length, 2, label);
    if (label === 'other protocol') assert.match(row(report, 'team_versions').detail, /bridge protocol 2 \(this build expects 1\)$/u);
    if (label === 'never answers') assert.equal(seen.children[0].killed, 1, 'the hung child is ended by its handle');
    if (label === 'model question times out') {
      assert.deepEqual(seen.events, [`fire:${doctorTeam.MODEL_TIMEOUT_MS}`, 'stop', 'returned'], 'stopped after the timeout won, before the row');
    }
  }

  // An app version that could not be read cannot be compared across two PCs.
  const dirs = tempRoot(t);
  const unknown = await doctorTeam.runTeamDoctor({ settings: { profilePath: dirs.profile, engine: 'ollama' }, env: { JENNY_ENABLE_TEAM: '1' },
    appVersion: '', runtime: packagedRuntime(dirs, { ok: true }), deps: teamFakes().deps });
  assert.deepEqual([row(unknown, 'team_versions').ok, row(unknown, 'team_bridge').ok], [false, true]);
  assert.match(row(unknown, 'team_versions').detail, /^app unknown, .*could not be read, so the two PCs cannot be compared/u);
});

test('probeBridgeVersion parses at close, ends a hung child by its handle, and clears its timer on every way out', async () => {
  const probe = async (child, { fire = [], spawnThrows = false } = {}) => {
    const timers = fakeTimers(fire);
    let made = null;
    const answer = await probeBridgeVersion({ binaryPath: FAKE_BRIDGE, timers,
      spawnChild: () => { if (spawnThrows) throw new Error('EACCES'); made = fakeChild(child); return made; } });
    assert.equal(timers.clears, timers.sets, `timer cleared: ${JSON.stringify(answer)}`);
    return { answer, child: made };
  };
  assert.deepEqual((await probe({ late: true })).answer, { ok: true, line: 'jenny-team-bridge protocol 1', protocol: 1 }, 'data after exit');
  assert.deepEqual((await probe({ stdout: 'jenny-team-bridge protocol 1' })).answer.ok, true, 'no newline');
  assert.deepEqual((await probe({}, { spawnThrows: true })).answer, { ok: false, reason: 'not_started' });
  assert.deepEqual((await probe({ errors: 1 })).answer, { ok: false, reason: 'not_started' });
  assert.deepEqual((await probe({ errors: 2 })).answer, { ok: false, reason: 'not_started' }, 'a second error is handled');
  assert.deepEqual((await probe({ stdout: 'x'.repeat(5000) })).answer, { ok: false, reason: 'bad_line' });
  assert.deepEqual((await probe({ stdout: `jenny-team-bridge protocol 1\n${'x'.repeat(5000)}` })).answer, { ok: false, reason: 'bad_line' });
  assert.deepEqual((await probe({ stdout: 'jenny-team-bridge protocol 01\n' })).answer, { ok: false, reason: 'bad_line' });
  assert.deepEqual((await probe({ code: 2 })).answer, { ok: false, reason: 'exited', code: 2 });
  const hung = await probe({ hang: true }, { fire: [PROBE_TIMEOUT_MS] });
  assert.deepEqual(hung.answer, { ok: false, reason: 'timeout' });
  assert.deepEqual([hung.child.killed, hung.child.stdout.destroyed, hung.child.unrefs], [1, 1, 1]);
});

// A profile the CLI has used: shell-config.json naming `root` as its working folder.
function usedProfile(dirs, root = dirs.workspace) {
  fs.mkdirSync(dirs.profile, { recursive: true });
  fs.writeFileSync(path.join(dirs.profile, 'shell-config.json'), JSON.stringify({ toolsWorkspaceRoot: root }));
}

test('the model probe: a stop that does not confirm the sidecar exited fails the row, and each fault has its own detail', async (t) => {
  const modelRow = async (hostOptions, prepare = usedProfile) => {
    const dirs = tempRoot(t);
    prepare(dirs);
    const fake = fakeCliHost(hostOptions);
    const report = await doctorTeam.runTeamDoctor({ settings: { profilePath: dirs.profile, engine: 'ollama', model: '' },
      env: { JENNY_ENABLE_TEAM: '1' }, appVersion: '1.7.0', runtime: packagedRuntime(dirs, { ok: true }),
      deps: { ...teamFakes().deps, startModelProbe: (args) => doctorTeam.startCliModelProbe(args, fake.host) } });
    return { result: row(report, 'team_engine_model'), seen: fake.seen, dirs };
  };
  const clean = await modelRow({});
  assert.deepEqual(clean.result, { name: 'team_engine_model', ok: true, detail: 'ollama, 2 models' });
  assert.equal(clean.seen.created[0].workspaceRoot, clean.dirs.workspace, 'the root the profile already holds');
  assert.deepEqual([clean.seen.closed, clean.seen.released], [1, 1]);
  for (const [options, pattern] of [
    [{ close: 'alive' }, /^ollama: the sidecar did not confirm it stopped, so a Jenny sidecar may still be running \(pid 4242\): check Task Manager$/u],
    [{ close: 'hang' }, /may still be running: check Task Manager$/u],
    [{ busy: true }, /in use by another jenny command: close it/u],
    [{ startFails: true }, /the sidecar did not start: run plain `jenny doctor`/u],
    [{ engineDown: true }, /the engine did not answer: start it/u],
  ]) {
    const { result, seen } = await modelRow(options);
    assert.equal(result.ok, false, JSON.stringify(options));
    assert.match(result.detail, pattern, JSON.stringify(options));
    assert.equal(seen.released, options.busy ? 0 : 1, `lock released: ${JSON.stringify(options)}`);
  }
  const unused = await modelRow({}, () => {});
  assert.match(unused.result.detail, /has not been used yet: run `jenny sessions list`/u);
  assert.deepEqual([unused.seen.created.length, fs.existsSync(unused.dirs.profile)], [0, false], 'nothing composed or created');
  const gone = await modelRow({}, (dirs) => usedProfile(dirs, path.join(dirs.root, 'missing')));
  assert.match(gone.result.detail, /last worked in is gone/u);
});

test('the model probe writes nothing to a used CLI profile (the real composition, the sidecar faked)', { timeout: 120_000 }, async (t) => {
  const dirs = tempRoot(t);
  const runtime = resolveCliRuntime({ root: ROOT, env: { JENNY_BACKEND_PYTHON: PYTHON } });
  const options = (workspaceRoot) => ({ profilePath: dirs.profile, workspaceRoot, ...hostLaunchOptions(runtime),
    engine: { type: 'ollama', model: '' }, permissions: { allowedTools: [], disallowedTools: [], permissionMode: 'plan' }, logger: () => {} });
  // Use the profile once, as `jenny sessions list` does: the lock, then the composition with no sidecar.
  const held = await acquireCliProfile({ userDataPath: dirs.profile, ...lockOptions(runtime) });
  await createCliHost(options(dirs.workspace)).close();
  held.release();
  const before = snapshot(dirs.profile);
  assert.ok(Object.keys(before).includes('shell-config.json'), JSON.stringify(Object.keys(before)));
  const host = { acquireCliProfile, closeTimeoutMs: 20_000,
    createCliHost: (given) => { const real = createCliHost(given); return { start: async () => {}, close: () => real.close() }; },
    hostComposition: () => ({ backend: { listModelsForEngine: async () => ({ available: true, data: [{ id: 'm' }] }) } }) };
  const probe = doctorTeam.startCliModelProbe({ settings: { profilePath: dirs.profile, engine: 'ollama', model: '' }, runtime }, host);
  assert.equal(await probe.result, 1);
  assert.deepEqual(await probe.stop(), { exited: true });
  assert.deepEqual(snapshot(dirs.profile), before, 'the probe wrote nothing to the profile');
});

test('doctor-team pins its protocol constants to the sources that own them and loads no Electron', () => {
  const session = fs.readFileSync(path.join(ROOT, 'services/team/team-session.js'), 'utf8');
  assert.equal(Number(/^const PROTOCOL_VERSION = (\d+);$/mu.exec(session)?.[1]), doctorTeam.TEAM_PROTOCOL_VERSION);
  const lib = fs.readFileSync(path.join(ROOT, 'native/jenny-team-bridge/src/lib.rs'), 'utf8');
  assert.equal(/pub const VERSION_LINE: &str = "jenny-team-bridge protocol (\d+)";/u.exec(lib)?.[1], String(doctorTeam.BRIDGE_PROTOCOL));
  assert.equal(fs.readFileSync(path.join(ROOT, 'cli/doctor-team.js'), 'utf8').includes("'electron'"), false);
  // In this process main, doctor and doctor-team are loaded, and nothing loaded the package.
  assert.equal(Object.keys(require.cache).some((key) => /[\\/]node_modules[\\/]electron[\\/]/u.test(key)), false);
});
