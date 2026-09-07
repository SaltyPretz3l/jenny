'use strict';

// Jenny one-shot setup orchestrator (cross-platform: Windows / macOS / Linux).
//
// Invoked by the thin OS wrappers (setup.ps1 / setup.command / setup.sh) after
// they verify Node + run `npm install`, or directly via `npm run setup`.
//
// Phases (each idempotent, each prints why it skipped):
//   A. verify prerequisites (Node/npm/Python/git)
//   B. npm install (skip only when the platform wrapper already completed it)
//   C. create <repoRoot>/.venv + pip install -e ".[dev]"
//   D. ensure Ollama is installed and serving
//   E. pull the default local model (skip when already present)
//   F. optional `pre-commit install`
//   G. launch Jenny (`npm run dev`)
//
// Everything that touches the machine is dependency-injected so tests drive the
// whole flow without spawning anything real.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const prereqs = require('./prereqs');
const pythonEnv = require('./python-env');
const ollamaStep = require('./ollama-step');
const { ui: defaultUi } = require('./console-ui');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
// Single source of truth for the default model tag (also the managed default).
const { DEFAULT_MANAGED_SHELL_MODEL } = require(path.join(REPO_ROOT, 'services', 'backend', 'backend-config'));

function defaultRestartOllamaAfterUpgrade({ platform }) {
  const { shutdownAnyLocalOllamaSync } = require('../../services/backend/ollama-shutdown');
  return shutdownAnyLocalOllamaSync({ platform });
}

const EXIT = Object.freeze({
  OK: 0,
  PREREQ: 10,
  OLLAMA: 11,
  PYTHON: 12,
  MODEL: 13,
  UNKNOWN: 1,
});

const HELP = `Jenny setup — get a fresh clone running.

Usage:
  node scripts/setup/setup.js [options]
  (or run ./setup.ps1 on Windows, ./setup.command on macOS)

Options:
  --help, -h        Show this help and exit.
  --yes, -y         Assume "yes" for every prompt (non-interactive).
  --model <tag>     Pull a specific Ollama model instead of the default.
  --skip-model      Skip the model download (you can pull it later in-app).
  --no-launch       Set up everything but do not start Jenny at the end.
  --dev             Contributor setup: install the Python dev/test/build extra
                    (.[dev]) and the git pre-commit hook. Default is run-only.
  --no-precommit    Do not install the git pre-commit hook.
  --bootstrapped-npm  Internal: the wrapper already ran "npm install".
  --force           Re-run steps even when they look already-done.

Exit codes: 0 ok · 10 prereq · 11 ollama · 12 python · 13 model · 1 other`;

function parseArgs(argv) {
  const opts = {
    help: false,
    yes: false,
    skipModel: false,
    noLaunch: false,
    noPrecommit: false,
    dev: false,
    bootstrappedNpm: false,
    force: false,
    model: '',
    errors: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--yes':
      case '-y':
        opts.yes = true;
        break;
      case '--skip-model':
        opts.skipModel = true;
        break;
      case '--no-launch':
        opts.noLaunch = true;
        break;
      case '--no-precommit':
        opts.noPrecommit = true;
        break;
      case '--dev':
        opts.dev = true;
        break;
      case '--bootstrapped-npm':
        opts.bootstrappedNpm = true;
        break;
      case '--force':
        opts.force = true;
        break;
      case '--model':
        if (!argv[i + 1] || String(argv[i + 1]).startsWith('-')) {
          opts.errors.push('--model requires a valid model tag.');
        } else {
          opts.model = argv[i + 1];
          i += 1;
        }
        break;
      default:
        if (arg.startsWith('--model=')) {
          opts.model = arg.slice('--model='.length);
          if (!opts.model || opts.model.startsWith('-')) {
            opts.errors.push('--model requires a valid model tag.');
          }
        } else {
          opts.errors.push(`Unknown option: ${arg}`);
        }
        break;
    }
  }
  if (opts.model && (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(opts.model) || opts.model.startsWith('-'))) {
    opts.errors.push('The model tag is invalid.');
  }
  return opts;
}

