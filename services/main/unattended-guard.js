'use strict';

const MAX_FAILURE_MESSAGES = 32;

function createUnattendedGuard({
  powerMonitor,
  getBackendService,
  getThresholdMinutes,
  isEnabled,
  sendBridgeEvent,
  log,
  // Row 196: how long ago the owner last really used the keyboard or mouse (ms), or null. Windows' idle
  // time counts the input a computer turn injects, so while one runs this is the owner's real idle time.
  getRealInputAgeMs = null,
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
  let realInput = null; // { ageMs, at }: read on the last tick (the read is asynchronous)

  function refreshRealInput() {
    if (typeof getRealInputAgeMs !== 'function') return;
    let pending;
    try { pending = getRealInputAgeMs(); } catch (_error) { realInput = null; return; }
    Promise.resolve(pending).then((ageMs) => {
      realInput = Number.isFinite(ageMs) && ageMs >= 0 ? { ageMs, at: now() } : null;
    }, () => { realInput = null; });
  }

  /** The idle seconds to judge by: the owner's real idle time while a computer turn's watch answers. */
  function idleSecondsNow() {
    const system = powerMonitor.getSystemIdleTime();
    const fresh = realInput && now() - realInput.at <= intervalMs * 2 ? realInput.ageMs / 1000 : null;
    refreshRealInput();
    return Number.isFinite(fresh) && Number.isFinite(system) ? Math.max(system, fresh) : system;
  }

  // A throw counts as not armed: an unreadable Full auto state keeps the pause.
  function isArmed(sessionId) {
    try {
      return getBackendService()?.primaryFullAuto?.isArmed?.(sessionId) === true;
    } catch (_error) {
      return false;
    }
  }

  function tick() {
    try {
      if (isEnabled() !== true) return;
      const thresholdMinutes = getThresholdMinutes();
      if (!Number.isFinite(thresholdMinutes) || thresholdMinutes < 1) return;

      const backend = getBackendService();
      const idleSeconds = idleSecondsNow();
      if (!Number.isFinite(idleSeconds) || idleSeconds < thresholdMinutes * 60) return;

      const store = backend?.sessionStore;
      const records = typeof store?.listSessionRecords === 'function'
        ? store.listSessionRecords()
        : (store?.listSessions?.() || []);
      const autoSessionIds = new Set(records.filter(record => record?.run_mode === 'auto')
        .map(record => String(record?.id || '').trim()).filter(id => id && !isArmed(id)));
      for (const sessionId of autoSessionIds) {
        try {
          const result = backend.sessionRuntime?.pausePending?.({
            sessionId,
            reason: 'unattended_idle',
          });
          if (Number(result?.paused || 0) > 0) {
            log('INFO', 'unattended_guard.pending_paused', {
              sessionId,
              paused: result.paused,
              idleSeconds,
              thresholdMinutes,
              checkedAtMs: now(),
            });
          }
        } catch (error) {
          log('WARN', 'unattended_guard.pending_pause_failed', {
            sessionId,
            message: String(error?.message || error).slice(0, 240),
          });
        }
      }

      const activeStreams = backend?.activeStreams;
      if (!activeStreams || typeof activeStreams.has !== 'function') return;
      for (const streamId of pausedStreamIds) {
        if (!activeStreams.has(streamId)) pausedStreamIds.delete(streamId);
      }
      if (activeStreams.size === 0) return;
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
        if (isArmed(sessionId)) continue;

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
