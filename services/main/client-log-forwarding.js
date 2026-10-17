const { buildFeatureFlags } = require('../feature-flags');
const { getBridgeChannel } = require('../ipc-contract');

const MAX_BATCH_ENTRIES = 200;

function createLogRedactionPrefixesProvider({ app, rootDir, getShellConfigService = () => null } = {}) {
  return function getLogRedactionPrefixes() {
    const shellConfigService = getShellConfigService();
    return [
      app && typeof app.getPath === 'function' ? app.getPath('userData') : '',
      rootDir,
      shellConfigService && typeof shellConfigService.getState === 'function'
        ? shellConfigService.getState().toolsWorkspaceRoot
        : '',
    ].filter(Boolean);
  };
}

function createClientLogBatchHandler({
  getDiagnosticLogService = () => null,
  getRedactionPrefixes = () => [],
  env = process.env,
  log = () => {},
} = {}) {
  const debugForwardingEnabled = buildFeatureFlags(env).agent_test_hooks === true;
  let warnedAboutDrops = false;

  return function handleClientLogBatch(_event, batch) {
    const diagnosticLogService = getDiagnosticLogService();
    if (!diagnosticLogService) return;
    const rawEntries = Array.isArray(batch?.entries) ? batch.entries : [];
    const entries = rawEntries.slice(0, MAX_BATCH_ENTRIES);
    const droppedCount = Number(batch?.dropped_count) || 0;
    if (droppedCount > 0 && !warnedAboutDrops) {
      warnedAboutDrops = true;
      log('WARN', 'logs.client_forwarding_dropped', {
        droppedCount,
        message: 'Renderer log forwarding buffer overflowed; oldest entries were dropped.',
      });
    }
    if (droppedCount > 0) {
      diagnosticLogService.recordDrop('renderer', droppedCount);
    }
    const redactionPrefixes = getRedactionPrefixes();
    let rejectedCount = Math.max(rawEntries.length - entries.length, 0);
    for (const entry of entries) {
      // Per-entry isolation: one malformed entry must not suppress the rest.
      try {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          rejectedCount += 1;
          continue;
        }
        const level = String(entry.level || '').toUpperCase();
        if (level === 'DEBUG' && !debugForwardingEnabled) {
          continue;
        }
        // The renderer payload is untrusted across the IPC seam: pin the
        // layer/source so a crafted entry cannot impersonate another layer.
        diagnosticLogService.append({ ...entry, layer: 'renderer', source: 'renderer' }, {
          broadcast: false,
          defaults: { layer: 'renderer', redaction_prefixes: redactionPrefixes },
        });
      } catch (_error) {
        // Best-effort: the log path never throws back across the seam.
        rejectedCount += 1;
      }
    }
    if (rejectedCount > 0) {
      diagnosticLogService.recordDrop('renderer', rejectedCount);
    }
  };
}

function registerClientLogIpcHandler(ipcMainLike, { authorize = null, ...options } = {}) {
  if (!ipcMainLike || typeof ipcMainLike.on !== 'function') {
    return;
  }
  const handler = createClientLogBatchHandler(options);
  for (const methodPath of ['diagnostics.logs.appendRendererBatch', 'logs.clientAppend']) {
    const channel = getBridgeChannel(methodPath, 'send');
    const registeredHandler = typeof authorize === 'function' ? (event, batch) => {
      try {
        if (authorize(event, { methodPath, channel }) !== true) return;
      } catch (_error) {
        return;
      }
      handler(event, batch);
    } : handler;
    ipcMainLike.on(channel, registeredHandler);
  }
}

module.exports = {
  createClientLogBatchHandler,
  createLogRedactionPrefixesProvider,
  registerClientLogIpcHandler,
};
