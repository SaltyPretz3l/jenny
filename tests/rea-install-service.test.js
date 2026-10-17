const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { trackDirectory, cleanupTrackedResources } = require('./helpers/resource-cleanup');
const { ReaInstallService, reaPresetRow } = require('../services/rea-install-service');
const provenance = require('../config/rea-install-manifest.json');
const { McpDiscoveryService } = require('../services/mcp-discovery-service');
const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');
const { createJennyShellBridge } = require('../services/ipc-contract');
const { writeConfig, approvedServer } = require('./helpers/mcp-discovery-fixtures');

test.afterEach(cleanupTrackedResources);
const bytes = Buffer.from('pinned rea fixture');
const manifest = { ...provenance, tarballBytes: bytes.length,
  sha256: crypto.createHash('sha256').update(bytes).digest('hex') };

function write(file, value = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

const SECRET_STDERR = 'C:\\Users\\x\\secret token=abc \\\\fileserver\\share\\Users\\brend\\x '
  + '//registry.npmjs.org/:_authToken=npm_SECRETVALUE';

function harness(options = {}) {
  const realUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-rea-'));
  trackDirectory(realUserData);
  let userDataPath = realUserData;
  if (options.junction) {
    // A relocated profile reached through a junction must keep working.
    userDataPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-rea-link-')), 'profile');
    trackDirectory(path.dirname(userDataPath));
    fs.symlinkSync(realUserData, userDataPath, 'junction');
  }
  const home = path.join(userDataPath, 'home');
  const calls = { npm: [], download: [], update: [], refresh: [], probe: [], log: [], fetch: 0 };
  let rows = options.rows || [reaPresetRow(manifest)];
  const discovery = {
    getState: () => ({ servers: rows }),
    updateServer: async (payload) => {
      calls.update.push(payload);
      if (options.updateResult) return options.updateResult;
      rows = [{ ...payload.server, enabled: false }];
      return { ok: true };
    },
  };
  const fsImpl = { ...fs, existsSync: (file) => file === nodePath
    ? options.nodeFound !== false : fs.existsSync(file), ...options.fsImpl };
  const nodePath = path.win32.join(manifest.nodeRoot, 'node.exe');
  const svc = new ReaInstallService({ manifest, userDataPath, discovery,
    platform: options.platform || 'win32', homedir: () => home, fsImpl,
    env: { PATH: 'system', JENNY_TEST: 'private', jenny_other: 'private', API_TOKEN: 'abc' },
    logger: (...args) => calls.log.push(args),
    skillsService: { getUserRoot: () => path.join(home, '.companion', 'skills'),
      getState: () => ({ scopes: [] }),
      getSidecarConfig: () => ({ skills_user_enabled: options.scopeEnabled === true }),
      refreshState: async (payload) => { calls.refresh.push(payload); if (options.refreshFails) throw new Error('refresh'); } },
    fetchImpl: () => { calls.fetch++; throw new Error('unexpected fetch'); },
    downloadImpl: async (payload) => {
      calls.download.push(payload);
      if (options.downloadImpl) return options.downloadImpl(payload);
      write(payload.destPath, options.shortDownload ? bytes.subarray(1) : bytes);
      payload.onProgress({ downloadedBytes: bytes.length, totalBytes: bytes.length });
      return options.badHash ? '0'.repeat(64) : manifest.sha256;
    },
    execFile: (file, args, spawnOptions, callback) => {
      if (args[0] === '--version') {
        if (options.nodeProbe) return options.nodeProbe(callback);
        callback(null, `${options.nodeVersion || 'v22.23.2'}\n`, '');
        return;
      }
      calls.npm.push({ file, args, options: spawnOptions });
      if (options.npmFails) return callback(new Error('npm failed'), '', SECRET_STDERR);
      const pkg = path.join(spawnOptions.cwd, 'node_modules', 'rea-agents');
      write(path.join(pkg, 'package.json'), JSON.stringify({ name: manifest.package,
        version: options.invalidInstall ? '0.0.1' : manifest.version }));
      write(path.join(pkg, 'scripts', 'rea.mjs'));
      const skill = path.join(pkg, 'skills', manifest.skill);
      write(path.join(skill, 'SKILL.md'), '# rea');
      write(path.join(skill, 'references', 'a.md'), 'reference');
      write(path.join(skill, 'references', 'evil.txt'), 'skip');
      write(path.join(skill, 'references', 'directory.md', 'nested.md'), 'skip');
      write(path.join(skill, 'other.md'), 'skip');
      try { fs.symlinkSync(path.join(skill, 'SKILL.md'), path.join(skill, 'references', 'link.md')); }
      catch (error) { if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error; }
      // A junction needs no privilege on Windows: the one link kind this host can always plant.
      write(path.join(userDataPath, 'outside', 'keep.md'), 'outside');
      fs.symlinkSync(path.join(userDataPath, 'outside'), path.join(skill, 'references', 'j.md'), 'junction');
      callback(null, '', '');
    },
    probeImpl: async (payload) => {
      calls.probe.push(payload);
      return options.probeFails ? { healthy: false, reason: SECRET_STDERR } : { healthy: true };
    }, ...options.serviceOptions });
  return { svc, calls, discovery, userDataPath };
}

function oldInstall(svc) {
  write(path.join(svc.currentDir, 'old.txt'), 'old install');
}

function noStaging(svc) {
  assert.deepEqual(fs.readdirSync(svc.prefixDir).filter((name) => name.startsWith('staging-')), []);
}

test('plan uses local Node and reads the installed version and managed command without fetching', async () => {
  const { svc, calls } = harness({ scopeEnabled: true });
  write(path.join(svc.packageDir, 'package.json'), JSON.stringify({ name: manifest.package, version: manifest.version }));
  write(path.join(svc.skillTargetDir, 'SKILL.md'), '# skill');
  await svc.discovery.updateServer({ name: 'rea', server: svc.managedRow() });
  const plan = await svc.getInstallPlan();
  assert.deepEqual(plan.node, { found: true, version: 'v22.23.2', supported: true });
  assert.deepEqual(plan.installed, { version: manifest.version, upToDate: true, managedCommand: true });
  assert.deepEqual(plan.skill, { name: manifest.skill, copied: true, scopeEnabled: true });
  assert.deepEqual(plan.connection, { present: true, enabled: false });
  assert.equal(plan.active, null);
  assert.equal(plan.prefix, svc.currentDir);
  assert.equal(calls.fetch, 0);
  assert.equal(calls.download.length, 0);
  assert.equal(calls.npm.length, 0);
});

for (const [version, supported] of [['v22.18.0', false], ['v24.11.0', true], ['v23.5.0', false],
  ['v24.10.0', false], ['v26.0.0', true]]) {
  test(`plan checks ${version} against the pinned Node range`, async () => {
    const { svc, calls } = harness({ nodeVersion: version });
    assert.equal((await svc.getInstallPlan()).node.supported, supported);
    assert.equal(calls.fetch, 0);
  });
}

test('plan reports a found Node whose version probe fails as unsupported', async () => {
  const { svc } = harness({ nodeProbe: (callback) => callback(new Error('spawn')) });
  assert.deepEqual((await svc.getInstallPlan()).node, { found: true, version: '', supported: false });
});

for (const [code, options, payload] of [
  ['opt_in_required', { platform: 'linux', rows: [] }, {}],
  ['unsupported_platform', { platform: 'linux', rows: [] }, { confirmed: true }],
  ['connection_missing', { rows: [], nodeFound: false }, { confirmed: true }],
  ['connection_enabled', { rows: [{ name: 'rea', enabled: true }], nodeFound: false }, { confirmed: true }],
  ['node_missing', { nodeFound: false }, { confirmed: true }],
  ['node_unsupported', { nodeVersion: 'v22.18.0' }, { confirmed: true }],
]) {
  test(`install refuses ${code} before filesystem or download effects`, async () => {
    const { svc, calls } = harness(options);
    assert.equal((await svc.installRea(payload)).error.code, code);
    assert.equal(fs.existsSync(svc.prefixDir), false);
    assert.equal(calls.download.length, 0);
    assert.equal(calls.npm.length, 0);
  });
}

test('in_progress covers Node preflight and excludes both install and uninstall without filesystem effects', async () => {
  let finishProbe;
  const { svc, calls } = harness({ nodeProbe: (callback) => { finishProbe = callback; } });
  const first = svc.installRea({ confirmed: true });
  assert.equal((await svc.installRea({ confirmed: true })).error.code, 'in_progress');
  assert.equal((await svc.uninstallRea({ confirmed: true })).error.code, 'in_progress');
  assert.equal((await svc.installRea()).error.code, 'opt_in_required');
  assert.equal(fs.existsSync(svc.prefixDir), false);
  assert.equal(calls.download.length, 0);
  assert.equal(calls.npm.length, 0);
  finishProbe(null, 'v22.18.0', '');
  assert.equal((await first).error.code, 'node_unsupported');
});

for (const [label, options] of [['digest', { badHash: true }], ['byte count', { shortDownload: true }]]) {
  test(`integrity mismatch in ${label} fails closed and removes staging before npm`, async () => {
    const { svc, calls } = harness(options);
    const result = await svc.installRea({ confirmed: true });
    assert.equal(result.code, 'integrity_mismatch');
    assert.equal(result.status, 'failed');
    assert.equal(calls.npm.length, 0);
    noStaging(svc);
  });
}

for (const [code, options] of [['npm_failed', { npmFails: true }], ['probe_failed', { probeFails: true }]]) {
  test(`${code} removes staging, preserves the old install and redacts paths and secrets`, async () => {
    const { svc } = harness(options);
    oldInstall(svc);
    const result = await svc.installRea({ confirmed: true });
    assert.equal(result.code, code);
    assert.equal(fs.readFileSync(path.join(svc.currentDir, 'old.txt'), 'utf8'), 'old install');
    assert.ok(result.error.includes('[path]'));
    assert.ok(result.error.includes('token=[redacted]'));
    assert.ok(!result.error.includes('abc') && !result.error.includes('C:\\Users'));
    assert.ok(!result.error.includes('fileserver') && !result.error.includes('npm_SECRET'));
    assert.ok(result.error.length <= 300);
    noStaging(svc);
  });
}

test('null payloads are refused like missing consent', async () => {
  const { svc } = harness();
  assert.equal((await svc.installRea(null)).error.code, 'opt_in_required');
  assert.equal((await svc.uninstallRea(null)).error.code, 'opt_in_required');
});

test('happy path verifies, probes, publishes, rewrites the row and copies only regular skill Markdown files', async () => {
  const { svc, calls, userDataPath } = harness({ scopeEnabled: true });
  const phases = [];
  svc.on('install-progress', (progress) => { if (phases.at(-1) !== progress.phase) phases.push(progress.phase); });
  const result = await svc.installRea({ confirmed: true, requestId: 'happy' });
  const staging = path.join(svc.prefixDir, 'staging-happy');
  assert.deepEqual(calls.npm[0].args, [svc.npmCliPath, 'install', '--prefix', staging,
    '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel', 'error',
    path.join(staging, 'rea-agents-6.4.0.tgz')]);
  assert.equal(calls.npm[0].file, svc.nodePath);
  assert.equal(calls.npm[0].options.cwd, staging);
  assert.equal(calls.npm[0].options.timeout, 600000);
  assert.equal(calls.npm[0].options.maxBuffer, 4 * 1024 * 1024);
  assert.equal(calls.npm[0].options.windowsHide, true);
  assert.equal(Object.keys(calls.npm[0].options.env).some((key) => /^JENNY_/i.test(key)), false);
  assert.equal(calls.npm[0].options.env.API_TOKEN, undefined);
  assert.equal(calls.npm[0].options.env.npm_config_update_notifier, 'false');
  assert.deepEqual(calls.probe, [{ server: { name: 'rea', transport: 'stdio', command: svc.nodePath,
    args: [path.join(staging, 'node_modules', 'rea-agents', 'scripts', 'rea.mjs'), 'mcp'] }, timeoutMs: 120000 }]);
  assert.deepEqual(calls.update, [{ name: 'rea', server: svc.managedRow() }]);
  assert.equal(fs.existsSync(svc.entryPath), true);
  assert.deepEqual(fs.readdirSync(svc.skillTargetDir).sort(), ['SKILL.md', 'references']);
  assert.deepEqual(fs.readdirSync(path.join(svc.skillTargetDir, 'references')), ['a.md']);
  assert.equal(fs.readFileSync(path.join(userDataPath, 'outside', 'keep.md'), 'utf8'), 'outside');
  assert.deepEqual(calls.refresh, [{ emit: true, force: true, reason: 'rea_skill_installed' }]);
  assert.deepEqual(phases, ['downloading', 'verifying', 'installing', 'probing', 'publishing', 'connecting', 'copying_skill', 'completed']);
  assert.equal(result.status, 'completed');
  assert.equal(result.skillCopied, true);
  assert.equal(result.skillScopeEnabled, true);
  assert.deepEqual(calls.log.at(-1), ['INFO', 'rea_install.finished', { requestId: 'happy', status: 'completed', code: '' }]);
  noStaging(svc);
});

test('a profile and skills root reached through a junction install and copy the skill', async () => {
  const { svc } = harness({ junction: true });
  const result = await svc.installRea({ confirmed: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.skillCopied, true);
  assert.equal(fs.existsSync(svc.entryPath), true);
});

test('a listener that throws on the terminal event does not turn the install into a failure', async () => {
  const { svc } = harness();
  const terminal = [];
  svc.on('install-progress', (payload) => {
    if (payload.status !== 'running') terminal.push(payload.status);
    if (payload.phase === 'completed') throw new Error('listener');
  });
  assert.equal((await svc.installRea({ confirmed: true })).status, 'completed');
  assert.deepEqual(terminal, ['completed']);
});

test('skill copy failure leaves the published install completed and cleans the skill staging folder', async () => {
  const { svc } = harness({ fsImpl: { copyFileSync: () => { throw new Error('unwritable'); } } });
  const result = await svc.installRea({ confirmed: true, requestId: 'skill-fail' });
  assert.equal(result.status, 'completed');
  assert.equal(result.skillCopied, false);
  assert.equal(result.skillError, 'skill_copy_failed');
  assert.equal(result.code, '');
  assert.equal(result.error, '');
  assert.equal(fs.existsSync(svc.entryPath), true);
  assert.equal(fs.existsSync(`${svc.skillTargetDir}.staging-skill-fail`), false);
});

test('skill refresh failure does not undo a successful copy', async () => {
  const { svc } = harness({ refreshFails: true });
  const result = await svc.installRea({ confirmed: true });
  assert.equal(result.status, 'completed');
  assert.equal(result.skillCopied, true);
});

test('invalid npm package metadata fails before readiness or publishing', async () => {
  const { svc, calls } = harness({ invalidInstall: true });
  oldInstall(svc);
  assert.equal((await svc.installRea({ confirmed: true })).code, 'install_invalid');
  assert.equal(calls.probe.length, 0);
  assert.equal(fs.existsSync(path.join(svc.currentDir, 'old.txt')), true);
  noStaging(svc);
});

test('download errors retain the helper code in bounded text and clean staging', async () => {
  const { svc } = harness({ downloadImpl: () => { throw Object.assign(new Error('token=abc C:\\Users\\x\\secret'), { code: 'response_timeout' }); } });
  const result = await svc.installRea({ confirmed: true });
  assert.equal(result.code, 'download_failed');
  assert.ok(result.error.includes('response_timeout'));
  assert.ok(!result.error.includes('abc') && !result.error.includes('C:\\Users'));
  noStaging(svc);
});

test('a raw filesystem error never becomes the public install code', async () => {
  const { svc } = harness({ fsImpl: { mkdirSync: () => { throw Object.assign(new Error('C:\\Users\\x locked'), { code: 'EPERM' }); } } });
  const result = await svc.installRea({ confirmed: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'install_failed');
  assert.ok(!result.error.includes('C:\\Users'));
});

test('connection rewrite failure keeps the published install and reports it as unmanaged', async () => {
  const { svc } = harness({ updateResult: { ok: false, error: { message: 'blocked' } } });
  assert.equal((await svc.installRea({ confirmed: true })).code, 'connection_update_failed');
  assert.equal(fs.existsSync(svc.entryPath), true);
  assert.equal((await svc.getInstallPlan()).installed.managedCommand, false);
  noStaging(svc);
});

test('a failed publish rename puts the previous install back and cleans staging', async () => {
  const { svc } = harness({ fsImpl: { renameSync: (from, to) => {
    if (path.basename(to) === 'current' && !path.basename(from).startsWith('staging-old-')) throw new Error('EBUSY');
    return fs.renameSync(from, to);
  } } });
  oldInstall(svc);
  const result = await svc.installRea({ confirmed: true });
  assert.equal(result.code, 'publish_failed');
  assert.ok(result.error.includes('was kept'));
  assert.equal(fs.readFileSync(path.join(svc.currentDir, 'old.txt'), 'utf8'), 'old install');
  noStaging(svc);
});

test('uninstall removes the managed prefix, restores the preset and keeps the copied skill without progress', async () => {
  const { svc, calls } = harness();
  await svc.installRea({ confirmed: true });
  calls.update.length = 0;
  const events = [];
  svc.on('install-progress', (payload) => events.push(payload));
  assert.deepEqual(await svc.uninstallRea({ confirmed: true }), { ok: true, removed: true, connectionRestored: true, skillKept: true });
  assert.equal(fs.existsSync(svc.prefixDir), false);
  assert.equal(fs.existsSync(path.join(svc.skillTargetDir, 'SKILL.md')), true);
  assert.deepEqual(calls.update, [{ name: 'rea', server: reaPresetRow(manifest) }]);
  assert.deepEqual(events, []);
});

test('uninstall is idempotent and preserves a custom connection', async () => {
  const { svc, calls } = harness({ rows: [{ name: 'rea', command: 'custom', args: [] }] });
  oldInstall(svc);
  assert.equal((await svc.uninstallRea({ confirmed: true })).connectionRestored, false);
  assert.deepEqual(await svc.uninstallRea({ confirmed: true }), { ok: true, removed: false, connectionRestored: false, skillKept: true });
  assert.deepEqual(calls.update, []);
});

test('uninstall refuses opt-in and enabled connections before removal', async () => {
  const { svc } = harness({ rows: [{ name: 'rea', enabled: true }] });
  oldInstall(svc);
  assert.equal((await svc.uninstallRea()).error.code, 'opt_in_required');
  assert.equal((await svc.uninstallRea({ confirmed: true })).error.code, 'connection_enabled');
  assert.equal(fs.existsSync(svc.currentDir), true);
});

test('uninstall reports removal failure without rewriting the connection', async () => {
  const { svc, calls } = harness({ serviceOptions: { removeTree: () => { throw new Error('locked'); } } });
  oldInstall(svc);
  assert.equal((await svc.uninstallRea({ confirmed: true })).error.code, 'remove_failed');
  assert.deepEqual(calls.update, []);
});

test('uninstall connection failure reports the error while the removal stands', async () => {
  const { svc, calls } = harness({ updateResult: { ok: false } });
  oldInstall(svc);
  await svc.discovery.updateServer({ name: 'rea', server: svc.managedRow() });
  svc.discovery.getState = () => ({ servers: [svc.managedRow()] });
  const result = await svc.uninstallRea({ confirmed: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'connection_update_failed');
  assert.equal(result.removed, true);
  assert.equal(result.connectionRestored, false);
  assert.equal(fs.existsSync(svc.prefixDir), false);
  assert.equal(calls.update.length, 2);
});

test('reconcile removes only abandoned staging directories, including the skill staging folder', () => {
  const { svc } = harness();
  oldInstall(svc);
  write(path.join(svc.prefixDir, 'staging-abandoned', 'partial.tgz'));
  write(path.join(svc.prefixDir, 'keep', 'keep.txt'));
  write(`${svc.skillTargetDir}.staging-dead/SKILL.md`, '# dead');
  write(path.join(svc.skillTargetDir, 'SKILL.md'), '# live');
  svc.reconcile();
  assert.deepEqual(fs.readdirSync(svc.prefixDir).sort(), ['current', 'keep']);
  assert.deepEqual(fs.readdirSync(path.dirname(svc.skillTargetDir)), [manifest.skill]);
});

test('reconcile restores an install that a killed run had moved aside', () => {
  const { svc } = harness();
  write(path.join(svc.prefixDir, 'staging-old-dead', 'old.txt'), 'old install');
  write(path.join(svc.prefixDir, 'staging-dead', 'partial.tgz'));
  svc.reconcile();
  assert.deepEqual(fs.readdirSync(svc.prefixDir), ['current']);
  assert.equal(fs.readFileSync(path.join(svc.currentDir, 'old.txt'), 'utf8'), 'old install');
});

test('preset restore is byte-for-byte the Windows rea launch preset', () => {
  assert.deepEqual(reaPresetRow(provenance), { name: 'rea', transport: 'stdio',
    command: 'C:\\Program Files\\nodejs\\npx.cmd', args: ['-y', 'rea-agents@6.4.0', 'mcp'] });
});

function ipcBridge(reaInstallService, discovery, authorize = () => true) {
  const handlers = new Map();
  registerAuxiliaryIpcHandlers({
    ipcMainLike: { handle: (channel, handler) => handlers.set(channel, handler) },
    reaInstallService, mcpDiscoveryService: discovery, ipcAuthorization: { authorize },
  });
  return createJennyShellBridge({ ipcRenderer: {
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args),
  } });
}

test('registered IPC install persists a disabled pending-review row with its environment and limits intact', async () => {
  const { svc, userDataPath } = harness();
  const preset = { ...reaPresetRow(manifest), env: { REA_LOG_LEVEL: 'debug' },
    memory_limit_mb: 2048, max_processes: 16, inspect_timeout_seconds: 120, request_timeout_seconds: 300 };
  writeConfig(userDataPath, [approvedServer(preset, { enabled: false })], { mcp_config_schema_version: 2 });
  const discovery = new McpDiscoveryService({ userDataPath });
  svc.discovery = discovery;
  const bridge = ipcBridge(svc, discovery).mcpDiscovery;
  assert.equal((await bridge.getReaInstallPlan()).connection.present, true);
  assert.equal((await bridge.installRea()).error.code, 'opt_in_required');
  assert.equal((await bridge.installRea({ confirmed: true })).status, 'completed');
  const persisted = new McpDiscoveryService({ userDataPath }).getState().servers.find((row) => row.name === 'rea');
  assert.equal(persisted.command, svc.nodePath);
  assert.deepEqual(persisted.args, [svc.entryPath, 'mcp']);
  assert.equal(persisted.enabled, false);
  assert.equal(persisted.trust.status, 'pending');
  const diskRow = JSON.parse(fs.readFileSync(discovery.configPath, 'utf8')).mcp_servers[0];
  for (const key of ['env', 'memory_limit_mb', 'max_processes', 'inspect_timeout_seconds', 'request_timeout_seconds']) {
    assert.deepEqual(diskRow[key], preset[key]);
  }
  assert.equal((await bridge.getReaInstallPlan()).installed.managedCommand, true);
  assert.equal((await bridge.uninstallRea({ confirmed: true })).connectionRestored, true);
  const restored = new McpDiscoveryService({ userDataPath }).getState().servers.find((row) => row.name === 'rea');
  assert.equal(restored.command, reaPresetRow(manifest).command);
  assert.deepEqual(restored.args, reaPresetRow(manifest).args);
  assert.equal(fs.existsSync(path.join(svc.skillTargetDir, 'SKILL.md')), true);
});

test('registered IPC handlers degrade safely when the rea installer is unavailable', async () => {
  const bridge = ipcBridge(null, null).mcpDiscovery;
  assert.deepEqual(await bridge.getReaInstallPlan(), { supported: false });
  assert.deepEqual(await bridge.installRea({ confirmed: true }), { ok: false, error: { code: 'unavailable' } });
  assert.deepEqual(await bridge.uninstallRea({ confirmed: true }), { ok: false, error: { code: 'unavailable' } });
});

test('registered IPC authorization refuses install before any service effects', async () => {
  const { svc, discovery, calls } = harness();
  const bridge = ipcBridge(svc, discovery, () => false).mcpDiscovery;
  assert.deepEqual(await bridge.installRea({ confirmed: true }), { ok: false, authorized: false, code: 'ipc_sender_unauthorized' });
  assert.equal(fs.existsSync(svc.prefixDir), false);
  assert.equal(calls.download.length, 0);
  assert.equal(calls.npm.length, 0);
});
