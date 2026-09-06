const { buildFeatureFlags } = require('../feature-flags');
const { getBridgeChannel } = require('../ipc-contract');
const { normalizeLogEntry } = require('../log-entry-normalizer');

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
  getProcessLogWriter = () => null,
  getRedactionPrefixes = () => [],
  env = process.env,
  log = () => {},
} = {}) {
  const debugForwardingEnabled = buildFeatureFlags(env).agent_test_hooks === true;
  let warnedAboutDrops = false;

  return function handleClientLogBatch(_event, batch) {
    const diagnosticLogService = getDiagnosticLogService();
    const writer = getProcessLogWriter();
    const hasCanonicalService = diagnosticLogService
      && typeof diagnosticLogService.append === 'function';
    if (!hasCanonicalService
      && (!writer || (typeof writer.writeBatch !== 'function' && typeof writer.write !== 'function'))) {
      return;
    }
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
    if (droppedCount > 0 && hasCanonicalService
      && typeof diagnosticLogService.recordDrop === 'function') {
      diagnosticLogService.recordDrop('renderer', droppedCount);
    }
    const redactionPrefixes = getRedactionPrefixes();
    const normalizedEntries = [];
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
        const normalized = normalizeLogEntry(entry, {
          layer: 'renderer',
          redaction_prefixes: redactionPrefixes,
        });
        // The renderer payload is untrusted across the IPC seam: pin the
        // layer/source so a crafted entry cannot impersonate another layer.
        normalized.layer = 'renderer';
        normalized.source = 'renderer';
        normalizedEntries.push(normalized);
      } catch (_error) {
        // Best-effort: the log path never throws back across the seam.
        rejectedCount += 1;
      }
    }
    if (rejectedCount > 0 && hasCanonicalService
      && typeof diagnosticLogService.recordDrop === 'function') {
      diagnosticLogService.recordDrop('renderer', rejectedCount);
    }
    try {
      if (normalizedEntries.length === 0) return;
      if (hasCanonicalService) {
        normalizedEntries.forEach((entry) => diagnosticLogService.append(entry, {
          broadcast: false,
          persist: true,
        }));
      } else if (typeof writer.writeBatch === 'function') writer.writeBatch(normalizedEntries);
      else normalizedEntries.forEach((entry) => writer.write(entry));
    } catch (_error) {
      // Best-effort: sink failures never escape the renderer IPC seam.
    }
  };
}

function registerClientLogIpcHandler(ipcMainLike, options = {}) {
  if (!ipcMainLike || typeof ipcMainLike.on !== 'function') {
    return;
  }
  const handler = createClientLogBatchHandler(options);
  ipcMainLike.on(getBridgeChannel('diagnostics.logs.appendRendererBatch', 'send'), handler);
  ipcMainLike.on(getBridgeChannel('logs.clientAppend', 'send'), handler);
}

module.exports = {
  createClientLogBatchHandler,
  createLogRedactionPrefixesProvider,
  registerClientLogIpcHandler,
};
