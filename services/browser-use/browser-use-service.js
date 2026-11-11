'use strict';

/**
 * The main-process owner of model-driven browsing (roadmap row 114): one page per
 * chat, at most a few at once, driven one step at a time by the action layer and
 * handed to the user when they touch it while the model is working on it.
 *
 * Every Electron object is injected, so this runs in plain Node. The lifecycle
 * rules (open, busy, user-held, crash, inactivity, cap) are the state table in
 * the row 114 browser-use plan. Messages are written for the model, and
 * logs carry event names and generic reasons only, never an address or page text.
 */

const { createConsentGate, refusalMessage } = require('./consent-gate');
const { createChordForwarder } = require('./input-watch');
const { createPageActions, createReaderBridge } = require('./page-actions');
const { createPageHost } = require('./page-host');
const { READER_WORLD_ID, buildReaderCall } = require('./page-reader-script');
const { FIXED_PORTS } = require('./reserved-ports');
const { fail, tooManyPagesMessage } = require('./result-format');
const { createSettler } = require('./settle');
const { classifyUrl, createUrlGuard, withDefaultScheme } = require('./url-guard');
const { createUserControls } = require('./user-controls');
const { createUserHold } = require('./user-hold');
const { createPanelSeat } = require('./panel-seat');
const {
  CLOSED_STATE, KNOWN_ACTIONS, MAX_TARGET_CHARS, MESSAGES, NOTES, linkAbort, noop, runAdBlockAction, targetOf, createEntryLookup,
} = require('./service-support');

const KNOWN_ACTION_SET = new Set(KNOWN_ACTIONS);
const MAX_CLOSED_NOTES = 32;
const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const CHANGED_METHOD = 'browserUse.onChanged';
const ACTIVITY_TOUCH_MS = 1000; // mouse moves arrive far faster than an idle timer needs
const USER_BROWSING_MS = 15000; // long enough for a clicked link to finish redirecting, short enough that a page cannot use a stale click

