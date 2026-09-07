const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const AGENT_FLAG = '--agent';
const WORKSPACE_ROOT_FLAG = '--workspace-root';

// Resolve the tools workspace root to forward into the agent profile.
// Precedence, most explicit first:
//   1. an explicit `--workspace-root <path>` / `--workspace-root=<path>` flag
//   2. an inherited JENNY_TOOLS_WORKSPACE_ROOT env var
//   3. the launcher's cwd (the deliberate default — see resolveLaunch)
// Relative flag values are resolved against cwd because the downstream
// seeding (shell-config-service.normalizeWorkspaceRoot) only trims the value;
// it does not turn a relative path into an absolute one, and the tools
// workspace boundary checks expect a real absolute root.
function resolveAgentWorkspaceRoot({ explicitRoot, inheritedRoot, cwd }) {
  const fromFlag = String(explicitRoot == null ? '' : explicitRoot).trim();
  if (fromFlag) {
    return path.resolve(cwd, fromFlag);
  }
  const fromEnv = String(inheritedRoot == null ? '' : inheritedRoot).trim();
  if (fromEnv) {
    // Already an explicit choice by whoever exported it — pass through verbatim.
    return fromEnv;
  }
  return cwd;
}

// Pure resolver: given the argv tail, a base env, and the launcher cwd, compute
// the child env and the args forwarded to Electron. Exported for unit tests; the
// real spawn only happens when start.js is run as the entry script (see bottom).
//
// `--agent` is consumed here (it configures agent/dev automation mode);
// `--workspace-root <path>` is consumed in agent mode (it seeds the tools
// workspace root); everything else passes through verbatim, e.g.:
//   node start.js --agent --remote-debugging-port=9333
//   node start.js --agent --workspace-root /path/to/your/repo
function resolveLaunch({ argv = [], env = {}, cwd }) {
  const childEnv = { ...env };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const forwardedArgs = [];
  let agentMode = /^(1|true|yes|on)$/i.test(String(childEnv.JENNY_AGENT_DEV || '').trim());
  let explicitWorkspaceRoot = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === AGENT_FLAG) {
      agentMode = true;
      continue;
    }
    if (arg === WORKSPACE_ROOT_FLAG) {
      // `--workspace-root <path>`: consume the following token as the value.
      const nextArg = argv[i + 1];
      const workspaceRootValue = String(nextArg == null ? '' : nextArg).trim();
      if (!workspaceRootValue || workspaceRootValue.startsWith('-')) {
        throw new TypeError(`${WORKSPACE_ROOT_FLAG} requires a nonblank path value that does not start with "-"`);
      }
      explicitWorkspaceRoot = String(nextArg);
      i += 1;
      continue;
    }
    if (arg.startsWith(`${WORKSPACE_ROOT_FLAG}=`)) {
      // `--workspace-root=<path>` inline form.
      explicitWorkspaceRoot = arg.slice(WORKSPACE_ROOT_FLAG.length + 1);
      continue;
    }
    forwardedArgs.push(arg);
  }

  if (agentMode) {
    // Umbrella switch read by main.js, feature flags, and log forwarding.
    childEnv.JENNY_AGENT_DEV = '1';
    // Renderer console output reaches stdout (and therefore the driving agent).
    if (!childEnv.ELECTRON_ENABLE_LOGGING) {
      childEnv.ELECTRON_ENABLE_LOGGING = '1';
    }
    // Isolated profile so automated turns never pollute the real %APPDATA%
    // profile. main.js consumes JENNY_USER_DATA_DIR before any service reads
    // app.getPath('userData'); the per-profile single-instance lock also lets
    // an agent instance run beside the real app.
    if (!String(childEnv.JENNY_USER_DATA_DIR || '').trim()) {
      childEnv.JENNY_USER_DATA_DIR = path.join(os.tmpdir(), 'jenny-agent-profile');
    }
    // Fixed CDP endpoint for WebSocket-driving automation and CI.
    const hasExplicitCdpArg = forwardedArgs.some((arg) => arg.startsWith('--remote-debugging-port'));
    if (!hasExplicitCdpArg) {
      const cdpPort = Number.parseInt(String(childEnv.JENNY_CDP_PORT || '').trim(), 10);
      forwardedArgs.push(`--remote-debugging-port=${Number.isInteger(cdpPort) && cdpPort > 0 ? cdpPort : 9222}`);
    }
    // Tools workspace root for the agent profile. A fresh agent profile starts
    // rootless, so file/terminal tools are dropped from the model's tool list
    // until a root is set — and there is no headless way to set one at runtime
    // (the workspace-root choose flow opens a native OS dialog CDP cannot drive).
    // shell-config-service._seedWorkspaceRootFromEnvOnce() reads
    // JENNY_TOOLS_WORKSPACE_ROOT at startup and seeds it iff no root is yet
    // configured, so forwarding it here makes `node start.js --agent` able to
    // drive file/terminal tools on the very first turn.
    //
    // Deliberate call: when neither the flag nor an inherited env var is set we
    // DEFAULT to cwd rather than launching rootless. Agent mode exists to make
    // the app driveable for automation, and a rootless tools layer defeats that
    // for the common case of "drive Jenny against the repo I launched from."
    // The default is bounded — it only applies in agent mode, only when nothing
    // else specified a root, and the seed is one-shot per profile (a root the
    // isolated profile already persisted wins on relaunch). To launch
    // intentionally rootless, point --workspace-root at an empty profile and
    // clear the persisted root, or start the real (non-agent) app.
    childEnv.JENNY_TOOLS_WORKSPACE_ROOT = resolveAgentWorkspaceRoot({
      explicitRoot: explicitWorkspaceRoot,
      inheritedRoot: childEnv.JENNY_TOOLS_WORKSPACE_ROOT,
      cwd,
    });
  }

  return { agentMode, env: childEnv, forwardedArgs };
}

