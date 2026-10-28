'use strict';
// The sidecar manager and the Codex setup adapter destructure child_process at
// require time, so the recorder must be installed before any backend module loads.
const childProcess = require('node:child_process');
const SPAWN_APIS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'];
const originalApis = Object.fromEntries(SPAWN_APIS.map((name) => [name, childProcess[name]]));
const spawned = [];
for (const name of SPAWN_APIS) {
  childProcess[name] = function recordedSpawn(command, ...rest) {
    spawned.push({ api: name, command: String(command), args: Array.isArray(rest[0]) ? rest[0].map(String) : [] });
    return originalApis[name].call(this, command, ...rest);
  };
}

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { removeTreeSync } = require('../../services/fs-remove-no-follow');
const { composeCliBackend } = require('../../services/cli-host/composition');
const { createCliHost, hostComposition } = require('../../services/cli-host/host');
const { CLI_ERROR_CODES } = require('../../services/cli-host/local-only-providers');
const { CLI_CURATED_TOOLS } = require('../../services/cli-host/curated-tool-executor');

const ROOT = path.resolve(__dirname, '../..');
const PYTHON = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const FIXTURE_TEXT = 'CLI host fixture text 7f3a.';

test.after(() => { for (const name of SPAWN_APIS) childProcess[name] = originalApis[name]; });

