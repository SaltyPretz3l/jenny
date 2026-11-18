'use strict';

// Desktop (OS toast) notifications for renderer-detected events: finished
// replies, failed runs, permission requests, questions and the turns Jenny
// starts herself (row 89: checks, wake updates, digests). The renderer sends
// fire-and-forget candidates over `notifications.notify`; this module gates
// them on the feature flag, the windowUi.notifications preferences and window
// focus, then shows a default toast. It never focuses, shows or raises the
// window on emit; only a click restores + focuses it (reminder-notifier path).
// Row 89: wake updates share one counting toast per chat until the user looks,
// and the Jenny chat stays silent inside its quiet hours (Settings > Jenny chat).
// Slice 2a-6c: team messages (`team`) count the same way per team and channel,
// and a click hands the message's routing ids back to the renderer.
// Row 175: `teamProject` toasts (a member's own project turn, an approval nobody who can answer is viewing) name the
// team and the host conversation (`sessionId`, a host id: never a local chat's) and open that conversation on a click.
// They pass the same gates and also need the Team category on; the local-chat gates (child session, the Jenny chat's
// quiet hours) read only local sessions, so they do not apply.

const { getBridgeChannel } = require('../ipc-contract');
const { t } = require('../i18n-main');
const { quietRemainingMs } = require('../primary-digest');
const { normalizeNotificationSettings } = require('../shell-config-notifications-schema');
const { createTrustedSenderAuthorizer } = require('./ipc-sender-authorization');

const EMITTED_CATEGORIES = Object.freeze(['replies', 'failures', 'permissions', 'questions', 'jenny', 'team', 'teamProject']);
const FIELD_LIMITS = Object.freeze({ key: 120, sessionId: 80, title: 120, body: 240, preview: 240, conversation: 120, sender: 80 });
// A team toast's way back to its message (slice 2a-6c): ids the host made, never a key or a token.
const ROUTE_ID = /^[A-Za-z0-9_-]{1,160}$/;
const ROUTE_FIELDS = Object.freeze(['teamId', 'channelId', 'messageId', 'threadRootId']);
// A project toast's way back (row 175): the team, the host conversation and its project.
const PROJECT_ROUTE_FIELDS = Object.freeze(['teamId', 'projectId', 'sessionId']);
const HOST_SESSION_ID = /^sess_[A-Za-z0-9_-]{1,123}$/;
const MAX_GROUP_SENDERS = 8;
const MAX_LIVE_NOTIFICATIONS = 5;
const MAX_FAILURE_MESSAGES = 32;
const MAX_SUPPRESSION_LOG_KEYS = 64;
// Control characters, and the bidi embeddings, overrides and isolates (U+202A-U+202E, U+2066-U+2069) that would
// let a name reorder the rest of a toast's line.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clipField(value, limit) {
  if (typeof value !== 'string') return null;
  return value.replace(CONTROL_CHARS, '').trim().slice(0, limit);
}

// Renderer payloads are untrusted: rebuild the candidate from known fields
// only. Returns null when a required field is missing or mistyped.
function normalizeNotificationCandidate(raw) {
  if (!isPlainObject(raw)) return null;
  const category = typeof raw.category === 'string' ? raw.category : '';
  if (!EMITTED_CATEGORIES.includes(category)) return null;
  const key = clipField(raw.key, FIELD_LIMITS.key);
  const title = clipField(raw.title, FIELD_LIMITS.title);
  if (!key || !title) return null;
  if (category === 'teamProject') return projectCandidate(raw, category);
  const sessionId = raw.sessionId == null ? '' : clipField(raw.sessionId, FIELD_LIMITS.sessionId);
  const body = raw.body == null ? '' : clipField(raw.body, FIELD_LIMITS.body);
  if (sessionId == null || body == null) return null;
  const candidate = { category, key, sessionId, title, body };
  if (category === 'replies' || category === 'jenny' || category === 'team') {
    const preview = clipField(raw.preview, FIELD_LIMITS.preview);
    if (preview) candidate.preview = preview;
  }
  // A wake update groups with the chat's other updates; nothing else groups.
  if (category === 'jenny' && raw.group === 'updates' && sessionId) candidate.group = 'updates';
  if (category === 'team') return teamCandidate(raw, candidate);
  return candidate;
}

