const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveLaunch, resolveAgentWorkspaceRoot, resolveChildExitCode } = require('../start');

const CWD = path.resolve('C:/dev/jenny');

test('non-agent launch forwards args verbatim and never seeds a tools workspace root', () => {
  const { agentMode, env, forwardedArgs } = resolveLaunch({
    argv: ['--some-electron-flag', 'value'],
    env: {},
    cwd: CWD,
  });

  assert.equal(agentMode, false);
  assert.equal('JENNY_TOOLS_WORKSPACE_ROOT' in env, false);
  assert.equal('JENNY_AGENT_DEV' in env, false);
  assert.deepEqual(forwardedArgs, ['--some-electron-flag', 'value']);
});

test('--agent defaults the tools workspace root to the launcher cwd', () => {
  const { agentMode, env, forwardedArgs } = resolveLaunch({
    argv: ['--agent'],
    env: {},
    cwd: CWD,
  });

  assert.equal(agentMode, true);
  assert.equal(env.JENNY_AGENT_DEV, '1');
  assert.equal(env.JENNY_TOOLS_WORKSPACE_ROOT, CWD);
  // --agent is consumed; the CDP port is appended on the agent's behalf.
  assert.ok(forwardedArgs.includes('--remote-debugging-port=9222'));
  assert.ok(!forwardedArgs.includes('--agent'));
});

test('--agent triggered via JENNY_AGENT_DEV env still defaults the workspace root', () => {
  const { agentMode, env } = resolveLaunch({
    argv: [],
    env: { JENNY_AGENT_DEV: 'true' },
    cwd: CWD,
  });

  assert.equal(agentMode, true);
  assert.equal(env.JENNY_TOOLS_WORKSPACE_ROOT, CWD);
});

test('--workspace-root <path> seeds JENNY_TOOLS_WORKSPACE_ROOT and is consumed (not forwarded)', () => {
  const target = path.resolve('C:/dev/other');
  const { env, forwardedArgs } = resolveLaunch({
    argv: ['--agent', '--workspace-root', target, '--remote-debugging-port=9333'],
    env: {},
    cwd: CWD,
  });

  assert.equal(env.JENNY_TOOLS_WORKSPACE_ROOT, target);
  assert.ok(!forwardedArgs.includes('--workspace-root'));
  assert.ok(!forwardedArgs.includes(target));
  // An explicit CDP arg is preserved and the launcher does not add a second one.
  assert.deepEqual(forwardedArgs, ['--remote-debugging-port=9333']);
});

test('--workspace-root rejects a following Electron flag instead of consuming it', () => {
  assert.throws(
    () => resolveLaunch({
      argv: ['--agent', '--workspace-root', '--remote-debugging-port=9333'],
      env: {},
      cwd: CWD,
    }),
    { name: 'TypeError', message: /--workspace-root/ }
  );
});

test('a trailing bare --workspace-root is rejected', () => {
  assert.throws(
    () => resolveLaunch({
      argv: ['--agent', '--workspace-root'],
      env: {},
      cwd: CWD,
    }),
    { name: 'TypeError', message: /--workspace-root/ }
  );
});

test('--workspace-root keeps accepting a healthy separated path', () => {
  const { env } = resolveLaunch({
    argv: ['--agent', '--workspace-root', '/some/path'],
    env: {},
    cwd: CWD,
  });

  assert.equal(env.JENNY_TOOLS_WORKSPACE_ROOT, path.resolve(CWD, '/some/path'));
});

test('--workspace-root=<path> inline form is supported', () => {
  const target = path.resolve('C:/dev/inline');
  const { env, forwardedArgs } = resolveLaunch({
    argv: ['--agent', `--workspace-root=${target}`],
    env: {},
    cwd: CWD,
  });

  assert.equal(env.JENNY_TOOLS_WORKSPACE_ROOT, target);
  assert.ok(!forwardedArgs.some((arg) => arg.startsWith('--workspace-root')));
});

test('a relative --workspace-root is resolved against cwd to an absolute path', () => {
  const { env } = resolveLaunch({
    argv: ['--agent', '--workspace-root', './sub/dir'],
    env: {},
    cwd: CWD,
  });

  assert.equal(env.JENNY_TOOLS_WORKSPACE_ROOT, path.resolve(CWD, './sub/dir'));
});

test('the --workspace-root flag wins over an inherited JENNY_TOOLS_WORKSPACE_ROOT', () => {
  const flagRoot = path.resolve('G:/from/flag');
  const { env } = resolveLaunch({
    argv: ['--agent', '--workspace-root', flagRoot],
    env: { JENNY_TOOLS_WORKSPACE_ROOT: 'G:/from/env' },
    cwd: CWD,
  });

  assert.equal(env.JENNY_TOOLS_WORKSPACE_ROOT, flagRoot);
});

test('an inherited JENNY_TOOLS_WORKSPACE_ROOT is preserved verbatim when no flag is given', () => {
  const { env } = resolveLaunch({
    argv: ['--agent'],
    env: { JENNY_TOOLS_WORKSPACE_ROOT: 'G:/from/env' },
    cwd: CWD,
  });

  assert.equal(env.JENNY_TOOLS_WORKSPACE_ROOT, 'G:/from/env');
});

test('resolveLaunch strips ELECTRON_RUN_AS_NODE from the child env', () => {
  const { env } = resolveLaunch({
    argv: ['--agent'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
    cwd: CWD,
  });

  assert.equal('ELECTRON_RUN_AS_NODE' in env, false);
});

test('Electron close results map signal termination to failure and clean exit to zero', () => {
  assert.equal(resolveChildExitCode(null, 'SIGTERM'), 1);
  assert.equal(resolveChildExitCode(0, null), 0);
});

test('resolveAgentWorkspaceRoot precedence: flag > inherited env > cwd default', () => {
  assert.equal(
    resolveAgentWorkspaceRoot({ explicitRoot: '', inheritedRoot: '', cwd: CWD }),
    CWD
  );
  assert.equal(
    resolveAgentWorkspaceRoot({ explicitRoot: '  ', inheritedRoot: 'G:/env', cwd: CWD }),
    'G:/env'
  );
  assert.equal(
    resolveAgentWorkspaceRoot({ explicitRoot: 'G:/flag', inheritedRoot: 'G:/env', cwd: CWD }),
    path.resolve(CWD, 'G:/flag')
  );
});
