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
