// Pure packaged-smoke request parsing and a dependency-injected smoke controller.

const fs = require('fs');
const path = require('path');

const DEFAULT_PACKAGED_SMOKE_TIMEOUT_MS = 45_000;
const PACKAGED_SMOKE_REQUEST_FILENAME = 'packaged-smoke-request.json';

function parsePackagedSmokeCliArgs(argv = process.argv.slice(1)) {
  const args = Array.isArray(argv) ? argv : [];
  const result = {
    outputPath: '',
    timeoutMs: '',
  };
  for (const rawArg of args) {
    const arg = String(rawArg || '').trim();
    if (!arg) {
      continue;
    }
    if (arg.startsWith('--packaged-smoke-output=')) {
      result.outputPath = arg.slice('--packaged-smoke-output='.length).trim();
      continue;
    }
    if (arg.startsWith('--packaged-smoke-timeout-ms=')) {
      result.timeoutMs = arg.slice('--packaged-smoke-timeout-ms='.length).trim();
    }
  }
  return result;
}

function readPackagedSmokeRequest(requestPath) {
  const normalizedPath = String(requestPath || '').trim();
  if (!normalizedPath || !fs.existsSync(normalizedPath)) {
    return {
      requestPath: '',
      outputPath: '',
      timeoutMs: '',
    };
  }
  try {
    const payload = JSON.parse(fs.readFileSync(normalizedPath, 'utf8'));
    const request = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload
      : {};
    return {
      requestPath: normalizedPath,
      outputPath: String(
        request.outputPath
        || request.output_path
        || ''
      ).trim(),
      timeoutMs: String(
        request.timeoutMs
        || request.timeout_ms
        || ''
      ).trim(),
    };
  } catch (_error) {
    return {
      requestPath: normalizedPath,
      outputPath: '',
      timeoutMs: '',
    };
  } finally {
    try {
      fs.unlinkSync(normalizedPath);
    } catch (_error) {
      // Best effort only.
    }
  }
}

function resolvePackagedSmokeConfig({
  argv = process.argv.slice(1),
  env = process.env,
  execPath = process.execPath,
} = {}) {
  const cliArgs = parsePackagedSmokeCliArgs(argv);
  const requestCandidates = [
    env.JENNY_PACKAGED_SMOKE_REQUEST,
    execPath ? path.join(path.dirname(execPath), PACKAGED_SMOKE_REQUEST_FILENAME) : '',
  ];
  const requestConfig = requestCandidates
    .map((candidate) => readPackagedSmokeRequest(candidate))
    .find((candidate) => candidate.requestPath || candidate.outputPath || candidate.timeoutMs)
    || { requestPath: '', outputPath: '', timeoutMs: '' };
  return {
    outputPath: String(
      env.JENNY_PACKAGED_SMOKE_OUTPUT
      || cliArgs.outputPath
      || requestConfig.outputPath
      || ''
    ).trim(),
    timeoutMs: String(
      env.JENNY_PACKAGED_SMOKE_TIMEOUT_MS
      || cliArgs.timeoutMs
      || requestConfig.timeoutMs
      || ''
    ).trim(),
    requestPath: requestConfig.requestPath,
  };
}

function shouldBypassSingleInstanceForPackagedSmoke(config = {}) {
  return Boolean(
    String(config.outputPath || '').trim()
    && String(config.requestPath || '').trim()
  );
}

function shouldUsePackagedSidecarRuntime({
  appRef = null,
  resourcesPath = process.resourcesPath,
} = {}) {
  if (appRef && appRef.isPackaged === true) {
    return true;
  }
  const manifestPath = path.join(String(resourcesPath || '').trim(), 'sidecar', 'manifest.json');
  return Boolean(manifestPath && fs.existsSync(manifestPath));
}