// A team toast names its team and channel (both required), may name its message, its thread's root and the
// message's seq, and groups with the conversation's other messages until the user looks. Each field is rebuilt
// on its own; a malformed one is dropped, and without team and channel the candidate is refused.
function teamCandidate(raw, candidate) {
  for (const field of ROUTE_FIELDS) {
    if (typeof raw[field] === 'string' && ROUTE_ID.test(raw[field])) candidate[field] = raw[field];
  }
  if (!candidate.teamId || !candidate.channelId || candidate.sessionId) return null;
  if (Number.isSafeInteger(raw.seq) && raw.seq > 0) candidate.seq = raw.seq;
  candidate.conversation = clipField(raw.conversation, FIELD_LIMITS.conversation) || '';
  candidate.sender = clipField(raw.sender, FIELD_LIMITS.sender) || '';
  candidate.group = 'conversation';
  return candidate;
}

// A project toast (row 175): its team and host conversation are required, its project optional; each field is checked
// whole (a host id is never clipped into another one). It groups with nothing.
function projectCandidate(raw, category) {
  const key = clipField(raw.key, FIELD_LIMITS.key);
  const title = clipField(raw.title, FIELD_LIMITS.title);
  const body = raw.body == null ? '' : clipField(raw.body, FIELD_LIMITS.body);
  if (!key || !title || body == null) return null;
  if (typeof raw.teamId !== 'string' || !ROUTE_ID.test(raw.teamId) || typeof raw.sessionId !== 'string' || !HOST_SESSION_ID.test(raw.sessionId)) return null;
  const candidate = { category, key, sessionId: raw.sessionId, title, body, teamId: raw.teamId };
  if (typeof raw.projectId === 'string' && ROUTE_ID.test(raw.projectId)) candidate.projectId = raw.projectId;
  return candidate;
}

// The counted toast's second line: the senders in the order they wrote, three named, then how many more.
function sendersLine(senders) {
  if (senders.length <= 3) return senders.join(', ');
  return t('desktopNotifier.toast.teamSenders', '{names} and {count} others', { names: senders.slice(0, 3).join(', '), count: senders.length - 3 });
}

// A runtime child (a read-only task a parent turn spawned into its own
// session) is not the owner's turn: its reply, failure or wait belongs to the
// parent's progress, not to a toast. The child's stream carries no admission
// and its lineage never crosses the bridge, so main asks the runtime store.
// Any failure reads as "not a child" so a store hiccup never mutes toasts.
function isRuntimeChildSession(runtime, sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  const store = runtime?.store;
  if (!id || !store || typeof store.listSummaries !== 'function' || typeof store.get !== 'function') return false;
  try {
    let cursor = null;
    do {
      const page = store.listSummaries({ sessionId: id, limit: 100, cursor });
      if (page.items.some((item) => store.get(item.work_id)?.input?.kind === 'child_chat')) return true;
      cursor = page.next_cursor;
    } while (cursor);
  } catch (_error) {
    return false;
  }
  return false;
}

function isWindowFocused(mainWindow) {
  return mainWindow.isVisible?.() === true
    && mainWindow.isFocused?.() === true
    && mainWindow.isMinimized?.() !== true;
}

