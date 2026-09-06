/* Calendar widget controller for the Home dashboard: owns week navigation,
 * the inline create/edit form lifecycle, and calendar IPC mutations. Markup
 * comes from the grid/form modules; the manager wires shell + snapshot
 * application in via deps. Rebuilds are keyed so steady-state repaints (the
 * 30s clock tick) never wipe in-progress typing or the user's scroll
 * position — the now-line updates imperatively on the skip path.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardCalendar = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};

  const DEFAULT_SCROLL_TOP_PX = 7 * 60; // first build lands at 07:00

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  // "HH:MM" + minutes -> "HH:MM" (wraps within a day). Used to slide an event's
  // end forward when the user moves start past it.
  function addMinutesToHHMM(hhmm, minutes) {
    const match = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!match) {
      return hhmm;
    }
    const total = ((Number(match[1]) * 60 + Number(match[2]) + minutes) % 1440 + 1440) % 1440;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  function createCalendarWidget(deps = {}) {
    const gridModule = deps.gridModule || windowRef.rendererDashboardCalendarGrid || null;
    const formModule = deps.formModule || windowRef.rendererDashboardCalendarForm || null;
    const agendaModule = deps.agendaModule || windowRef.rendererDashboardCalendarAgenda || null;
    const monthModule = deps.monthModule || windowRef.rendererDashboardCalendarMonth || null;
    const toolbarModule = deps.toolbarModule || windowRef.rendererDashboardCalendarToolbar || null;
    const runtimeModule = deps.runtimeModule || windowRef.rendererDashboardCalendarRuntime || null;
    const railModule = deps.railModule || windowRef.rendererDashboardCalendarRail || null;
    const remindersModule = deps.remindersModule || windowRef.rendererDashboardCalendarReminders || null;
    // Reminder CRUD lives on the manager (echo-verified); the agenda's Done
    // affordance is its only caller.
    const reminderActions = asObject(deps.reminderActions);
    const chip = typeof deps.chip === 'function'
      ? deps.chip
      : (typeof windowRef.inventoryChip === 'function' ? windowRef.inventoryChip : null);
    const popover = deps.popover || windowRef.inventoryPopover || null;
    const actionButton = typeof deps.actionButton === 'function'
      ? deps.actionButton
      : (typeof windowRef.inventoryActionButton === 'function' ? windowRef.inventoryActionButton : null);
    const statusRow = typeof deps.statusRow === 'function'
      ? deps.statusRow
      : (typeof windowRef.inventoryStatusRow === 'function' ? windowRef.inventoryStatusRow : null);
    const toggleModule = deps.toggleSwitch || windowRef.inventoryToggleSwitch || null;
    const formPrimitives = asObject(deps.formPrimitives) || {};
    const shell = deps.shell || windowRef.jennyShell || null;
    const onSnapshot = typeof deps.onSnapshot === 'function' ? deps.onSnapshot : null;
    const onHomeConfig = typeof deps.onHomeConfig === 'function' ? deps.onHomeConfig : null;
    const onAiPayload = typeof deps.onAiPayload === 'function' ? deps.onAiPayload : null;
    const appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : () => {};
    const nowProvider = typeof deps.nowProvider === 'function' ? deps.nowProvider : () => new Date();

    let weekOffset = 0;
    let form = null; // { values, error }
    let formSaveInFlight = false;
    let feedsOpen = false;
    let feedsError = '';
    let pendingFeeds = null;
    // View shape: 'agenda' (glanceable default), 'week' (time grid), or 'month'
    // (continuous-scroll week rows). Lazily adopted from persisted config on
    // first render, then owned locally so a toggle is optimistic; the echoed
    // config write keeps the store honest.
    let viewMode = null;
    let selectedDayKey = '';
    // Collapsible quick-add (natural-language create). quickAddPending holds a parsed
    // descriptor awaiting confirmation when its slot overlaps an existing event.
    let quickAddValue = '';
    let quickAddPending = null; // { payload, parsed, conflicts }
    let quickAddError = '';
    let quickAddExpanded = false;
    let lastBody = null;
    let lastCtx = null;
    // After an innerHTML rebuild, element references die — so focus moves and
    // live-region announcements are deferred by selector/text and applied once
    // the new DOM exists (see applyDeferredFocusAndAnnounce).
    let pendingFocusSelector = '';
    let pendingAnnounce = '';
    let formReturnFocus = '';
    let feedsReturnFocus = '';

    function readCalendarState(ctx) {
      const calendar = asObject(ctx?.state?.calendar) || {};
      return {
        instances: Array.isArray(calendar.instances) ? calendar.instances : [],
        events: Array.isArray(calendar.events) ? calendar.events : [],
        categories: Array.isArray(calendar.categories) ? calendar.categories : [],
        feeds: Array.isArray(calendar.feeds) ? calendar.feeds : [],
      };
    }

    // The canonical feed CONFIG (with URLs) lives in homeConfig; the calendar
    // snapshot's feeds[] carries fetch status. The panel shows both.
    function readConfiguredFeeds(ctx) {
      const feeds = ctx?.state?.homeConfig?.calendar?.feeds;
      return Array.isArray(feeds) ? feeds : [];
    }

    function readConfigViewMode(ctx) {
      const mode = ctx?.state?.homeConfig?.calendar?.viewMode;
      return mode === 'week' || mode === 'agenda' || mode === 'month' ? mode : 'agenda';
    }

    function currentViewMode(ctx) {
      if (viewMode === null) {
        viewMode = readConfigViewMode(ctx);
      }
      return viewMode;
    }

    // Persist the full calendar config object (feeds + view mode) so a partial
    // write can never drop the sibling key. onHomeConfig folds the echo back
    // into the shared state slice (wired through the manager).
    function persistViewMode(next, ctx) {
      if (!shell?.home?.updateConfig) {
        return;
      }
      const feeds = readConfiguredFeeds(ctx);
      Promise.resolve(shell.home.updateConfig({ calendar: { feeds, viewMode: next } }))
        .then((config) => {
          if (config && onHomeConfig) {
            onHomeConfig(config);
          }
        })
        .catch((error) => {
          appendClientLog('WARN', 'home.calendar_viewmode_persist_failed', {
            message: String(error?.message || error || ''),
          });
        });
    }

    function setViewMode(next, ctx) {
      if ((next !== 'agenda' && next !== 'week' && next !== 'month') || viewMode === next) {
        return;
      }
      viewMode = next;
      selectedDayKey = '';
      pendingAnnounce = { agenda: 'Agenda view', week: 'Week view', month: 'Month view' }[next] || '';
      persistViewMode(next, ctx);
      requestRender();
    }

    async function persistFeeds(nextFeeds) {
      if (!shell?.home?.updateConfig) {
        return;
      }
      pendingFeeds = nextFeeds;
      try {
        const config = await shell.home.updateConfig({ calendar: { feeds: nextFeeds } });
        feedsError = '';
        if (config && onHomeConfig) {
          onHomeConfig(config);
        }
        requestRender();
      } catch (error) {
        feedsError = String(error?.message || error || 'Could not update feeds.');
        requestRender();
      } finally {
        if (pendingFeeds === nextFeeds) pendingFeeds = null;
      }
    }

    function addFeedFromPanel(body, ctx) {
      if (!formModule) {
        return;
      }
      const values = formModule.readFeedFormValues(body);
      if (!/^https?:\/\/\S+$/i.test(values.url)) {
        feedsError = 'Feed URL must start with http(s)://';
        requestRender();
        return;
      }
      feedsError = '';
      void persistFeeds([
        ...(pendingFeeds || readConfiguredFeeds(ctx)),
        { name: values.name, url: values.url, colorId: values.colorId },
      ]);
    }

    function requestRender() {
      if (lastBody && lastCtx) {
        render(lastBody, lastCtx);
      }
    }

    async function retryLoad() {
      if (!shell?.calendar?.getState) {
        return;
      }
      try {
        const snapshot = await shell.calendar.getState();
        if (snapshot && onSnapshot) {
          onSnapshot(snapshot);
        }
      } catch (error) {
        appendClientLog('WARN', 'home.calendar_retry_failed', { message: String(error?.message || error) });
      }
      requestRender();
    }

    // restore=true queues focus back to the element that opened the form (the
    // innerHTML rebuild on the next render destroys the live focus), so closing
    // never strands focus on <body>.
    function closeForm(restore = false) {
      form = null;
      if (restore && formReturnFocus) {
        pendingFocusSelector = formReturnFocus;
      }
      formReturnFocus = '';
    }

    function closeFeeds(restore = false) {
      feedsOpen = false;
      feedsError = '';
      if (restore && feedsReturnFocus) {
        pendingFocusSelector = feedsReturnFocus;
      }
      feedsReturnFocus = '';
    }

    function getFeedsReturnFocusSelector(toggle) {
      const stableId = String(toggle?.dataset?.calFeedFocus || '');
      return /^[a-z0-9-]+$/i.test(stableId)
        ? `[data-cal-feed-focus="${stableId}"]`
        : '[data-cal-overflow-toggle]';
    }

    // Captures live typing before any rebuild so repaints can't eat input.
    function preserveFormValues(body) {
      runtimeModule?.preserveFormValues?.(body, form, formModule);
    }

    async function submitForm(body, scope = 'all') {
      if (formSaveInFlight || !form || !formModule || !shell?.calendar) {
        return;
      }
      preserveFormValues(body);
      const { payload, error } = formModule.buildEventPayload(form.values);
      if (error) {
        form.error = error;
        requestRender();
        return;
      }
      const eventId = String(form.values.id || '');
      const eventTitle = String(form.values.title || '').trim() || 'Event';
      const occurrenceStart = String(form.values.occurrenceStart || '');
      const splitOccurrence = Boolean(eventId && scope === 'occurrence' && occurrenceStart);
      formSaveInFlight = true;
      try {
        let snapshot;
        if (splitOccurrence) {
          snapshot = await shell.calendar.updateEvent(eventId, { ...payload, occurrenceStart });
        } else if (eventId) {
          snapshot = await shell.calendar.updateEvent(eventId, payload);
        } else {
          snapshot = await shell.calendar.createEvent(payload);
        }
        pendingAnnounce = eventId
          ? `${eventTitle} updated${splitOccurrence ? ' (this event)' : ''}`
          : `${eventTitle} created`;
        closeForm(true);
        if (snapshot && onSnapshot) {
          onSnapshot(snapshot);
        }
        requestRender();
      } catch (mutationError) {
        form.error = String(mutationError?.message || mutationError || 'Could not save the event.');
        requestRender();
      } finally {
        formSaveInFlight = false;
      }
    }

    async function deleteFormEvent() {
      const eventId = String(form?.values?.id || '');
      if (!eventId || !shell?.calendar) {
        return;
      }
      const eventTitle = String(form?.values?.title || '').trim() || 'Event';
      try {
        const snapshot = await shell.calendar.deleteEvent(eventId);
        pendingAnnounce = `${eventTitle} deleted`;
        closeForm(true);
        if (snapshot && onSnapshot) {
          onSnapshot(snapshot);
        }
        requestRender();
      } catch (mutationError) {
        if (form) {
          form.error = String(mutationError?.message || mutationError || 'Could not delete the event.');
        }
        requestRender();
      }
    }

    function openCreateForm(slotDate) {
      if (!formModule) {
        return;
      }
      closeFeeds();
      form = { values: formModule.buildDefaultCreateValues(nowProvider(), slotDate), error: '' };
      pendingFocusSelector = '#calFormTitle';
      requestRender();
    }

    function openEditForm(eventId, ctx, instanceId) {
      if (!formModule) {
        return;
      }
      const { events, instances } = readCalendarState(ctx);
      const event = events.find((entry) => entry.id === eventId);
      if (!event) {
        appendClientLog('WARN', 'home.calendar_edit_missing_event', { eventId });
        return;
      }
      closeFeeds();
      const values = formModule.buildEditValues(event);
      // For a recurring series opened from a specific occurrence, seed the
      // date/time from the CLICKED occurrence (not the anchor) and remember the
      // occurrence start so a "this event" save can detach exactly it.
      if (event.recurrence !== 'none' && instanceId) {
        const occurrence = instances.find((entry) => String(entry.instanceId || '') === instanceId);
        if (occurrence && !occurrence.readonly) {
          const occStart = String(occurrence.start || '');
          values.occurrenceStart = occStart;
          values.recurring = true;
          values.date = occStart.slice(0, 10) || values.date;
          values.start = occStart.slice(11, 16) || values.start;
          values.end = String(occurrence.end || '').slice(11, 16) || values.end;
        }
      }
      form = { values, error: '' };
      pendingFocusSelector = '#calFormTitle';
      requestRender();
    }

    // Seeds the create form from a parsed quick-add descriptor (the ambiguous
    // path: a title was understood but the time still needs a human choice).
    function openCreateFormFromParsed(parsed) {
      if (!formModule) {
        return;
      }
      closeFeeds();
      const base = formModule.buildDefaultCreateValues(nowProvider());
      form = {
        values: {
          ...base,
          title: String(parsed.title || ''),
          date: parsed.date || base.date,
          allDay: parsed.allDay === true,
          start: parsed.start || base.start,
          end: parsed.end || base.end,
        },
        error: '',
      };
      pendingFocusSelector = '#calFormTitle';
      requestRender();
    }

    function buildPayloadFromParsed(parsed) {
      const start = parsed.allDay ? `${parsed.date}T00:00` : `${parsed.date}T${parsed.start}`;
      const end = parsed.allDay ? `${parsed.date}T00:00` : `${parsed.date}T${parsed.end}`;
      return {
        title: String(parsed.title || ''),
        start,
        end,
        allDay: parsed.allDay === true,
        categoryId: 'default',
        recurrence: 'none',
        notes: '',
      };
    }

    async function createFromQuickAdd(payload, title) {
      if (!shell?.calendar?.createEvent) {
        return;
      }
      try {
        const snapshot = await shell.calendar.createEvent(payload);
        quickAddValue = '';
        quickAddPending = null;
        quickAddError = '';
        quickAddExpanded = false;
        // Clear the live field imperatively: when the new event lands outside
        // the visible week the render-key is unchanged, so the skip path would
        // otherwise leave the just-submitted text sitting in the input.
        const input = lastBody && lastBody.querySelector('[data-cal-quickadd-input]');
        if (input) {
          input.value = '';
        }
        pendingAnnounce = `${String(title || '').trim() || 'Event'} created`;
        if (snapshot && onSnapshot) {
          onSnapshot(snapshot);
        }
        requestRender();
      } catch (error) {
        quickAddError = String(error?.message || error || 'Could not add the event.');
        quickAddPending = null;
        requestRender();
      }
    }

    // Captures live quick-add typing before any rebuild (twin of
    // preserveFormValues for the quick-add input).
    function preserveQuickAdd(body) {
      quickAddValue = runtimeModule?.preserveQuickAdd?.(body, quickAddValue) ?? quickAddValue;
    }

    // Enter / the "Add" button: parse the phrase and either create directly,
    // open the form prefilled (ambiguous), or surface a conflict confirmation.
    function submitQuickAdd(body, ctx) {
      preserveQuickAdd(body);
      quickAddError = '';
      const text = String(quickAddValue || '').trim();
      if (!text) {
        return;
      }
      const parsed = agendaModule && typeof agendaModule.parseQuickAdd === 'function'
        ? agendaModule.parseQuickAdd(text, nowProvider())
        : null;
      if (!parsed || parsed.ok !== true) {
        quickAddError = 'Add an event title — try "Lunch tomorrow 12:30pm".';
        requestRender();
        return;
      }
      if (parsed.ambiguous === true) {
        quickAddValue = '';
        quickAddPending = null;
        openCreateFormFromParsed(parsed);
        return;
      }
      const { instances } = readCalendarState(ctx || lastCtx);
      const conflicts = agendaModule && typeof agendaModule.findConflicts === 'function'
        ? agendaModule.findConflicts(parsed, instances)
        : [];
      const payload = buildPayloadFromParsed(parsed);
      if (conflicts.length) {
        quickAddPending = { payload, parsed, conflicts };
        pendingFocusSelector = '[data-cal-quickadd-confirm]';
        requestRender();
        return;
      }
      void createFromQuickAdd(payload, parsed.title);
    }

    function clearQuickAdd() {
      quickAddPending = null;
      quickAddValue = '';
      quickAddError = '';
    }

    function slotDateFromDayClick(target, offsetY) {
      const dayKey = target?.dataset?.calDay;
      if (!dayKey || !gridModule) {
        return null;
      }
      const day = gridModule.parseLocalDateTime(`${dayKey}T00:00`);
      if (!day) {
        return null;
      }
      const minutes = Number.isFinite(offsetY)
        ? Math.max(0, Math.min(1439, Math.floor(offsetY / 30) * 30))
        : 9 * 60;
      return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
    }

    function handleClick(event, body, ctx) {
      const overflowToggle = event.target?.closest?.('[data-cal-overflow-toggle]');
      if (overflowToggle && popover) {
        const popId = overflowToggle.getAttribute('aria-controls');
        const popEl = popId ? body.querySelector(`[id="${popId}"]`) : null;
        if (popEl) {
          popover.toggle(popEl, { trigger: overflowToggle, restoreFocus: true });
        }
        return;
      }
      const feedsToggle = event.target?.closest?.('[data-cal-feeds-toggle]');
      if (feedsToggle) {
        preserveFormValues(body);
        if (feedsOpen) {
          closeFeeds(true);
        } else {
          feedsReturnFocus = getFeedsReturnFocusSelector(feedsToggle);
          feedsOpen = true;
          feedsError = '';
          closeForm(); // the panels are mutually exclusive
          pendingFocusSelector = '[data-cal-feeds-close]';
        }
        requestRender();
        return;
      }
      if (event.target?.closest?.('[data-cal-feeds-close]')) {
        closeFeeds(true);
        requestRender();
        return;
      }
      const feedRemove = event.target?.closest?.('[data-cal-feed-remove]');
      if (feedRemove) {
        const feedId = String(feedRemove.dataset.calFeedRemove || '');
        void persistFeeds((pendingFeeds || readConfiguredFeeds(ctx)).filter((feed) => feed.id !== feedId));
        return;
      }
      if (event.target?.closest?.('[data-cal-feed-add]')) {
        addFeedFromPanel(body, ctx);
        return;
      }
      const formAction = event.target?.closest?.('[data-cal-form-action]');
      if (formAction) {
        const action = formAction.dataset.calFormAction;
        if (action === 'save') {
          void submitForm(body, 'all');
        } else if (action === 'save-occurrence') {
          void submitForm(body, 'occurrence');
        } else if (action === 'cancel') {
          closeForm(true);
          requestRender();
        } else if (action === 'delete') {
          void deleteFormEvent();
        }
        return;
      }
      if (event.target?.closest?.('[data-cal-retry]')) {
        void retryLoad();
        return;
      }
      const viewToggle = event.target?.closest?.('[data-cal-view]');
      if (viewToggle) {
        preserveFormValues(body);
        preserveQuickAdd(body);
        setViewMode(viewToggle.dataset.calView, ctx);
        return;
      }
      if (event.target?.closest?.('[data-cal-quickadd-expand]')) {
        quickAddExpanded = true;
        pendingFocusSelector = '[data-cal-quickadd-input]';
        requestRender();
        return;
      }
      if (event.target?.closest?.('[data-cal-quickadd-add]')) {
        submitQuickAdd(body, ctx);
        return;
      }
      if (event.target?.closest?.('[data-cal-quickadd-confirm]')) {
        if (quickAddPending) {
          const { payload, parsed } = quickAddPending;
          void createFromQuickAdd(payload, parsed.title);
        }
        return;
      }
      if (event.target?.closest?.('[data-cal-quickadd-edit]')) {
        if (quickAddPending) {
          const { parsed } = quickAddPending;
          clearQuickAdd();
          openCreateFormFromParsed(parsed);
        }
        return;
      }
      if (event.target?.closest?.('[data-cal-quickadd-dismiss]')) {
        clearQuickAdd();
        requestRender();
        return;
      }
      // The undo lifecycle (IPC, snapshot application, inline refusal note) is
      // owned by the runtime module; this dispatch only yields to it.
      if (runtimeModule?.handleUndoJournalClick?.(event, {
        shell, appendClientLog, onSnapshot, onAiPayload, onApplied: requestRender,
      })) { return; }
      const reminderDismiss = event.target?.closest?.('[data-cal-reminder-dismiss]');
      if (reminderDismiss) {
        const reminderId = String(reminderDismiss.dataset.calReminderDismiss || '');
        if (reminderId && typeof reminderActions?.remove === 'function') {
          Promise.resolve(reminderActions.remove(reminderId)).catch((error) => {
            appendClientLog('WARN', 'home.calendar_reminder_dismiss_failed', {
              message: String(error?.message || error || ''),
            });
          });
        }
        return;
      }
      const dayCell = event.target?.closest?.('[data-cal-day-cell]');
      if (dayCell) {
        preserveFormValues(body);
        preserveQuickAdd(body);
        selectedDayKey = String(dayCell.dataset.calDayCell || '');
        const selectedDay = gridModule.parseLocalDateTime(`${selectedDayKey}T00:00`);
        if (selectedDay && typeof gridModule.computeWeekOffsetForDate === 'function') {
          weekOffset = gridModule.computeWeekOffsetForDate(nowProvider(), selectedDay);
          pendingFocusSelector = `[data-cal-day-cell="${selectedDayKey}"]`;
          pendingAnnounce = `Week of ${gridModule.formatWeekRangeLabel(gridModule.computeWeekStart(selectedDay, 0))}`;
        }
        requestRender();
        return;
      }
      const railNav = event.target?.closest?.('[data-cal-rail-nav]');
      if (railNav) {
        preserveFormValues(body);
        preserveQuickAdd(body);
        const visibleWeek = gridModule.computeWeekStart(nowProvider(), weekOffset);
        const anchor = gridModule.listWeekDays(visibleWeek)[3];
        const delta = railNav.dataset.calRailNav === 'next' ? 1 : -1;
        const targetMonth = new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1);
        weekOffset = gridModule.computeWeekOffsetForDate(nowProvider(), targetMonth);
        pendingFocusSelector = `[data-cal-rail-nav="${railNav.dataset.calRailNav}"]`;
        pendingAnnounce = targetMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
        requestRender();
        return;
      }
      const nav = event.target?.closest?.('[data-cal-nav]');
      if (nav) {
        const direction = nav.dataset.calNav;
        // Month mode is a continuous scroll, not paginated weeks: the chevrons
        // scroll the canvas and Today re-anchors — no data change, no rebuild.
        if (currentViewMode(ctx) === 'month' && monthModule) {
          monthModule.navScroll(body.querySelector('[data-cal-scroll]'), direction);
          return;
        }
        preserveFormValues(body);
        weekOffset = direction === 'today' ? 0 : weekOffset + (direction === 'next' ? 1 : -1);
        const weekStart = gridModule.computeWeekStart(nowProvider(), weekOffset);
        pendingAnnounce = `Week of ${gridModule.formatWeekRangeLabel(weekStart)}`;
        requestRender();
        return;
      }
      if (event.target?.closest?.('[data-cal-new-event]')) {
        formReturnFocus = '[data-cal-new-event]';
        openCreateForm(null);
        return;
      }
      const instanceButton = event.target?.closest?.('[data-cal-instance]');
      if (instanceButton) {
        if (instanceButton.dataset.calReadonly === '1') {
          return; // feed events are read-only in v1
        }
        const eventId = String(instanceButton.dataset.calEventId || '');
        const instanceId = String(instanceButton.dataset.calInstanceId || '').replace(/"/g, '');
        if (eventId) {
          formReturnFocus = instanceId ? `[data-cal-instance-id="${instanceId}"]` : '';
          openEditForm(eventId, ctx, instanceId);
        }
        return;
      }
      // "+N more" in the month or all-day grid opens that day's overflow popover. The
      // popover is inline; this body listener fires BEFORE the global document
      // click-away (inventory/index.js), so opening here isn't undone in the
      // same click (the chip is registered as the popover's trigger).
      const moreChip = event.target?.closest?.('.cal-month__more, .cal-week__allday-more');
      if (moreChip && popover) {
        const popId = moreChip.getAttribute('aria-controls');
        const popEl = popId ? body.querySelector(`[id="${popId}"]`) : null;
        if (popEl) {
          popover.toggle(popEl, { trigger: moreChip });
        }
        return;
      }
      // A click on empty day-column space creates an event at that slot.
      if (event.target?.classList?.contains('cal-week__day')) {
        const slot = slotDateFromDayClick(event.target, event.offsetY);
        if (slot) {
          openCreateForm(slot);
        }
        return;
      }
      // A click on empty month-cell space creates an event at 09:00 that day.
      const monthDay = event.target?.closest?.('[data-cal-month-day]');
      if (monthDay && monthModule) {
        const slot = monthModule.slotFromDay(monthDay.dataset.calMonthDay);
        if (slot) {
          openCreateForm(slot);
        }
      }
    }

    function isEditableTarget(target) {
      if (!target) {
        return false;
      }
      const tag = String(target.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable === true;
    }

    // Widget-scoped shortcuts (keydown on the body, not document, so they only
    // fire when focus is inside the calendar). 'n'/'c' open create; Escape
    // closes whatever panel is open. Guarded against firing mid-typing.
    function handleKeydown(event, body) {
      // Enter inside the quick-add field commits the parse (the field is a
      // bare input with no surrounding <form>, so Enter wouldn't submit).
      if (event.key === 'Enter' && event.target?.closest?.('[data-cal-quickadd-input]')) {
        event.preventDefault();
        submitQuickAdd(body, lastCtx);
        return;
      }
      if (event.key === 'Escape') {
        if (quickAddPending) {
          event.preventDefault();
          clearQuickAdd();
          requestRender();
        } else if (form) {
          event.preventDefault();
          preserveFormValues(body);
          closeForm(true);
          requestRender();
        } else if (quickAddExpanded) {
          event.preventDefault();
          preserveQuickAdd(body);
          quickAddExpanded = false;
          pendingFocusSelector = '[data-cal-quickadd-expand]';
          requestRender();
        } else {
          const toolbarPopover = body.querySelector('#calToolbarOverflow:not([hidden])');
          if (toolbarPopover && popover) {
            event.preventDefault();
            popover.close(toolbarPopover, { restoreFocus: true });
          } else if (feedsOpen) {
            event.preventDefault();
            closeFeeds(true);
            requestRender();
          }
        }
        return;
      }
      if ((event.key === 'n' || event.key === 'c')
        && !event.ctrlKey && !event.metaKey && !event.altKey
        && !form && !feedsOpen && !isEditableTarget(event.target)) {
        event.preventDefault();
        formReturnFocus = '[data-cal-new-event]';
        openCreateForm(null);
      }
    }

    function bindBody(body, ctx) {
      if (body.dataset.calBound === '1') {
        return;
      }
      body.dataset.calBound = '1';
      toggleModule?.initToggleHandlers?.(body.ownerDocument || windowRef.document);
      body.addEventListener('click', (event) => handleClick(event, body, lastCtx || ctx));
      body.addEventListener('keydown', (event) => handleKeydown(event, body));
      body.addEventListener('change', (event) => {
        const field = event.target?.closest?.('[data-cal-form-field]');
        if (form && field) {
          preserveFormValues(body);
          // When start is pushed past end, slide end to start+30min in place
          // (imperative DOM write — a rebuild here would drop focus mid-edit).
          if (field.dataset.calFormField === 'start'
            && form.values.allDay !== true
            && String(form.values.end || '') <= String(form.values.start || '')) {
            const bumped = addMinutesToHHMM(form.values.start, 30);
            form.values.end = bumped;
            const endEl = body.querySelector('#calFormEnd');
            if (endEl) {
              endEl.value = bumped;
            }
          }
        }
      });
      body.addEventListener('inv-toggle-change', (event) => {
        if (form && event.detail?.id === 'calFormAllDay') {
          preserveFormValues(body);
          requestRender(); // time fields show/hide with the all-day flag
        }
      });
    }

    // First-paint / degraded states. Loading shows while the snapshot is still
    // in flight (retry re-pokes getState); the no-IPC case is a hard error so
    // a missing service never masquerades as an empty week.
    function renderWidgetState(body) {
      const canRetry = Boolean(shell?.calendar?.getState);
      if (!statusRow) {
        body.innerHTML = '<div class="cal-status">'
          + (canRetry ? 'Loading calendar…' : 'Calendar unavailable.')
          + '</div>';
        body.dataset.calRenderKey = canRetry ? '__loading__' : '__error__';
        return;
      }
      if (canRetry) {
        body.innerHTML = '<div class="cal-status">'
          + statusRow({
            tone: 'pending', spinner: true, label: 'Loading calendar',
            message: 'Fetching your events…', ariaLive: 'polite',
          })
          + actionButton({ variant: 'ghost', size: 'sm', label: 'Retry', dataset: { 'cal-retry': '1' } })
          + '</div>';
        body.dataset.calRenderKey = '__loading__';
      } else {
        body.innerHTML = '<div class="cal-status">'
          + statusRow({
            tone: 'danger', label: 'Calendar unavailable',
            message: 'Could not reach the calendar service.', ariaLive: 'assertive',
          })
          + '</div>';
        body.dataset.calRenderKey = '__error__';
      }
    }

    // Element references die on each innerHTML rebuild, so focus moves and
    // live-region text are applied by selector/text once the new DOM exists.
    function applyDeferredFocusAndAnnounce(body) {
      const focusSel = pendingFocusSelector;
      const announce = pendingAnnounce;
      pendingFocusSelector = '';
      pendingAnnounce = '';
      runtimeModule?.applyDeferredFocusAndAnnounce?.(body, { focusSelector: focusSel, announce });
    }

    function render(body, ctx) {
      if (!body || !gridModule || !runtimeModule || !actionButton) {
        return;
      }
      lastBody = body;
      lastCtx = ctx;
      bindBody(body, ctx);

      // No calendar slice yet (or no IPC) -> loading/error state, not a blank
      // grid that reads as "no events".
      if (!asObject(ctx?.state?.calendar)) {
        renderWidgetState(body);
        return;
      }

      const now = nowProvider();
      const mode = currentViewMode(ctx);
      const { instances, categories, feeds } = readCalendarState(ctx);
      const configFeeds = readConfiguredFeeds(ctx);
      const windowStart = ctx?.state?.calendar?.windowStart;
      const windowEnd = ctx?.state?.calendar?.windowEnd;
      const weekStart = gridModule.computeWeekStart(now, weekOffset);
      const weekStartKey = gridModule.formatLocalDate(weekStart);
      const weekEndKey = gridModule.formatLocalDate(
        gridModule.listWeekDays(weekStart)[6]
      );
      const nextWeekStart = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 7);
      const weekInstances = instances.filter((instance) => {
        const start = gridModule.parseLocalDateTime(instance.start);
        const end = gridModule.parseLocalDateTime(instance.end);
        return start && end && end > weekStart && start < nextWeekStart;
      });
      const monthDigest = mode === 'month'
        ? instances.map((i) => [i.instanceId, i.start, i.end, i.title, i.notes,
          i.categoryId, i.allDay, i.readonly, i.recurrenceUnsupported, i.tzApprox])
        : null;
      const railDigest = railModule?.computeRailDigest?.({
        weekStart, instances, weekInstances, categories, configFeeds, feeds, mode, gridModule, now,
      }) || null;
      // Reminders live outside the calendar snapshot, so their digest is the
      // only thing that repaints the agenda when one is added/edited/removed.
      const reminders = Array.isArray(ctx?.state?.proactive?.reminders) ? ctx.state.proactive.reminders : [];
      const remindersDigest = remindersModule?.computeRemindersDigest?.(reminders) || null;
      const journalEntries = ctx?.state?.homeJournal?.entries;
      const journalDigest = remindersModule?.computeJournalDigest?.(journalEntries) || null;
      const journalByEntity = remindersModule?.buildJournalIndex?.(journalEntries) || null;
      const weekStripDigest = mode === 'agenda'
        ? (railModule?.computeWeekStripDigest?.({
          weekStart, weekInstances, now, selectedDayKey, gridModule,
        }) || null)
        : null;
      const renderKey = runtimeModule.computeRenderKey({
        weekStartKey,
        todayKey: gridModule.formatLocalDate(now),
        weekInstances,
        monthDigest,
        railDigest,
        remindersDigest,
        weekStripDigest,
        journalDigest,
        feeds,
        categories,
        mode,
        uiState: {
          form, feedsOpen, configFeeds, feedsError, weekOffset, selectedDayKey,
          quickAddExpanded, quickAddValue, quickAddError, quickAddPending,
        },
      });
      if (body.dataset.calRenderKey === renderKey) {
        applyDeferredFocusAndAnnounce(body);
        runtimeModule.updateNowLine(body, now, gridModule);
        runtimeModule.updateAgendaRelative(body, now, { gridModule, agendaModule });
        return;
      }
      preserveFormValues(body);
      preserveQuickAdd(body);
      const scrollEl = body.querySelector('[data-cal-scroll]');
      const previousScrollTop = scrollEl ? scrollEl.scrollTop : null;

      // View content and quick-add stand down while a panel (form or feeds) is
      // open, so the open task owns the pane.
      const panelOpen = Boolean(form || feedsOpen);
      let viewMarkup;
      if (mode === 'agenda' && agendaModule) {
        viewMarkup = agendaModule.buildAgendaMarkup({
          weekStart, instances: weekInstances, reminders, categories, now, selectedDayKey, actionButton,
          journalByEntity,
        });
      } else if (mode === 'month' && monthModule) {
        const span = monthModule.computeMonthSpan(windowStart, windowEnd);
        viewMarkup = monthModule.buildMonthMarkup({
          gridStart: span.gridStart, weekCount: span.weekCount,
          instances, now, windowStart, windowEnd, actionButton, chip, popover,
        });
      } else {
        viewMarkup = gridModule.buildCalendarGridMarkup({
          weekStart, instances: weekInstances, now, actionButton, chip, popover,
        });
      }

      const railMarkup = railModule?.buildRailMarkup?.({
        mode, now, weekStart, instances, weekInstances, categories, feeds, configFeeds,
        selectedDayKey, actionButton, gridModule,
      }) || '';
      const compactUpNext = railModule?.buildCompactUpNextMarkup?.({
        mode, now, instances, gridModule,
      }) || '';
      const panelMarkup = feedsOpen && formModule
          ? formModule.buildFeedsPanelMarkup({
            feeds: configFeeds,
            feedsMeta: feeds,
            categories,
            error: feedsError,
            deps: formPrimitives,
          })
          : (form && formModule
          ? formModule.buildEventFormMarkup({
            values: form.values,
            categories,
            error: form.error,
            deps: formPrimitives,
          })
          : '');
      const quickAddMarkup = !panelOpen && mode === 'agenda' && agendaModule
          ? agendaModule.buildQuickAddMarkup({
            value: quickAddValue,
            pending: quickAddPending,
            error: quickAddError,
            now,
            expanded: quickAddExpanded,
            deps: formPrimitives,
          })
          : '';
      // The week strip is part of the agenda CARD (Daybook face), not the rail:
      // it leads the pane so the week reads before the day list.
      const weekStripMarkup = !panelOpen && mode === 'agenda'
        ? (railModule?.buildWeekStripMarkup?.({
          weekStart, weekInstances, now, selectedDayKey, actionButton, gridModule,
        }) || '')
        : '';
      const paneMarkup = panelOpen
        ? panelMarkup
        : `${weekStripMarkup}${compactUpNext}${viewMarkup}${quickAddMarkup}`;
      body.innerHTML = ''
        + (toolbarModule
          ? toolbarModule.buildToolbarMarkup({ weekStart, feeds, mode, now, actionButton, popover, gridModule, monthModule })
          : '')
        + `<div class="cal-layout cal-layout--${mode}">`
        + railMarkup
        + `<main class="cal-pane">${paneMarkup}</main>`
        + '</div>';
      body.dataset.calRenderKey = renderKey;

      const nextScrollEl = body.querySelector('[data-cal-scroll]');
      if (nextScrollEl) {
        let defaultTop;
        if (mode === 'month' && monthModule) {
          // Month anchors today's week just below the sticky header on first
          // paint; later repaints keep the user's scroll position.
          defaultTop = monthModule.defaultScrollTop(nextScrollEl);
        } else {
          // First build of the week that contains today lands near "now" (~90min
          // of lead-in) so the now-line is on-screen; other weeks keep the 07:00
          // default, and any path with a prior scroll keeps the user's position.
          const todayKey = gridModule.formatLocalDate(now);
          const showsToday = weekStartKey <= todayKey && todayKey <= weekEndKey;
          defaultTop = showsToday
            ? Math.max(0, Math.min(gridModule.MINUTES_PER_DAY, gridModule.minutesOfDay(now) - 90))
            : DEFAULT_SCROLL_TOP_PX;
        }
        nextScrollEl.scrollTop = previousScrollTop !== null ? previousScrollTop : defaultTop;
      }

      applyDeferredFocusAndAnnounce(body);
    }

    return {
      id: 'calendar',
      title: 'Calendar',
      render,
    };
  }

  return { createCalendarWidget };
});