function npmCommand(platform) {
  return platform === 'win32' ? 'npm.cmd' : 'npm';
}

// Streaming command runner (inherits stdio). npm is a .cmd on Windows, which
// Node refuses to spawn without a shell; everything else is a real executable
// or an absolute path and spawns bare.
function defaultRunStreaming(cmd, args, { cwd = REPO_ROOT, shell = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: 'inherit', windowsHide: true, shell });
    } catch (error) {
      resolve({ status: 127, error });
      return;
    }
    child.on('error', (error) => resolve({ status: 127, error }));
    child.on('close', (code) => resolve({ status: typeof code === 'number' ? code : 1 }));
  });
}

// Detached launcher for the friend distribution: start the app in its own process
// group with no inherited stdio and no console window, then unref so setup can exit
// while Jenny keeps running. A short observation window rejects immediate exits.
function defaultLaunchDetached(cmd, args, { cwd = REPO_ROOT, shell = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore', windowsHide: true, shell });
    } catch (error) {
      resolve({ status: 127, error });
      return;
    }
    child.once('error', (error) => resolve({ status: 127, error }));
    child.once('spawn', () => {
      var settled = false;
      var timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.unref();
        resolve({ status: 0 });
      }, 1500);
      child.once('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: typeof code === 'number' ? code : 1, earlyExit: true });
      });
    });
  });
}

// True when this checkout is the lean friend distribution. The staging generator
// (scripts/packaging/create_github_stage.py --dist) sets "distribution": true in the
// shipped package.json; the dev repo never has it, so dev keeps the attached console.
function defaultIsDistribution(repoRoot = REPO_ROOT) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    return Boolean(data && data.distribution === true);
  } catch (_error) {
    return false;
  }
}

async function defaultPromptYesNo(question, { yes }) {
  if (yes) {
    return true;
  }
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (value) => resolve(value));
  });
  rl.close();
  return /^y(es)?$/i.test(String(answer || '').trim());
}