function tempRoot(t, prefix) {
  const artifacts = path.join(ROOT, 'artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  const root = fs.mkdtempSync(path.join(artifacts, prefix));
  t.after(() => removeTreeSync(root));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  return { root, profile: path.join(root, 'profile'), workspace };
}

function baseOptions(dirs, overrides = {}) {
  return { profilePath: dirs.profile, workspaceRoot: dirs.workspace, repoRoot: ROOT,
    pythonExecutable: PYTHON, engine: { type: 'replay', model: 'replay-model' }, ...overrides };
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// The Windows venv python.exe is a launcher that runs the base interpreter as
// its child, so a gone launcher pid alone does not prove the interpreter exited.
function livingChildrenOf(pid) {
  if (process.platform !== 'win32') return [];
  const output = originalApis.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(pid)}").ProcessId`], { encoding: 'utf8' });
  return output.split(/\s+/u).filter(Boolean).map(Number).filter(isAlive);
}

function isCodexSpawn(entry) {
  return [entry.command, ...entry.args].some((token) => /^codex/iu.test(path.basename(token.trim().replace(/^"/u, ''))));
}

test('composition validates options before touching the profile', (t) => {
  const dirs = tempRoot(t, 'cli-host-validate-');
  const cases = [
    [{ profilePath: 'relative/profile' }, 'invalid_profile_path'],
    [{ workspaceRoot: path.join(dirs.root, 'missing') }, 'invalid_workspace_root'],
    [{ workspaceRoot: 'relative' }, 'invalid_workspace_root'],
    [{ workspaceRoot: dirs.root }, 'invalid_workspace_root'],
    [{ engine: { type: 'replay', model: 42 } }, 'invalid_engine'],
    [{ engine: null }, 'invalid_engine'],
    [{ pythonExecutable: '' }, 'invalid_python_executable'],
    [{ repoRoot: 'relative' }, 'invalid_repo_root'],
    [{ pythonExecutable: undefined }, 'invalid_python_executable'],
    [{ pythonExecutable: undefined, resolvePackagedLaunch: 'not-a-function' }, 'invalid_packaged_launch'],
    [{ pythonRuntimeBundleRoot: path.join(dirs.root, 'missing-bundle') }, 'invalid_python_runtime_bundle_root'],
    [{ pythonRuntimeBundleRoot: 'relative' }, 'invalid_python_runtime_bundle_root'],
  ];
  for (const [override, reason] of cases) {
    assert.throws(() => composeCliBackend(baseOptions(dirs, override)), (error) => {
      assert.ok(error instanceof TypeError, reason);
      assert.equal(error.code, CLI_ERROR_CODES.INVALID_OPTION);
      assert.equal(error.reason, reason);
      return true;
    }, reason);
  }
  assert.throws(() => composeCliBackend(baseOptions(dirs, { engine: { type: 'codex-cli', model: 'gpt' } })),
    { code: CLI_ERROR_CODES.ENGINE_NOT_LOCAL, reason: 'engine_not_local' });
  assert.equal(fs.existsSync(dirs.profile), false, 'a refused composition must not create the profile');
});

test('an unstarted host closes cleanly, ends its event iterators and refuses further use', async (t) => {
  const dirs = tempRoot(t, 'cli-host-unstarted-');
  const host = createCliHost(baseOptions(dirs));
  const { backend } = hostComposition(host);
  const listenersWithHost = backend.listenerCount('chat-stream');
  const iterator = host.events();
  const pending = iterator.next();
  assert.deepEqual(await host.close(), { ok: true, sidecar_exited: true });
  assert.deepEqual(await pending, { value: undefined, done: true });
  assert.deepEqual(await host.events().next(), { value: undefined, done: true });
  assert.equal(backend.listenerCount('chat-stream'), listenersWithHost - 1);
  const closedError = { code: CLI_ERROR_CODES.HOST_STATE, reason: 'host_closed' };
  await assert.rejects(host.start(), closedError);
  await assert.rejects(host.createSession({ title: 'late' }), closedError);
  await assert.rejects(host.submit({ session_id: 'x', prompt: 'y', idempotency_key: 'z' }), closedError);
  await assert.rejects(host.waitForWork('work_x', { timeoutMs: 10 }), closedError);
  assert.throws(() => hostComposition({}), { code: CLI_ERROR_CODES.HOST_STATE, reason: 'unknown_host' });
});

function useReplayScript(t, dirs, calls) {
  const script = path.join(dirs.root, 'replay.json');
  fs.writeFileSync(script, JSON.stringify({ version: 1, calls }));
  const prior = process.env.JENNY_REPLAY_SCRIPT;
  process.env.JENNY_REPLAY_SCRIPT = script;
  t.after(() => { if (prior === undefined) delete process.env.JENNY_REPLAY_SCRIPT; else process.env.JENNY_REPLAY_SCRIPT = prior; });
}

// The installed route (S9): no interpreter, a packaged-launch resolver and the resources
// directory as the sidecar cwd. The resolver here hands back the venv sidecar so the packaged
// plumbing runs end to end through the real sidecar.
test('a packaged-launch host runs a replay turn through the resolver it was given', { timeout: 80_000 }, async (t) => {
  const dirs = tempRoot(t, 'cli-host-packaged-');
  const bundle = path.join(dirs.root, 'resources');
  fs.mkdirSync(bundle);
  useReplayScript(t, dirs, [{ text: 'Packaged route 3b9e.' }]);
  const resolverCalls = [];
  const spawnStart = spawned.length;
  const host = createCliHost(baseOptions(dirs, {
    pythonExecutable: undefined,
    pythonRuntimeBundleRoot: bundle,
    resolvePackagedLaunch: async () => {
      resolverCalls.push(Date.now());
      return { ok: true, launchCommand: PYTHON, launchArgs: ['-m', 'sidecar'], launchSource: 'packaged-binary' };
    },
  }));
  const { backend } = hostComposition(host);
  let closed = false;
  try {
    assert.equal(backend.options.pythonExecutable, undefined, 'no interpreter reaches the backend in the packaged route');
    assert.equal(backend.options.pythonRuntimeBundleRoot, fs.realpathSync.native(bundle));
    assert.equal(resolverCalls.length, 0, 'the resolver runs inside start, not at composition');
    await host.start();
    assert.equal(resolverCalls.length, 1);
    assert.equal(backend.sidecarManager.getStatus().launchSource, 'packaged-binary');
    const { session_id: sessionId } = await host.createSession({ title: 'CLI packaged route' });
    const sent = await host.submit({ session_id: sessionId, prompt: 'Say the code.', idempotency_key: 'cli_host_packaged' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const work = await host.waitForWork(sent.work_id, { timeoutMs: 45_000 });
    assert.equal(work.status, 'completed', JSON.stringify(work));
    const messages = backend.sessionStore.getSessionMessages(sessionId);
    assert.match(String(messages.at(-1)?.content || ''), /Packaged route 3b9e/u);
    const flow = spawned.slice(spawnStart);
    assert.ok(flow.some((entry) => path.resolve(entry.command) === path.resolve(PYTHON) && entry.args.join(' ') === '-m sidecar'),
      `the sidecar is spawned from the resolver's launch: ${JSON.stringify(flow)}`);
    const outcome = await host.close();
    closed = true;
    assert.deepEqual(outcome, { ok: true, sidecar_exited: true });
  } finally {
    if (!closed) await host.close();
  }
});

test('a refused packaged launch fails the start with the resolver\'s reason and spawns nothing', { timeout: 30_000 }, async (t) => {
  const dirs = tempRoot(t, 'cli-host-packaged-refused-');
  const spawnStart = spawned.length;
  const host = createCliHost(baseOptions(dirs, {
    pythonExecutable: '',
    resolvePackagedLaunch: async () => ({ ok: false, launchCommand: '', launchArgs: [], launchSource: 'packaged-binary',
      failureReason: 'Packaged sidecar manifest missing: resources/sidecar/manifest.json' }),
  }));
  try {
    await assert.rejects(host.start(), /manifest missing/u);
    assert.deepEqual(spawned.slice(spawnStart).filter((entry) => entry.api === 'spawn' && /python|sidecar/iu.test(entry.command)), []);
  } finally {
    await host.close();
  }
});

test('CLI host runs a replay turn with a sidecar read_file and leaves no process behind', { timeout: 80_000 }, async (t) => {
  const dirs = tempRoot(t, 'cli-host-');
  fs.writeFileSync(path.join(dirs.workspace, 'fixture.txt'), FIXTURE_TEXT);
  const script = path.join(dirs.root, 'replay.json');
  fs.writeFileSync(script, JSON.stringify({ version: 1, calls: [
    { tool_calls: [{ tool_id: 'read_file', arguments: { path: 'fixture.txt' } }] },
    { text: 'Read the fixture.' },
  ] }));
  const prior = process.env.JENNY_REPLAY_SCRIPT;
  process.env.JENNY_REPLAY_SCRIPT = script;
  t.after(() => { if (prior === undefined) delete process.env.JENNY_REPLAY_SCRIPT; else process.env.JENNY_REPLAY_SCRIPT = prior; });
  const spawnStart = spawned.length;
  const logs = [];
  // Under the ceiling nothing is auto unless the run names it, read_file included.
  const host = createCliHost(baseOptions(dirs, { permissions: { allowedTools: ['read_file'] },
    logger: (level, event, data) => logs.push({ level, event, data }) }));
  const { backend, toolExecutor } = hostComposition(host);
  const listenersWithHost = backend.listenerCount('chat-stream');
  const events = [];
  const pump = (async () => { for await (const event of host.events()) events.push(event); })();
  let closed = false;
  try {
    assert.deepEqual(toolExecutor.registry.getAllTools().map((tool) => tool.name).sort(), [...CLI_CURATED_TOOLS]);
    assert.equal(toolExecutor.registry.getTool('run_command'), undefined);
    await host.start();
    const { session_id: sessionId } = await host.createSession({ title: 'CLI host composition' });
    assert.ok(sessionId);
    const sent = await host.submit({ session_id: sessionId, prompt: 'Read the fixture.', idempotency_key: 'cli_host_fixture' });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const work = await host.waitForWork(sent.work_id, { timeoutMs: 45_000 });
    assert.equal(work.status, 'completed', JSON.stringify(work));
    await assert.rejects(host.waitForWork('work_unknown_cli', { timeoutMs: 100 }), { code: CLI_ERROR_CODES.WORK_WAIT });

    const results = backend.sessionStore.getSession(sessionId).turn_events.filter((row) => row.kind === 'tool_result');
    assert.deepEqual(results.map((row) => row.payload.tool_name), ['read_file'], JSON.stringify(results));
    assert.equal(results[0].payload.success, true);
    assert.match(results[0].payload.tool_output_summary, /CLI host fixture text 7f3a/u);
    assert.ok(events.some((event) => event.type === 'tool_result'), JSON.stringify(events.map((event) => event.type)));
    assert.ok(events.some((event) => event.type === 'complete'), JSON.stringify(events.map((event) => event.type)));

    // The registry is still closed after a full turn: nothing registered desktop tools at start.
    assert.deepEqual(backend.toolExecutor.registry.getAllTools().map((tool) => tool.name).sort(), [...CLI_CURATED_TOOLS]);

    // No credential can land: the store reports encryption unavailable and refuses the write.
    const status = backend.secureStore.getStatus();
    assert.equal(status.status, 'unavailable');
    assert.equal(status.ready, false);
    assert.equal(status.encryptionAvailable, false);
    assert.notEqual(status.storageBackend, 'basic_text');
    assert.throws(() => backend.secureStore.setWebSearchProviderKey('brave', 'cli-placeholder-value'), /Refusing to store/u);
    assert.throws(() => backend.secureStore.setModelProviderOAuth('chatgpt', '{"placeholder":true}'), /Refusing to store/u);
    const securePath = path.join(dirs.profile, 'secure-state.json');
    if (fs.existsSync(securePath)) assert.doesNotMatch(fs.readFileSync(securePath, 'utf8'), /cli-placeholder-value|placeholder/u);

    // The Codex integration is inert: exercising its auth surface spawns nothing.
    const codexState = await backend.codexCliAuthService.getState();
    assert.equal(codexState.ok, false);
    assert.equal(codexState.code, 'cli_unsupported');
    assert.equal((await backend.codexCliAuthService.openLoginTerminal()).ok, false);
    assert.equal(backend.codexCliRuntimeService.getState().enabled === true, false);

    const pid = backend.sidecarManager.getStatus().pid;
    assert.ok(Number.isSafeInteger(pid) && pid > 0, 'the managed sidecar pid must be visible');
    const interpreters = livingChildrenOf(pid);
    const outcome = await host.close();
    closed = true;
    assert.deepEqual(outcome, { ok: true, sidecar_exited: true });
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    for (const child of interpreters) assert.equal(isAlive(child), false, `sidecar interpreter ${child} survived close`);
    assert.deepEqual(await host.close(), { ok: true, sidecar_exited: true });
    await pump;
    assert.equal(backend.listenerCount('chat-stream'), listenersWithHost - 1, 'close must remove the host listener');

    const flow = spawned.slice(spawnStart);
    assert.ok(flow.some((entry) => path.resolve(entry.command) === path.resolve(PYTHON)),
      `the recorder must see the sidecar spawn: ${JSON.stringify(flow)}`);
    assert.deepEqual(flow.filter(isCodexSpawn), []);
    t.diagnostic(JSON.stringify({ spawned: flow.map((entry) => path.basename(entry.command)),
      sidecar_interpreters_checked: interpreters.length }));
  } catch (error) {
    t.diagnostic(JSON.stringify({ events: events.map((event) => event.type),
      logs: logs.filter((entry) => /error|fail/iu.test(JSON.stringify(entry))).slice(-8) }));
    throw error;
  } finally {
    if (!closed) await host.close();
  }
});