function createBrowserUseService({
  createView, sessionFromPartition, getMainWindow, getReservedPorts, getRunningTurnId, sendBridgeEvent, logger,
  canOpenByHand, showMenu, writeClipboard, revealFile, adBlocker = null, isAppMuted = () => false, onChatSound = noop,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, randomToken,
  inactivityMs = 600000, maxPages = 2, maxStepsPerTurn = 30, holdIdleMs = 1800000,
}) {
  const entries = new Map();
  const notes = new Map();
  const chains = new Map();
  const inflight = new Map();
  const pendingDisposals = new Set();
  let disposed = false;
  let disposePromise = null;
  const forwardChord = createChordForwarder(getMainWindow);

  const log = (level, event, fields = {}) => { try { logger?.(level, event, fields); } catch (_error) { /* logging never breaks a step */ } };
  const actionLogger = { warn: () => log('WARN', 'browser_use.action_warning') };
  const reservedPorts = () => {
    try { return getReservedPorts?.() ?? FIXED_PORTS; } catch (_error) { return FIXED_PORTS; }
  };

  // ---- state pushes and notes ----

  function stateOf(entry) {
    const { current } = entry;
    return {
      open: true, mode: entry.mode, ...entry.host.info(), busy: current !== null,
      action: current?.action || '', target: current?.target || '', asking: current?.asking === true, waiting: entry.waiting,
      crashed: entry.crashed, user_touched: entry.userTouched, stopped_short: entry.stoppedShort, closed_reason: '',
    };
  }

  function push(sessionId, state) {
    try { sendBridgeEvent?.(CHANGED_METHOD, { session_id: sessionId, ...state }); } catch (_error) { /* the renderer may be gone */ }
  }

  function notify(entry) {
    if (entries.get(entry.sessionId) !== entry) return;
    const state = stateOf(entry);
    const sent = JSON.stringify(state);
    if (sent === entry.lastSent) return;
    entry.lastSent = sent;
    push(entry.sessionId, state);
    onChatSound(entry.sessionId, state.sound);
  }

  function rememberNote(sessionId, note) {
    notes.delete(sessionId);
    notes.set(sessionId, note);
    while (notes.size > MAX_CLOSED_NOTES) notes.delete(notes.keys().next().value);
  }

  function trackDisposal(promise) {
    const tracked = Promise.resolve(promise).catch(() => false).finally(() => pendingDisposals.delete(tracked));
    pendingDisposals.add(tracked);
    return tracked;
  }

  // ---- timers ----

  function clearEntryTimer(entry) {
    if (entry.timer !== null) clearTimer(entry.timer);
    entry.timer = null;
  }

  function armTimer(entry) {
    clearEntryTimer(entry);
    if (entry.current || disposed || entries.get(entry.sessionId) !== entry) return;
    entry.timer = setTimer(() => {
      entry.timer = null;
      if (entry.current || entries.get(entry.sessionId) !== entry) return;
      // Someone is looking at it or holding it. Hiding it or handing it back restarts the wait.
      if (entry.panelBounds || entry.mode === 'user' || entry.host.keepsPageAlive()) {
        armTimer(entry);
        return;
      }
      log('INFO', 'browser_use.closed_idle');
      removeEntry(entry, NOTES.idle, 'idle');
    }, inactivityMs);
    entry.timer?.unref?.();
  }

  function touch(entry) {
    if (entries.get(entry.sessionId) !== entry) return;
    entry.lastActiveAt = now();
    if (!entry.current) armTimer(entry);
  }

  // ---- entry lifecycle ----

  // The turn running in this chat now, or '' between turns. A failed lookup reads as no turn, so nothing can hang on it.
  function runningTurn(sessionId) {
    try { return String(getRunningTurnId?.(sessionId) || ''); } catch (_error) { return ''; }
  }

  // Working on the page, not merely running: a turn that has not touched the page has nothing to take back.
  const isWorkingOnPage = (entry) => entry.current !== null || (entry.turnKey !== '' && runningTurn(entry.sessionId) === entry.turnKey);

  function enterUserMode(entry, reason) {
    if (entries.get(entry.sessionId) !== entry || entry.mode === 'user') return;
    // Between tasks the page is simply the user's: nothing is taken over, so nothing can wait on it later.
    if (reason !== 'panel' && !isWorkingOnPage(entry)) {
      entry.userBrowsingUntil = now() + USER_BROWSING_MS;
      if (!entry.userTouched) {
        entry.userTouched = true;
        notify(entry);
      }
      return;
    }
    entry.mode = 'user';
    entry.heldTurn = entry.current ? entry.turnKey : runningTurn(entry.sessionId);
    entry.hold.begin();
    if (entry.current) {
      entry.current.reason = entry.current.reason || 'user';
      entry.current.controller.abort();
    }
    log('INFO', 'browser_use.take_over', { reason });
    touch(entry);
    notify(entry);
  }

  function returnToModel(entry, fields) {
    entry.mode = 'model';
    entry.hold.end();
    log('INFO', 'browser_use.hand_back', fields);
    touch(entry);
    notify(entry);
  }

  function buildHost(entry, keptSettings = null) {
    return createPageHost({
      keptSettings,
      createView,
      sessionFromPartition,
      getMainWindow,
      randomToken,
      urlGuard: entry.urlGuard,
      consent: entry.consent,
      isUserHolding: () => entry.mode === 'user' || now() < entry.userBrowsingUntil,
      isModelActing: () => entry.current !== null,
      adBlocker,
      isAppMuted,
      onBrowserChord: (chord) => controls.onChord(entry, chord),
      onContextMenu: (params) => controls.onContextMenu(entry, params),
      onUserInput: (reason) => enterUserMode(entry, reason),
      onActivity: () => { if (now() - entry.lastActiveAt >= ACTIVITY_TOUCH_MS) touch(entry); },
      onCrash: () => handleCrash(entry),
      onChanged: () => notify(entry),
      forwardChord,
      logger,
      now,
      setTimer,
      clearTimer,
    });
  }

  function openEntry(sessionId) {
    const entry = {
      sessionId, host: null, consent: null, urlGuard: null, mode: 'model', current: null, turnKey: '', steps: 0,
      heldTurn: '', userBrowsingUntil: 0, userTouched: false, stoppedShort: false, crashed: false, waiting: false, waitedCall: '',
      crashNote: false, panelBounds: null, lastSize: { ...DEFAULT_VIEWPORT }, lastActiveAt: now(), timer: null, lastSent: '',
    };
    entry.hold = createUserHold({ getLastActiveAt: () => entry.lastActiveAt, idleLimitMs: holdIdleMs, now, setTimer, clearTimer });
    entry.urlGuard = createUrlGuard({ resolveHost: (host) => entry.host.resolveHost(host), reservedPorts, now });
    entry.consent = createConsentGate({ urlGuard: entry.urlGuard, getCurrentUrl: () => entry.host?.currentUrl() || '', now });
    void adBlocker?.ready?.();
    entry.host = buildHost(entry);
    entries.set(sessionId, entry);
    return entry;
  }

  function removeEntry(entry, note, reason) {
    if (entries.get(entry.sessionId) === entry) entries.delete(entry.sessionId);
    clearEntryTimer(entry);
    if (note) rememberNote(entry.sessionId, note);
    if (entry.current) {
      entry.current.reason = reason;
      entry.current.controller.abort();
    }
    entry.hold.end();
    trackDisposal(entry.host.dispose());
    push(entry.sessionId, { ...CLOSED_STATE, closed_reason: note?.reason || '' });
    onChatSound(entry.sessionId, null);
  }

  function handleCrash(entry) {
    if (entries.get(entry.sessionId) !== entry) return;
    log('WARN', 'browser_use.page_crashed');
    const keptSettings = entry.host.keptSettings();
    trackDisposal(entry.host.dispose());
    entry.mode = 'model';
    entry.userBrowsingUntil = 0;
    entry.crashed = true;
    try {
      entry.host = buildHost(entry, keptSettings);
      controls.dress(entry);
      if (entry.panelBounds) entry.host.place(entry.panelBounds);
      else entry.host.offscreen(entry.lastSize);
    } catch (_error) {
      removeEntry(entry, NOTES.crashFatal, 'crash');
      return;
    }
    if (entry.current) {
      entry.current.reason = 'crash';
      entry.current.controller.abort();
    } else {
      entry.crashNote = true;
    }
    entry.hold.end();
    touch(entry);
    notify(entry);
  }

  /** Closes the least recently active page nobody is using, if the cap needs one gone. */
  function makeRoom() {
    if (entries.size < maxPages) return true;
    let victim = null;
    for (const entry of entries.values()) {
      // A page someone has been using by hand counts; the idle close is what frees it.
      const inUse = entry.current || entry.mode !== 'model' || entry.userTouched || entry.panelBounds || inflight.has(entry.sessionId) || entry.host.keepsPageAlive();
      if (!inUse && (!victim || entry.lastActiveAt < victim.lastActiveAt)) victim = entry;
    }
    if (!victim) return false;
    log('INFO', 'browser_use.evicted');
    removeEntry(victim, NOTES.evicted, 'evicted');
    return true;
  }

  // ---- running a step ----

  function overrideResult(reason, sessionId, result) {
    const wait = result?.humanWaitMs > 0 ? { humanWaitMs: result.humanWaitMs } : {};
    switch (reason) {
      case 'crash': return { ...fail('page_crashed', MESSAGES.crashed), ...wait };
      case 'dispose': return { ...fail('unavailable', MESSAGES.unavailable), ...wait };
      default: {
        const note = notes.get(sessionId) || NOTES.userClosed;
        return { ...fail(note.status, note.message), ...wait };
      }
    }
  }

  // The status line says when a step is waiting on the user rather than on the page.
  function watchAsk(entry, current, authorize) {
    if (typeof authorize !== 'function') return authorize;
    const setAsking = (asking) => {
      current.asking = asking;
      notify(entry);
    };
    return async (...args) => {
      setAsking(true);
      try {
        return await authorize(...args);
      } finally {
        setAsking(false);
      }
    };
  }

  async function invokeAction(entry, input, ctx, signal) {
    const { host, current } = entry;
    const reader = createReaderBridge({
      webContents: host.actionContents, buildReaderCall, worldId: READER_WORLD_ID, getGeneration: host.getGeneration,
    });
    const settler = createSettler({ webContents: host.actionContents, reader });
    const gate = entry.consent.forCall({
      authorize: watchAsk(entry, current, ctx.authorize), callId: ctx.callId, toolInput: input, signal, userText: ctx.userText,
    });
    const onTarget = (facts) => {
      current.target = String(facts?.name ?? '').slice(0, MAX_TARGET_CHARS);
      notify(entry);
    };
    const actions = createPageActions({
      webContents: host.actionContents, reader, gate, settler, logger: actionLogger, onTarget, armView: host.armView, getSound: host.sound,
    });
    if (!Object.hasOwn(actions, input.action)) return fail('invalid_arguments', MESSAGES.unknownAction);
    return actions[input.action](input, { signal });
  }

  async function runCall(entry, input, ctx) {
    const controller = new AbortController();
    const current = { controller, reason: '', action: input.action, target: targetOf(input), asking: false };
    entry.current = current;
    entry.crashed = false;
    entry.host.setStepActive(true);
    clearEntryTimer(entry);
    notify(entry);
    const unlink = linkAbort(ctx.abortSignal, controller, () => entry.host.stopLoading());
    let result;
    try {
      result = await invokeAction(entry, input, ctx, controller.signal);
    } catch (_error) {
      log('WARN', 'browser_use.step_failed');
      result = fail('unavailable', MESSAGES.stepFailed);
    } finally {
      unlink();
      if (entry.current === current) {
        entry.current = null;
        entry.host.setStepActive(false);
      }
    }
    const heldByUser = current.reason === 'user';
    if (current.reason && !heldByUser) result = overrideResult(current.reason, entry.sessionId, result);
    if (entries.get(entry.sessionId) === entry) {
      entry.lastActiveAt = now();
      armTimer(entry);
      notify(entry);
    }
    return heldByUser ? resumeAfterUser(entry, ctx, result?.humanWaitMs) : result;
  }

  // The step stays open while the user has the page, so the turn carries on once they hand it back.
  async function resumeAfterUser(entry, ctx, earlierWaitMs = 0) {
    entry.waiting = true;
    entry.waitedCall = ctx.callId || '';
    notify(entry);
    const { ended, waitedMs } = await entry.hold.wait({ signal: ctx.abortSignal, suspendClocks: ctx.suspendTurnClocks });
    entry.waiting = false;
    if (ended !== 'stopped') entry.waitedCall = '';
    notify(entry);
    const humanWaitMs = earlierWaitMs + waitedMs;
    const wait = humanWaitMs > 0 ? { humanWaitMs } : {};
    if (ended === 'stopped') return { ...fail('cancelled', MESSAGES.cancelled), ...wait };
    if (ended === 'idle') return { ...fail('paused_by_user', MESSAGES.paused), ...wait };
    if (entries.get(entry.sessionId) !== entry) return overrideResult(disposed ? 'dispose' : 'close', entry.sessionId, wait);
    if (entry.crashNote) {
      entry.crashNote = false;
      return { ...fail('page_crashed', MESSAGES.crashed), ...wait };
    }
    const page = await runCall(entry, { action: 'read' }, ctx);
    const totalWaitMs = humanWaitMs + (page.humanWaitMs || 0);
    const result = page.status === 'ok' ? { ...page, status: 'handed_back', message: MESSAGES.handedBack } : page;
    return totalWaitMs > 0 ? { ...result, humanWaitMs: totalWaitMs } : result;
  }

  // A navigate that can only be refused must not cost another chat its page.
  function refusedBeforeOpening(url) {
    // The same spelling repair page-actions applies, so a bare localhost:3000 is judged as http://.
    const verdict = classifyUrl(withDefaultScheme(String(url ?? '')), { kind: 'navigation', reservedPorts: reservedPorts() });
    return verdict.allowed || verdict.reason === 'invalid_url' ? null : fail('refused', refusalMessage(verdict.reason));
  }

  function acquireEntry(sessionId) {
    if (!makeRoom()) return { failure: fail('too_many_pages', tooManyPagesMessage(maxPages)) };
    try {
      const entry = openEntry(sessionId);
      controls.dress(entry);
      notes.delete(sessionId);
      return { entry };
    } catch (_error) {
      log('WARN', 'browser_use.start_failed');
      return { failure: fail('unavailable', MESSAGES.couldNotStart) };
    }
  }

  // Past the paused check every call is a step: a model stuck in a loop hits the limit.
  function stepLimitFailure(entry, ctx) {
    const turn = ctx.turnId || ctx.callId;
    if (turn !== entry.turnKey) {
      entry.turnKey = turn;
      entry.steps = 0;
    }
    if (entry.steps >= maxStepsPerTurn) {
      return fail('step_limit', `You have used all ${maxStepsPerTurn} browser steps for this turn. Stop here and tell the user where you got to.`);
    }
    entry.steps += 1;
    return null;
  }

  async function runLocked(input, ctx) {
    if (disposed) return fail('unavailable', MESSAGES.unavailable);
    if (ctx.abortSignal?.aborted) return fail('cancelled', MESSAGES.cancelled);
    let entry = entries.get(ctx.sessionId);
    if (!entry) {
      if (input.action !== 'navigate') {
        const note = notes.get(ctx.sessionId);
        return note ? fail(note.status, note.message) : fail('no_page', MESSAGES.noPage);
      }
      const refused = refusedBeforeOpening(input.url);
      if (refused) return refused;
      const acquired = acquireEntry(ctx.sessionId);
      if (acquired.failure) return acquired.failure;
      entry = acquired.entry;
    }
    if (input.action === 'close') {
      if (entry.mode === 'user') return fail('refused', MESSAGES.userHasPage);
      removeEntry(entry, NOTES.modelClosed, 'close');
      return { ok: true, status: 'closed', message: MESSAGES.closed };
    }
    if (input.action === 'ad_block') return stepLimitFailure(entry, ctx) || runAdBlockAction(entry, input);
    if (entry.mode === 'user') {
      // Asking Jenny for more is handing the page back. Only the turn it was taken from waits.
      if (entry.heldTurn === (ctx.turnId || ctx.callId)) return resumeAfterUser(entry, ctx);
      returnToModel(entry, { reason: 'new_request' });
    }
    entry.userBrowsingUntil = 0;
    entry.userTouched = false;
    const limited = stepLimitFailure(entry, ctx);
    if (limited) return limited;
    if (entry.crashNote) {
      entry.crashNote = false;
      if (input.action !== 'navigate') return fail('page_crashed', MESSAGES.crashed);
    }
    return runCall(entry, input, ctx);
  }

  // One call per chat at a time. Counted before it is queued so eviction sees a waiting chat as busy.
  function enqueue(sessionId, task) {
    inflight.set(sessionId, (inflight.get(sessionId) || 0) + 1);
    const run = (chains.get(sessionId) || Promise.resolve()).then(task).finally(() => {
      const left = (inflight.get(sessionId) || 1) - 1;
      if (left > 0) inflight.set(sessionId, left); else inflight.delete(sessionId);
    });
    const tail = run.then(noop, noop);
    chains.set(sessionId, tail);
    tail.then(() => { if (chains.get(sessionId) === tail) chains.delete(sessionId); });
    return run;
  }

  function execute(input, ctx = {}) {
    if (disposed) return Promise.resolve(fail('unavailable', MESSAGES.unavailable));
    const action = input && typeof input === 'object' && !Array.isArray(input) ? input.action : undefined;
    if (typeof action !== 'string' || !KNOWN_ACTION_SET.has(action)) {
      return Promise.resolve(fail('invalid_arguments', MESSAGES.unknownAction));
    }
    const context = ctx && typeof ctx === 'object' ? ctx : {};
    if (typeof context.sessionId !== 'string' || !context.sessionId) {
      return Promise.resolve(fail('unavailable', MESSAGES.unavailable));
    }
    return enqueue(context.sessionId, () => runLocked(input, context))
      .catch(() => fail('unavailable', MESSAGES.stepFailed))
      .then((result) => noteHowStepEnded(context.sessionId, result));
  }

  // A step that did not work is the one sign the model may be waiting on the user: only then does the panel offer to tell it to carry on.
  function noteHowStepEnded(sessionId, result) {
    const entry = entries.get(sessionId);
    if (entry) {
      entry.stoppedShort = result?.ok !== true;
      notify(entry);
    }
    return result;
  }

  // ---- panel and user controls ----

  function getState(sessionId) {
    const entry = entries.get(sessionId);
    return entry ? stateOf(entry) : { ...CLOSED_STATE, closed_reason: notes.get(sessionId)?.reason || '' };
  }

  const { noPage, withEntry } = createEntryLookup(entries);

  function ownsContents(contents) {
    return [...entries.values()].some((entry) => entry.host.webContents === contents);
  }

  async function capture(sessionId) {
    const entry = entries.get(sessionId);
    if (!entry) return noPage();
    const shot = await entry.host.capture();
    return shot.ok ? shot : { ok: false, reason: 'capture_failed' };
  }

  function takeOver(sessionId) {
    return withEntry(sessionId, (entry) => {
      enterUserMode(entry, 'panel');
      return { ok: true };
    });
  }

  function handBack(sessionId) {
    return withEntry(sessionId, (entry) => {
      if (entry.mode === 'user') returnToModel(entry);
      return { ok: true };
    });
  }

  // Whether this call spent its time waiting for a hand back, so a Stop can say so. Holds during the wait and after a Stop.
  function waitedOnUser(sessionId, callId) {
    return Boolean(callId) && entries.get(sessionId)?.waitedCall === callId;
  }

  async function close(sessionId) {
    const entry = entries.get(sessionId);
    if (!entry) return noPage();
    removeEntry(entry, NOTES.userClosed, 'close');
    await entry.host.dispose().catch(noop);
    return { ok: true };
  }

  // A chat that reported back to the chat that started it is done with its page. One the user has used by hand, or
  // that is still playing something, stays. Unlike eviction, a page that is only on show closes: watching is not using.
  function closeFinished(sessionId) {
    const entry = entries.get(sessionId);
    if (!entry || entry.current || inflight.has(sessionId)) return false;
    if (entry.mode === 'user' || entry.userTouched || now() < entry.userBrowsingUntil || entry.host.keepsPageAlive()) return false;
    log('INFO', 'browser_use.closed_finished');
    removeEntry(entry, NOTES.finished, 'close');
    return true;
  }

  function dispose() {
    if (!disposePromise) {
      disposed = true;
      for (const entry of [...entries.values()]) removeEntry(entry, null, 'dispose');
      disposePromise = Promise.allSettled([...pendingDisposals]).then(noop);
    }
    return disposePromise;
  }

  const seat = createPanelSeat({ entries, getMainWindow, touch });
  const controls = createUserControls({
    entries,
    canOpen: canOpenByHand,
    showMenu,
    writeClipboard,
    revealFile,
    log,
    openForUser: (sessionId, url) => {
      const refused = refusedBeforeOpening(url);
      if (refused) return { failure: 'refused' };
      const acquired = acquireEntry(sessionId);
      return acquired.failure ? { failure: acquired.failure.status } : acquired;
    },
    driveByHand: (entry) => {
      entry.crashed = false;
      enterUserMode(entry, 'hand');
    },
    finishByHand: (entry) => {
      touch(entry);
      notify(entry);
    },
    pushCommand: (entry, command) => push(entry.sessionId, { ...stateOf(entry), command }),
    focusApp: () => { try { getMainWindow?.()?.webContents?.focus?.(); } catch (_error) { /* the window is going away */ } },
  });

  const toggleSound = (sessionId) => withEntry(sessionId, (entry) => {
    entry.host.toggleSound();
    return { ok: true };
  });
  const setAdBlock = (sessionId, enabled) => withEntry(sessionId, (entry) => ({ ok: true, changed: entry.host.setAdBlock(enabled, 'user') }));
  const applyAppMute = () => { for (const entry of entries.values()) entry.host.applyMute(); };

  return {
    execute, getState, ...seat, ownsContents, capture, takeOver, handBack, waitedOnUser, close, closeFinished, dispose,
    toggleSound, setAdBlock, applyAppMute,
    navigate: controls.navigate,
    zoom: controls.zoom,
    find: controls.find,
    stopFind: controls.stopFind,
    siteInfo: controls.siteInfo,
    removeSite: controls.removeSite,
    revealDownload: controls.revealDownload,
    configure: controls.configure,
  };
}

module.exports = { createBrowserUseService };