function resolveChildExitCode(code, signal) {
  return code ?? (signal ? 1 : 0);
}

function launch() {
  const electronPath = require('electron');

  // The main window loads the sandboxed, esbuild-bundled preload
  // (preload.bundle.js). Refresh it when its source-graph stamp changes. A
  // failure here is fatal: a stale or missing bundle boots a dead,
  // jennyShell-less shell.
  try {
    const { buildPreloadBundle } = require('./scripts/build/build-preload');
    buildPreloadBundle();
  } catch (error) {
    console.error(`Jenny launcher failed to build the preload bundle: ${String((error && error.message) || error)}`);
    process.exit(1);
  }

  let launchOptions;
  try {
    launchOptions = resolveLaunch({
      argv: process.argv.slice(2),
      env: process.env,
      cwd: process.cwd(),
    });
  } catch (error) {
    console.error(String((error && error.message) || error));
    process.exit(1);
    return;
  }
  const { agentMode, env, forwardedArgs } = launchOptions;

  if (agentMode) {
    console.log(
      `Jenny agent mode: userData=${env.JENNY_USER_DATA_DIR} ` +
        `workspaceRoot=${env.JENNY_TOOLS_WORKSPACE_ROOT} ` +
        `args=${forwardedArgs.join(' ') || '(none)'}`
    );
  }

  // Keep the attached-parent spawn pattern: a detached Electron child gets
  // reaped when the launching terminal/agent session ends mid-test.
  const child = spawn(electronPath, ['.', ...forwardedArgs], {
    stdio: 'inherit',
    env,
    cwd: __dirname,
  });

  child.on('error', (error) => {
    console.error(`Jenny launcher failed to start Electron: ${String((error && error.message) || error)}`);
    process.exit(1);
  });

  child.on('close', (code, signal) => {
    process.exit(resolveChildExitCode(code, signal));
  });
}

// Only spawn Electron when run as the entry script; `require()` (tests) gets the
// pure resolver without launching anything.
if (require.main === module) {
  launch();
}

module.exports = { resolveLaunch, resolveAgentWorkspaceRoot, resolveChildExitCode };
