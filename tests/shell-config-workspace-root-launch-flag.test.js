// Dogfood HB-032: `node start.js --agent --workspace-root <path>` was ignored
// when the profile already had a saved root, so a turn ran in the previous
// folder. An explicit agent-mode flag now replaces the saved root; the cwd
// default and an inherited env var stay a one-shot seed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ShellConfigService } = require('../services/shell-config-service');
const { resolveLaunch } = require('../start');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

const SAVED_ROOT = path.resolve('C:/saved/workspace');
const FLAG_ROOT = path.resolve('C:/flag/workspace');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function profileWithSavedRoot() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-launch-flag-'));
  trackDirectory(userDataPath);
  const first = new ShellConfigService({ userDataPath, env: { JENNY_TOOLS_WORKSPACE_ROOT: SAVED_ROOT } });
  assert.equal(first.getToolsWorkspaceRoot(), SAVED_ROOT);
  return userDataPath;
}

function relaunch(userDataPath, env) {
  const logs = [];
  const service = new ShellConfigService({
    userDataPath,
    env,
    logger: (level, event, details) => logs.push({ level, event, details }),
  });
  return { service, logs };
}

test('an explicit agent-mode --workspace-root replaces the saved root and persists', () => {
  const userDataPath = profileWithSavedRoot();
  const launch = resolveLaunch({ argv: ['--agent', '--workspace-root', FLAG_ROOT], env: {}, cwd: path.resolve('C:/dev/jenny') });
  const { service, logs } = relaunch(userDataPath, launch.env);

  assert.equal(service.getToolsWorkspaceRoot(), FLAG_ROOT);
  assert.ok(logs.some((entry) => entry.event === 'shell_config.workspace_root_replaced_by_launch_flag'));

  // The replacement is the profile's saved root from then on.
  const later = relaunch(userDataPath, {});
  assert.equal(later.service.getToolsWorkspaceRoot(), FLAG_ROOT);
});

test('the agent cwd default never replaces a saved root', () => {
  const userDataPath = profileWithSavedRoot();
  const launch = resolveLaunch({ argv: ['--agent'], env: {}, cwd: FLAG_ROOT });
  assert.equal(launch.env.JENNY_TOOLS_WORKSPACE_ROOT, FLAG_ROOT);
  const { service, logs } = relaunch(userDataPath, launch.env);

  assert.equal(service.getToolsWorkspaceRoot(), SAVED_ROOT);
  assert.ok(logs.some((entry) => entry.event === 'shell_config.workspace_root_env_seed_ignored'));
});

test('an inherited env root, or an inherited explicit marker, never replaces a saved root', () => {
  const userDataPath = profileWithSavedRoot();
  const launch = resolveLaunch({
    argv: ['--agent'],
    env: { JENNY_TOOLS_WORKSPACE_ROOT: FLAG_ROOT, JENNY_TOOLS_WORKSPACE_ROOT_EXPLICIT: '1' },
    cwd: path.resolve('C:/dev/jenny'),
  });
  assert.equal('JENNY_TOOLS_WORKSPACE_ROOT_EXPLICIT' in launch.env, false);

  assert.equal(relaunch(userDataPath, launch.env).service.getToolsWorkspaceRoot(), SAVED_ROOT);
});

test('the explicit marker does nothing outside agent mode', () => {
  const userDataPath = profileWithSavedRoot();
  const { service } = relaunch(userDataPath, {
    JENNY_TOOLS_WORKSPACE_ROOT: FLAG_ROOT,
    JENNY_TOOLS_WORKSPACE_ROOT_EXPLICIT: '1',
  });

  assert.equal(service.getToolsWorkspaceRoot(), SAVED_ROOT);
});

for (const stateDirRoot of ['C:/dev/jenny/.jenny', 'C:/dev/jenny/.jenny/artifacts']) {
  test(`an explicit root at or under the .jenny state dir is refused: ${stateDirRoot}`, () => {
    const userDataPath = profileWithSavedRoot();
    const launch = resolveLaunch({
      argv: ['--agent', '--workspace-root', path.resolve(stateDirRoot)],
      env: {},
      cwd: path.resolve('C:/dev/jenny'),
    });
    const { service, logs } = relaunch(userDataPath, launch.env);

    assert.equal(service.getToolsWorkspaceRoot(), SAVED_ROOT);
    assert.ok(logs.some((entry) => entry.event === 'shell_config.workspace_root_env_seed_rejected'));
  });
}

test('the same folder spelled differently is not rewritten', () => {
  const userDataPath = profileWithSavedRoot();
  const respelled = process.platform === 'win32' ? SAVED_ROOT.toUpperCase() : `${SAVED_ROOT}${path.sep}`;
  const launch = resolveLaunch({ argv: ['--agent', '--workspace-root', respelled], env: {}, cwd: path.resolve('C:/dev/jenny') });
  const { service, logs } = relaunch(userDataPath, launch.env);

  assert.equal(service.getToolsWorkspaceRoot(), SAVED_ROOT);
  assert.equal(logs.some((entry) => entry.event === 'shell_config.workspace_root_replaced_by_launch_flag'), false);
});

test('the launcher marks only its own flag as explicit', () => {
  const cwd = path.resolve('C:/dev/jenny');
  assert.equal(resolveLaunch({ argv: ['--agent', '--workspace-root', FLAG_ROOT], env: {}, cwd }).env.JENNY_TOOLS_WORKSPACE_ROOT_EXPLICIT, '1');
  assert.equal(resolveLaunch({ argv: ['--agent', `--workspace-root=${FLAG_ROOT}`], env: {}, cwd }).env.JENNY_TOOLS_WORKSPACE_ROOT_EXPLICIT, '1');
  assert.equal('JENNY_TOOLS_WORKSPACE_ROOT_EXPLICIT' in resolveLaunch({ argv: ['--agent'], env: {}, cwd }).env, false);
  // Outside agent mode the flag is consumed but seeds nothing and marks nothing.
  const plain = resolveLaunch({ argv: ['--workspace-root', FLAG_ROOT], env: {}, cwd }).env;
  assert.equal('JENNY_TOOLS_WORKSPACE_ROOT_EXPLICIT' in plain, false);
  assert.equal('JENNY_TOOLS_WORKSPACE_ROOT' in plain, false);
});
