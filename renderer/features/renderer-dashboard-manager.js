/* Home dashboard orchestrator (parallel to the companion manager). Owns the
 * #homeDashboardGrid widget registry, seeds the dashboard state slices
 * (scheduler / homeConfig), primes them over the shell
 * bridge on the first render, and repaints on the bridge change events.
 * render() is cheap and idempotent — the
 * lifecycle activates Home twice (sync paint + post-refresh) by design.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'));
    return;
  }
  root.rendererDashboardUtils = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils) || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const registryModuleFallback = typeof windowRef.rendererDashboardRegistry !== 'undefined'
    ? windowRef.rendererDashboardRegistry
    : typeof require === 'function'
      ? require('./renderer-dashboard-registry')
      : {};
  const CLOCK_REPAINT_INTERVAL_MS = 30 * 1000;

  function noop() {}

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function reminderFieldsMatch(expected, echoed) {
    return asObject(echoed)
      && String(echoed.id || '') === String(expected?.id || '')
      && String(echoed.label || '') === String(expected?.label || '')
      && String(echoed.prompt || '') === String(expected?.prompt || '')
      && (echoed.enabled !== false) === (expected?.enabled !== false)
      && String(echoed.createdAt || '') === String(expected?.createdAt || '');
  }

  // What the body-level pinned-note overlay shows (id, title, text per pin, in pin order).
  function pinnedNotesKey(scratchpad) {
    const pins = Array.isArray(scratchpad?.pins) ? scratchpad.pins : [];
    if (pins.length === 0) return '';
    const notes = Array.isArray(scratchpad.notes) ? scratchpad.notes : [];
    return JSON.stringify(pins.map((id) => {
      const note = notes.find((entry) => entry?.id === id);
      return [id, String(note?.title || ''), String(note?.text || '')];
    }));
  }

  // The home config minus the scratchpad: tells a pad-only echo from one that moved another section.
  function homeConfigWithoutScratchpadKey(homeConfig) {
    return JSON.stringify({ ...(asObject(homeConfig) || {}), scratchpad: null });
  }

  function uniqueReminderIndex(reminders) {
    if (!Array.isArray(reminders)) return null;
    const byId = new Map();
    for (const reminder of reminders) {
      const id = String(reminder?.id || '');
      if (!id || byId.has(id)) return null;
      byId.set(id, reminder);
    }
    return byId;
  }

  function createDashboardManager(deps) {
    const { state } = deps;
    const {
      homeInfoStrip = null, homeDashboardGrid = null, homeDaybook = null,
      homeDashboardRail = null, homeRailResizer = null, homeRailGrip = null,
    } = deps.dom || {};
    const {
      appendClientLog = noop,
      clearPendingOrigin = noop,
      activateWorkspaceSession = null,
      setActiveView = noop,
      renderAll = noop,
      applyCompanionPayload = noop,
      // The ask pill's seam: the shell's real New chat path. A Home ask then
      // goes out through the composer's own send control, never a second
      // send path.
      handleCreateSession = null,
    } = deps.callbacks || {};
    // Owner document of the grid first: the hidden strip and every registry
    // widget are created here and inserted around/into that deps-provided host.
    const documentRef = (homeDashboardGrid && homeDashboardGrid.ownerDocument)
      || deps.documentRef || windowRef.document || null;
    const shell = deps.shell || windowRef.jennyShell || null;
    const setTimeoutImpl = deps.setTimeoutImpl
      || function defaultSetTimeout(fn, ms) { return setTimeout(fn, ms); };
    const clearTimeoutImpl = deps.clearTimeoutImpl
      || function defaultClearTimeout(timer) { clearTimeout(timer); };
    const setIntervalImpl = deps.setIntervalImpl
      || function defaultSetInterval(fn, ms) { return setInterval(fn, ms); };
    const clearIntervalImpl = deps.clearIntervalImpl
      || function defaultClearInterval(timer) { clearInterval(timer); };
    const registryModule = deps.modules?.dashboardRegistry || registryModuleFallback;
    const registry = registryModule?.createDashboardRegistry?.({
      documentRef,
      appendClientLog,
    }) || null;
    // Widget modules resolve from explicit injection or the window global
    // only (no require fallback) so bare unit tests get an empty registry.
    const widgetsCoreModule = deps.modules?.dashboardWidgetsCore
      || windowRef.rendererDashboardWidgetsCore
      || null;
    const calendarModule = deps.modules?.dashboardCalendar
      || windowRef.rendererDashboardCalendar
      || null;
    const awayDigestModule = deps.modules?.dashboardAwayDigest || windowRef.rendererDashboardWidgetAwayDigest || null;
    const remindersModule = deps.modules?.dashboardCalendarReminders || windowRef.rendererDashboardCalendarReminders || null;
    const scratchpadModule = deps.modules?.dashboardWidgetsScratchpad
      || windowRef.rendererDashboardWidgetsScratchpad
      || null;
    const scratchpadActionsModule = deps.modules?.dashboardScratchpadActions
      || windowRef.rendererDashboardScratchpadActions
      || null;
    const actionButton = typeof deps.actionButton === 'function'
      ? deps.actionButton
      : (typeof windowRef.inventoryActionButton === 'function' ? windowRef.inventoryActionButton : null);
    const loopsModule = deps.modules?.dashboardLoops
      || windowRef.rendererDashboardLoops
      || null;
    const infoStripRenderer = widgetsCoreModule?.createInfoStripRenderer?.({
      nowProvider: deps.nowProvider,
    }) || null;
    const daybookModule = deps.modules?.dashboardDaybook || windowRef.rendererDashboardDaybook || null;
    const pageMenuModule = deps.modules?.dashboardPageMenu || windowRef.rendererDashboardPageMenu || null;

    // The hero's page-level controls (focus mode / edit layout) live in one
    // popover menu beside the ask pill; the items reuse the strip delegation's
    // datasets, so this controller owns presentation only.
    const pageMenuController = pageMenuModule?.createPageMenuController?.({
      documentRef,
      getState: () => state,
      inventory: deps.inventory,
      actionButton: actionButton || undefined,
    }) || null;

    // Enter on the pill: bare New chat (reuses an untouched empty chat), then
    // prefill and press the composer's own send; the composer owns model,
    // effort and tools. send:false only prefills. The daybook's latch spans
    // the promise, so a second Enter cannot open a second chat.
    function startAskFromPill(text, options = {}) {
      const body = String(text || '');
      if (!body.trim() || typeof handleCreateSession !== 'function') {
        return sendScratchpadToChat(body, { allowEmpty: true });
      }
      return openChatAndSend(body, options);
    }

    async function openChatAndSend(body, options) {
      let sessionId;
      try {
        sessionId = String(await handleCreateSession() || '').trim();
      } catch (error) {
        appendClientLog('WARN', 'home.ask_open_chat_failed', { message: String(error?.message || error || '') });
        return false;
      }
      // Write only into the chat this ask opened; otherwise the question
      // stays in the pill rather than landing in another chat's composer.
      if (!sessionId || String(state.currentSessionId || '').trim() !== sessionId) {
        appendClientLog('WARN', 'home.ask_chat_not_opened', {
          reason: sessionId ? 'session_changed' : 'missing_session_id',
        });
        return false;
      }
      if (!sendScratchpadToChat(body)) {
        return false;
      }
      if (options.send === false) return true;
      // The prefilled composer's own send control (same pane as the text).
      const trigger = documentRef?.getElementById?.('chatInput')
        ?.closest?.('.composer')?.querySelector?.('[data-chat-node="sendButton"]') || null;
      if (!trigger || trigger.disabled === true) {
        // The text is already safe in the composer; the user presses send.
        appendClientLog('WARN', 'home.ask_send_unavailable', {});
        return true;
      }
      trigger.click();
      return true;
    }

    // Owns the rail width, the scratchpad-height grip, and the hero ask pill's
    // keys. Callbacks below are hoisted declarations, live before any pointer
    // or key event can fire.
    const daybookController = daybookModule?.createDaybookController?.({
      documentRef,
      shell,
      dom: { homeDaybook, homeDashboardRail, homeRailResizer, homeRailGrip, homeInfoStrip },
      getHomeConfig: () => state.homeConfig,
      onConfigApplied: (config) => { applyHomeConfigPayload(config); repaintIfHomeActive(); },
      onAsk: (text, options) => startAskFromPill(text, options),
      appendClientLog,
      setTimeoutImpl,
      clearTimeoutImpl,
    }) || null;

    let bound = false;
    let primeStarted = false;
    const fence = asyncFence.createDisposalFence();
    let scratchpadActions = null;
    let scratchpadWidget = null;
    let clockUpdateTimer = null;
    let gridClickHandler = null;
    let stripClickHandler = null;
    let focusHotkeyHandler = null;
    let lifecycleFlushHandler = null;
    let visibilityFlushHandler = null;
    let awayDigestRepaintScheduled = false;
    let awayDigestWidget = null;
    const unsubscribes = [];

    function scheduleAwayDigestRepaint() {
      if (awayDigestRepaintScheduled) return;
      awayDigestRepaintScheduled = true;
      Promise.resolve().then(() => { awayDigestRepaintScheduled = false; if (!fence.isDisposed()) repaintIfHomeActive(); });
    }
    // The shell creates the reader at boot (Home may never be visited); this
    // manager adopts it, or builds its own when it is constructed standalone.
    const ownsAwayDigestReader = !state.awayDigestReader;
    const awayDigestReader = state.awayDigestReader
      || awayDigestModule?.createAwayDigestReader?.({ windowRef, documentRef, state, callbacks: { appendClientLog } }) || null;
    state.awayDigestReader = awayDigestReader;
    if (awayDigestReader?.subscribe) unsubscribes.push(awayDigestReader.subscribe(scheduleAwayDigestRepaint));

    // Reminder deletion for the Daybook agenda's Done affordance.
    const reminderActions = {
      remove: async (reminderId) => {
        const removedId = String(reminderId || '');
        const survivingReminders = (Array.isArray(state.proactive?.reminders) ? state.proactive.reminders : [])
          .filter((entry) => String(entry?.id || '') && String(entry.id) !== removedId);
        const payload = await shell?.proactive?.deleteReminder?.(reminderId);
        const reminders = asObject(payload)?.proactive?.reminders;
        const echoedById = uniqueReminderIndex(reminders);
        if (
          !echoedById
          || echoedById.size !== survivingReminders.length
          || echoedById.has(removedId)
          || survivingReminders.some((entry) => (
            !reminderFieldsMatch(entry, echoedById.get(String(entry.id)))
          ))
        ) {
          throw new Error('Reminder deletion was not acknowledged.');
        }
        applyProactivePayload(payload);
        try {
          await refreshCompanionPayload();
        } catch (error) {
          appendClientLog('WARN', 'home.companion_refresh_failed', { message: String(error?.message || error || '') });
        }
        repaintIfHomeActive();
        return payload;
      },
    };

    if (registry) {
      const defaultWidgets = [
        (() => {
          if (!scratchpadModule?.createScratchpadWidget || !scratchpadActionsModule?.createScratchpadActions) {
            return null;
          }
          scratchpadActions = scratchpadActionsModule.createScratchpadActions({
            shell,
            appendClientLog,
            // Lets a save rewrite the whole notes object off live app state.
            getScratchpad: () => state.homeConfig?.scratchpad,
            getHomeConfig: () => state.homeConfig,
            // Repaint on the echo so structural changes (add / delete / rename /
            // switch) reflect; the widget's render-key skip keeps an autosave
            // echo from clobbering an in-focus textarea or rebuilding the strip.
            onHomeConfig: (payload) => {
              // A changed pinned overlay (pin set, or a pinned note's title/text) also
              // drives a full renderAll: the body-level sticky-note overlay sits outside
              // the dashboard repaint scope. Autosaves of unpinned notes pay nothing.
              const prevPinned = pinnedNotesKey(state.homeConfig?.scratchpad);
              const prevOthers = homeConfigWithoutScratchpadKey(state.homeConfig);
              applyHomeConfigPayload(payload);
              if (homeConfigWithoutScratchpadKey(state.homeConfig) === prevOthers) {
                repaintScratchpadIfHomeActive();
              } else {
                repaintIfHomeActive();
              }
              if (pinnedNotesKey(state.homeConfig?.scratchpad) !== prevPinned) {
                renderAll();
              }
            },
            applyCompanionPayload: (payload) => {
              applyCompanionPayload(payload);
              repaintIfHomeActive();
            },
            onCalendarSnapshot: (snapshot) => {
              applyCalendarPayload(snapshot);
              repaintIfHomeActive();
            },
            sendToChat: (text) => sendScratchpadToChat(text),
            setTimeoutImpl,
            clearTimeoutImpl,
          });
          const padWidget = scratchpadModule.createScratchpadWidget({
            actions: scratchpadActions,
            nowProvider: deps.nowProvider,
          });
          scratchpadWidget = padWidget;
          // Daybook: the pad IS the rail. Set here, not in the widget module,
          // so the layout decision stays with the layout owner.
          padWidget.slot = 'rail';
          return padWidget;
        })(),
        // Full-width work surfaces close the grid: calendar, then open loops.
        // applyCalendarPayload/repaintIfHomeActive are hoisted declarations,
        // live by the time the widget's callbacks fire.
        calendarModule?.createCalendarWidget?.({
          shell,
          appendClientLog,
          reminderActions, // the Daybook agenda's reminder Done affordance
          onSnapshot: (payload) => {
            if (applyCalendarChange(payload)) repaintIfHomeActive();
          },
          // Without this the local homeConfig slice (feeds + view mode) lags a
          // refresh after the widget writes config, so a just-saved view toggle
          // or feed would render stale until the next prime.
          onHomeConfig: (payload) => {
            applyHomeConfigPayload(payload);
            repaintIfHomeActive();
          },
          onAiPayload: applyHomeAiPayload, // undo returns fresh journal + reminders
        }),
        // Finished background work sits under the week, before open loops.
        (awayDigestWidget = awayDigestReader && awayDigestModule?.createAwayDigestWidget?.({
          reader: awayDigestReader, actionButton,
          tooltip: windowRef.inventory?.tooltip || null, documentRef, setTimeoutImpl, clearTimeoutImpl,
          callbacks: { appendClientLog, showComposerActionError: null,
            // Same route as continue-session: activate, then leave Home for the chat.
            openSession: async (sessionId) => { clearPendingOrigin(); await activateWorkspaceSession?.(sessionId); setActiveView('chat'); renderAll(); } },
        }) || null),
        loopsModule?.createOpenLoopsWidget?.(),
      ].filter(Boolean);
      for (const widget of defaultWidgets) {
        registry.register(widget);
      }
    }

    // Placeholder slices so the first paint has shapes to read. The homeConfig
    // seed is deliberately NOT a complete config (no pins/showContextualTips):
    // isCompleteHomeConfig is how the pad writers and Settings tell it from the
    // user's real config, so they load first instead of writing over it.
    function seedDashboardState() {
      if (!asObject(state.scheduler)) {
        state.scheduler = { upcoming: [], running: [], generatedAt: '', relevant: false, lifecycle: null };
      }
      if (!asObject(state.homeConfig)) {
        state.homeConfig = {
          links: [],
          widgets: { order: [], hidden: [] },
          scratchpad: {
            notes: [{ id: 'note-1', title: jt('dashboard.scratchpad.actions.noteOne', 'Note 1'), text: '', updatedAt: '', appendLog: false }],
            activeNoteId: 'note-1',
            settings: { rows: 6, font: 'prose', captureMode: 'append', markdown: false, globalCapture: true },
          },
          calendar: { feeds: [], viewMode: 'agenda' },
          layout: { railWidth: 360 },
          focusMode: false,
        };
      }
      if (!asObject(state.proactive)) {
        state.proactive = { reminders: [], workspaceRoot: '', workspaceRootStatus: { state: 'missing', message: '' } };
      }
      state.homeJournal = asObject(state.homeJournal) || { entries: [] };
      if (!asObject(state.calendar)) {
        state.calendar = {
          generatedAt: '',
          windowStart: '',
          windowEnd: '',
          categories: [],
          instances: [],
          events: [],
          feeds: [],
        };
      }
    }

    seedDashboardState();

    function applySchedulerPayload(payload) {
      const source = asObject(payload);
      if (!source) {
        return state.scheduler;
      }
      state.scheduler = {
        upcoming: Array.isArray(source.upcoming) ? source.upcoming : [],
        running: Array.isArray(source.running) ? source.running : [],
        generatedAt: String(source.generatedAt || ''),
        relevant: source.relevant === true,
        lifecycle: asObject(source.lifecycle),
      };
      return state.scheduler;
    }

    function applyCalendarPayload(payload) {
      const source = asObject(payload);
      if (!source) {
        return state.calendar;
      }
      state.calendar = {
        generatedAt: String(source.generatedAt || ''),
        windowStart: String(source.windowStart || ''),
        windowEnd: String(source.windowEnd || ''),
        categories: Array.isArray(source.categories) ? source.categories : [],
        instances: Array.isArray(source.instances) ? source.instances : [],
        events: Array.isArray(source.events) ? source.events : [],
        feeds: Array.isArray(source.feeds) ? source.feeds : [],
      };
      return state.calendar;
    }

    // A mutation reaches Home twice with the same content: the service's
    // 'changed' push and the widget's invoke reply (only generatedAt differs).
    // Applies either way; reports whether the content moved, so the second
    // arrival skips a full repaint.
    let calendarContentKey = '';
    function applyCalendarChange(payload) {
      applyCalendarPayload(payload);
      const key = JSON.stringify({ ...state.calendar, generatedAt: '' });
      if (key === calendarContentKey) return false;
      calendarContentKey = key;
      return true;
    }

    function applyHomeConfigPayload(payload) {
      const source = asObject(payload);
      const scratchpad = asObject(source?.scratchpad);
      if (
        !source
        || !Array.isArray(source.links)
        || !asObject(source.widgets)
        || !scratchpad
        || !Array.isArray(scratchpad.notes)
        || typeof scratchpad.activeNoteId !== 'string'
        || !asObject(scratchpad.settings)
        || !Array.isArray(scratchpad.pins)
        || !asObject(source.calendar)
        || typeof source.focusMode !== 'boolean'
        || typeof source.showContextualTips !== 'boolean'
      ) {
        return state.homeConfig;
      }
      state.homeConfig = {
        links: source.links,
        widgets: source.widgets,
        // Daybook rail width. Passed through (not part of the required shape
        // above) so an older service payload cannot reject the whole config —
        // the daybook controller re-clamps an absent/garbage value to 360.
        layout: asObject(source.layout) || { railWidth: 360 },
        scratchpad,
        calendar: source.calendar,
        focusMode: source.focusMode,
        showContextualTips: source.showContextualTips,
      };
      return state.homeConfig;
    }

    function applyProactivePayload(payload) {
      const source = asObject(payload);
      const proactive = asObject(source?.proactive);
      if (!source || !proactive || !Array.isArray(proactive.reminders)) {
        return state.proactive;
      }
      state.proactive = {
        reminders: proactive.reminders.map((entry) => ({ ...entry })),
        workspaceRoot: String(source.toolsWorkspaceRoot || ''),
        workspaceRootStatus: asObject(source.workspaceRootStatus) || { state: 'missing', message: '' },
      };
      return state.proactive;
    }

    async function refreshCompanionPayload() {
      const payload = await shell?.companion?.getState?.();
      if (payload) applyCompanionPayload(payload);
      return payload;
    }

    // AI payloads carry {journal, proactive} ONLY; the fold preserves the
    // workspace-root fields applyProactivePayload owns and they do not carry.
    function applyHomeAiPayload(payload) {
      const next = remindersModule?.foldHomeAiPayload?.(state, payload);
      if (next) { state.proactive = next.proactive; state.homeJournal = next.journal; }
      repaintIfHomeActive();
    }

    function isHomeActive() {
      return state.ui?.activeView === 'home';
    }

    function isEditMode() {
      return state.ui?.dashboardEditMode === true;
    }

    function buildEditToolbar(widget) {
      if (typeof actionButton !== 'function') {
        return '';
      }
      const name = widget.title || widget.id;
      return ''
        + actionButton({
          plain: true, className: 'dashboard-card__edit-btn', label: '↑',
          ariaLabel: jt('dashboard.widgets.layout.moveEarlier', 'Move {name} earlier', { name }),
          title: jt('dashboard.widgets.layout.moveEarlier', 'Move {name} earlier', { name }),
          dataset: { 'widget-edit': 'up', 'widget-id': widget.id },
        })
        + actionButton({
          plain: true, className: 'dashboard-card__edit-btn', label: '↓',
          ariaLabel: jt('dashboard.widgets.layout.moveLater', 'Move {name} later', { name }),
          title: jt('dashboard.widgets.layout.moveLater', 'Move {name} later', { name }),
          dataset: { 'widget-edit': 'down', 'widget-id': widget.id },
        })
        + actionButton({
          plain: true, className: 'dashboard-card__edit-btn', label: jt('common.hide', 'Hide'),
          ariaLabel: jt('dashboard.widgets.layout.hideWidget', 'Hide {name}', { name }),
          title: jt('dashboard.widgets.layout.hideWidget', 'Hide {name}', { name }),
          dataset: { 'widget-edit': 'hide', 'widget-id': widget.id },
        });
    }

    // In edit mode, hidden-but-registered widgets get a restore strip in a
    // sibling element below the grid (the registry's orphan sweep owns the
    // grid's children, so the strip cannot live inside it).
    function renderHiddenStrip() {
      if (!homeDashboardGrid?.parentNode || !documentRef) {
        return;
      }
      let strip = homeDashboardGrid.parentNode.querySelector('#homeDashboardHiddenStrip');
      const hidden = Array.isArray(state.homeConfig?.widgets?.hidden)
        ? state.homeConfig.widgets.hidden
        : [];
      const known = new Map((registry?.list?.() || []).map((widget) => [widget.id, widget]));
      const entries = hidden.filter((id) => known.has(id));
      if (!isEditMode() || !entries.length || typeof actionButton !== 'function') {
        strip?.remove();
        return;
      }
      if (!strip) {
        strip = documentRef.createElement('div');
        strip.id = 'homeDashboardHiddenStrip';
        strip.className = 'dashboard-hidden-strip';
        strip.addEventListener('click', (event) => {
          const trigger = event?.target?.closest?.('[data-widget-edit]');
          if (trigger) {
            handleWidgetEdit(trigger.dataset.widgetEdit, String(trigger.dataset.widgetId || ''));
          }
        });
        homeDashboardGrid.parentNode.insertBefore(strip, homeDashboardGrid.nextSibling);
      }
      const stripKey = entries.join('|');
      if (strip.dataset.stripKey === stripKey) {
        return;
      }
      strip.dataset.stripKey = stripKey;
      strip.innerHTML = '<span class="dashboard-hidden-strip__label">' + escapeHtml(jt('dashboard.widgets.layout.hiddenLabel', 'Hidden:')) + '</span>'
        + entries.map((id) => actionButton({
          plain: true, className: 'dashboard-card__edit-btn',
          label: jt('dashboard.widgets.layout.showWidget', 'Show {name}', { name: known.get(id).title || id }),
          dataset: { 'widget-edit': 'show', 'widget-id': id },
        })).join('');
    }

    function paint() {
      if (!registry || !homeDashboardGrid) {
        return null;
      }
      // The dim scope is the whole Daybook (both columns), not just the main
      // grid; the grid stays the fallback host for bare-DOM harnesses.
      const focusHost = homeDaybook || homeDashboardGrid;
      if (state.homeConfig?.focusMode === true) {
        focusHost.dataset.focusMode = 'on';
      } else {
        delete focusHost.dataset.focusMode;
      }
      // A throw in the chrome must not cost the widgets their paint.
      guardPaintStep('home.dashboard_daybook_sync_failed', () => daybookController?.syncFromConfig?.());
      paintInfoStrip();
      guardPaintStep('home.dashboard_hidden_strip_failed', renderHiddenStrip);
      return registry.renderInto(homeDashboardGrid, paintContext());
    }

    function guardPaintStep(logEvent, step) {
      try {
        step();
      } catch (error) {
        appendClientLog('WARN', logEvent, { message: String(error?.message || error || '') });
      }
    }

    function paintInfoStrip() {
      if (!infoStripRenderer || !homeInfoStrip) return;
      guardPaintStep('home.dashboard_info_strip_failed', () => {
        infoStripRenderer.render(homeInfoStrip, { state });
        // The page menu joins the ask pill INSIDE the built-once region,
        // so the chrome repaint above never touches a live draft.
        const askRegion = homeInfoStrip.querySelector?.('.home-info-strip__ask');
        if (askRegion && pageMenuController) {
          pageMenuController.ensure(askRegion);
          pageMenuController.sync();
        }
      });
    }

    function paintContext() {
      return {
        state,
        documentRef,
        slotHosts: { main: homeDashboardGrid, rail: homeDashboardRail || homeDashboardGrid },
        infoStripEl: homeInfoStrip,
        widgetsConfig: asObject(state.homeConfig?.widgets) || null,
        editMode: isEditMode(),
        buildEditToolbar,
      };
    }

    function repaintIfHomeActive() {
      if (!fence.isDisposed() && isHomeActive()) {
        paint();
      }
    }

    // A pad autosave echo touches no other card: repaint just the pad (full paint when absent).
    function repaintScratchpadIfHomeActive() {
      if (fence.isDisposed() || !isHomeActive()) return;
      if (!registry?.renderOne?.(homeDashboardGrid, 'scratchpad', paintContext())) {
        paint();
      }
    }

    let primeFailed = false;
    async function refreshDashboardState() {
      if (fence.isDisposed()) return state;
      primeFailed = false;
      const sources = [
        ['scheduler', () => shell?.scheduler?.getState?.(), applySchedulerPayload],
        ['home_config', () => shell?.home?.getConfig?.(), applyHomeConfigPayload],
        ['reminders', () => shell?.proactive?.getState?.(), applyProactivePayload],
        ['calendar', () => shell?.calendar?.getState?.(), applyCalendarPayload],
        ['home_ai_journal', () => shell?.home?.getAiJournal?.(), (payload) => applyHomeAiPayload({ journal: payload })],
      ];
      await Promise.all(sources.map(async ([sourceId, read, apply]) => {
        try {
          const payload = await read();
          if (fence.isDisposed()) return;
          if (payload) {
            apply(payload);
          }
        } catch (error) {
          if (fence.isDisposed()) return;
          primeFailed = true;
          appendClientLog('WARN', 'home.dashboard_refresh_failed', {
            source: sourceId,
            message: String(error?.message || error || ''),
          });
        }
      }));
      return state;
    }

    // The clock, the next-event digest, the greeting, the date and the
    // calendar's now-line and "in 35m" labels all move with the minute and
    // nothing else, so the tick repaints once per new minute while Home is
    // visible (render keys keep unchanged cards cheap) and is idle otherwise.
    let lastTickMinute = null;
    function repaintOnMinuteTick() {
      if (fence.isDisposed() || !isHomeActive() || documentRef?.visibilityState === 'hidden') {
        return;
      }
      const now = typeof deps.nowProvider === 'function' ? deps.nowProvider() : new Date();
      const minute = Math.floor(now.getTime() / 60000);
      if (minute === lastTickMinute) return;
      lastTickMinute = minute;
      paint();
    }

    function track(unsubscribe) {
      if (typeof unsubscribe === 'function') {
        unsubscribes.push(unsubscribe);
      }
    }

    // Scratchpad "Send to chat": append below any existing composer draft
    // (collecting snippets is a feature), navigate to chat, focus — never
    // auto-send. Mirrors the IDE send-to-Jenny prefill, minus session creation.
    // allowEmpty is the ask pill's "just take me to chat" path: same navigate +
    // focus + renderAll semantics, no composer write.
    function sendScratchpadToChat(text, options = {}) {
      const body = String(text || '');
      if (!body.trim() && options.allowEmpty !== true) {
        return false;
      }
      const chatInput = documentRef?.getElementById?.('chatInput');
      if (!chatInput) {
        return false;
      }
      if (body.trim()) {
        const existing = String(chatInput.value || '');
        chatInput.value = existing.trim()
          ? `${existing.replace(/\s+$/, '')}\n\n${body}`
          : body;
        try {
          // The DOCUMENT's own view first: node's global Event is a different
          // realm's constructor and JSDOM refuses to dispatch it, so the
          // composer's resize/persist listeners would never hear this.
          const EventCtor = documentRef?.defaultView?.Event
            || windowRef.Event
            || (typeof Event !== 'undefined' ? Event : null);
          if (EventCtor) {
            chatInput.dispatchEvent(new EventCtor('input', { bubbles: true }));
          }
        } catch (_error) {
          // Event construction is best-effort; the value is already set.
        }
      }
      setActiveView('chat');
      try {
        chatInput.focus();
      } catch (_error) {
        // focus is best-effort.
      }
      renderAll();
      return true;
    }

    // Optimistic flip (instant dim), then persist. A refused write restores the
    // prior mode; only the latest toggle's echo may land, so a slow first echo
    // cannot undo a second flip.
    let focusToggleSeq = 0;
    function toggleFocusMode() {
      const previous = state.homeConfig?.focusMode === true;
      const seq = ++focusToggleSeq;
      state.homeConfig = { ...(asObject(state.homeConfig) || {}), focusMode: !previous };
      paint();
      persistHomeConfig({ focusMode: !previous }, 'home.focus_mode_persist_failed', {
        isCurrent: () => seq === focusToggleSeq,
        onFailure: () => { state.homeConfig = { ...(asObject(state.homeConfig) || {}), focusMode: previous }; },
      });
    }

    // Writes a home config patch and adopts the echo, repainting only when the
    // echo changed what is on screen.
    function persistHomeConfig(patch, logEvent, { isCurrent = () => true, onFailure = noop } = {}) {
      const updateConfig = shell?.home?.updateConfig;
      if (typeof updateConfig !== 'function') {
        return;
      }
      Promise.resolve(updateConfig(patch))
        .then((config) => {
          if (!config || !isCurrent()) return;
          const before = JSON.stringify(state.homeConfig);
          applyHomeConfigPayload(config);
          if (JSON.stringify(state.homeConfig) !== before) repaintIfHomeActive();
        })
        .catch((error) => {
          appendClientLog('WARN', logEvent, { message: String(error?.message || error || '') });
          if (!isCurrent()) return;
          onFailure();
          repaintIfHomeActive();
        });
    }

    function isEditableTarget(target) {
      const tag = String(target?.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select'
        || target?.isContentEditable === true;
    }

    function handleFocusHotkey(event) {
      // Auto-repeat of a held chord would flip (and persist) once per repeat.
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.repeat) {
        return;
      }
      if (String(event.key || '').toLowerCase() !== 'f') {
        return;
      }
      if (!isHomeActive() || isEditableTarget(event.target)) {
        return;
      }
      event.preventDefault();
      toggleFocusMode();
    }

    function handleStripClick(event) {
      if (event?.target?.closest?.('[data-dashboard-focus-toggle]')) {
        toggleFocusMode();
        return;
      }
      if (event?.target?.closest?.('[data-dashboard-edit-toggle]')) {
        if (!asObject(state.ui)) {
          state.ui = {};
        }
        state.ui.dashboardEditMode = state.ui.dashboardEditMode !== true;
        paint();
      }
    }

    function persistWidgetsConfig(patch) {
      persistHomeConfig({ widgets: patch }, 'home.widget_layout_persist_failed');
    }

    function handleWidgetEdit(action, widgetId) {
      const widgets = asObject(state.homeConfig?.widgets) || { order: [], hidden: [] };
      const hidden = Array.isArray(widgets.hidden) ? [...widgets.hidden] : [];
      if (action === 'hide') {
        if (!hidden.includes(widgetId)) {
          hidden.push(widgetId);
        }
        persistWidgetsConfig({ hidden });
        return;
      }
      if (action === 'show') {
        persistWidgetsConfig({ hidden: hidden.filter((id) => id !== widgetId) });
        return;
      }
      if (action !== 'up' && action !== 'down') {
        return;
      }
      // Swap with the nearest visible card in the SAME column (the rail and the
      // main grid are separate hosts), then persist the full order including
      // hidden ids, so a restored card returns to its old place.
      const hostOf = (id) => (registry?.list?.().find((entry) => entry.id === id)?.slot === 'rail'
        ? homeDashboardRail || homeDashboardGrid
        : homeDashboardGrid);
      const visible = registry?.listRenderableIds?.({ state, widgetsConfig: widgets }) || [];
      const peers = visible.filter((id) => hostOf(id) === hostOf(widgetId));
      const index = peers.indexOf(widgetId);
      const target = peers[action === 'up' ? index - 1 : index + 1];
      if (index === -1 || !target) {
        return;
      }
      const order = registry.listRenderableIds({ state, widgetsConfig: { ...widgets, hidden: [] } });
      const from = order.indexOf(widgetId);
      const to = order.indexOf(target);
      [order[from], order[to]] = [order[to], order[from]];
      persistWidgetsConfig({ order });
    }

    function handleGridClick(event) {
      const editTrigger = event?.target?.closest?.('[data-widget-edit]');
      if (editTrigger) {
        handleWidgetEdit(editTrigger.dataset.widgetEdit, String(editTrigger.dataset.widgetId || ''));
      }
    }

    function bind() {
      if (bound || fence.isDisposed()) {
        return;
      }
      bound = true;
      if (homeDashboardGrid && !gridClickHandler) {
        gridClickHandler = handleGridClick;
        homeDashboardGrid.addEventListener('click', gridClickHandler);
      }
      if (homeInfoStrip && !stripClickHandler) {
        stripClickHandler = handleStripClick;
        homeInfoStrip.addEventListener('click', stripClickHandler);
      }
      const keyTarget = documentRef?.defaultView || windowRef;
      if (keyTarget?.addEventListener && !focusHotkeyHandler) {
        focusHotkeyHandler = handleFocusHotkey;
        keyTarget.addEventListener('keydown', focusHotkeyHandler);
      }
      // Flush the scratchpad's pending debounced save before the window closes
      // or is hidden, so the last <600ms of typing is never lost on a hard exit.
      if (keyTarget?.addEventListener && !lifecycleFlushHandler) {
        lifecycleFlushHandler = () => { scratchpadActions?.flushSave?.(); };
        keyTarget.addEventListener('beforeunload', lifecycleFlushHandler);
      }
      if (documentRef?.addEventListener && !visibilityFlushHandler) {
        visibilityFlushHandler = () => {
          if (documentRef.visibilityState === 'hidden') {
            scratchpadActions?.flushSave?.();
          }
        };
        documentRef.addEventListener('visibilitychange', visibilityFlushHandler);
      }
      // Only the info-strip digest reads the scheduler slice, and its "in 5m"
      // etas move every minute: repaint the strip, not every widget.
      track(shell?.scheduler?.onChanged?.((payload) => {
        applySchedulerPayload(payload);
        if (!fence.isDisposed() && isHomeActive()) paintInfoStrip();
      }));
      track(shell?.calendar?.onChanged?.((payload) => {
        if (applyCalendarChange(payload)) repaintIfHomeActive();
      }));
      // The ONLY push channel reminders have: entity pushes ride calendar.onChanged,
      // but a reminder Jenny adds reaches Home over this event alone.
      track(shell?.home?.onAiChanged?.(applyHomeAiPayload));
      if (infoStripRenderer && homeInfoStrip && !clockUpdateTimer) {
        clockUpdateTimer = setIntervalImpl(repaintOnMinuteTick, CLOCK_REPAINT_INTERVAL_MS);
        if (typeof clockUpdateTimer?.unref === 'function') {
          clockUpdateTimer.unref();
        }
      }
    }

    function render() {
      if (fence.isDisposed()) return null;
      if (!primeStarted) {
        primeStarted = true;
        refreshDashboardState().then(() => {
          // A failed source (main busy at boot) re-primes on the next render
          // instead of leaving the seeded placeholders up until a push.
          if (primeFailed) primeStarted = false;
          repaintIfHomeActive();
        }).catch(noop);
      }
      return paint();
    }

    async function dispose() {
      if (!fence.dispose()) return;
      awayDigestWidget?.dispose?.();
      if (ownsAwayDigestReader) {
        awayDigestReader?.dispose?.();
        if (state.awayDigestReader === awayDigestReader) state.awayDigestReader = null;
      }
      // Start the scratchpad's final flush first — it clears its own save timer
      // synchronously and hands back the write promise — then tear the rest
      // down while that write is in flight and await it at the end, so a caller
      // that can wait sees the last <600ms of typing land before teardown ends.
      scratchpadWidget?.dispose?.();
      const scratchpadFlush = scratchpadActions?.dispose?.();
      for (const unsubscribe of unsubscribes.splice(0)) {
        try {
          unsubscribe();
        } catch (_error) {
          // Best-effort unsubscribe only.
        }
      }
      if (clockUpdateTimer) {
        clearIntervalImpl(clockUpdateTimer);
        clockUpdateTimer = null;
      }
      if (gridClickHandler && homeDashboardGrid) {
        homeDashboardGrid.removeEventListener('click', gridClickHandler);
        gridClickHandler = null;
      }
      if (stripClickHandler && homeInfoStrip) {
        homeInfoStrip.removeEventListener('click', stripClickHandler);
        stripClickHandler = null;
      }
      daybookController?.dispose?.();
      pageMenuController?.dispose?.();
      if (focusHotkeyHandler) {
        const keyTarget = documentRef?.defaultView || windowRef;
        keyTarget?.removeEventListener?.('keydown', focusHotkeyHandler);
        focusHotkeyHandler = null;
      }
      if (lifecycleFlushHandler) {
        const keyTarget = documentRef?.defaultView || windowRef;
        keyTarget?.removeEventListener?.('beforeunload', lifecycleFlushHandler);
        lifecycleFlushHandler = null;
      }
      if (visibilityFlushHandler) {
        documentRef?.removeEventListener?.('visibilitychange', visibilityFlushHandler);
        visibilityFlushHandler = null;
      }
      bound = false;
      try {
        await scratchpadFlush;
      } catch (_error) {
        // The scratchpad write logs its own failures; teardown never rejects.
      }
    }

    return {
      bind,
      render,
      refreshDashboardState,
      registry,
      // Reachable for the Daybook agenda wave, which becomes their only caller.
      reminderActions,
      dispose,
    };
  }

  return { createDashboardManager, pinnedNotesKey };
});
