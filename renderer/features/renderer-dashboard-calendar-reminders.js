/* Reminder -> agenda pseudo-instance projection for the Home Daybook calendar.
 *
 * Reminders are display-only in the Daybook: nothing in the app FIRES them, and
 * this module never mutates them. It maps the persisted reminder records
 * (services/shell-config-followups-schema.js normalizeReminder) onto the days
 * the agenda is rendering so a reminder sits in the timeline next to real
 * events instead of in a separate widget.
 *
 * Placement by scheduleType:
 *   once_at          -> exactly once, on its own local date/time
 *   daily_at         -> on EVERY rendered day, at dailyAt
 *   interval_minutes -> NEVER on the timeline (there is no meaningful clock
 *                       position for "every N minutes"); the agenda lists those
 *                       in a compact standing footer instead. Legacy-only —
 *                       the Daybook does not offer the cadence for new
 *                       reminders.
 * Disabled reminders are excluded everywhere.
 *
 * It also owns the pure half of the assistant undo journal
 * (services/home-assistant-service.js): which journal entry is still undoable
 * for a given record, the journal's render-key contribution, and the fold of a
 * `home.onAiChanged` payload onto the dashboard state slices. Those live here
 * rather than in the agenda or the manager because both consumers need the
 * same "live entry" rule and neither has the line budget to own it.
 *
 * Pure functions: records in, plain objects out — no state, no IPC, no DOM.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardCalendarReminders = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const {
    formatLocalDate, pad2, parseLocalDateTime, startOfLocalDay,
  } = windowRef.rendererDashboardWidgetsCore
    || (typeof require === 'function' ? require('./renderer-dashboard-widgets-core') : {});

  const DEFAULT_DAILY_AT = '09:00';
  const HHMM = /^(\d{2}):(\d{2})$/;

  function isEnabled(reminder) {
    return Boolean(reminder) && reminder.enabled !== false && String(reminder.id || '') !== '';
  }

  function scheduleTypeOf(reminder) {
    return String(reminder?.scheduleType || '');
  }

  function normalizeTimeOfDay(value, fallback) {
    const match = HHMM.exec(String(value || ''));
    if (!match) {
      return fallback;
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour <= 23 && minute <= 59 ? `${pad2(hour)}:${pad2(minute)}` : fallback;
  }

  function formatLocalStamp(date) {
    return `${formatLocalDate(date)}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }

  // A reminder occupies a single minute so it sorts by clock time among events
  // without ever painting as a duration. Computed through Date arithmetic so a
  // 23:59 reminder rolls into the next day instead of clamping.
  function endStampFor(startStamp) {
    const start = parseLocalDateTime(startStamp);
    if (!start) {
      return startStamp;
    }
    return formatLocalStamp(new Date(start.getTime() + 60000));
  }

  function buildPseudoInstance(reminder, startStamp) {
    return {
      instanceId: `reminder:${reminder.id}`,
      reminderId: String(reminder.id),
      kind: 'reminder',
      eventId: '',
      title: String(reminder.label || 'Reminder'),
      prompt: String(reminder.prompt || ''),
      start: startStamp,
      end: endStampFor(startStamp),
      allDay: false,
      categoryId: 'default',
      sourceKind: String(reminder.sourceKind || ''),
      sourceId: String(reminder.sourceId || ''),
    };
  }

  /**
   * The pseudo-instance a single reminder contributes to one local day, or null
   * when it contributes none.
   * @param {Object} reminder persisted reminder record
   * @param {Date} day local day being rendered
   */
  function reminderInstanceForDay(reminder, day) {
    if (!isEnabled(reminder) || !(day instanceof Date) || Number.isNaN(day.getTime())) {
      return null;
    }
    const dayKey = formatLocalDate(startOfLocalDay(day));
    const scheduleType = scheduleTypeOf(reminder);
    if (scheduleType === 'daily_at') {
      return buildPseudoInstance(reminder, `${dayKey}T${normalizeTimeOfDay(reminder.dailyAt, DEFAULT_DAILY_AT)}`);
    }
    if (scheduleType === 'once_at') {
      const onceAt = String(reminder.onceAt || '');
      // A malformed onceAt places nothing rather than defaulting to "today" —
      // a one-shot reminder must never be invented on an arbitrary day.
      if (!parseLocalDateTime(onceAt) || onceAt.slice(0, 10) !== dayKey) {
        return null;
      }
      return buildPseudoInstance(reminder, onceAt);
    }
    // interval_minutes (and any unknown cadence) never lands on the timeline.
    return null;
  }

  /** Every reminder pseudo-instance for one local day. */
  function remindersForDay(reminders, day) {
    return (Array.isArray(reminders) ? reminders : [])
      .map((reminder) => reminderInstanceForDay(reminder, day))
      .filter(Boolean);
  }

  /**
   * Enabled interval-cadence reminders — the ones with no timeline position.
   * The agenda renders these in its standing footer.
   */
  function listStandingReminders(reminders) {
    return (Array.isArray(reminders) ? reminders : [])
      .filter((reminder) => isEnabled(reminder) && scheduleTypeOf(reminder) === 'interval_minutes')
      .map((reminder) => ({
        id: String(reminder.id),
        label: String(reminder.label || 'Reminder'),
        intervalMinutes: Number(reminder.intervalMinutes) || 0,
        sourceKind: String(reminder.sourceKind || ''),
        sourceId: String(reminder.sourceId || ''),
      }));
  }

  /**
   * Compact projection for the calendar's render key: reminders live outside
   * the calendar snapshot, so without this a reminder edit would repaint
   * nothing.
   */
  function computeRemindersDigest(reminders) {
    return (Array.isArray(reminders) ? reminders : []).map((reminder) => [
      String(reminder?.id || ''),
      String(reminder?.label || ''),
      scheduleTypeOf(reminder),
      String(reminder?.dailyAt || ''),
      String(reminder?.onceAt || ''),
      Number(reminder?.intervalMinutes) || 0,
      reminder?.enabled !== false,
      String(reminder?.sourceKind || ''),
    ]);
  }

  // ---- assistant undo journal (pure projections) ----

  /**
   * An entry is undoable only while it is neither already undone nor superseded
   * by a later assistant write to the same record. Everything else in the ring
   * is history: it stays in the journal but must NOT offer an undo affordance,
   * because the service would refuse it.
   */
  function isLiveJournalEntry(entry) {
    return Boolean(entry)
      && String(entry.id || '') !== ''
      && String(entry.entityId || '') !== ''
      && !String(entry.undoneAt || '')
      && !String(entry.supersededAt || '');
  }

  /**
   * Map of `${entity}:${entityId}` -> the live journal entry for that record,
   * for the agenda to look a row's undo affordance up by identity. Later
   * entries win: the store supersedes older ones, so a surviving duplicate pair
   * is malformed data and the NEWER entry is the one an undo should target.
   * @param {Object[]} entries journal entries from home.getAiJournal
   */
  function buildJournalIndex(entries) {
    const index = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (isLiveJournalEntry(entry)) {
        index.set(`${String(entry.entity || '')}:${String(entry.entityId || '')}`, entry);
      }
    }
    return index;
  }

  /**
   * Render-key contribution for the journal. The journal rides neither the
   * calendar snapshot nor the reminders array, so without this an undo — which
   * changes only `undoneAt` — would leave its own now-dead button on screen.
   */
  function computeJournalDigest(entries) {
    return (Array.isArray(entries) ? entries : []).map((entry) => [
      String(entry?.id || ''),
      String(entry?.entity || ''),
      String(entry?.entityId || ''),
      String(entry?.undoneAt || ''),
      String(entry?.supersededAt || ''),
    ]);
  }

  /**
   * Fold a `home.onAiChanged` push (or an undo result) onto the dashboard state
   * slices. The payload carries reminders and the journal ONLY — never the
   * workspace-root fields that ride the proactive channel — so those are
   * preserved rather than blanked, which is what applying it through
   * applyProactivePayload would do.
   * @param {Object} state dashboard state (reads .proactive and .homeJournal)
   * @param {Object} payload {journal:{entries}, proactive:{reminders}}
   * @returns {{proactive: Object, journal: {entries: Object[]}}} next slices
   */
  function foldHomeAiPayload(state, payload) {
    const prior = state && typeof state === 'object' ? state : {};
    const source = payload && typeof payload === 'object' ? payload : {};
    const reminders = source.proactive?.reminders;
    const entries = source.journal?.entries;
    return {
      proactive: Array.isArray(reminders)
        ? { ...(prior.proactive || {}), reminders: reminders.map((entry) => ({ ...entry })) }
        : (prior.proactive || { reminders: [] }),
      journal: Array.isArray(entries)
        ? { entries: entries.map((entry) => ({ ...entry })) }
        : (prior.homeJournal || { entries: [] }),
    };
  }

  return {
    buildJournalIndex,
    computeJournalDigest,
    computeRemindersDigest,
    foldHomeAiPayload,
    isLiveJournalEntry,
    listStandingReminders,
    reminderInstanceForDay,
    remindersForDay,
  };
});
