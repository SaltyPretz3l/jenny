const { registerIpcInvokeHandlers } = require('../../ipc-contract');
const { t } = require('../../i18n-main');

// System domain IPC: the status snapshot, system stats and their watch cadence,
// diagnostics (logs, renderer errors, stream metrics, startup audit, harness and
// Jenny status, phase percentiles, Codex CLI state), app updates, and the usage
// history reads.

const MAX_INTERACTIVE_USAGE_ROWS = 200;
const MAX_EXPORT_USAGE_ROWS = 500;
const USAGE_EXPORT_SCOPES = new Set(['session', 'today', 'all']);

function registerSystemIpcHandlers(ipcMain, {
  backendService,
  logStore,
  updateService,
  log,
  refreshGpuMemorySample,
  getCurrentSystemStatsPayload,
  getSystemStats,
  getStartupAuditConfig,
  createStartupAuditMarkHandler,
  createStartupAuditMarksBatchHandler,
  workspaceAuthorization,
}) {
  registerIpcInvokeHandlers(ipcMain, {
    'status.get': () => backendService.refreshStatusSnapshot(),
    'system.getStats': () => {
      // The renderer invokes this exactly once at boot; the 2s system:stats push
      // feeds it thereafter. Keep this unforced so cold boot never spawns a GPU probe.
      void refreshGpuMemorySample().catch(() => null);
      return getCurrentSystemStatsPayload();
    },
    'system.refreshStats': async () => {
      await refreshGpuMemorySample({ force: true, manual: true }).catch(() => null);
      return getCurrentSystemStatsPayload(null, { fresh: true });
    },
    'system.setStatsWatch': (_event, payload) => {
      const cadence = getSystemStats()?.watchCadence;
      if (!cadence) return { watched: false };
      const source = String(payload?.source || '').trim().slice(0, 32);
      return { watched: cadence.setWatched(source, payload?.watched === true) };
    },
    'diagnostics.logs.getSnapshot': () => logStore.getSnapshot(),
    'diagnostics.reportRendererError': require('../../main-error-hardening').createRendererDiagnosticsHandler(log),
    'diagnostics.reportClientStreamMetrics': (_, payload) => {
      const { mergeClientTimingIntoTurnDiagnostic } = require('../../backend/turn-diagnostic-dump');
      return mergeClientTimingIntoTurnDiagnostic({
        service: backendService,
        streamId: payload?.stream_id || payload?.streamId,
        clientTiming: payload?.client_timing || payload?.clientTiming,
      });
    },
    'diagnostics.getStartupAuditConfig': () => getStartupAuditConfig(),
    'diagnostics.reportStartupMark': createStartupAuditMarkHandler(),
    'diagnostics.reportStartupMarksBatch': createStartupAuditMarksBatchHandler(),
    'updates.getState': () => updateService.getState(),
    'updates.check': () => updateService.check(),
    'updates.download': () => updateService.download(),
    'updates.install': () => updateService.install(),
    'updates.skip': (_, version) => updateService.skip(version),
  }, workspaceAuthorization);
}

function codexCliUnavailable() {
  return {
    ok: false,
    status: 'unavailable',
    code: 'codex_cli_unavailable',
      message: t('main.codexCli.runtimeUnavailable', 'Codex CLI runtime service is unavailable.'),
  };
}

function registerRuntimeDiagnosticsIpcHandlers(ipcMainLike, { backendService, ipcAuthorization }) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'harness.inspect': (_, options) => backendService.inspectHarness(options),
    'diagnostics.getJennyStatus': (_, options) => backendService.getJennyStatus(options),
    'diagnostics.phasePercentiles.get': () => backendService.getPhasePercentilesSnapshot(),
    'diagnostics.phasePercentiles.reset': () => backendService.resetPhasePercentiles(),
    'codexCli.getState': () =>
      backendService?.getCodexCliState?.() || codexCliUnavailable(),
    'codexCli.refresh': () =>
      backendService?.refreshCodexCliState?.() || codexCliUnavailable(),
  }, ipcAuthorization);
}

function cloneJsonSafe(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_error) {
    return fallback;
  }
}

function boundedUsageLimit(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function unavailableUsageExport(scope = '') {
  return {
    ok: false,
    scope,
    rows: [],
    persistence: { available: false, durable: false, read_only_reason: 'unavailable' },
    retention: { max_age_days: 30, max_turns: 500, retained_turns: 0, oldest_at: '' },
    error: 'Usage history is unavailable.',
  };
}

function unavailableUsageSnapshot() {
  return {
    available: false,
    persistence: { available: false, durable: false, read_only_reason: 'unavailable' },
    retention: { max_age_days: 30, max_turns: 500, retained_turns: 0, oldest_at: '' },
    session_id: '',
    today: {},
    session: {},
    cumulative: {},
    recent_turns: [],
    last_record_error: null,
  };
}

function registerUsageIpcHandlers(ipcMainLike, { usageHistory, ipcAuthorization }) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'usage.getSnapshot': (_, payload = {}) => {
      const request = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload
        : {};
      const mode = String(request.mode || 'interactive').trim().toLowerCase();
      const sessionId = String(request.sessionId || '').trim();
      if (mode === 'export') {
        const scope = String(request.scope || '').trim().toLowerCase();
        if (!USAGE_EXPORT_SCOPES.has(scope)) {
          return unavailableUsageExport(scope || 'invalid');
        }
        const result = usageHistory?.getExportRows?.({
          sessionId,
          scope,
          limit: MAX_EXPORT_USAGE_ROWS,
        }) || unavailableUsageExport(scope);
        return cloneJsonSafe(result, unavailableUsageExport(scope));
      }
      if (mode !== 'interactive') {
        return cloneJsonSafe(unavailableUsageExport('invalid'), unavailableUsageExport('invalid'));
      }
      const result = usageHistory?.getSnapshot?.({
        sessionId,
        limit: boundedUsageLimit(request.limit, MAX_INTERACTIVE_USAGE_ROWS, MAX_INTERACTIVE_USAGE_ROWS),
      }) || unavailableUsageSnapshot();
      return cloneJsonSafe(result, unavailableUsageSnapshot());
    },
    'usage.clearHistory': () => usageHistory?.clearHistory?.() || ({
      ok: false,
      cleared_turn_count: 0,
      durable: false,
      error: 'Usage history is unavailable.',
    }),
  }, ipcAuthorization);
}

module.exports = {
  registerRuntimeDiagnosticsIpcHandlers,
  registerSystemIpcHandlers,
  registerUsageIpcHandlers,
};
