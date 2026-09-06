/* Home dashboard orchestrator (parallel to the companion manager). Owns the
 * #homeDashboardGrid widget registry, seeds the dashboard state slices
 * (scheduler / weather / homeConfig), primes them over the shell
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

  function updatedReminderMatches(requested, echoed, prior) {
    if (!asObject(echoed) || !String(echoed.id || '')) return false;
    if (String(requested?.id || '') && String(echoed.id || '') !== String(requested.id)) return false;
    if (String(echoed.label || '') !== String(requested?.label || '')) return false;
    if (String(echoed.prompt || '') !== String(requested?.prompt || '')) return false;
    if ((echoed.enabled !== false) !== (requested?.enabled !== false)) return false;
    if (prior || Object.prototype.hasOwnProperty.call(requested || {}, 'createdAt')) {
      return String(echoed.createdAt || '') === String((requested?.createdAt ?? prior?.createdAt) || '');
    }
    return typeof echoed.createdAt === 'string';
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
      // Ask-pill mini-composer seams. handleCreateSession is the shell's real
      // create path (options.preferences carries the pill's draft); the send
      // trigger defaults to the composer's own send control so a Home ask goes
      // out through exactly the code path the composer uses.
      handleCreateSession = null,
      getRuntimePreferences = null,
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
    const askConfigModule = deps.modules?.dashboardAskConfig || windowRef.rendererDashboardAskConfig || null;
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

    // The ask pill's mini-composer draft (model / effort / tools). Renderer
    // local and never persisted; the manager applies it exactly once, to the
    // session an ask starts.
    const askConfigController = askConfigModule?.createAskConfigController?.({
      documentRef,
      shell,
      getState: () => state,
      getRuntimePreferences: typeof getRuntimePreferences === 'function'
        ? getRuntimePreferences
        : undefined,
      appendClientLog,
      inventory: deps.inventory,
      modules: deps.modules,
    }) || null;
    const askLauncher = askConfigModule?.createAskLauncher?.({
      documentRef,
      appendClientLog,
      askConfig: askConfigController,
      handleCreateSession,
      getCurrentSessionId: () => state.currentSessionId,
      setSessionToolOverrides: (sessionId, overrides) => Promise.resolve(
        shell?.sessions?.setPreferences?.(sessionId, { tool_category_overrides: overrides })
      ),
      prefillComposer: (text) => sendScratchpadToChat(text),
      navigateOnly: () => sendScratchpadToChat('', { allowEmpty: true }),
    }) || null;

    // Enter on the pill starts a configured chat; without the launcher module
    // it degrades to prefill-and-navigate behaviour.
    function startAskFromPill(text, options) {
      return askLauncher
        ? askLauncher.startAsk(text, options)
        : sendScratchpadToChat(text, { allowEmpty: true });
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
    const unsubscribes = [];

    // Reminder persistence, kept live after the reminders widget was cut from
    // Home: the Daybook agenda consumes these next to own reminder CRUD.
    const reminderActions = {
      upsert: async (reminder) => {
        const priorReminders = Array.isArray(state.proactive?.reminders)
          ? state.proactive.reminders.slice()
          : [];
        const payload = await shell?.proactive?.upsertReminder?.(reminder);
        const reminders = asObject(payload)?.proactive?.reminders;
        const expectedId = String(reminder?.id || '');
        const priorIds = new Set(priorReminders.map((entry) => String(entry?.id || '')));
        const priorTarget = priorReminders.find((entry) => String(entry?.id || '') === expectedId);
        const echoedById = uniqueReminderIndex(reminders);
        const newIds = echoedById
          ? [...echoedById.keys()].filter((id) => !priorIds.has(id))
          : [];
        const echoedTargetId = expectedId || (newIds.length === 1 ? newIds[0] : '');
        const echoed = echoedById?.get(echoedTargetId);
        const expectedCount = priorReminders.length + (priorTarget ? 0 : 1);
        const unaffectedPreserved = priorReminders
          .filter((entry) => String(entry?.id || '') !== echoedTargetId)
          .every((entry) => reminderFieldsMatch(entry, echoedById?.get(String(entry?.id || ''))));
        if (
          !echoedById
          || echoedById.size !== expectedCount
          || newIds.length !== (priorTarget ? 0 : 1)
          || !updatedReminderMatches(reminder, echoed, priorTarget)
          || !unaffectedPreserved
        ) {
          throw new Error('Reminder persistence acknowledgement did not match the requested change.');
        }
        applyProactivePayload(payload);
        await refreshCompanionPayload();
        repaintIfHomeActive();
        return payload;
      },
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
        await refreshCompanionPayload();
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
              // When a pin is (or was) involved, also drive a full renderAll so
              // the body-level sticky-note overlay (outside the dashboard repaint
              // scope) refreshes via the renderPinnedNotes chrome hook. Gated on
              // pin presence so the common no-pins autosave echo pays nothing.
              const prevPins = (state.homeConfig?.scratchpad?.pins || []).length;
              applyHomeConfigPayload(payload);
              repaintIfHomeActive();
              const nextPins = (state.homeConfig?.scratchpad?.pins || []).length;
              if (prevPins > 0 || nextPins > 0) {
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
            applyCalendarPayload(payload);
            repaintIfHomeActive();
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
        loopsModule?.createOpenLoopsWidget?.(),
      ].filter(Boolean);
      for (const widget of defaultWidgets) {
        registry.register(widget);
      }
    }

    function seedDashboardState() {
      if (!asObject(state.scheduler)) {
        state.scheduler = { upcoming: [], running: [], generatedAt: '', relevant: false, lifecycle: null };
      }
      if (!asObject(state.weather)) {
        state.weather = {
          available: false,
          configured: false,
          tempC: null,
          tempF: null,
          code: null,
          description: '',
          isDay: null,
          lat: null,
          lon: null,
          units: 'metric',
          fetchedAt: '',
          error: '',
        };
      }
      if (!asObject(state.homeConfig)) {
        state.homeConfig = {
          links: [],
          weather: { lat: null, lon: null, units: 'metric' },
          widgets: { order: [], hidden: [] },
          scratchpad: {
            notes: [{ id: 'note-1', title: 'Note 1', text: '', updatedAt: '', appendLog: false }],
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

    function applyWeatherPayload(payload) {
      const source = asObject(payload);
      if (!source) {
        return state.weather;
      }
      state.weather = { ...state.weather, ...source };
      return state.weather;
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

    function applyHomeConfigPayload(payload) {
      const source = asObject(payload);
      const scratchpad = asObject(source?.scratchpad);
      if (
        !source
        || !Array.isArray(source.links)
        || !asObject(source.weather)
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
        weather: source.weather,
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
          ariaLabel: `Move ${name} earlier`,
          title: `Move ${name} earlier`,
          dataset: { 'widget-edit': 'up', 'widget-id': widget.id },
        })
        + actionButton({
          plain: true, className: 'dashboard-card__edit-btn', label: '↓',
          ariaLabel: `Move ${name} later`,
          title: `Move ${name} later`,
          dataset: { 'widget-edit': 'down', 'widget-id': widget.id },
        })
        + actionButton({
          plain: true, className: 'dashboard-card__edit-btn', label: 'Hide',
          ariaLabel: `Hide ${name}`,
          title: `Hide ${name}`,
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
      strip.innerHTML = '<span class="dashboard-hidden-strip__label">Hidden:</span>'
        + entries.map((id) => actionButton({
          plain: true, className: 'dashboard-card__edit-btn',
          label: `Show ${known.get(id).title || id}`,
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
      daybookController?.syncFromConfig?.();
      if (infoStripRenderer && homeInfoStrip) {
        try {
          infoStripRenderer.render(homeInfoStrip, { state });
          // The config chip joins the ask pill INSIDE the built-once region,
          // so the 30s chrome repaint above never touches a live draft.
          const askRegion = homeInfoStrip.querySelector?.('.home-info-strip__ask');
          if (askRegion && askConfigController) {
            askConfigController.ensure(askRegion);
            askConfigController.sync();
          }
          if (askRegion && pageMenuController) {
            pageMenuController.ensure(askRegion);
            pageMenuController.sync();
          }
        } catch (error) {
          appendClientLog('WARN', 'home.dashboard_info_strip_failed', {
            message: String(error?.message || error || ''),
          });
        }
      }
      renderHiddenStrip();
      return registry.renderInto(homeDashboardGrid, {
        state,
        documentRef,
        slotHosts: { main: homeDashboardGrid, rail: homeDashboardRail || homeDashboardGrid },
        infoStripEl: homeInfoStrip,
        widgetsConfig: asObject(state.homeConfig?.widgets) || null,
        editMode: isEditMode(),
        buildEditToolbar,
      });
    }

    function repaintIfHomeActive() {
      if (!fence.isDisposed() && isHomeActive()) {
        paint();
      }
    }

    async function refreshDashboardState() {
      if (fence.isDisposed()) return state;
      const sources = [
        ['scheduler', () => shell?.scheduler?.getState?.(), applySchedulerPayload],
        ['weather', () => shell?.weather?.getState?.(), applyWeatherPayload],
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
          appendClientLog('WARN', 'home.dashboard_refresh_failed', {
            source: sourceId,
            message: String(error?.message || error || ''),
          });
        }
      }));
      return state;
    }

    function updateClockIfHomeActive() {
      if (!isHomeActive()) {
        return;
      }
      const clockNode = homeInfoStrip?.querySelector?.('.home-info-strip__time');
      if (!clockNode || typeof widgetsCoreModule?.formatClockTime !== 'function') {
        return;
      }
      const now = typeof deps.nowProvider === 'function' ? deps.nowProvider() : new Date();
      clockNode.textContent = widgetsCoreModule.formatClockTime(now);
    }

    function track(unsubscribe) {
      if (typeof unsubscribe === 'function') {
        unsubscribes.push(unsubscribe);
      }
    }

    async function handleDashboardAction(action, dataset) {
      if (action === 'continue-session' && dataset?.sessionId) {
        clearPendingOrigin();
        if (typeof activateWorkspaceSession === 'function') {
          await activateWorkspaceSession(dataset.sessionId);
        }
        setActiveView('chat');
        renderAll();
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

    // Optimistic flip (instant dim), then persist; the echoed config corrects
    // state if the write was rejected.
    function toggleFocusMode() {
      const next = state.homeConfig?.focusMode !== true;
      state.homeConfig = { ...(asObject(state.homeConfig) || {}), focusMode: next };
      paint();
      const updateConfig = shell?.home?.updateConfig;
      if (typeof updateConfig === 'function') {
        Promise.resolve(updateConfig({ focusMode: next }))
          .then((config) => {
            if (config) {
              applyHomeConfigPayload(config);
              repaintIfHomeActive();
            }
          })
          .catch((error) => {
            appendClientLog('WARN', 'home.focus_mode_persist_failed', {
              message: String(error?.message || error || ''),
            });
          });
      }
    }

    function isEditableTarget(target) {
      const tag = String(target?.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select'
        || target?.isContentEditable === true;
    }

    function handleFocusHotkey(event) {
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) {
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
      const updateConfig = shell?.home?.updateConfig;
      if (typeof updateConfig !== 'function') {
        return;
      }
      Promise.resolve(updateConfig({ widgets: patch }))
        .then((config) => {
          if (config) {
            applyHomeConfigPayload(config);
            repaintIfHomeActive();
          }
        })
        .catch((error) => {
          appendClientLog('WARN', 'home.widget_layout_persist_failed', {
            message: String(error?.message || error || ''),
          });
        });
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
      // Reorder over the currently visible sequence and persist the FULL
      // sequence as the explicit order — what you see is what gets saved.
      const sequence = registry?.listRenderableIds?.({
        state,
        widgetsConfig: widgets,
      }) || [];
      const index = sequence.indexOf(widgetId);
      const swapWith = action === 'up' ? index - 1 : index + 1;
      if (index === -1 || swapWith < 0 || swapWith >= sequence.length) {
        return;
      }
      const next = [...sequence];
      [next[index], next[swapWith]] = [next[swapWith], next[index]];
      persistWidgetsConfig({ order: next });
    }

    function handleGridClick(event) {
      const editTrigger = event?.target?.closest?.('[data-widget-edit]');
      if (editTrigger) {
        handleWidgetEdit(editTrigger.dataset.widgetEdit, String(editTrigger.dataset.widgetId || ''));
        return;
      }
      const trigger = event?.target?.closest?.('[data-dashboard-action]');
      if (!trigger || !homeDashboardGrid?.contains(trigger)) {
        return;
      }
      handleDashboardAction(trigger.dataset.dashboardAction, trigger.dataset)
        .catch((error) => {
          appendClientLog('WARN', 'home.dashboard_action_failed', {
            action: String(trigger.dataset.dashboardAction || ''),
            message: String(error?.message || error || ''),
          });
        });
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
      track(shell?.scheduler?.onChanged?.((payload) => {
        applySchedulerPayload(payload);
        repaintIfHomeActive();
      }));
      track(shell?.weather?.onChanged?.((payload) => {
        applyWeatherPayload(payload);
        repaintIfHomeActive();
      }));
      track(shell?.calendar?.onChanged?.((payload) => {
        applyCalendarPayload(payload);
        repaintIfHomeActive();
      }));
      // The ONLY push channel reminders have: entity pushes ride calendar.onChanged,
      // but a reminder Jenny adds reaches Home over this event alone.
      track(shell?.home?.onAiChanged?.(applyHomeAiPayload));
      // Keep only the clock text honest; the other Home chrome and registered
      // widgets do not depend on this 30-second tick.
      if (infoStripRenderer && homeInfoStrip && !clockUpdateTimer) {
        clockUpdateTimer = setIntervalImpl(updateClockIfHomeActive, CLOCK_REPAINT_INTERVAL_MS);
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
          repaintIfHomeActive();
        }).catch(noop);
      }
      return paint();
    }

    async function dispose() {
      if (!fence.dispose()) return;
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
      askConfigController?.dispose?.();
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

  return { createDashboardManager };
});
