'use strict';

const { t } = require('../i18n-main');
const {
  isReminderDue,
  reminderDueAt,
} = require('../shell-config-followups-schema');

const MAX_FAILURE_MESSAGES = 32;

function createReminderNotifier({
  getShellConfigService,
  getMainWindow,
  notificationFactory,
  isSupported,
  sendBridgeEvent,
  log,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  intervalMs = 30000,
} = {}) {
  const snoozedUntilById = new Map();
  const loggedFailureMessages = new Set();
  let timer = null;
  let firstTickAfterStart = false;
  let observedConfigService = null;
  let observedMainWindow = null;
  let observedWebContents = null;
  let loadFinishedListener = null;
  let rendererReadyAfterMs = null;
  let unsupportedLogged = false;

  function logFailure(event, error) {
    const message = String(error?.message || error).slice(0, 240);
    const key = `${event}:${message}`;
    if (loggedFailureMessages.has(key)) return;
    if (loggedFailureMessages.size >= MAX_FAILURE_MESSAGES) {
      loggedFailureMessages.delete(loggedFailureMessages.values().next().value);
    }
    loggedFailureMessages.add(key);
    try {
      log('WARN', event, { message });
    } catch (_logError) {
      // A diagnostic sink failure must not escape the synchronous poller.
    }
  }

  function openReminder(reminderId) {
    const mainWindow = getMainWindow?.();
    if (!mainWindow || mainWindow.isDestroyed?.()) return;
    if (mainWindow.isMinimized?.()) mainWindow.restore?.();
    mainWindow.focus?.();
    sendBridgeEvent('reminders.onOpen', { id: reminderId });
  }

  function showNotification(title, body, reminderId) {
    try {
      if (isSupported() !== true) {
        if (!unsupportedLogged) {
          unsupportedLogged = true;
          try {
            log('WARN', 'reminder_notifier.unsupported', {});
          } catch (_logError) {
            // A diagnostic sink failure must not escape the synchronous poller.
          }
        }
        return;
      }
    } catch (error) {
      logFailure('reminder_notifier.notification_failed', error);
      return;
    }
    try {
      const notification = notificationFactory({ title, body, silent: false });
      notification?.on?.('click', () => openReminder(reminderId));
      notification?.show?.();
    } catch (error) {
      logFailure('reminder_notifier.notification_failed', error);
    }
  }

  function fireReminder(service, reminder, firedAt, extra = {}, persist = true) {
    if (persist) service.upsertReminder({ ...reminder, lastFiredAt: firedAt });
    snoozedUntilById.delete(String(reminder.id || ''));
    sendBridgeEvent('reminders.onFired', {
      id: String(reminder.id || ''),
      label: String(reminder.label || ''),
      prompt: String(reminder.prompt || ''),
      firedAt,
      ...extra,
    });
  }

  function clearRendererReadinessObservation() {
    if (loadFinishedListener) {
      observedWebContents?.removeListener?.('did-finish-load', loadFinishedListener);
    }
    observedMainWindow = null;
    observedWebContents = null;
    loadFinishedListener = null;
    rendererReadyAfterMs = null;
  }

  function isRendererReady(mainWindow, nowMs) {
    const webContents = mainWindow.webContents;
    if (!webContents || typeof webContents.isLoading !== 'function') return true;
    if (observedMainWindow !== mainWindow) {
      clearRendererReadinessObservation();
      observedMainWindow = mainWindow;
      observedWebContents = webContents;
      if (typeof webContents.once === 'function') {
        loadFinishedListener = () => {
          loadFinishedListener = null;
          rendererReadyAfterMs = now() + intervalMs;
        };
        webContents.once('did-finish-load', loadFinishedListener);
      }
    }
    if (webContents.isLoading()) return false;
    if (rendererReadyAfterMs == null) rendererReadyAfterMs = nowMs + intervalMs;
    return nowMs >= rendererReadyAfterMs;
  }

  function tick() {
    try {
      const mainWindow = getMainWindow?.();
      if (!mainWindow || mainWindow.isDestroyed?.()) return;
      const nowMs = now();
      if (!Number.isFinite(nowMs)) return;
      if (!isRendererReady(mainWindow, nowMs)) return;
      const isFirstTick = firstTickAfterStart;
      firstTickAfterStart = false;
      const service = getShellConfigService?.();
      const reminders = service?.getState?.()?.proactive?.reminders;
      if (!Array.isArray(reminders)) return;

      const liveIds = new Set(reminders.map((reminder) => String(reminder?.id || '')));
      for (const reminderId of snoozedUntilById.keys()) {
        if (!liveIds.has(reminderId)) snoozedUntilById.delete(reminderId);
      }
      const remindersById = new Map(reminders.map((reminder) => [
        String(reminder?.id || ''), reminder,
      ]));
      const expiredSnoozes = [];
      for (const [reminderId, untilMs] of snoozedUntilById) {
        const reminder = remindersById.get(reminderId);
        if (untilMs <= nowMs && reminder?.enabled !== false) expiredSnoozes.push(reminder);
      }
      const due = reminders.filter((reminder) => {
        const reminderId = String(reminder?.id || '');
        return !snoozedUntilById.has(reminderId) && isReminderDue(reminder, nowMs);
      });
      if (!expiredSnoozes.length && !due.length) return;

      const firedAt = new Date(nowMs).toISOString();
      for (const reminder of expiredSnoozes) {
        showNotification(
          String(reminder.label || ''),
          String(reminder.prompt || ''),
          String(reminder.id || '')
        );
        fireReminder(
          service,
          reminder,
          firedAt,
          {},
          reminder.scheduleType === 'interval_minutes'
        );
      }
      const missed = isFirstTick
        ? due.filter((reminder) => reminder.scheduleType === 'once_at'
          && reminderDueAt(reminder, nowMs) < nowMs)
        : [];
      const missedIds = new Set(missed.map((reminder) => reminder.id));
      if (missed.length) {
        const count = missed.length;
        const title = count === 1
          ? t('main.reminders.missedOne', '1 reminder was due while Jenny was closed')
          : t(
              'main.reminders.missedMany',
              '{count} reminders were due while Jenny was closed',
              { count }
            );
        showNotification(
          title,
          missed.slice(0, 5).map((reminder) => String(reminder.label || '')).join('\n'),
          String(missed[0].id || '')
        );
        for (const reminder of missed) {
          fireReminder(service, reminder, firedAt, { missed: true });
        }
      }
      for (const reminder of due) {
        if (missedIds.has(reminder.id)) continue;
        showNotification(
          String(reminder.label || ''),
          String(reminder.prompt || ''),
          String(reminder.id || '')
        );
        fireReminder(service, reminder, firedAt);
      }
    } catch (error) {
      logFailure('reminder_notifier.tick_failed', error);
    }
  }

  function onConfigChanged(_state, meta) {
    if (meta?.reason === 'proactive_reminder_deleted') {
      snoozedUntilById.delete(String(meta.reminderId || ''));
    }
  }

  function start() {
    if (timer) return;
    observedConfigService = getShellConfigService?.() || null;
    observedConfigService?.on?.('changed', onConfigChanged);
    firstTickAfterStart = true;
    tick();
    timer = setIntervalFn(tick, intervalMs);
    timer?.unref?.();
  }

  function stop() {
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
    observedConfigService?.removeListener?.('changed', onConfigChanged);
    observedConfigService = null;
    clearRendererReadinessObservation();
    snoozedUntilById.clear();
  }

  function snooze(id, minutes = 10) {
    const reminderId = String(id || '').trim();
    const parsedMinutes = Number(minutes);
    const snoozeMinutes = Number.isFinite(parsedMinutes) && parsedMinutes > 0
      ? Math.floor(parsedMinutes)
      : 10;
    const untilMs = now() + snoozeMinutes * 60000;
    if (reminderId) snoozedUntilById.set(reminderId, untilMs);
    return { id: reminderId, minutes: snoozeMinutes, untilMs };
  }

  return { start, stop, tick, snooze };
}

module.exports = {
  createReminderNotifier,
};
