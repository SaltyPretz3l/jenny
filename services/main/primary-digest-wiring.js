'use strict';

/* services/main/primary-digest-wiring.js - desktop composition of row 86 (plan PRIMARY_DIGESTS_2026-10-27.md): the
 * presence tracker (presence-tracker.js) driven by a 30 s poll, window focus/blur and powerMonitor events, and the
 * digest ops (primary-digest.js) fed by the facts composer (primary-away-facts.js) over the runtime snapshot, the
 * session directory, the Jenny chat's mail inbox and its control history.
 *
 * The tracker runs whatever the flag says, so `lastPresentAt` is current the day the user turns digests on; it writes
 * only on present -> away edges and at quit. Everything reads `backendService` lazily and degrades to "not present" /
 * "no facts" / "engine cold" on any failure, so a broken port never starts a turn.
 */

const { createPresenceTracker, DEFAULT_IDLE_THRESHOLD_SECONDS: IDLE_THRESHOLD_SECONDS } = require('./presence-tracker');
const { wirePrimaryDigests } = require('../primary-digest');
const { composeAwayFacts } = require('../primary-away-facts');
const { createSessionDirectoryService } = require('../session-directory-service');
const { createSessionMailStore } = require('../backend/session-mail-store');
const { getResidentModels } = require('../backend/backend-resident-models');

const POLL_MS = 30000;
const SNAPSHOT_LIMIT = 100;
const DIRECTORY_ROWS = 50;
// `lastPresentAt` on disk only matters across a restart (the tracker keeps it in memory), so ordinary edges and the
// present heartbeat write at most this often, and only while digests are on; quit and suspend always write.
const PRESENCE_WRITE_EVERY_MS = 15 * 60000;

function electronModule(name) {
  try { return require('electron')[name] || null; } catch (_error) { return null; }
}

