'use strict';
// Opt-in codex-cli ChatGPT product engine (explicit cloud opt-in, AGENTS.md).
// Composed via backend-service; reached via codexCli.* IPC + provider registry.
// See docs/architecture/BACKEND_SEAM_LANE.md.

const { spawn: defaultSpawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  getCodexCliChildSpawnOptions,
} = require('./codex-cli-child-process');
const {
  CODEX_LOGIN_COMMAND,
  classifyCodexLoginSetupError,
  createCodexLoginSetupResult,
} = require('./codex-cli-login-setup');

const DEFAULT_OUTPUT_LIMIT = 24_000;
const DEFAULT_STATUS_TIMEOUT_MS = 8000;

function appendTail(current, chunk, limit) {
  const next = `${current || ''}${String(chunk || '')}`;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function isAccessDenied(error) {
  const message = String(error?.message || error || '');
  return error?.code === 'EACCES' || /access is denied/i.test(message);
}

function classifySpawnError(error) {
  if (isAccessDenied(error)) {
    return 'cli_access_denied';
  }
  if (error?.code === 'ENOENT') {
    return 'auth_required_or_cli_missing';
  }
  return 'cli_spawn_failed';
}

function normalizeCommand(command, fallback = 'codex') {
  const token = String(command || '').trim();
  return token || fallback;
}

function isPathLikeCommand(command) {
  const value = String(command || '').trim();
  return path.isAbsolute(value) || value.includes(path.sep) || (path.sep === '\\' && value.includes('/'));
}

function isWindowsAppsCodexPath(candidate) {
  const normalized = String(candidate || '').replace(/\//g, '\\').toLowerCase();
  return normalized.includes('\\windowsapps\\openai.codex_')
    || normalized.includes('\\windowsapps\\openai.codex\\');
}

function isVscodeExtensionCodexPath(candidate) {
  const normalized = String(candidate || '').replace(/\//g, '\\').toLowerCase();
  return normalized.includes('\\.vscode\\extensions\\openai.chatgpt-')
    || normalized.includes('\\.vscode-insiders\\extensions\\openai.chatgpt-')
    || normalized.includes('\\.cursor\\extensions\\openai.chatgpt-');
}

function classifyCodexCommandSource(commandPath, command = 'codex') {
  const normalizedPath = String(commandPath || '').trim();
  if (!normalizedPath) {
    return 'unknown';
  }
  if (isWindowsAppsCodexPath(normalizedPath)) {
    return 'windowsapps';
  }
  if (isVscodeExtensionCodexPath(normalizedPath)) {
    return 'vscode_extension';
  }
  const normalizedCommand = normalizeCommand(command);
  if (normalizedPath === normalizedCommand && !isPathLikeCommand(normalizedPath)) {
    return 'shell_path';
  }
  return 'path_command';
}

function findExistingFile(candidates) {
  for (const candidate of candidates) {
    const normalized = String(candidate || '').trim();
    if (!normalized) {
      continue;
    }
    try {
      if (fs.existsSync(normalized)) {
        return normalized;
      }
    } catch (_error) {
      // Ignore unreadable candidates and keep searching.
    }
  }
  return '';
}

function listChildDirectories(rootDir) {
  const normalizedRoot = String(rootDir || '').trim();
  if (!normalizedRoot) {
    return [];
  }
  try {
    return fs.readdirSync(normalizedRoot, { withFileTypes: true })
      .filter((entry) => entry && typeof entry.isDirectory === 'function' && entry.isDirectory())
      .map((entry) => path.join(normalizedRoot, entry.name));
  } catch (_error) {
    return [];
  }
}

function resolveCodexFromVscodeExtensions(env = process.env) {
  const homes = [env?.USERPROFILE, env?.HOME]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
  const extensionRoots = homes.flatMap((home) => [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
  ]);
  const candidateExtensions = extensionRoots
    .flatMap((rootDir) => listChildDirectories(rootDir))
    .filter((dir) => path.basename(dir).toLowerCase().startsWith('openai.chatgpt-'))
    .sort((left, right) => {
      try {
        return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
      } catch (_error) {
        return 0;
      }
    });
  return findExistingFile(candidateExtensions.map((extensionDir) =>
    path.join(extensionDir, 'bin', 'windows-x86_64', 'codex.exe')
  ));
}

function resolveCodexCommandPath(command = 'codex', env = process.env, platform = process.platform) {
  const normalized = normalizeCommand(command);
  if (isPathLikeCommand(normalized)) {
    return normalized;
  }

  const pathValue = String(env?.PATH || env?.Path || '').trim();
  // .exe FIRST on Windows. The resolved path is later handed to a
  // `shell: false` spawn, and Node documents that as unable to launch a .cmd or
  // .bat (they are not executables -- they need cmd.exe). npm's global bin dir
  // ships codex.cmd next to nothing else, so the old .cmd-first order resolved
  // to a path that could never start, and the VS Code-extension codex.exe
  // fallback below was unreachable because `candidates` was non-empty.
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const SHELL_ONLY_EXTENSIONS = new Set(['.cmd', '.bat']);
  const candidates = [];
  if (pathValue) {
    for (const rawDir of pathValue.split(path.delimiter)) {
      const dir = String(rawDir || '').trim();
      if (!dir) {
        continue;
      }
      for (const extension of extensions) {
        const candidate = path.join(dir, `${normalized}${extension}`);
        try {
          if (fs.existsSync(candidate)) {
            candidates.push(candidate);
          }
        } catch (_error) {
          // Ignore unreadable PATH entries and keep searching.
        }
      }
    }
  }

  const usable = candidates.filter((candidate) => !isWindowsAppsCodexPath(candidate));
  // A .cmd/.bat shim is not "found" for our purposes: the caller spawns with
  // shell:false. Fall through to the VS Code-extension codex.exe instead, and
  // only return the shim if that lookup also comes up empty (better a command
  // that fails loudly than the bare name).
  const preferred = usable.find(
    (candidate) => !SHELL_ONLY_EXTENSIONS.has(path.extname(candidate).toLowerCase())
  );
  if (preferred) {
    return preferred;
  }
  if (platform === 'win32') {
    const extensionResolved = resolveCodexFromVscodeExtensions(env);
    if (extensionResolved) {
      return extensionResolved;
    }
  }
  return usable[0] || candidates[0] || normalized;
}

function classifyAuthType(stdout, stderr) {
  const combined = `${stdout || ''}\n${stderr || ''}`.toLowerCase();
  if (combined.includes('chatgpt')) {
    return 'chatgpt';
  }
  if (combined.includes('api key') || combined.includes('api-key')) {
    return 'api_key';
  }
  return '';
}

function isAuthRequiredOutput(stdout, stderr) {
  const combined = `${stdout || ''}\n${stderr || ''}`.toLowerCase();
  return combined.includes('not logged in')
    || combined.includes('login required')
    || combined.includes('authentication required')
    || combined.includes('run `codex login`')
    || combined.includes('run codex login')
    || combined.includes('please login');
}

function createCodexSetupCheckResult({
  ok = false,
  code = '',
  message = '',
  command = CODEX_LOGIN_COMMAND,
  commandPath = '',
  commandSource = '',
  authType = '',
  exitCode = null,
  stdoutTail = '',
  stderrTail = '',
} = {}) {
  const setup = createCodexLoginSetupResult({
    ok,
    code: ok ? 'ready' : code,
    command,
    message,
    scrubText: (value) => String(value || '')
      .replace(/[A-Za-z]:[\\/][^\s'"`<>]+/g, '[path]')
      .slice(0, 1000),
  });
  return {
    ok: ok === true,
    code: ok === true ? 'ready' : setup.code,
    command,
    commandPath: String(commandPath || '').trim(),
    commandSource: String(commandSource || classifyCodexCommandSource(commandPath)).trim() || 'unknown',
    authType: String(authType || '').trim(),
    exitCode: Number.isFinite(Number(exitCode)) ? Number(exitCode) : null,
    stdoutTail: String(stdoutTail || ''),
    stderrTail: String(stderrTail || ''),
    message: ok === true
      ? String(message || 'Codex CLI is authenticated.').trim()
      : setup.message,
  };
}

function loginTerminalResult(ok, code) {
  return createCodexLoginSetupResult({ ok, code });
}

function quoteWindowsCmdArgument(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return 'codex';
  }
  if (!/[\s&()^%!"]/u.test(raw)) {
    return raw;
  }
  return `"${raw.replace(/"/g, '""')}"`;
}

function loginTerminalResultForCommand(ok, code, commandPath = '') {
  return {
    ...loginTerminalResult(ok, code),
    commandPath: String(commandPath || '').trim(),
  };
}

async function checkCodexDiagnosticSetup({
  cwd = process.cwd(),
  codexCommand = 'codex',
  env = process.env,
  platform = process.platform,
  spawn = defaultSpawn,
  timeoutMs = DEFAULT_STATUS_TIMEOUT_MS,
  outputLimit = DEFAULT_OUTPUT_LIMIT,
} = {}) {
  const commandPath = resolveCodexCommandPath(codexCommand, env, platform);
  const commandSource = classifyCodexCommandSource(commandPath, codexCommand);
  const command = 'codex login status';
  const limit = Math.max(Number(outputLimit) || DEFAULT_OUTPUT_LIMIT, 1);
  const timeout = Math.max(Number(timeoutMs) || DEFAULT_STATUS_TIMEOUT_MS, 1);
  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let timer = null;
    let stdoutTail = '';
    let stderrTail = '';

    function finish(result) {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(result);
    }

    try {
      child = spawn(commandPath, ['login', 'status'], {
        cwd,
        ...getCodexCliChildSpawnOptions({ platform }),
        env,
      });
    } catch (error) {
      finish(createCodexSetupCheckResult({
        ok: false,
        code: classifySpawnError(error),
        command,
        commandPath,
        commandSource,
        message: String(error?.message || error || 'Codex CLI login status failed.'),
      }));
      return;
    }

    timer = setTimeout(() => {
      try {
        child?.kill?.('SIGTERM');
      } catch (_error) {
        // Best effort; the status probe is bounded by the returned result.
      }
      finish(createCodexSetupCheckResult({
        ok: false,
        code: 'cli_status_timeout',
        command,
        commandPath,
        commandSource,
        stdoutTail,
        stderrTail,
      }));
    }, timeout);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    child.stdout?.on?.('data', (chunk) => {
      stdoutTail = appendTail(stdoutTail, chunk, limit);
    });
    child.stderr?.on?.('data', (chunk) => {
      stderrTail = appendTail(stderrTail, chunk, limit);
    });
    child.once?.('error', (error) => {
      finish(createCodexSetupCheckResult({
        ok: false,
        code: classifySpawnError(error),
        command,
        commandPath,
        commandSource,
        message: String(error?.message || error || 'Codex CLI login status failed.'),
        stdoutTail,
        stderrTail,
      }));
    });
    child.once?.('close', (exitCode) => {
      const normalizedExitCode = Number.isFinite(Number(exitCode)) ? Number(exitCode) : null;
      if (normalizedExitCode === 0) {
        finish(createCodexSetupCheckResult({
          ok: true,
          code: 'ready',
          command,
          commandPath,
          commandSource,
          authType: classifyAuthType(stdoutTail, stderrTail),
          exitCode: normalizedExitCode,
          stdoutTail,
          stderrTail,
          message: 'Codex CLI is authenticated.',
        }));
        return;
      }
      finish(createCodexSetupCheckResult({
        ok: false,
        code: isAuthRequiredOutput(stdoutTail, stderrTail)
          ? 'auth_required_or_cli_missing'
          : 'cli_exit_failed',
        command,
        commandPath,
        commandSource,
        exitCode: normalizedExitCode,
        stdoutTail,
        stderrTail,
        message: stdoutTail || stderrTail || `Codex CLI login status exited with code ${normalizedExitCode}.`,
      }));
    });
  });
}

async function openCodexLoginTerminal({
  cwd = process.cwd(),
  platform = process.platform,
  spawn = defaultSpawn,
  commandShell = process.env.ComSpec || 'cmd.exe',
  codexCommand = 'codex',
  env = process.env,
} = {}) {
  if (platform !== 'win32') {
    return loginTerminalResultForCommand(false, 'unsupported_platform');
  }
  const commandPath = resolveCodexCommandPath(codexCommand, env, platform);
  const loginCommand = `${quoteWindowsCmdArgument(commandPath)} login`;
  let child = null;
  try {
    child = spawn(commandShell, [
      '/d',
      '/c',
      'start',
      'Jenny Codex Login',
      'cmd.exe',
      '/k',
      loginCommand,
    ], {
      cwd,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      shell: false,
      env,
    });
  } catch (error) {
    return loginTerminalResultForCommand(false, classifyCodexLoginSetupError(error), commandPath);
  }
  if (!child || typeof child.once !== 'function') {
    try {
      child?.unref?.();
    } catch (_error) {
      // Best effort only; the visible login terminal is independent of Jenny.
    }
    return loginTerminalResultForCommand(true, 'login_terminal_opened', commandPath);
  }
  return new Promise((resolve) => {
    let settled = false;
    function settle(result) {
      if (settled) {
        return;
      }
      settled = true;
      child.removeListener?.('error', onError);
      child.removeListener?.('spawn', onSpawn);
      resolve(result);
    }
    function onError(error) {
      settle(loginTerminalResultForCommand(false, classifyCodexLoginSetupError(error), commandPath));
    }
    function onSpawn() {
      try {
        child.unref?.();
      } catch (_error) {
        // Best effort only; the visible login terminal is independent of Jenny.
      }
      settle(loginTerminalResultForCommand(true, 'login_terminal_opened', commandPath));
    }
    child.once('error', onError);
    child.once('spawn', onSpawn);
  });
}

module.exports = {
  checkCodexDiagnosticSetup,
  classifyCodexCommandSource,
  openCodexLoginTerminal,
  resolveCodexCommandPath,
};
