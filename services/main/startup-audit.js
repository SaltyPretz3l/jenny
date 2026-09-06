// Reads cold-start audit environment settings once and emits structured marks
// through the injected logger with no Electron dependency.

function createStartupAudit({
  env = process.env,
  log = () => {},
  canLog = () => true,
  getStartupElapsedMs = () => 0,
} = {}) {
  const STARTUP_AUDIT_ENABLED = /^(1|true|yes|on)$/i.test(String(env.JENNY_COLD_START_AUDIT || '').trim());
  const STARTUP_AUDIT_RUN_ID = String(env.JENNY_COLD_START_AUDIT_RUN_ID || '').trim();
  const STARTUP_AUDIT_PROMPT = String(env.JENNY_COLD_START_AUDIT_PROMPT || '').trim();
  const STARTUP_AUDIT_MODEL = String(env.JENNY_COLD_START_AUDIT_MODEL || '').trim();
  const STARTUP_AUDIT_REASONING_EFFORT = String(env.JENNY_COLD_START_AUDIT_REASONING_EFFORT || 'high').trim() || 'high';
  // Marks emitted before the log store exists are buffered here and flushed
  // once logging is ready. Capped so a pathological caller (or a startup that
  // never reaches readiness) cannot grow this queue unbounded in a long-lived
  // process. New marks are dropped once the cap is hit (not the oldest ones
  // evicted) because the value of this buffer is capturing the *earliest*
  // marks of a cold start; drops are counted, not silently discarded.
  const PENDING_MARKS_CAP = 32;
  const pendingMarks = [];
  let droppedPendingMarksCount = 0;

  // Startup marks are pure observability. A logger failure must never break the
  // lifecycle handler that emitted the mark -- and there is nowhere to report a
  // logging failure to, so it is swallowed rather than surfaced.
  function safeLog(level, event, payload) {
    try {
      log(level, event, payload);
    } catch (_e) {
      // Intentionally ignored -- see above.
    }
  }

  // Flushes in ts_ms order, not push order: marks can be buffered out of
  // chronological order (e.g. a mark carrying an earlier captured timestamp
  // pushed after one carrying a later one), and a consumer reading the mark
  // stream depends on it being time-ordered.
  function flushPendingMarks() {
    if (droppedPendingMarksCount > 0) {
      safeLog('WARN', 'startup.audit.marks_dropped', { count: droppedPendingMarksCount, cap: PENDING_MARKS_CAP });
      droppedPendingMarksCount = 0;
    }
    if (!pendingMarks.length) {
      return;
    }
    const marks = pendingMarks.splice(0).sort((a, b) => a.ts_ms - b.ts_ms);
    for (const pendingMark of marks) {
      safeLog('INFO', 'startup.audit.mark', pendingMark);
    }
  }

  // Exported so callers can force an early flush once logging becomes ready,
  // rather than waiting on the next mark (which may never come if startup
  // fails right after the log store is created).
  function flushStartupAuditMarks() {
    if (!canLog()) {
      return;
    }
    flushPendingMarks();
  }

  function emitStartupAuditMark(mark, details = {}) {
    if (!STARTUP_AUDIT_ENABLED) {
      return;
    }
    const normalizedMark = String(mark || '').trim();
    if (!normalizedMark) {
      return;
    }
    const sourceDetails = details && typeof details === 'object' && !Array.isArray(details) ? details : {};
    const payload = {
      ...sourceDetails,
      audit_run_id: STARTUP_AUDIT_RUN_ID,
      mark: normalizedMark,
      startupMs: Number.isFinite(Number(sourceDetails.startupMs)) ? Number(sourceDetails.startupMs) : getStartupElapsedMs(),
      ts_ms: Number.isFinite(Number(sourceDetails.ts_ms)) ? Number(sourceDetails.ts_ms) : Date.now(),
    };
    if (!canLog()) {
      if (pendingMarks.length >= PENDING_MARKS_CAP) {
        droppedPendingMarksCount += 1;
        return;
      }
      pendingMarks.push(payload);
      return;
    }
    flushPendingMarks();
    safeLog('INFO', 'startup.audit.mark', payload);
  }

  // The 'main-entry' mark: module-entry timestamp, require-graph cost, and the
  // launcher-to-main attribution the launchers export (JENNY_LAUNCHER_STARTED_AT_MS
  // is the launcher's own start time; JENNY_LAUNCH_PATH labels dev vs the two
  // public wrappers). Lives here, not main.js, so main.js stays under its cap
  // and the fields are unit-testable; audit-gated like every other mark.
  function emitMainEntryMark({ mainModuleEntryAt, appStartupStartedAt } = {}) {
    const launcherStartedAtMs = Number(env.JENNY_LAUNCHER_STARTED_AT_MS) || 0;
    const launchPath = String(env.JENNY_LAUNCH_PATH || '').trim();
    emitStartupAuditMark('main-entry', {
      source: 'main',
      ts_ms: mainModuleEntryAt,
      module_load_ms: Math.max(appStartupStartedAt - mainModuleEntryAt, 0),
      ...(launcherStartedAtMs
        ? { launcher_to_main_ms: Math.max(mainModuleEntryAt - launcherStartedAtMs, 0) }
        : {}),
      ...(launchPath ? { launch_path: launchPath } : {}),
    });
  }

  function getStartupAuditConfig() {
    if (!STARTUP_AUDIT_ENABLED) {
      return { enabled: false };
    }
    return {
      enabled: true,
      runId: STARTUP_AUDIT_RUN_ID,
      prompt: STARTUP_AUDIT_PROMPT,
      model: STARTUP_AUDIT_MODEL,
      reasoningEffort: STARTUP_AUDIT_REASONING_EFFORT,
    };
  }

  function handleStartupAuditMarkPayload(payload = {}) {
    if (!STARTUP_AUDIT_ENABLED) {
      return { ok: false, ignored: true };
    }
    const mark = String(payload?.mark || payload?.name || '').trim();
    if (!mark) {
      return { ok: false, ignored: true };
    }
    const details = payload && typeof payload === 'object' && !Array.isArray(payload) ? { ...payload } : {};
    delete details.mark;
    delete details.name;
    emitStartupAuditMark(mark, {
      ...details,
      source: String(details.source || 'renderer'),
    });
    return { ok: true };
  }

  function createStartupAuditMarkHandler() {
    return (_event, payload = {}) => handleStartupAuditMarkPayload(payload);
  }

  function createStartupAuditMarksBatchHandler() {
    return (_event, payload = {}) => {
      if (!STARTUP_AUDIT_ENABLED) {
        return { ok: false, ignored: true, count: 0 };
      }
      const marks = Array.isArray(payload?.marks) ? payload.marks : [];
      const cappedMarks = marks.slice(0, 200);
      let count = 0;
      let ignoredCount = Math.max(0, marks.length - cappedMarks.length);
      for (const entry of cappedMarks) {
        const result = handleStartupAuditMarkPayload(entry);
        if (result.ok === true) {
          count += 1;
        } else {
          ignoredCount += 1;
        }
      }
      return {
        ok: count > 0,
        ignored: count === 0,
        count,
        ignored_count: ignoredCount,
      };
    };
  }

  return {
    enabled: STARTUP_AUDIT_ENABLED,
    emitMainEntryMark,
    emitStartupAuditMark,
    flushStartupAuditMarks,
    getStartupAuditConfig,
    handleStartupAuditMarkPayload,
    createStartupAuditMarkHandler,
    createStartupAuditMarksBatchHandler,
  };
}

module.exports = { createStartupAudit };