function attachPrimaryDigests(backendService, {
  configService = () => null, getMainWindow = () => null, powerMonitor = electronModule('powerMonitor'), app = electronModule('app'),
  log = () => {}, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
} = {}) {
  const read = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const controls = () => backendService.primaryChatControls || null;
  const store = () => backendService.sessionStore || null;

  function isWindowPresent() {
    const window = getMainWindow();
    return Boolean(window) && !window.isDestroyed?.() && window.isVisible?.() === true && window.isFocused?.() === true
      && window.isMinimized?.() !== true;
  }
  const idleSeconds = () => Number(powerMonitor?.getSystemIdleTime?.());
  const isPresent = () => read(() => isWindowPresent() && idleSeconds() < IDLE_THRESHOLD_SECONDS, false);

  let directory = null;
  const sessionDirectory = () => {
    directory ||= createSessionDirectoryService({
      sessionStore: store, projectService: () => backendService.projectService,
      runtime: () => backendService.runtimeApplicationService, configService,
      waitNotices: () => backendService.sessionRuntime?.waitNotices,
      projectNotesService: () => backendService.projectNotesService, chatWorkspaceService: () => backendService.chatWorkspace,
      pendingApprovals: () => backendService.pendingToolApprovals,
      visibleChat: () => require('../backend/memory-reflection-eligibility').visibleChatPredicate(backendService),
      primaryChatEnabled: () => backendService.featureFlags?.primary_chat !== false,
      log,
    });
    return directory;
  };

  // D2: the facts since `since`, from data already held in main.
  function factsSince({ since, until }) {
    const primaryId = controls()?.primarySessionId?.() ?? null;
    if (!primaryId) return null;
    const snapshot = read(() => backendService.runtimeApplicationService?.getSnapshot?.({ limit: SNAPSHOT_LIMIT, cursor: null }), null);
    const listed = read(() => sessionDirectory().list({
      callerSessionId: primaryId, scope: 'all', include_archived: true, limit: DIRECTORY_ROWS,
    }), null);
    const mail = read(() => createSessionMailStore(store()).read(primaryId), null);
    const history = read(() => controls()?.getState?.()?.history, null);
    const sessions = listed?.ok === true && Array.isArray(listed.rows) ? [...listed.rows] : [];
    // Work in a chat past the directory page keeps its real title (else the model hears "Chat deleted").
    const known = new Set(sessions.map((row) => row.session_id || row.id));
    for (const row of snapshot?.ok === true && Array.isArray(snapshot.work) ? snapshot.work : []) {
      const id = row?.session_id;
      if (!id || known.has(id)) continue;
      known.add(id);
      const summary = read(() => store()?.getSessionSummary?.(id), null);
      if (summary) sessions.push(summary);
    }
    return composeAwayFacts({
      since, until, primarySessionId: primaryId,
      sources: {
        work: snapshot?.ok === true && Array.isArray(snapshot.work) ? snapshot.work : [],
        sessions,
        mail: mail?.ok === true && Array.isArray(mail.mail?.inbox) ? mail.mail.inbox : [],
        schedules: Array.isArray(history) ? history : [],
      },
    });
  }

  // Q4: never cold-start a model. Ollama answers with its resident list (the Jenny chat's own model must be in it);
  // other engines report model_loaded.
  const modelKey = (name) => String(name || '').trim().toLowerCase().replace(/:latest$/, '');
  async function engineReady(summary) {
    if (String(backendService.sidecarManager?.getStatus?.()?.phase || '') !== 'ready') return false;
    const resident = await getResidentModels(backendService);
    if (!Array.isArray(resident)) return backendService.currentStatus?.model_loaded === true;
    const wanted = modelKey(summary?.preferred_model || backendService.currentModel);
    return wanted ? resident.some((entry) => modelKey(entry?.name) === wanted) : resident.length > 0;
  }

  // Quiet hours are chatUi settings (Settings > Jenny chat); the digest record holds only the cursors.
  const quietHours = () => {
    const chatUi = read(() => configService()?.getChatUiState?.(), null) || {};
    return { quietStart: chatUi.digestQuietStart, quietEnd: chatUi.digestQuietEnd };
  };
  const ops = wirePrimaryDigests(backendService, { factsSince, engineReady, isPresent, quietHours, log });
  const digestsOn = () => backendService.featureFlags?.primary_chat !== false && backendService.featureFlags?.primary_digests === true;
  let lastWriteMs = 0;
  let forceWrite = false;
  function writePresence(iso, { heartbeat = false } = {}) {
    const nowMs = Date.now();
    if (!forceWrite && (!digestsOn() || nowMs - lastWriteMs < PRESENCE_WRITE_EVERY_MS)) return heartbeat ? false : true;
    lastWriteMs = nowMs;
    return controls()?.updateDigest?.({ lastPresentAt: iso }) === true;
  }
  const forced = (fn) => () => { forceWrite = true; try { return read(fn, null); } finally { forceWrite = false; } };
  const tracker = createPresenceTracker({
    isWindowPresent,
    getSystemIdleSeconds: idleSeconds,
    readLastPresentAt: () => controls()?.getDigest?.()?.lastPresentAt ?? null,
    writeLastPresentAt: (iso) => writePresence(iso),
    onReturn: (info) => ops.onReturn(info),
    log,
  });

  let timer = null;
  // A present heartbeat keeps the stamp near-current, so a crash is not read as a long absence on the next launch.
  const tick = () => {
    const state = read(() => tracker.tick(), null);
    if (state?.present === true && state.lastSeenPresentAt) read(() => writePresence(state.lastSeenPresentAt, { heartbeat: true }), null);
  };
  const onResume = () => read(() => tracker.noteResume(), null);
  const onSuspend = forced(() => tracker.noteSuspend());
  const onQuit = forced(() => tracker.noteQuit());
  let observedWindow = null;
  const onFocus = () => read(() => tracker.noteFocus(), null);
  const onBlur = () => read(() => tracker.noteBlur(), null);

  // The main window can be created after this attach; focus listeners bind on the first poll that sees it.
  function observeWindow() {
    const window = read(getMainWindow, null);
    if (!window || window === observedWindow || window.isDestroyed?.()) return;
    observedWindow = window;
    window.on?.('focus', onFocus);
    window.on?.('blur', onBlur);
  }

  function start() {
    if (timer) return;
    powerMonitor?.on?.('resume', onResume);
    powerMonitor?.on?.('unlock-screen', onResume);
    powerMonitor?.on?.('suspend', onSuspend);
    powerMonitor?.on?.('lock-screen', onSuspend);
    timer = setIntervalFn(() => { observeWindow(); tick(); }, POLL_MS);
    timer?.unref?.();
    observeWindow();
    tick();
  }

  function stop() {
    onQuit();
    app?.removeListener?.('before-quit', onQuit);
    if (timer) clearIntervalFn(timer);
    timer = null;
    powerMonitor?.removeListener?.('resume', onResume);
    powerMonitor?.removeListener?.('unlock-screen', onResume);
    powerMonitor?.removeListener?.('suspend', onSuspend);
    powerMonitor?.removeListener?.('lock-screen', onSuspend);
    if (observedWindow && !observedWindow.isDestroyed?.()) {
      observedWindow.removeListener?.('focus', onFocus);
      observedWindow.removeListener?.('blur', onBlur);
    }
    observedWindow = null;
  }

  const handle = { ops, tracker, factsSince, start, stop };
  backendService.primaryDigestPresence = handle;
  // Self-contained lifecycle (main.js and both composition roots sit at their line caps): every quit attempt stamps
  // presence, but a quit the unsaved-work preflight cancels keeps tracking; teardown waits for will-quit.
  start();
  app?.on?.('before-quit', onQuit);
  app?.once?.('will-quit', stop);
  return handle;
}

module.exports = { attachPrimaryDigests };
