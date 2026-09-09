/* Stateless runtime helpers for the Home dashboard calendar controller.
 * The controller owns all durable widget state; this module only projects that
 * state into a render key or performs bounded in-place DOM maintenance.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardCalendarRuntime = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function preserveFormValues(body, form, formModule) {
    if (form && formModule && body && typeof formModule.readEventFormValues === 'function') {
      form.values = formModule.readEventFormValues(body, form.values);
    }
    return form;
  }

  function preserveQuickAdd(body, currentValue = '') {
    if (!body) {
      return String(currentValue || '');
    }
    const input = body.querySelector('[data-cal-quickadd-input]');
    return input ? String(input.value || '') : String(currentValue || '');
  }

  function computeRenderKey({
    weekStartKey,
    todayKey,
    weekInstances,
    monthDigest,
    railDigest,
    remindersDigest,
    weekStripDigest,
    journalDigest,
    feeds,
    categories,
    mode,
    uiState,
  } = {}) {
    const ui = uiState || {};
    const form = ui.form || null;
    const quickAddPending = ui.quickAddPending || null;
    return JSON.stringify([
      weekStartKey,
      todayKey,
      mode === 'month' ? monthDigest : weekInstances,
      railDigest,
      // Reminders and the agenda week strip are not derived from the calendar
      // snapshot, so they need their own key contributions.
      remindersDigest || null,
      weekStripDigest || null,
      // Likewise the assistant undo journal: an undo flips only `undoneAt`, so
      // without this the row keeps a button the service would now refuse.
      journalDigest || null,
      (Array.isArray(feeds) ? feeds : []).map((feed) => [feed.id, feed.name, feed.warning, feed.ok]),
      (Array.isArray(categories) ? categories : []).map((category) => [category.id, category.label]),
      form ? [form.values?.id || 'new', form.values?.allDay === true, form.error || ''] : null,
      ui.feedsOpen ? [ui.configFeeds || [], ui.feedsError || ''] : null,
      ui.weekOffset || 0,
      mode,
      ui.selectedDayKey || '',
      ui.quickAddExpanded === true,
      ui.quickAddValue || '',
      ui.quickAddError || '',
      quickAddPending
        ? [quickAddPending.parsed?.title || '', quickAddPending.conflicts?.length || 0]
        : null,
    ]);
  }

  function updateNowLine(body, now, gridModule) {
    const nowLine = body?.querySelector?.('.cal-week__now-line');
    if (nowLine && gridModule && typeof gridModule.minutesOfDay === 'function') {
      nowLine.style.top = `${gridModule.minutesOfDay(now)}px`;
    }
  }

  function updateAgendaRelative(body, now, { gridModule, agendaModule } = {}) {
    if (!body || !gridModule || !agendaModule || typeof agendaModule.formatRelative !== 'function') {
      return;
    }
    const relativeLabels = body.querySelectorAll('[data-cal-rel]');
    relativeLabels.forEach((label) => {
      const start = gridModule.parseLocalDateTime(label.getAttribute('data-cal-start'));
      if (start) {
        label.textContent = agendaModule.formatRelative(now, start);
      }
    });
    const nowMs = now.getTime();
    body.querySelectorAll('[data-cal-end]').forEach((item) => {
      const end = gridModule.parseLocalDateTime(item.getAttribute('data-cal-end'));
      if (!end) {
        return;
      }
      const past = end.getTime() < nowMs;
      item.classList.toggle('cal-agenda__item--past', past);
      if (past) {
        item.classList.remove('cal-agenda__item--next');
      }
    });
  }

  function applyDeferredFocusAndAnnounce(body, { focusSelector = '', announce = '' } = {}) {
    if (!body || (!focusSelector && !announce)) {
      return;
    }
    const run = () => {
      if (announce) {
        const region = body.querySelector('[data-cal-announce]');
        if (region) {
          region.textContent = announce;
        }
      }
      if (focusSelector) {
        const target = body.querySelector(focusSelector);
        if (target && typeof target.focus === 'function') {
          if (target.matches('[data-cal-month-day]')) {
            // Month cells contain buttons but are not themselves tab stops.
            // Chat navigation targets the whole day, even when it is empty.
            target.setAttribute('tabindex', '-1');
            target.scrollIntoView?.({ block: 'center', inline: 'nearest', behavior: 'instant' });
            target.focus({ preventScroll: true });
          } else {
            target.focus();
          }
        }
      }
    };
    if (typeof queueMicrotask === 'function') {
      queueMicrotask(run);
    } else {
      run();
    }
  }

  // Navigation returns state projections so the controller stays below its cap.
  function handleWeekNavClick(event, {
    body, ctx, weekOffset, gridModule, monthModule, currentViewMode, nowProvider,
  } = {}) {
    const railNav = event?.target?.closest?.('[data-cal-rail-nav]');
    if (railNav) {
      const visibleWeek = gridModule.computeWeekStart(nowProvider(), weekOffset);
      const anchor = gridModule.listWeekDays(visibleWeek)[3];
      const delta = railNav.dataset.calRailNav === 'next' ? 1 : -1;
      const targetMonth = new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1);
      return {
        handled: true,
        weekOffset: gridModule.computeWeekOffsetForDate(nowProvider(), targetMonth),
        pendingFocusSelector: `[data-cal-rail-nav="${railNav.dataset.calRailNav}"]`,
        pendingAnnounce: targetMonth.toLocaleDateString(globalThis.jennyI18n?.tag?.(), { month: 'long', year: 'numeric' }),
        preserveQuickAdd: true,
      };
    }
    const nav = event?.target?.closest?.('[data-cal-nav]');
    if (!nav) {
      return null;
    }
    const direction = nav.dataset.calNav;
    // Month mode is a continuous scroll, not paginated weeks: the chevrons
    // scroll the canvas and Today re-anchors — no data change, no rebuild.
    if (currentViewMode(ctx) === 'month' && monthModule) {
      monthModule.navScroll(body.querySelector('[data-cal-scroll]'), direction);
      return { handled: true, scrolled: true };
    }
    const nextWeekOffset = direction === 'today' ? 0 : weekOffset + (direction === 'next' ? 1 : -1);
    const weekStart = gridModule.computeWeekStart(nowProvider(), nextWeekOffset);
    return {
      handled: true,
      weekOffset: nextWeekOffset,
      pendingFocusSelector: '',
      pendingAnnounce: jt("dashboard.calendar.weekOf", "Week of {range}", { range: String(gridModule.formatWeekRangeLabel(weekStart)) }),
      preserveQuickAdd: false,
    };
  }

  // ---- assistant undo affordance ----

  // The service refuses an undo in three cases (docs/TOOLS.md#home); each gets
  // copy that says what happened to the RECORD, not what the store did.
  // 'failed'/unknown covers a rejected round-trip or a reason we don't model.
  const UNDO_REFUSAL_COPY = {
    entry_not_found: jt('dashboard.calendar.undoEntryNotFound', 'that change is no longer in the undo list'),
    already_undone: jt('dashboard.calendar.undoAlreadyUndone', 'already undone'),
    superseded: jt('dashboard.calendar.undoSuperseded', 'jenny changed this again since — nothing to undo'),
    changed_since: jt('dashboard.calendar.undoChangedSince', "you've edited this since — nothing to undo"),
    failed: jt('dashboard.calendar.undoFailed', 'could not undo that change'),
  };
  const UNDO_NOTE_CLASS = 'cal-agenda__undo-note';
  const UNDO_NOTE_MS = 6000;

  /**
   * A refusal changes nothing, so it must NOT go through a rebuild: it is
   * written imperatively next to the row it refused and expires on its own. No
   * render-key contribution (a rebuild would wipe it) and no toast dependency.
   */
  function showUndoRefusal(trigger, reason, { setTimeoutImpl } = {}) {
    const doc = trigger?.ownerDocument;
    const host = trigger?.closest?.('.cal-agenda__item-wrap') || trigger?.parentElement;
    if (!doc || !host) {
      return null;
    }
    host.querySelectorAll?.(`.${UNDO_NOTE_CLASS}`)?.forEach?.((stale) => stale.remove());
    const note = doc.createElement('span');
    note.className = UNDO_NOTE_CLASS;
    note.setAttribute('role', 'status');
    note.dataset.calUndoRefusal = String(reason || 'failed');
    note.textContent = UNDO_REFUSAL_COPY[String(reason || '')] || UNDO_REFUSAL_COPY.failed;
    host.append(note);
    const schedule = typeof setTimeoutImpl === 'function' ? setTimeoutImpl : setTimeout;
    const timer = schedule(() => note.remove(), UNDO_NOTE_MS);
    if (typeof timer?.unref === 'function') {
      timer.unref();
    }
    return note;
  }

  /**
   * Delegated handler for the agenda's "undo jenny's change" affordance. The
   * controller calls it first in its click dispatch and stops when it returns
   * true, so all of the undo lifecycle lives here rather than in the
   * at-ceiling controller.
   *
   * On success the three returned snapshots are applied through the SAME paths
   * a push would use (the service also broadcasts home.onAiChanged, but a
   * renderer that only waited for the push would leave a stubbed shell — and a
   * slow bridge — showing stale rows).
   * @returns {boolean} true when the click was an undo click
   */
  function handleUndoJournalClick(event, {
    shell, onSnapshot, onAiPayload, onApplied, appendClientLog = () => {}, setTimeoutImpl,
  } = {}) {
    const trigger = event?.target?.closest?.('[data-cal-undo-journal]');
    if (!trigger) {
      return false;
    }
    const entryId = String(trigger.dataset?.calUndoJournal || '');
    if (!entryId || typeof shell?.home?.undoAiEntry !== 'function') {
      return true;
    }
    Promise.resolve(shell.home.undoAiEntry(entryId))
      .then((result) => {
        if (!result || result.ok !== true) {
          showUndoRefusal(trigger, result?.reason, { setTimeoutImpl });
          return;
        }
        if (result.calendar && typeof onSnapshot === 'function') {
          onSnapshot(result.calendar);
        }
        if (typeof onAiPayload === 'function') {
          onAiPayload({ journal: result.journal, proactive: result.proactive });
        }
        if (typeof onApplied === 'function') {
          onApplied();
        }
      })
      .catch((error) => {
        appendClientLog('WARN', 'home.calendar_undo_failed', {
          entryId,
          message: String(error?.message || error || ''),
        });
        showUndoRefusal(trigger, 'failed', { setTimeoutImpl });
      });
    return true;
  }

  return {
    UNDO_REFUSAL_COPY,
    applyDeferredFocusAndAnnounce,
    computeRenderKey,
    handleUndoJournalClick,
    handleWeekNavClick,
    preserveFormValues,
    preserveQuickAdd,
    updateAgendaRelative,
    updateNowLine,
  };
});
