'use strict';

const MAX_FAILURE_MESSAGES = 32;

function createUnattendedGuard({
  powerMonitor,
  getBackendService,
  getThresholdMinutes,
  isEnabled,
  sendBridgeEvent,
  log,
  intervalMs = 30000,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const pausedStreamIds = new Set();
  const loggedFailureMessages = new Set();
  let timer = null;
  let unavailable = false;
  let unavailableLogged = false;

  function tick() {
    try {
      if (isEnabled() !== true) return;
      const thresholdMinutes = getThresholdMinutes();
      if (!Number.isFinite(thresholdMinutes) || thresholdMinutes < 1) return;

      const backend = getBackendService();
      const activeStreams = backend?.activeStreams;
      if (!activeStreams || typeof activeStreams.has !== 'function') return;
      for (const streamId of pausedStreamIds) {
        if (!activeStreams.has(streamId)) pausedStreamIds.delete(streamId);
      }
      if (activeStreams.size === 0) return;

      const idleSeconds = powerMonitor.getSystemIdleTime();
      if (!Number.isFinite(idleSeconds) || idleSeconds < thresholdMinutes * 60) return;

      const store = backend.sessionStore;
      const records = typeof store?.listSessionRecords === 'function'
        ? store.listSessionRecords()
        : (store?.listSessions?.() || []);
      for (const streamId of activeStreams.keys()) {
        if (pausedStreamIds.has(streamId)) continue;
        const record = records.find((candidate) => {
          const activeTurn = candidate?.active_turn || store?.getActiveTurn?.(candidate?.id);
          return String(activeTurn?.stream_id || activeTurn?.request_id || '').trim() === streamId;
        });
        if (!record) continue;
        const sessionId = String(record.id || '').trim();
        const session = store?.getSession?.(sessionId) || record;
        if (session?.run_mode !== 'auto') continue;

        const result = backend.pauseSessionAutoRun(sessionId, {
          streamId,
          reason: 'unattended_idle',
          idleSeconds,
        });
        const details = {
          sessionId,
          streamId,
          idleSeconds,
          thresholdMinutes,
          checkedAtMs: now(),
        };
        if (result?.requested === true) {
          pausedStreamIds.add(streamId);
          sendBridgeEvent('safety.onUnattendedPause', {
            session_id: sessionId,
            stream_id: streamId,
            idle_seconds: idleSeconds,
            threshold_minutes: thresholdMinutes,
            state: 'requested',
          });
          log('INFO', 'unattended_guard.pause_requested', details);
        } else {
          log('INFO', 'unattended_guard.pause_skipped', {
            ...details,
            reason: result?.reason,
          });
        }
      }
    } catch (error) {
      const message = String(error?.message || error).slice(0, 240);
      if (loggedFailureMessages.has(message)) return;
      if (loggedFailureMessages.size >= MAX_FAILURE_MESSAGES) {
        loggedFailureMessages.delete(loggedFailureMessages.values().next().value);
      }
      loggedFailureMessages.add(message);
      try {
        log('WARN', 'unattended_guard.tick_failed', { message });
      } catch (_logError) {
        // A diagnostic sink failure must not escape the synchronous poller.
      }
    }
  }

  function start() {
    if (timer || unavailable) return;
    if (typeof powerMonitor?.getSystemIdleTime !== 'function') {
      unavailable = true;
      if (!unavailableLogged) {
        unavailableLogged = true;
        log('WARN', 'unattended_guard.unavailable', { reason: 'no_idle_api' });
      }
      return;
    }
    tick();
    timer = setIntervalFn(tick, intervalMs);
    timer?.unref?.();
  }

  function stop() {
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
    pausedStreamIds.clear();
  }

  function snapshot() {
    return {
      running: timer !== null,
      pausedStreamIds: [...pausedStreamIds],
      unavailable,
    };
  }

  return { start, stop, tick, snapshot };
}

module.exports = {
  createUnattendedGuard,
};
