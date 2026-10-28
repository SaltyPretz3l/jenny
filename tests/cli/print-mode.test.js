'use strict';

// Jenny CLI S5: print mode through the real process. `node cli/main.js -p` runs the replay engine
// against the real sidecar, writes cli.v1 frames to stdout and exits with the frozen code for how
// the run ended: 0 ok, 2 usage, 3 policy denial, 4 input required, 5 budget or timeout, 75 busy,
// 130 the caller's pipe closed (when the run was told to watch it).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { parseArguments, resolveSettings, DEFAULT_TIMEOUT_MS } = require('../../cli/arguments');
const { createOutput } = require('../../cli/output');
const { classify } = require('../../cli/print');
const { EXIT_CODES, CLI_VERSION } = require('../../cli/exit-codes');
const { main } = require('../../cli/main');
const { validateCliEvent } = require('../../services/cli-host/event-projection');

const ROOT = path.resolve(__dirname, '../..');
const MAIN = path.join(ROOT, 'cli/main.js');
const PYTHON = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const LOCK_CHILD = path.join(ROOT, 'tests/helpers/cli-profile-lock-child.js');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-cli-print-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'fixture.txt'), 'print mode fixture 51c2');
  return { root, workspace, profile: path.join(root, 'profile') };
}

function replayScript(root, calls) {
  const file = path.join(root, `replay-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, calls }));
  return file;
}

function captureStreams() {
  const out = { stdout: '', stderr: '' };
  const stream = (key) => ({ write(chunk) { out[key] += String(chunk); return true; }, isTTY: false });
  return { out, stdout: stream('stdout'), stderr: stream('stderr') };
}

function runCli(args, { dirs, replay, stdinText, stdin = 'ignore', env = {} } = {}) {
  const child = spawn(process.execPath, [MAIN, ...args], {
    cwd: dirs.workspace,
    env: { ...process.env, JENNY_PROFILE: dirs.profile, JENNY_REPLAY_SCRIPT: replay || '', JENNY_BACKEND_PYTHON: PYTHON, NO_COLOR: '1', ...env },
    stdio: [stdinText !== undefined ? 'pipe' : stdin, 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (stdinText !== undefined) child.stdin.end(stdinText);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => child.once('exit', (code) => resolve({ code, stdout, stderr })));
  return { child, done };
}

function frames(stdout) {
  const list = stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  for (const frame of list) assert.deepEqual(validateCliEvent(frame), { ok: true }, JSON.stringify(frame).slice(0, 300));
  return list;
}

function resultOf(list) {
  assert.equal(list.at(-1).kind, 'result', `result must be the last frame: ${list.map((f) => f.kind).join(',')}`);
  assert.equal(list.filter((f) => f.kind === 'result').length, 1);
  return list.at(-1).payload;
}

test('arguments: grammar, validation and precedence', () => {
  const parsed = parseArguments(['-p', '--allowed-tools', 'read_file,glob_*', '--allowed-tools', 'grep_search', '--max-turns', '3',
    '--timeout', '1.5', '--output-format', 'STREAM-JSON', 'say', 'hello']);
  assert.equal(parsed.prompt, 'say hello');
  assert.deepEqual(parsed.flags.allowedTools, ['read_file', 'glob_*', 'grep_search']);
  assert.equal(parsed.flags.maxTurns, 3);
  assert.equal(parsed.flags.timeoutMs, 1500);
  assert.equal(parsed.flags.outputFormat, 'stream-json');
  assert.equal(parseArguments(['doctor', '--json']).command, 'doctor');
  for (const bad of [['--output-format', 'yaml'], ['--timeout', 'soon'], ['--max-turns', '0'], ['--permission-mode', 'dangerously-skip'],
    ['--permission-mode', 'auto'], ['--bogus'], ['doctor', 'extra'], ['-r', 'bad id'], ['-c', '-r', 'sess_1'],
    ['--allowed-tools', 'read_(file)', '-p', 'x']]) {
    assert.throws(() => {
      const result = parseArguments(bad);
      resolveSettings({ flags: result.flags, env: {} });
    }, (error) => error.usage === true || error.code === 'CMP-CLI-0008', bad.join(' '));
  }
  assert.throws(() => parseArguments(['--permission-mode', 'auto']), /not available yet/u, 'auto is refused until it exists, never silently ask');
  assert.throws(() => resolveSettings({ flags: parseArguments(['-p', 'x']).flags, env: { JENNY_PERMISSION_MODE: 'auto' } }), /not available yet/u);
  // Disallows are the union of every layer; a desktop-only tool is pre-allowed from the command line only.
  const layered = resolveSettings({ flags: parseArguments(['-p', '--disallowed-tools', 'write_file', '--allowed-tools', 'run_command', 'x']).flags,
    env: { JENNY_DISALLOWED_TOOLS: 'edit_file,write_file' }, profileConfig: { disallowed_tools: ['memory:forget'] } });
  assert.deepEqual(layered.disallowedTools, ['write_file', 'edit_file', 'memory:forget']);
  assert.deepEqual(layered.allowedTools, ['run_command']);
  assert.throws(() => resolveSettings({ flags: parseArguments(['-p', 'x']).flags, env: { JENNY_ALLOWED_TOOLS: 'read_file,run_command' } }),
    (error) => error.reason === 'desktop_only_requires_flag' && /JENNY_ALLOWED_TOOLS/u.test(error.message));
  assert.throws(() => resolveSettings({ flags: parseArguments(['-p', 'x']).flags, env: {}, profileConfig: { allowed_tools: ['delete_file'] } }),
    (error) => error.reason === 'desktop_only_requires_flag' && /cli\.json/u.test(error.message));
  assert.equal(resolveSettings({ flags: parseArguments(['-p', 'x']).flags, env: {} }).cancelOnStdinClose, false);
  assert.equal(resolveSettings({ flags: parseArguments(['-p', '--cancel-on-stdin-close', 'x']).flags, env: {} }).cancelOnStdinClose, true);
  const settings = resolveSettings({ flags: parseArguments(['-p', '--model', 'flag-model', 'x']).flags,
    env: { JENNY_MODEL: 'env-model', JENNY_ENGINE: 'vllm', JENNY_TIMEOUT: '2', JENNY_PROFILE: 'C:/p' },
    profileConfig: { model: 'file-model', engine: 'ollama', output_format: 'json', timeout_seconds: 9, allowed_tools: ['read_file'] } });
  assert.equal(settings.model, 'flag-model', 'flags beat env');
  assert.equal(settings.engine, 'vllm', 'env beats the profile file');
  assert.equal(settings.outputFormat, 'json', 'the file beats the default');
  assert.equal(settings.budgets.timeout_ms, 2000);
  assert.deepEqual(settings.allowedTools, ['read_file']);
  assert.equal(settings.profilePath, path.resolve('C:/p'));
  const defaults = resolveSettings({ flags: parseArguments(['-p', 'x']).flags, env: {} });
  assert.deepEqual(defaults.budgets, { max_turns: null, max_output_tokens: null, max_inference_requests: null, timeout_ms: DEFAULT_TIMEOUT_MS });
  assert.equal(defaults.engine, 'ollama');
  assert.equal(defaults.permissionMode, 'ask');
});

test('main: help, version and usage errors never touch a profile', async (t) => {
  const dirs = tempRoot(t);
  const env = { JENNY_PROFILE: dirs.profile };
  let streams = captureStreams();
  assert.equal(await main(['--help'], { env, ...streams }), EXIT_CODES.OK);
  assert.match(streams.out.stdout, /Usage: jenny/u);
  streams = captureStreams();
  assert.equal(await main(['-V', '--json'], { env, ...streams }), EXIT_CODES.OK);
  assert.equal(JSON.parse(streams.out.stdout).versions.cli, CLI_VERSION);
  streams = captureStreams();
  assert.equal(await main(['--output-format', 'xml', '-p', 'x'], { env, ...streams }), EXIT_CODES.USAGE);
  assert.match(streams.out.stderr, /output-format/u);
  streams = captureStreams();
  assert.equal(await main(['--output-format', 'json'], { env, stdin: { isTTY: true }, ...streams }), EXIT_CODES.USAGE, 'the interactive loop prints text only');
  assert.match(streams.out.stderr, /Interactive mode prints text/u);
  assert.equal(fs.existsSync(dirs.profile), false, 'no profile was created');

  // A cli.json that cannot be read as a small JSON object is a usage error, never ignored.
  fs.mkdirSync(dirs.profile, { recursive: true });
  fs.writeFileSync(path.join(dirs.profile, 'cli.json'), '{ not json');
  streams = captureStreams();
  assert.equal(await main(['-p', 'x'], { env, stdin: { isTTY: false }, ...streams }), EXIT_CODES.USAGE);
  assert.match(streams.out.stderr, /cli\.json is not valid JSON/u);
  fs.writeFileSync(path.join(dirs.profile, 'cli.json'), '[]');
  streams = captureStreams();
  assert.equal(await main(['-p', 'x'], { env, stdin: { isTTY: false }, ...streams }), EXIT_CODES.USAGE);
  assert.match(streams.out.stderr, /must hold a JSON object/u);
  fs.writeFileSync(path.join(dirs.profile, 'cli.json'), `{"pad":"${'x'.repeat(70 * 1024)}"}`);
  streams = captureStreams();
  assert.equal(await main(['-p', 'x'], { env, stdin: { isTTY: false }, ...streams }), EXIT_CODES.USAGE);
  assert.match(streams.out.stderr, /larger than/u);
  assert.equal(fs.existsSync(path.join(dirs.profile, 'profile-owner.json')), false, 'the profile was never claimed');
});

test('output: text mode streams deltas to stdout and keeps diagnostics on stderr', () => {
  const streams = captureStreams();
  const output = createOutput({ format: 'text', stdout: streams.stdout, stderr: streams.stderr });
  const base = { v: 1, run_id: 'r', session_id: 's', event_seq: 0 };
  output.frame({ ...base, kind: 'delta', payload: { text: 'Hello' } });
  output.frame({ ...base, kind: 'tool_use', payload: { call_id: 'c', tool_name: 'read_file', summary: 'fixture.txt' } });
  output.frame({ ...base, kind: 'delta', payload: { text: ' world' } });
  output.frame({ ...base, kind: 'result', payload: { subtype: 'success', is_error: false, exit_code: 0, result: 'Hello world' } });
  assert.equal(streams.out.stdout, 'Hello\n world\n');
  assert.match(streams.out.stderr, /\[tool\] read_file: fixture.txt/u);
  const json = captureStreams();
  const jsonOut = createOutput({ format: 'json', stdout: json.stdout, stderr: json.stderr });
  jsonOut.frame({ ...base, kind: 'delta', payload: { text: 'x' } });
  jsonOut.frame({ ...base, kind: 'result', payload: { subtype: 'success' } });
  assert.equal(json.out.stdout.trim().split('\n').length, 1, 'json prints the result frame only');
});

test('classify: the exit owed wins in order', () => {
  const complete = { raw: { type: 'complete' }, frame: { kind: 'complete' } };
  assert.deepEqual(classify({ cancelledBy: 'SIGTERM', timedOut: true, terminal: complete }), { reason: 'cancelled', signal: 'SIGTERM' });
  assert.deepEqual(classify({ timedOut: true, terminal: complete }), { reason: 'timeout' });
  assert.deepEqual(classify({ terminal: { raw: { type: 'error', message: 'model generation failed: budget_exhausted' }, frame: { kind: 'error' } } }), { reason: 'budget' });
  assert.deepEqual(classify({ terminal: { raw: { type: 'complete', status: 'denied' }, frame: { kind: 'complete' } } }), { reason: 'denied' });
  assert.deepEqual(classify({ terminal: complete, inputRequired: true }), { reason: 'input_required' });
  assert.deepEqual(classify({ work: { status: 'needs_attention' } }), { reason: 'input_required' });
  assert.deepEqual(classify({ terminal: complete }), { reason: 'complete' });
  assert.deepEqual(classify({ work: { status: 'failed' } }), { reason: 'error' });
  // A lost profile lock is an error (exit 6 through the aggregator), whatever else happened.
  assert.deepEqual(classify({ cancelledBy: 'SIGINT', terminal: complete, lockLost: new Error('lost') }), { reason: 'error' });
  // A paused work record is a resumable budget stop that names the work, never a cancel.
  assert.deepEqual(classify({ work: { status: 'paused', work_id: 'work_9' }, terminal: complete }),
    { reason: 'budget', resumable_stop: { reason: 'paused', work_id: 'work_9' } });
  assert.deepEqual(classify({ work: { status: 'paused' }, workId: 'work_8' }),
    { reason: 'budget', resumable_stop: { reason: 'paused', work_id: 'work_8' } });
});

test('print mode: a replay turn with a pre-allowed read ends with exit 0 and the result last', { timeout: 120_000 }, async (t) => {
  const dirs = tempRoot(t);
  const replay = replayScript(dirs.root, [
    { tool_calls: [{ tool_id: 'read_file', arguments: { path: 'fixture.txt' } }] },
    { text: 'The fixture says 51c2.' },
  ]);
  const { done } = runCli(['-p', '--engine', 'replay', '--output-format', 'stream-json', '--allowed-tools', 'read_file', 'Read the fixture.'], { dirs, replay });
  const run = await done;
  const list = frames(run.stdout);
  assert.equal(run.code, EXIT_CODES.OK, run.stderr);
  assert.equal(list[0].kind, 'init');
  assert.deepEqual(list[0].payload.allowed_tools, ['read_file']);
  assert.equal(list[0].payload.engine, 'replay');
  assert.equal(list[0].payload.budgets.timeout_ms, DEFAULT_TIMEOUT_MS);
  assert.ok(list.some((f) => f.kind === 'accepted'), 'durable acceptance precedes the stream');
  assert.ok(list.some((f) => f.kind === 'tool_result' && f.payload.status === 'ok' && f.payload.tool_name === 'read_file'));
  const result = resultOf(list);
  assert.equal(result.subtype, 'success');
  assert.equal(result.exit_code, 0);
  assert.match(result.result, /51c2/u);
  assert.deepEqual(result.permission_denials, []);
  assert.equal(result.num_turns, 1);
  assert.match(run.stderr, /\[timing\] host ready \d+ ms/u, 'cold start is recorded');
  assert.equal(fs.existsSync(path.join(dirs.profile, 'profile-owner.json')), true);

  // Text mode on the same profile: stdout is the answer and nothing else; the prompt may come from stdin.
  const text = await runCli(['-p', '--engine', 'replay', '--allowed-tools', 'read_file'], { dirs, replay, stdinText: 'Read the fixture.\n' }).done;
  assert.equal(text.code, EXIT_CODES.OK, text.stderr);
  assert.equal(text.stdout, 'The fixture says 51c2.\n');
});

test('print mode: a tool outside the ceiling is denied by policy (exit 3) and nothing is written', { timeout: 120_000 }, async (t) => {
  const dirs = tempRoot(t);
  const replay = replayScript(dirs.root, [
    { tool_calls: [{ tool_id: 'write_file', arguments: { path: 'out.txt', content: 'never' } }] },
    { text: 'Wrote it.' },
  ]);
  const run = await runCli(['-p', '--engine', 'replay', '--output-format', 'stream-json', 'Write out.txt'], { dirs, replay }).done;
  const list = frames(run.stdout);
  assert.equal(run.code, EXIT_CODES.POLICY_DENIED, run.stderr);
  const decision = list.find((f) => f.kind === 'decision');
  assert.deepEqual([decision.payload.outcome, decision.payload.by, decision.payload.rule, decision.payload.tool_name], ['deny', 'policy', 'not_pre_allowed', 'write_file']);
  const result = resultOf(list);
  assert.equal(result.subtype, 'denied');
  assert.equal(result.permission_denials.length, 1);
  assert.equal(result.permission_denials[0].tool_name, 'write_file');
  assert.equal(fs.existsSync(path.join(dirs.workspace, 'out.txt')), false);
});

test('print mode: budgets and timeouts end the run with exit 5', { timeout: 120_000 }, async (t) => {
  const dirs = tempRoot(t);
  const replay = replayScript(dirs.root, [
    { tool_calls: [{ tool_id: 'read_file', arguments: { path: 'fixture.txt' } }] },
    { tool_calls: [{ tool_id: 'read_file', arguments: { path: 'fixture.txt' } }] },
    { text: 'Read it twice.' },
  ]);
  const budget = await runCli(['-p', '--engine', 'replay', '--output-format', 'stream-json', '--allowed-tools', 'read_file',
    '--max-inference-requests', '1', 'Read twice'], { dirs, replay }).done;
  const list = frames(budget.stdout);
  assert.equal(budget.code, EXIT_CODES.BUDGET, budget.stderr);
  assert.equal(list[0].payload.budgets.max_inference_requests, 1);
  assert.equal(resultOf(list).subtype, 'budget');

  const timeout = await runCli(['-p', '--engine', 'replay', '--output-format', 'stream-json', '--allowed-tools', 'read_file',
    '--timeout', '0.001', 'Read twice'], { dirs, replay }).done;
  assert.equal(timeout.code, EXIT_CODES.BUDGET, timeout.stderr);
  assert.equal(resultOf(frames(timeout.stdout)).subtype, 'budget');
});

test('print mode: a question nobody can answer is declined and the run reports input required (exit 4)', { timeout: 120_000 }, async (t) => {
  const dirs = tempRoot(t);
  const replay = replayScript(dirs.root, [
    { tool_calls: [{ tool_id: 'ask_user', arguments: { questions: [{ id: 'q1', prompt: 'Which file?', options: ['a', 'b'] }] } }] },
    { text: 'No answer came.' },
  ]);
  const run = await runCli(['-p', '--engine', 'replay', '--output-format', 'stream-json', 'Ask me'], { dirs, replay }).done;
  const list = frames(run.stdout);
  assert.equal(run.code, EXIT_CODES.DECISION_REQUIRED, run.stderr);
  const decision = list.find((f) => f.kind === 'decision');
  assert.deepEqual([decision.payload.request, decision.payload.outcome, decision.payload.by], ['user_questions', 'decline', 'policy']);
  assert.equal(resultOf(list).subtype, 'input_required');
});

test('print mode: a held profile answers busy (exit 75) and a closed caller pipe cancels (exit 130)', { timeout: 120_000 }, async (t) => {
  const dirs = tempRoot(t);
  fs.mkdirSync(dirs.profile, { recursive: true });
  const holder = spawn(process.execPath, [LOCK_CHILD, dirs.profile, PYTHON], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  t.after(() => { if (holder.exitCode === null) holder.kill(); });
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  const busy = await runCli(['-p', '--engine', 'replay', '--output-format', 'stream-json', 'hello'], { dirs }).done;
  assert.equal(busy.code, EXIT_CODES.PROFILE_BUSY, busy.stderr);
  const busyFrames = frames(busy.stdout);
  assert.equal(busyFrames[0].kind, 'error');
  assert.equal(busyFrames[0].payload.code, 'CMP-CLI-0005');
  assert.equal(resultOf(busyFrames).exit_code, EXIT_CODES.PROFILE_BUSY);
  holder.stdin.end();
  await new Promise((resolve) => holder.once('exit', resolve));

  const replay = replayScript(dirs.root, [{ text: 'never reached' }]);
  const { child, done } = runCli(['-p', '--engine', 'replay', '--output-format', 'stream-json', '--cancel-on-stdin-close', 'hello'], { dirs, replay, stdin: 'pipe' });
  child.stdin.end();
  const cancelled = await done;
  assert.equal(cancelled.code, EXIT_CODES.SIGINT, cancelled.stderr);
  const result = resultOf(frames(cancelled.stdout));
  assert.equal(result.subtype, 'cancelled');
  assert.equal(result.exit_code, 130);
});

test('print mode: a piped stdin the caller neither writes nor closes is left alone when the prompt is an argument', { timeout: 120_000 }, async (t) => {
  const dirs = tempRoot(t);
  const replay = replayScript(dirs.root, [{ text: 'Done without stdin.' }]);
  // The parent keeps the pipe open and silent for the whole run (the default for a spawned child).
  const { child, done } = runCli(['-p', '--engine', 'replay', 'hello'], { dirs, replay, stdin: 'pipe' });
  const run = await done;
  assert.equal(run.code, EXIT_CODES.OK, run.stderr);
  assert.equal(run.stdout, 'Done without stdin.\n');
  child.stdin.end();
  // And closing it early without the opt-in is not a cancel either.
  const early = runCli(['-p', '--engine', 'replay', 'hello'], { dirs, replay, stdin: 'pipe' });
  early.child.stdin.end();
  const finished = await early.done;
  assert.equal(finished.code, EXIT_CODES.OK, finished.stderr);
});

test('print mode: a profile another host owns, or one holding data the CLI never imported, is a usage error (exit 2)', { timeout: 60_000 }, async (t) => {
  const dirs = tempRoot(t);
  fs.mkdirSync(dirs.profile, { recursive: true });
  fs.writeFileSync(path.join(dirs.profile, 'sessions.json'), '{}');
  const run = await runCli(['-p', '--engine', 'replay', '--output-format', 'stream-json', 'hello'], { dirs }).done;
  assert.equal(run.code, EXIT_CODES.USAGE, run.stderr);
  const list = frames(run.stdout);
  assert.equal(list[0].kind, 'error');
  assert.equal(list[0].payload.code, 'CMP-HOST-0004');
  assert.equal(list[0].payload.retryable, false);
  assert.equal(resultOf(list).exit_code, EXIT_CODES.USAGE);
  assert.equal(fs.existsSync(path.join(dirs.profile, 'profile-owner.json')), false);
});

test('print mode: a session resumes only inside the workspace it was bound to', { timeout: 120_000 }, async (t) => {
  const dirs = tempRoot(t);
  const other = path.join(dirs.root, 'other-workspace');
  fs.mkdirSync(other);
  const replay = replayScript(dirs.root, [{ text: 'First answer.' }]);
  const first = await runCli(['-p', '--engine', 'replay', '--output-format', 'stream-json', 'hello'], { dirs, replay }).done;
  assert.equal(first.code, EXIT_CODES.OK, first.stderr);
  const sessionId = frames(first.stdout)[0].session_id;
  const foreign = await runCli(['-p', '--engine', 'replay', '--output-format', 'stream-json', '--cwd', other, '--resume', sessionId, 'again'], { dirs, replay }).done;
  assert.equal(foreign.code, EXIT_CODES.USAGE, foreign.stderr);
  const list = frames(foreign.stdout);
  assert.match(list.find((f) => f.kind === 'error').payload.message, /another workspace/u);
  const missing = await runCli(['-p', '--engine', 'replay', '--output-format', 'stream-json', '--cwd', other, '-c', 'again'], { dirs, replay }).done;
  assert.equal(missing.code, EXIT_CODES.USAGE, missing.stderr);
  assert.match(frames(missing.stdout).find((f) => f.kind === 'error').payload.message, /no session to continue in this workspace/u);
  const same = await runCli(['-p', '--engine', 'replay', '--output-format', 'stream-json', '-c', 'again'], { dirs, replay }).done;
  assert.equal(same.code, EXIT_CODES.OK, same.stderr);
  assert.equal(frames(same.stdout)[0].session_id, sessionId, 'continue picks the latest session of this workspace');
});

test('doctor reports the sidecar python, the profile lock and the engine', { timeout: 60_000 }, async (t) => {
  const dirs = tempRoot(t);
  const run = await runCli(['doctor', '--json'], { dirs }).done;
  assert.equal(run.code, EXIT_CODES.OK, run.stderr + run.stdout);
  const report = JSON.parse(run.stdout);
  assert.equal(report.ok, true);
  const names = report.checks.map((entry) => entry.name);
  for (const name of ['node', 'sidecar_python', 'sidecar_module', 'workspace', 'profile', 'engine', 'permissions']) assert.ok(names.includes(name), name);
  assert.match(report.checks.find((entry) => entry.name === 'profile').detail, /free/u);
});
