'use strict';

// new-test-file: team host file tools, slice 2 (row 123, docs/plans/TEAM_HOST_FILE_TOOLS_2026-11-16.md). The host
// setting reaches the sidecar's worker as a root boundary, never on the single-owner hosted path, and the managed
// status keeps the worker's report. tests/server/host-composition.test.js is at the line cap, so the composition
// cases live here. The last test is two processes: the hosted backend and a real Python sidecar on a replay script.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createHostedBackend } = require('../../services/host/service-composition');
const { buildManagedStatusSnapshot } = require('../../services/backend/managed-sidecar-status');
const { createCommandRouter } = require('../../server/command-router');
const { BackendEvents } = require('../../server/backend-events');
const { ClientRegistry } = require('../../server/client-registry');
const { CommandReceipts } = require('../../server/command-receipts');
const { ControlLeases } = require('../../server/control-leases');

const ROOT = path.resolve(__dirname, '../..');
const PYTHON = process.env.JENNY_TEST_PYTHON || path.resolve(ROOT, '.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const credentialService = { get: () => '', getStatus: () => ({ ready: true }) };

function tempBase(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-file-tools-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => path.join(base, 'home'));
  for (const dir of ['profile', 'projects', 'projects/project_a', 'projects/project_b']) fs.mkdirSync(path.join(base, dir));
  return base;
}

function teamBackend(base, extra = {}) {
  return createHostedBackend({ hostMode: 'server', credentialService, userDataPath: path.join(base, 'profile'),
    workspaceRoot: null, modelEndpoint: null, modelOptional: true, ...extra });
}

const BOUNDARY_KEYS = ['hosted_root_boundary', 'hosted_win32_files'];
const keysOf = (config) => BOUNDARY_KEYS.filter((key) => Object.hasOwn(config, key));

test('the setting on sends the projects root as the boundary with the Windows switch; off sends neither key', async (t) => {
  const base = tempBase(t);
  const projectsRoot = path.join(base, 'projects');
  const on = teamBackend(base, { projectsRoot, memberTurns: true, hostFileTools: true });
  try {
    const config = on.backend._buildManagedSidecarConfig();
    assert.equal(config.hosted_root_boundary, projectsRoot);
    assert.equal(config.hosted_win32_files, true);
    assert.equal(config.tools_workspace_root, null, 'no process root (I4)');
    assert.equal(on.backend.hostRootBoundary, projectsRoot);
  } finally { await on.dispose(); }
  for (const extra of [{}, { hostFileTools: false }, { hostFileTools: 'yes' }]) {
    const off = teamBackend(base, { projectsRoot, memberTurns: true, ...extra });
    try {
      assert.deepEqual(keysOf(off.backend._buildManagedSidecarConfig()), [], JSON.stringify(extra));
      assert.equal(off.backend.hostRootBoundary, null);
    } finally { await off.dispose(); }
  }
});

test('never on the single-owner hosted path: the setting needs a team host projects root (I5)', async (t) => {
  const base = tempBase(t);
  const refused = (error) => error.code === 'CMP-HOST-0001' && error.reason === 'file_tools_projects_root_required';
  assert.throws(() => teamBackend(base, { hostFileTools: true, memberTurns: true }), refused);
  assert.throws(() => teamBackend(base, { hostFileTools: true, projectsRoot: path.join(base, 'projects') }), refused,
    'a projects root without member turns is not a team host');
  assert.throws(() => teamBackend(base, { hostFileTools: true, workspaceRoot: path.join(base, 'projects') }), refused);
  const single = teamBackend(base, { workspaceRoot: path.join(base, 'projects') });
  try {
    assert.deepEqual(keysOf(single.backend._buildManagedSidecarConfig()), []);
    single.backend.hostRootBoundary = path.join(base, 'projects'); // even a stray property sends nothing there
    assert.deepEqual(keysOf(single.backend._buildManagedSidecarConfig()), []);
  } finally { await single.dispose(); }
});

test('host-core passes the loaded team.file_tools to the hosted backend, false without it', () => {
  const { createHostCore } = require('../../server/host-core');
  const seen = [];
  const createBackend = (options) => { seen.push(options.hostFileTools); throw new Error('captured'); };
  const config = { userDataPath: ROOT, secretsDir: ROOT, modelEndpoint: null };
  const team = { name: 'T', keySource: 'parent_channel', directPort: null, projectsRoot: path.join(ROOT, 'projects') };
  for (const each of [config, { ...config, team }, { ...config, team: { ...team, fileTools: false } },
    { ...config, team: { ...team, fileTools: true } }]) {
    assert.throws(() => createHostCore({ config: each, createBackend, launch: { repoRoot: ROOT } }), /captured/);
  }
  assert.deepEqual(seen, [false, false, false, true]);
});