function createPackagedSmokeController({
  outputPath = '',
  timeoutMs = DEFAULT_PACKAGED_SMOKE_TIMEOUT_MS,
  appRef = null,
  requestShutdown = null,
  ipcMainRef = null,
  getWindow = () => null,
  getBackendStatus = () => ({}),
  readyChannel = '',
} = {}) {
  const normalizedOutputPath = String(outputPath || '').trim();
  if (!normalizedOutputPath) {
    return null;
  }
  const normalizedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.max(Math.trunc(timeoutMs), 1)
    : DEFAULT_PACKAGED_SMOKE_TIMEOUT_MS;
  const state = {
    completed: false,
    rendererReady: false,
    backendStatus: null,
    timeoutHandle: null,
  };

  function writeResult(result) {
    if (state.completed) {
      return;
    }
    state.completed = true;
    if (state.timeoutHandle) {
      clearTimeout(state.timeoutHandle);
      state.timeoutHandle = null;
    }
    ipcMainRef.removeListener(readyChannel, handleRendererReady);
    const payload = {
      ok: result.ok === true,
      rendererReady: state.rendererReady,
      backendStatus: result.backendStatus || state.backendStatus || getBackendStatus() || {},
      launchSource: String(result.launchSource || state.backendStatus?.launchSource || '').trim(),
      packagedLaunchDetail: String(
        result.packagedLaunchDetail
        || state.backendStatus?.packagedLaunchDetail
        || ''
      ).trim(),
      error: String(result.error || '').trim(),
    };
    try {
      fs.mkdirSync(path.dirname(normalizedOutputPath), { recursive: true });
      fs.writeFileSync(normalizedOutputPath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (_error) {
      // Best effort only; the smoke runner will still fail on missing output.
    }
    process.exitCode = payload.ok ? 0 : 1;
    const exitDirectly = () => {
      if (typeof appRef?.exit === 'function') appRef.exit(process.exitCode);
      else appRef?.quit?.();
    };
    if (typeof requestShutdown !== 'function') {
      exitDirectly();
      return;
    }
    try {
      const shutdown = requestShutdown(process.exitCode);
      if (shutdown && typeof shutdown.catch === 'function') shutdown.catch(exitDirectly);
    } catch (_error) {
      exitDirectly();
    }
  }

  function maybeWriteSuccess() {
    if (!state.rendererReady) {
      return;
    }
    const backendStatus = state.backendStatus || getBackendStatus() || {};
    if (String(backendStatus.phase || '').trim().toLowerCase() !== 'ready') {
      return;
    }
    writeResult({
      ok: true,
      backendStatus,
      launchSource: backendStatus.launchSource,
      packagedLaunchDetail: backendStatus.packagedLaunchDetail,
    });
  }

  function handleRendererReady(event) {
    const windowRef = getWindow();
    if (!windowRef || windowRef.isDestroyed?.()) {
      return;
    }
    if (event?.sender && event.sender !== windowRef.webContents) {
      return;
    }
    state.rendererReady = true;
    maybeWriteSuccess();
  }

  ipcMainRef.on(readyChannel, handleRendererReady);
  state.timeoutHandle = setTimeout(() => {
    writeResult({
      ok: false,
      backendStatus: state.backendStatus || getBackendStatus() || {},
      launchSource: state.backendStatus?.launchSource || '',
      packagedLaunchDetail: state.backendStatus?.packagedLaunchDetail || '',
      error: `Packaged smoke timed out after ${normalizedTimeoutMs}ms.`,
    });
  }, normalizedTimeoutMs);
  if (typeof state.timeoutHandle?.unref === 'function') {
    state.timeoutHandle.unref();
  }

  return {
    markBackendReady(status) {
      state.backendStatus = status && typeof status === 'object' ? { ...status } : {};
      maybeWriteSuccess();
    },
    markBackendFailed(status, error) {
      state.backendStatus = status && typeof status === 'object' ? { ...status } : {};
      writeResult({
        ok: false,
        backendStatus: state.backendStatus,
        launchSource: state.backendStatus.launchSource || '',
        packagedLaunchDetail: state.backendStatus.packagedLaunchDetail || '',
        error: String(error || state.backendStatus.detail || 'Packaged smoke failed.'),
      });
    },
    dispose() {
      if (state.timeoutHandle) {
        clearTimeout(state.timeoutHandle);
        state.timeoutHandle = null;
      }
      ipcMainRef.removeListener(readyChannel, handleRendererReady);
    },
  };
}

module.exports = {
  DEFAULT_PACKAGED_SMOKE_TIMEOUT_MS,
  PACKAGED_SMOKE_REQUEST_FILENAME,
  parsePackagedSmokeCliArgs,
  readPackagedSmokeRequest,
  resolvePackagedSmokeConfig,
  shouldBypassSingleInstanceForPackagedSmoke,
  shouldUsePackagedSidecarRuntime,
  createPackagedSmokeController,
};