function createDesktopNotifier({
  isAppMuted = () => false,
  getShellConfigService,
  getMainWindow,
  notificationFactory,
  isSupported,
  sendBridgeEvent,
  log = () => {},
  isEnabled = () => false,
  ipcMainLike = null,
  authorizeSender = null,
  isChildSession = () => false,
  isPrimarySession = () => false,
  now = Date.now,
} = {}) {
  const liveNotifications = new Map();
  // Grouped live key -> { count, lastKey }: the count survives the toast's own
  // close (Windows closes it into the notification center after a few seconds)
  // and resets only when the user looks: a click, the window gaining focus, or
  // an update that arrives while the window is focused.
  const groupCounts = new Map();
  const loggedFailureMessages = new Set();
  const loggedSuppressions = new Set();
  const notifyChannel = getBridgeChannel('notifications.notify', 'send');
  const senderAuthorizer = typeof authorizeSender === 'function'
    ? authorizeSender
    : createTrustedSenderAuthorizer({ getMainWindow, log });
  let observedMainWindow = null;
  let unsupportedLogged = false;
  let registeredIpcMain = null;

  function safeLog(level, event, details) {
    try {
      log(level, event, details);
    } catch (_logError) {
      // A diagnostic sink failure must not escape the IPC seam.
    }
  }

  function logFailure(event, error) {
    const message = String(error?.message || error).slice(0, 240);
    const dedupeKey = `${event}:${message}`;
    if (loggedFailureMessages.has(dedupeKey)) return;
    if (loggedFailureMessages.size >= MAX_FAILURE_MESSAGES) {
      loggedFailureMessages.delete(loggedFailureMessages.values().next().value);
    }
    loggedFailureMessages.add(dedupeKey);
    safeLog('WARN', event, { message });
  }

  function suppress(reason, candidate) {
    const category = candidate?.category || '';
    const dedupeKey = `${reason}|${category}:${candidate?.key || ''}`;
    if (!loggedSuppressions.has(dedupeKey)) {
      if (loggedSuppressions.size >= MAX_SUPPRESSION_LOG_KEYS) {
        loggedSuppressions.delete(loggedSuppressions.values().next().value);
      }
      loggedSuppressions.add(dedupeKey);
      safeLog('INFO', 'desktop_notifier.suppressed', { reason, category });
    }
    return false;
  }

  function closeNotification(notification) {
    try {
      notification?.close?.();
    } catch (error) {
      logFailure('desktop_notifier.close_failed', error);
    }
  }

  function closeAll() {
    const notifications = [...liveNotifications.values()];
    liveNotifications.clear();
    groupCounts.clear();
    notifications.forEach(closeNotification);
  }

  function onWindowFocus() {
    closeAll();
  }

  function detachWindow() {
    try {
      observedMainWindow?.removeListener?.('focus', onWindowFocus);
    } catch (_error) {
      // A destroyed window may refuse listener removal; nothing to undo.
    }
    observedMainWindow = null;
  }

  function observeWindow(mainWindow) {
    if (observedMainWindow === mainWindow) return;
    detachWindow();
    try {
      mainWindow.on?.('focus', onWindowFocus);
      observedMainWindow = mainWindow;
    } catch (error) {
      logFailure('desktop_notifier.observe_failed', error);
    }
  }

  function openSession(candidate) {
    try {
      const mainWindow = getMainWindow?.();
      if (!mainWindow || mainWindow.isDestroyed?.()) return;
      if (mainWindow.isMinimized?.()) mainWindow.restore?.();
      mainWindow.focus?.();
      const payload = { sessionId: candidate.sessionId, category: candidate.category, key: candidate.key };
      // A team toast goes back to its message: the routing fields only, never its title or text.
      if (candidate.category === 'team') {
        for (const field of ROUTE_FIELDS) if (candidate[field]) payload[field] = candidate[field];
        if (candidate.seq) payload.seq = candidate.seq;
      }
      if (candidate.category === 'teamProject') for (const field of PROJECT_ROUTE_FIELDS) if (candidate[field]) payload[field] = candidate[field];
      sendBridgeEvent('notifications.onOpen', payload);
    } catch (error) {
      logFailure('desktop_notifier.open_failed', error);
    }
  }

  function readSettings() {
    try {
      return normalizeNotificationSettings(
        getShellConfigService?.()?.getWindowUiState?.()?.notifications
      );
    } catch (error) {
      logFailure('desktop_notifier.settings_failed', error);
      return normalizeNotificationSettings(null);
    }
  }

  // Q1: inside the Jenny chat's quiet hours nothing from that chat toasts;
  // what waits stays in Needs you. The window is plain arithmetic, so it goes
  // before the session lookup. Any read failure means "not quiet".
  function inPrimaryQuietHours(sessionId) {
    if (!sessionId) return false;
    try {
      const chatUi = getShellConfigService?.()?.getChatUiState?.() || {};
      if (quietRemainingMs(now(), chatUi.digestQuietStart, chatUi.digestQuietEnd) <= 0) return false;
      return isPrimarySession(sessionId) === true;
    } catch (error) {
      logFailure('desktop_notifier.quiet_hours_failed', error);
      return false;
    }
  }

  function supported() {
    try {
      if (isSupported() === true) return true;
    } catch (error) {
      logFailure('desktop_notifier.notification_failed', error);
      return false;
    }
    if (!unsupportedLogged) {
      unsupportedLogged = true;
      safeLog('WARN', 'desktop_notifier.unsupported', {});
    }
    return false;
  }

  function notify(rawCandidate) {
    const candidate = normalizeNotificationCandidate(rawCandidate);
    if (!candidate) return suppress('invalid', null);
    let flagOn = false;
    try {
      flagOn = isEnabled() === true;
    } catch (error) {
      logFailure('desktop_notifier.flag_failed', error);
    }
    if (!flagOn) return suppress('flag_off', candidate);
    const settings = readSettings();
    if (settings.enabled === false) return suppress('disabled', candidate);
    if (settings.categories[candidate.category] !== true) {
      return suppress('category_off', candidate);
    }
    const project = candidate.category === 'teamProject';
    if (project && settings.categories.team !== true) return suppress('category_off', candidate);
    // A project toast's session is a host conversation: the local-chat gates below read local sessions only.
    const localSession = project ? '' : candidate.sessionId;
    let childSession = false;
    try {
      childSession = localSession !== '' && isChildSession(localSession) === true;
    } catch (error) {
      logFailure('desktop_notifier.child_lookup_failed', error);
    }
    if (childSession) return suppress('child_session', candidate);
    if (inPrimaryQuietHours(localSession)) return suppress('quiet_hours', candidate);
    let mainWindow;
    let focused = false;
    try {
      mainWindow = getMainWindow?.() || null;
      if (mainWindow && mainWindow.isDestroyed?.()) mainWindow = null;
      if (mainWindow) observeWindow(mainWindow);
      focused = Boolean(mainWindow) && isWindowFocused(mainWindow);
      if (focused && settings.onlyWhenUnfocused) return suppress('focused', candidate);
    } catch (error) {
      logFailure('desktop_notifier.window_failed', error);
      mainWindow = null;
    }
    if (!mainWindow) return suppress('no_window', candidate);
    if (!supported()) return false;
    const team = candidate.category === 'team';
    const groupId = team ? `${candidate.teamId}:${candidate.channelId}` : candidate.sessionId;
    const liveKey = candidate.group
      ? `${candidate.category}:group:${candidate.group}:${groupId}`
      : `${candidate.category}:${candidate.key}`;
    const group = candidate.group ? groupCounts.get(liveKey) : null;
    const duplicate = candidate.group ? group?.lastKey === candidate.key : liveNotifications.has(liveKey);
    if (duplicate) return suppress('duplicate', candidate);
    // An update shown while the window is focused is being looked at: it starts a fresh count.
    const fresh = focused || !group;
    const count = candidate.group ? (fresh ? 0 : group.count) + 1 : 0;
    const senders = team ? (fresh ? [] : group.senders.slice()) : null;
    if (team && candidate.sender && !senders.includes(candidate.sender) && senders.length < MAX_GROUP_SENDERS) senders.push(candidate.sender);
    let title = candidate.title;
    if (count > 1 && team) title = t('desktopNotifier.toast.teamCount', '{count} new messages in {conversation}', { count, conversation: candidate.conversation }).slice(0, FIELD_LIMITS.title);
    else if (count > 1) title = t('desktopNotifier.toast.updates', 'Jenny has {count} updates', { count });
    if (candidate.group) {
      const previous = liveNotifications.get(liveKey);
      liveNotifications.delete(liveKey);
      if (previous) closeNotification(previous);
    }
    while (liveNotifications.size >= MAX_LIVE_NOTIFICATIONS) {
      const [oldestKey, oldest] = liveNotifications.entries().next().value;
      liveNotifications.delete(oldestKey);
      closeNotification(oldest);
    }
    let body = settings.replyPreview === true && candidate.preview
      ? candidate.preview
      : candidate.body;
    if (team && count > 1) body = sendersLine(senders).slice(0, FIELD_LIMITS.body);
    try {
      const notification = notificationFactory({
        title,
        body,
        silent: settings.sound !== true || isAppMuted(),
      });
      const forget = () => {
        if (liveNotifications.get(liveKey) === notification) liveNotifications.delete(liveKey);
      };
      notification?.on?.('click', () => {
        forget();
        groupCounts.delete(liveKey);
        openSession(candidate);
      });
      notification?.on?.('close', forget);
      liveNotifications.set(liveKey, notification);
      notification?.show?.();
      if (candidate.group) groupCounts.set(liveKey, { count, lastKey: candidate.key, senders: senders || [] });
      safeLog('INFO', 'desktop_notifier.shown', { category: candidate.category });
      return true;
    } catch (error) {
      liveNotifications.delete(liveKey);
      logFailure('desktop_notifier.notification_failed', error);
      return false;
    }
  }

  function handleNotifyIpc(event, candidate) {
    try {
      if (senderAuthorizer(event, { methodPath: 'notifications.notify' }) !== true) {
        suppress('unauthorized_sender', null);
        return;
      }
      notify(candidate);
    } catch (error) {
      logFailure('desktop_notifier.ipc_failed', error);
    }
  }

  function start() {
    if (registeredIpcMain) return;
    if (!ipcMainLike || typeof ipcMainLike.on !== 'function') return;
    ipcMainLike.on(notifyChannel, handleNotifyIpc);
    registeredIpcMain = ipcMainLike;
  }

  function stop() {
    if (registeredIpcMain) {
      try {
        registeredIpcMain.removeListener?.(notifyChannel, handleNotifyIpc);
      } catch (error) {
        logFailure('desktop_notifier.stop_failed', error);
      }
      registeredIpcMain = null;
    }
    detachWindow();
    closeAll();
  }

  return {
    start,
    stop,
    notify,
    getLiveCount: () => liveNotifications.size,
  };
}

module.exports = {
  EMITTED_CATEGORIES,
  FIELD_LIMITS,
  MAX_LIVE_NOTIFICATIONS,
  createDesktopNotifier,
  isRuntimeChildSession,
  normalizeNotificationCandidate,
};