test('the managed status keeps the worker report in its closed shape and only when the sidecar sends one', () => {
  const service = { currentEngineType: 'replay', currentModel: 'replay-model', currentStatus: {} };
  assert.equal(buildManagedStatusSnapshot(service, {}).hosted_files, undefined);
  assert.deepEqual(buildManagedStatusSnapshot(service, { hosted_files: { available: true, reason: null } }).hosted_files,
    { available: true, reason: null });
  assert.deepEqual(buildManagedStatusSnapshot(service, { hosted_files: { available: true, reason: 'file_access_elevated' } })
    .hosted_files, { available: false, reason: 'file_access_elevated' }, 'a reason is never available');
  assert.deepEqual(buildManagedStatusSnapshot(service, { hosted_files: { available: 'yes', reason: 'C:\\Users\\x' } })
    .hosted_files, { available: false, reason: null }, 'a path is not a word');
});

test('a launch keeps a saved file_tools true in the config it writes afresh; nothing else adds it (I11)', (t) => {
  const { buildHostConfig, carryFileTools, prepareHostLayout, writeHostConfig } = require('../../services/team/host/host-layout');
  const base = tempBase(t);
  const layout = prepareHostLayout(path.join(base, 'profile'));
  const fresh = () => buildHostConfig({ layout, name: 'Studio', directPort: 4242 });
  const written = [];
  const launchWrite = carryFileTools((_layout, config) => written.push(config), path.join(base, 'profile'));
  launchWrite(layout, fresh());
  assert.equal(Object.hasOwn(written.at(-1).team, 'file_tools'), false, 'nothing saved: a deploy writes none');
  for (const [saved, expected] of [[true, true], [false, undefined], ['yes', undefined]]) {
    writeHostConfig(layout, { ...fresh(), team: { ...fresh().team, file_tools: saved } });
    launchWrite(layout, fresh());
    assert.equal(written.at(-1).team.file_tools, expected, JSON.stringify(saved));
  }
  launchWrite(layout, { ...fresh(), team: { ...fresh().team, file_tools: false } });
  assert.equal(written.at(-1).team.file_tools, false, 'a config that states the setting keeps its own value');
});

// --- Two processes: a team host's turn reads and writes in its project and is refused another project's file ---

function withReplay(t, root, calls) {
  const script = path.join(root, 'replay.json');
  fs.writeFileSync(script, JSON.stringify({ version: 1, calls }), 'utf8');
  const prior = process.env.JENNY_REPLAY_SCRIPT;
  process.env.JENNY_REPLAY_SCRIPT = script;
  t.after(() => { if (prior === undefined) delete process.env.JENNY_REPLAY_SCRIPT; else process.env.JENNY_REPLAY_SCRIPT = prior; });
}

function waitFor(predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      let value = null;
      try { value = predicate(); } catch (_error) { /* retry while the sidecar starts */ }
      if (value) return resolve(value);
      if (Date.now() >= deadline) return reject(new Error('team host file tools wait timed out'));
      return setTimeout(poll, 25);
    };
    poll();
  });
}