async function runSetup(options = {}) {
  const argv = options.argv || process.argv.slice(2);
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const repoRoot = options.repoRoot || REPO_ROOT;
  const nodeVersion = options.nodeVersion || process.versions.node;
  const ui = options.ui || defaultUi;
  const deps = options.deps || {};
  const run = deps.runCapture || prereqs.defaultRun;
  const runStreaming = deps.runStreaming || defaultRunStreaming;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const spawnImpl = deps.spawnImpl || spawn;
  const fileExists = deps.fileExists || fs.existsSync;
  const sleepImpl = deps.sleepImpl;
  const promptYesNo = deps.promptYesNo || defaultPromptYesNo;
  const launchDetached = deps.launchDetached || defaultLaunchDetached;
  const isDistribution = deps.isDistribution || defaultIsDistribution;
  const restartOllamaAfterUpgrade = deps.restartOllamaAfterUpgrade
    || defaultRestartOllamaAfterUpgrade;

  const opts = parseArgs(argv);
  if (opts.errors.length) {
    ui.fail(opts.errors.join(' '));
    return EXIT.PREREQ;
  }
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return EXIT.OK;
  }
  const modelTag = opts.model || DEFAULT_MANAGED_SHELL_MODEL;
  let deferredCode = EXIT.OK;

  ui.heading('Jenny setup');

  // ---- Phase A: prerequisites -------------------------------------------
  ui.heading('1/7 · Prerequisites');
  const node = prereqs.checkNode(run, { nodeVersion });
  const npm = prereqs.checkNpm(run);
  const python = prereqs.checkPython(run, { platform });
  const git = prereqs.checkGit(run);

  if (!node.satisfiesMin) {
    ui.fail(`Supported Node LTS required: ${node.min} (found ${node.versionText}). See https://nodejs.org`);
    return EXIT.PREREQ;
  }
  ui.ok(`Node ${node.versionText}`);
  if (!npm.found || !npm.satisfiesMin) {
    ui.fail(`npm ${npm.min}+ required (found ${npm.found ? npm.versionText : 'none'}).`);
    return EXIT.PREREQ;
  }
  ui.ok(`npm ${npm.versionText}`);
  if (!python.found || !python.satisfiesMin) {
    let hint;
    if (platform === 'win32') {
      hint = 'winget install Python.Python.3.11';
    } else if (platform === 'darwin') {
      hint = 'brew install python@3.11';
    } else {
      hint = 'install Python 3.11 via your package manager (e.g. sudo apt install python3.11) — see https://www.python.org/downloads/';
    }
    ui.fail(`Python ${python.min}+ required (found ${python.found ? python.versionText : 'none'}). Try: ${hint}`);
    return EXIT.PREREQ;
  }
  ui.ok(`Python ${python.versionText}`);
  if (git.found) {
    ui.ok(`git ${git.versionText}`);
  } else {
    ui.warn('git not found — needed for updates and the pre-commit hook.');
  }

  // ---- Phase B: npm install ---------------------------------------------
  ui.heading('2/7 · Node dependencies');
  if (!opts.force && opts.bootstrappedNpm) {
    ui.skip('The platform wrapper completed npm install.');
  } else {
    ui.step('npm install');
    const result = await runStreaming(npmCommand(platform), ['install'], {
      cwd: repoRoot,
      shell: platform === 'win32',
    });
    if (result.status !== 0) {
      ui.fail('npm install failed. Fix the error above and re-run setup.');
      return EXIT.UNKNOWN;
    }
    ui.ok('Node dependencies installed.');
  }

  // ---- Phase C: Python venv + sidecar deps ------------------------------
  ui.heading('3/7 · Python sidecar environment');
  const venvResult = pythonEnv.ensureVenv(repoRoot, python.launcher, {
    run,
    platform,
    fileExists,
    ...(deps.rename ? { rename: deps.rename } : {}),
    ...(deps.nowProvider ? { nowProvider: deps.nowProvider } : {}),
  });
  if (venvResult.error) {
    ui.fail(`Could not create .venv (${venvResult.error}). ${venvResult.detail || ''}`.trim());
    return EXIT.PYTHON;
  }
  if (venvResult.created) {
    ui.ok('Created .venv');
  } else {
    ui.skip('.venv already present');
  }
  const pipTarget = opts.dev ? '.[dev]' : '.';
  ui.step(`pip install -e "${pipTarget}" (this can take a minute)`);
  const pip = pythonEnv.installSidecarDeps(repoRoot, { run, platform, dev: opts.dev });
  if (!pip.ok) {
    ui.fail(`Sidecar dependency install failed at ${pip.phase}.`);
    if (pip.detail) {
      ui.info(pip.detail.split('\n').slice(-3).join('\n'));
    }
    return EXIT.PYTHON;
  }
  ui.ok('Sidecar environment ready.');

  // ---- Phase D: ensure Ollama -------------------------------------------
  ui.heading('4/7 · Ollama runtime');
  let ollama = await ollamaStep.detectOllama({ fetchImpl, run, fileExists, platform, env });
  if (!ollama.installed || ollama.upgradeRequired === true) {
    const upgrading = ollama.installed && ollama.upgradeRequired === true;
    const plan = ollamaStep.installPlan(platform, { upgrade: upgrading });
    let attemptedInstall = false;
    if (plan.command) {
      const verb = upgrading ? `Upgrade Ollama to ${ollama.minimumVersion}+ with ${plan.manager}?` : `Install Ollama with ${plan.manager}?`;
      const consent = await promptYesNo(verb, { yes: opts.yes });
      if (consent) {
        ui.step(`${plan.manager} ${upgrading ? 'upgrade' : 'install'}`);
        const [cmd, cmdArgs] = plan.command;
        // winget/brew are real executables -> bare spawn resolves them.
        const installResult = await runStreaming(cmd, cmdArgs, { cwd: repoRoot });
        attemptedInstall = installResult.status === 0;
        if (!attemptedInstall) {
          ui.warn(`${plan.manager} ${upgrading ? 'upgrade' : 'install'} failed with exit ${installResult.status}.`);
        }
        // winget wrote the new PATH to the registry, but this process kept its
        // old PATH snapshot. Prepend the known Ollama install dir(s) so the
        // re-detect and the later serve/pull/show spawns resolve 'ollama'
        // without the user having to open a fresh shell.
        if (attemptedInstall) {
          const ollamaDirs = ollamaStep.ollamaInstallDirs(platform, env).filter((dir) => fileExists(dir));
          if (ollamaDirs.length) {
            env.PATH = [...ollamaDirs, env.PATH || ''].filter(Boolean).join(path.delimiter);
          }
          if (upgrading) {
            ui.step('Restarting Ollama to activate the upgraded runtime');
            try {
              await restartOllamaAfterUpgrade({ platform, env });
            } catch (error) {
              ui.warn(`Could not stop the older Ollama server (${String(error?.message || error).slice(0, 240)}).`);
            }
          }
          ollama = await ollamaStep.detectOllama({ fetchImpl, run, fileExists, platform, env });
        }
      }
    }
    if (!ollama.installed || ollama.upgradeRequired === true) {
      if (attemptedInstall) {
        // We already prepended the known install dir(s) to this process's PATH
        // and re-detected; if it's still not found, the binary landed somewhere
        // unexpected (or the manager silently failed). Don't claim it failed outright.
        ui.warn(upgrading
          ? `Ollama ${ollama.version || 'unknown'} is still active. Restart Ollama, then re-run setup; ${ollama.minimumVersion}+ is required.`
          : 'Ollama was installed but could not be located automatically. Open a new terminal and re-run setup to finish.');
      } else {
        ui.warn(upgrading
          ? `Ollama ${ollama.version || ''} is too old. Upgrade it from ${plan.manualUrl} then re-run setup.`
          : `Ollama is not installed. Install it from ${plan.manualUrl} then re-run setup.`);
      }
      if (!opts.skipModel) {
        return EXIT.OLLAMA;
      }
    }
  } else {
    ui.ok('Ollama detected.');
  }

  if (ollama.installed) {
    const serving = await ollamaStep.ensureServing({
      fetchImpl, spawnImpl, run, sleepImpl, initialDetect: ollama, platform, env, fileExists,
    });
    if (serving.running) {
      ollama = await ollamaStep.detectOllama({ fetchImpl, run, fileExists, platform, env });
      if (ollama.versionSupported !== true) {
        ui.warn(ollama.upgradeRequired
          ? `Ollama ${ollama.version} is too old; ${ollama.minimumVersion}+ is required before downloading models.`
          : `Could not verify the running Ollama version; ${ollama.minimumVersion}+ is required.`);
        if (!opts.skipModel) {
          return EXIT.OLLAMA;
        }
      } else {
        ui.ok(ollama.version
          ? `Ollama server ${ollama.version} is running.`
          : 'Ollama server is running (version unverified).');
      }
    } else {
      ui.warn('Ollama is installed but not serving. Start it with: ollama serve');
      if (!opts.skipModel) {
        return EXIT.OLLAMA;
      }
    }
  }

  // ---- Phase E: default model -------------------------------------------
  ui.heading('5/7 · Default model');
  if (opts.skipModel) {
    ui.skip('Model download skipped (--skip-model). Pull it later from the in-app setup tile.');
  } else if (!opts.force && ollamaStep.modelExists(modelTag, { run, platform, env, fileExists })) {
    ui.skip(`${modelTag} already downloaded.`);
  } else {
    ui.step(`Pulling ${modelTag} — this is a multi-GB download.`);
    const pull = await ollamaStep.pullModel(modelTag, {
      spawnImpl,
      platform,
      env,
      fileExists,
      onProgress: ({ percent, label }) => ui.progress(label, percent),
    });
    if (pull.ok) {
      ui.ok(`${modelTag} ready.`);
    } else {
      ui.warn(`Model pull failed (${pull.error || `exit ${pull.code}`}). Jenny will still launch; retry from the in-app setup tile or run: ollama pull ${modelTag}`);
      deferredCode = EXIT.MODEL;
    }
  }

  // ---- Phase F: pre-commit (contributor-only) ---------------------------
  // Only for a contributor setup (--dev) AND only when the repo actually ships a
  // pre-commit config. The lean run-only distribution has no .pre-commit-config.yaml,
  // so this is skipped — installing a hook with no config silently breaks the
  // user's first `git commit`.
  const preCommitConfig = path.join(repoRoot, '.pre-commit-config.yaml');
  if (!opts.noPrecommit && opts.dev && fileExists(path.join(repoRoot, '.git')) && fileExists(preCommitConfig)) {
    ui.heading('6/7 · git hooks (optional)');
    const venvPython = pythonEnv.venvPythonPath(repoRoot, platform);
    const hook = await runStreaming(venvPython, ['-m', 'pre_commit', 'install'], { cwd: repoRoot });
    if (hook.status === 0) {
      ui.ok('pre-commit hook installed.');
    } else {
      ui.warn('pre-commit not installed (optional; needed only for contributing).');
    }
  }

  // ---- Phase G: launch ---------------------------------------------------
  ui.heading('7/7 · Launch');
  // The lean friend distribution is flagged in package.json (set by the staging
  // generator, never in the dev repo). There we launch Jenny detached + hidden so
  // no console window is tied to the app; the dev repo keeps the attached
  // `npm run dev` so contributors still see live logs in their terminal.
  const distribution = isDistribution(repoRoot);
  const startLater = distribution
    ? 'Start Jenny anytime from the "Jenny" desktop shortcut, or run: npm run dev'
    : 'Start Jenny anytime with: npm run dev';
  if (opts.noLaunch) {
    if (deferredCode === EXIT.MODEL) ui.warn(`Setup incomplete: the default model is unavailable. ${startLater}`);
    else ui.ok(`Setup complete. ${startLater}`);
    return deferredCode;
  }
  const launch = await promptYesNo('Launch Jenny now?', { yes: opts.yes });
  if (!launch) {
    if (deferredCode === EXIT.MODEL) ui.warn(`Setup incomplete: the default model is unavailable. ${startLater}`);
    else ui.ok(`Setup complete. ${startLater}`);
    return deferredCode;
  }
  if (distribution) {
    // Detached + hidden: setup returns immediately and the terminal can close,
    // while Jenny keeps running in its own window with no log console attached.
    ui.step('Starting Jenny');
    const started = await launchDetached(npmCommand(platform), ['run', 'dev'], {
      cwd: repoRoot,
      shell: platform === 'win32',
    });
    if (started.status !== 0 || started.earlyExit === true) {
      ui.fail('Could not launch Jenny. Start it manually: npm run dev');
      return EXIT.UNKNOWN;
    }
    ui.ok('Jenny is starting in its own window — you can close this terminal.');
    if (deferredCode === EXIT.MODEL) ui.warn('Jenny launched, but setup is incomplete because the default model is unavailable.');
    return deferredCode;
  }
  ui.step('npm run dev');
  const dev = await runStreaming(npmCommand(platform), ['run', 'dev'], {
    cwd: repoRoot,
    shell: platform === 'win32',
  });
  // The app launched and (eventually) exited. Setup itself succeeded — the app's
  // own exit code (often non-zero on Ctrl-C / window close) is not a setup
  // failure, and any deferred model-pull warning was already surfaced and is now
  // stale (the user chose to launch). Only a spawn failure (couldn't start npm
  // at all) is a real launch error worth a non-zero setup exit.
  if (dev.status === 127) {
    ui.fail('Could not launch Jenny (npm run dev failed to start). Run it manually: npm run dev');
    return EXIT.UNKNOWN;
  }
  if (deferredCode === EXIT.MODEL) ui.warn('Jenny launched, but setup is incomplete because the default model is unavailable.');
  return deferredCode;
}

async function main() {
  try {
    const code = await runSetup();
    process.exit(code);
  } catch (error) {
    process.stderr.write(`\nSetup failed unexpectedly: ${(error && error.stack) || error}\n`);
    process.exit(EXIT.UNKNOWN);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  EXIT,
  HELP,
  parseArgs,
  npmCommand,
  runSetup,
};