test('a team project turn reads and writes in its own folder and is refused a second project\'s file',
  { timeout: 90_000 }, async (t) => {
    assert.equal(fs.existsSync(PYTHON), true, 'Test Python runtime must be provisioned.');
    const base = tempBase(t);
    const projectsRoot = path.join(base, 'projects');
    fs.writeFileSync(path.join(projectsRoot, 'project_a', 'notes.txt'), 'alpha notes 4c1e\n');
    fs.writeFileSync(path.join(projectsRoot, 'project_b', 'secret.txt'), 'beta secret 9d2f\n');
    withReplay(t, base, [
      { tool_calls: [{ tool_id: 'read_file', arguments: { path: 'notes.txt' } }] },
      { tool_calls: [{ tool_id: 'write_file', arguments: { path: 'made.txt', content: 'made on the host\n' } }] },
      { tool_calls: [{ tool_id: 'edit_file', arguments: { file_path: 'notes.txt', old_string: 'alpha', new_string: 'gamma' } }] },
      { tool_calls: [{ tool_id: 'read_file', arguments: { path: '../project_b/secret.txt' } }] },
      // The replay index counts history rows and a refused call adds one; trailing text entries keep it
      // from wrapping back to an already admitted call id.
      ...Array.from({ length: 4 }, () => ({ text: 'Done with the project files.' })),
    ]);
    const host = createHostedBackend({ hostMode: 'server', credentialService, userDataPath: path.join(base, 'profile'),
      workspaceRoot: null, modelEndpoint: { engine: 'replay', model: 'replay-model' }, repoRoot: ROOT,
      pythonExecutable: PYTHON, projectsRoot, memberTurns: true, hostFileTools: true });
    const clients = new ClientRegistry();
    const owner = clients.register('device-owner');
    const events = new BackendEvents({ backend: host.backend, bootEpoch: 'boot_files' });
    const router = createCommandRouter({ backend: host.backend, clients, leases: new ControlLeases(),
      receipts: new CommandReceipts({ filePath: path.join(base, 'command-receipts.json') }),
      bootEpoch: 'boot_files', eventStream: events });
    const context = { clientToken: owner.client_token, deviceId: 'device-owner', isAuthenticated: () => true };
    let sequence = 0;
    const dispatch = async (operation, params = {}, extra = {}) => router.dispatch({ api_version: 1,
      boot_epoch: 'boot_files', client_id: owner.client_id, request_id: `files_${++sequence}`, operation, params, ...extra },
    context);
    try {
      await host.start();
      const status = await waitFor(() => host.backend.currentStatus?.hosted_files);
      assert.deepEqual(status, { available: true, reason: null }, 'the worker started its file tools');
      const { project } = host.backend.projectService.create({ name: 'Project A' });
      assert.equal(host.backend.projectService.bindRoot(project.id, path.join(projectsRoot, 'project_a')).ok, true);
      const created = await dispatch('sessions.create', { title: 'Files', project_id: project.id });
      assert.equal(created.ok, true, JSON.stringify(created));
      const sessionId = created.session.session_id;
      const lease = (await dispatch('control.acquire', { takeover: false }, { session_id: sessionId })).lease;
      let settle;
      const terminal = new Promise((resolve) => { settle = resolve; });
      host.backend.on('chat-stream', (event) => {
        if (['complete', 'error', 'cancelled'].includes(event?.type)) settle(event);
      });
      const sent = await dispatch('chat.send', { prompt: 'Work on the project files.' }, { session_id: sessionId,
        control_generation: lease.generation, expected_revision: router.snapshot(sessionId).session.revision });
      assert.equal(sent.ok, true, JSON.stringify(sent));
      for (const expected of ['write_file', 'edit_file']) {
        const pending = await waitFor(() => router.snapshot(sessionId).pending_approvals?.[0]);
        assert.equal(pending.tool_name, expected, JSON.stringify(pending));
        const approved = await dispatch('approval.resolve', { stream_id: pending.stream_id,
          approval_id: pending.approval_id, decision_revision: pending.decision_revision, approved: true },
        { session_id: sessionId, control_generation: lease.generation,
          expected_revision: router.snapshot(sessionId).session.revision });
        assert.equal(approved.ok, true, JSON.stringify(approved));
        await waitFor(() => router.snapshot(sessionId).pending_approvals?.[0]?.approval_id !== pending.approval_id);
      }
      const final = await terminal;
      assert.equal(final.type, 'complete', JSON.stringify(final));
      const results = host.backend.sessionStore.getSession(sessionId).turn_events
        .filter((row) => row.kind === 'tool_result').map((row) => row.payload);
      assert.deepEqual(results.map((row) => row.tool_name), ['read_file', 'write_file', 'edit_file', 'read_file'],
        JSON.stringify(results));
      assert.equal(results[0].success, true);
      assert.match(results[0].tool_output_summary, /alpha notes 4c1e/u);
      assert.equal(results[1].success, true, JSON.stringify(results[1]));
      assert.equal(fs.readFileSync(path.join(projectsRoot, 'project_a', 'made.txt'), 'utf8'), 'made on the host\n');
      assert.equal(results[2].success, true, JSON.stringify(results[2]));
      assert.equal(fs.readFileSync(path.join(projectsRoot, 'project_a', 'notes.txt'), 'utf8'), 'gamma notes 4c1e\n');
      assert.equal(results[3].success, false, 'a second project\'s file is refused');
      assert.doesNotMatch(JSON.stringify(results), /beta secret 9d2f/u);
      // D8 across both processes: the edit kept no copy of the old text in the profile's stores; the only
      // files there are empty owner locks.
      const stored = ['workspace-snapshots', 'workspace-recovery'].flatMap((name) => {
        const dir = path.join(base, 'profile', name);
        return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((rel) => path.join(dir, rel)) : [];
      }).filter((file) => fs.statSync(file).isFile() && fs.statSync(file).size > 0);
      assert.deepEqual(stored, [], 'no snapshot or recovery object outside the project folder');
    } finally {
      router.dispose();
      events.dispose();
      try { await host.stop(); } catch (_error) { /* cleanup only */ }
      host.dispose();
    }
  });
