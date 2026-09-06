/* Timeline agenda + natural-language quick-add for the Home
 * dashboard calendar widget. Pure functions: instances in, HTML string out (or
 * a parsed quick-add descriptor) — no state, no IPC, no listeners. The
 * controller owns delegation and persistence; this module is the glanceable
 * counterpart to the week time-grid (renderer-dashboard-calendar-grid.js) and
 * reuses the same palette-safe category-hue token contract (.cal-event--<cat>
 * sets --cal-event-hue, which the agenda dots/rows read).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardCalendarAgenda = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const {
    addLocalDays, formatLocalDate, formatTimeShort, pad2, parseLocalDateTime, startOfLocalDay,
  } = windowRef.rendererDashboardWidgetsCore
    || (typeof require === 'function' ? require('./renderer-dashboard-widgets-core') : {});

  // Reminders arrive as raw records and are projected onto the rendered days
  // here (renderer-dashboard-calendar-reminders.js owns every placement rule).
  // Resolved lazily so a harness that assigns the global after this factory
  // runs still gets the real module.
  function resolveRemindersModule() {
    return windowRef.rendererDashboardCalendarReminders
      || (typeof require === 'function' ? require('./renderer-dashboard-calendar-reminders') : null);
  }

  const MS_PER_MINUTE = 60000;

  // Weekday word -> JS getDay() index. Common abbreviations included so the
  // quick-add parser is forgiving ("tues", "weds", "thurs").
  const WEEKDAY_WORDS = {
    sun: 0, sunday: 0,
    mon: 1, monday: 1,
    tue: 2, tues: 2, tuesday: 2,
    wed: 3, weds: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5,
    sat: 6, saturday: 6,
  };

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function resolveActionButton(deps) {
    if (typeof deps?.actionButton === 'function') {
      return deps.actionButton;
    }
    return typeof windowRef.inventoryActionButton === 'function'
      ? windowRef.inventoryActionButton
      : null;
  }

  // ---- assistant attribution + undo ----

  /**
   * "jenny" chip for a record the assistant CREATED. Keyed off the entity's own
   * sourceKind (persisted by HomeAssistantService), NOT off the journal —
   * attribution outlives the 20-entry undo ring, so a record stays badged long
   * after its entry has been evicted. That permanence is exactly why an
   * assistant EDIT of a user's record does not earn the chip: "jenny recently
   * changed this" is the undo affordance's job, and it expires with the ring.
   */
  function attributionChip(instance) {
    return String(instance?.sourceKind || '') === 'assistant'
      ? '<span class="cal-agenda__jenny" title="Added by jenny">jenny</span>'
      : '';
  }

  function journalEntryFor(journalByEntity, entity, entityId) {
    const id = String(entityId || '');
    return id && typeof journalByEntity?.get === 'function'
      ? journalByEntity.get(`${entity}:${id}`) || null
      : null;
  }

  /**
   * One-click revert of the indexed assistant write. NEVER nested inside an
   * event row: that row IS a button and a button cannot contain one, so the
   * caller places this in the <li> wrap for events and in the reminder row's
   * existing actions slot for reminders.
   */
  function undoAffordance(actionButton, entry, title) {
    return entry
      ? actionButton({
        variant: 'ghost',
        size: 'sm',
        label: 'Undo',
        className: 'cal-agenda__undo',
        ariaLabel: `Undo jenny's change to ${title}`,
        title: `Undo jenny's change to ${title}`,
        dataset: { 'cal-undo-journal': String(entry.id || '') },
      })
      : '';
  }

  function minutesToHHMM(minutes) {
    const clamped = Math.max(0, Math.min(1439, Math.round(minutes)));
    return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
  }

  // Whole-day overlap test on the local-naive instance strings.
  function instanceOnDay(instance, dayStartMs, dayEndMs) {
    const start = parseLocalDateTime(instance.start);
    const end = parseLocalDateTime(instance.end);
    if (!start || !end) {
      return false;
    }
    return end.getTime() > dayStartMs && start.getTime() < dayEndMs;
  }

  function categoryClass(instance) {
    const categoryId = /^[a-z][a-z0-9-]*$/.test(String(instance.categoryId || ''))
      ? instance.categoryId
      : 'default';
    return `cal-event--${categoryId}`;
  }

  // ---- agenda relative-time text ("in 35m" / "now") ----

  // The "up next" label for today's first future event. Returns '' beyond a day
  // out (the label is only ever attached to a same-day event, so that never
  // happens in practice, but the bound keeps it honest).
  function formatRelative(now, start) {
    const ms = start.getTime() - now.getTime();
    if (ms <= 0) {
      return 'now';
    }
    const mins = Math.round(ms / MS_PER_MINUTE);
    if (mins < 60) {
      return `in ${mins}m`;
    }
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    if (hrs < 24) {
      return rem ? `in ${hrs}h ${rem}m` : `in ${hrs}h`;
    }
    return '';
  }

  function formatAgendaDayLabel(day, now) {
    const todayKey = formatLocalDate(now);
    const dayKey = formatLocalDate(day);
    const datePart = day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (dayKey === todayKey) {
      return `Today · ${datePart}`;
    }
    if (dayKey === formatLocalDate(addLocalDays(now, 1))) {
      return `Tomorrow · ${datePart}`;
    }
    return `${day.toLocaleDateString(undefined, { weekday: 'long' })} · ${datePart}`;
  }

  function formatDuration(instance) {
    if (instance?.allDay === true) {
      return '';
    }
    const start = parseLocalDateTime(instance?.start);
    const end = parseLocalDateTime(instance?.end);
    if (!start || !end || end <= start) {
      return '';
    }
    const minutes = Math.max(1, Math.round((end.getTime() - start.getTime()) / MS_PER_MINUTE));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!hours) {
      return `${minutes}m`;
    }
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }

  // A reminder row is NOT an event button: it carries its own affordances, and
  // a button cannot legally nest buttons. It is a plain container with the two
  // reminder actions inside — "Done" (delete, handled by the calendar
  // controller) and "promote to open loop", which reuses the companion action
  // router's existing `promote_reminder:<id>` id so the Home view's delegated
  // [data-companion-action-id] handler picks it up unchanged.
  function buildReminderRow(actionButton, instance, { journalEntry = null } = {}) {
    const reminderId = String(instance.reminderId || '');
    const title = String(instance.title || '').trim() || 'Reminder';
    const start = parseLocalDateTime(instance.start);
    const timeLabel = start ? formatTimeShort(start) : '';
    const label = [`Reminder: ${title}`, timeLabel].filter(Boolean).join(', ');
    return '<li class="cal-agenda__item-wrap">'
      + `<div class="cal-agenda__item cal-agenda__item--reminder ${categoryClass(instance)}"`
      + ` role="group" aria-label="${escapeHtml(label)}"`
      + ` data-cal-reminder-id="${escapeHtml(reminderId)}"`
      + ` data-cal-source-kind="${escapeHtml(String(instance.sourceKind || ''))}">`
      + `<span class="cal-agenda__time">${escapeHtml(timeLabel)}</span>`
      + '<span class="cal-agenda__dot" aria-hidden="true"></span>'
      + `<span class="cal-agenda__title">${escapeHtml(title)}</span>`
      + '<span class="cal-agenda__meta">'
      + attributionChip(instance)
      + '<span class="cal-agenda__badge" title="Reminder — nudges are manual">reminder</span>'
      + '<span class="cal-agenda__reminder-actions">'
      + undoAffordance(actionButton, journalEntry, title)
      + actionButton({
        variant: 'ghost', size: 'sm', label: 'Done',
        ariaLabel: `Mark reminder done: ${title}`,
        title: `Mark reminder done: ${title}`,
        dataset: { 'cal-reminder-dismiss': reminderId },
      })
      + actionButton({
        variant: 'ghost', size: 'sm', label: 'Open loop',
        ariaLabel: `Promote reminder to an open loop: ${title}`,
        title: `Promote reminder to an open loop: ${title}`,
        dataset: { 'companion-action-id': `promote_reminder:${reminderId}` },
      })
      + '</span></span></div></li>';
  }

  function buildAgendaRow(actionButton, instance, {
    isNext, now, categoryLabel = '', journalByEntity = null,
  } = {}) {
    if (instance.kind === 'reminder') {
      return buildReminderRow(actionButton, instance, {
        journalEntry: journalEntryFor(journalByEntity, 'reminder', instance.reminderId),
      });
    }
    const readonly = instance.readonly === true;
    const title = String(instance.title || '').trim() || '(no title)';
    const undoEntry = journalEntryFor(journalByEntity, 'calendar_event', instance.eventId);
    const start = parseLocalDateTime(instance.start);
    const timeLabel = instance.allDay
      ? 'All day'
      : (start ? formatTimeShort(start) : '');
    const dataset = { 'cal-instance': '1' };
    if (instance.instanceId) {
      dataset['cal-instance-id'] = String(instance.instanceId);
    }
    if (!readonly && instance.eventId) {
      dataset['cal-event-id'] = String(instance.eventId);
    }
    if (readonly) {
      dataset['cal-readonly'] = '1';
    }
    // Timed rows carry their end so the controller's 30s tick can dim them once
    // they're over (past-ness isn't in the render-key, so it can't wait for a
    // rebuild). "Up next" and currently-running events keep full emphasis.
    const end = parseLocalDateTime(instance.end);
    let isPast = false;
    if (!instance.allDay && instance.end) {
      dataset['cal-end'] = String(instance.end);
      isPast = !isNext && !!end && end.getTime() < now.getTime();
    }
    const relText = isNext && start ? formatRelative(now, start) : '';
    const duration = formatDuration(instance);
    const tzApprox = instance.tzApprox === true;
    const badges = ''
      + (instance.recurrenceUnsupported === true
        ? '<span class="cal-agenda__badge" title="Recurrence only partially supported">↻</span>' : '')
      + (tzApprox
        ? '<span class="cal-agenda__badge" title="Approximate time (unrecognized feed time zone)">~tz</span>' : '')
      + (readonly && instance.recurrenceUnsupported !== true && !tzApprox
        ? '<span class="cal-agenda__badge" title="Subscribed feed event">feed</span>' : '');
    const labelBits = [title, timeLabel].filter(Boolean).join(', ')
      + (isNext ? ', up next' : '')
      + (tzApprox ? ', approximate time' : '')
      + (readonly ? ', read-only' : '');
    return '<li class="cal-agenda__item-wrap">'
      + actionButton({
        plain: true,
        className: `cal-agenda__item ${categoryClass(instance)}`
          + `${readonly ? ' cal-agenda__item--readonly' : ''}${isNext ? ' cal-agenda__item--next' : ''}`
          + `${isPast ? ' cal-agenda__item--past' : ''}`,
        ariaLabel: labelBits,
        title: instance.notes ? `${title}\n${String(instance.notes)}` : title,
        dataset,
        trustedHtml: ''
          + `<span class="cal-agenda__time">${escapeHtml(timeLabel)}</span>`
          + '<span class="cal-agenda__dot" aria-hidden="true"></span>'
          + `<span class="cal-agenda__title">${escapeHtml(title)}</span>`
          + '<span class="cal-agenda__meta">'
          + (duration ? `<span class="cal-agenda__duration">${escapeHtml(duration)}</span>` : '')
          + (categoryLabel ? `<span class="cal-agenda__category">${escapeHtml(categoryLabel)}</span>` : '')
          + (relText
            ? `<span class="cal-agenda__rel" data-cal-rel="1" data-cal-start="${escapeHtml(instance.start)}">${escapeHtml(relText)}</span>`
            : '')
          + attributionChip(instance)
          + badges
          + '</span>',
      })
      // Sibling of the row, not a child: the row itself is a button element,
      // so the undo control has to live beside it inside the wrap. (The tag
      // name is spelled out because the raw-primitive check reads comments.)
      + (undoEntry
        ? `<span class="cal-agenda__row-actions">${undoAffordance(actionButton, undoEntry, title)}</span>`
        : '')
      + '</li>';
  }

  // The accessible name always carries the full add-event prompt; the visual hint may be hover/focus-gated.
  function buildOpenSlotRow(actionButton, dayKey, dayLabel) {
    return '<li class="cal-agenda__item-wrap">'
      + actionButton({
        plain: true,
        className: 'cal-agenda__item cal-agenda__item--open',
        ariaLabel: `Open — add an event on ${dayLabel}`,
        title: 'Add an event on this day',
        dataset: { 'cal-month-day': dayKey },
        trustedHtml: ''
          + '<span class="cal-agenda__time"></span>'
          + '<span class="cal-agenda__dot" aria-hidden="true"></span>'
          + '<span class="cal-agenda__title">Open</span>'
          + '<span class="cal-agenda__meta cal-agenda__open-hint">add an event</span>',
      })
      + '</li>';
  }

  function compareForAgenda(a, b) {
    // All-day events lead the day; then by start string, then title.
    if ((a.allDay === true) !== (b.allDay === true)) {
      return a.allDay === true ? -1 : 1;
    }
    if (String(a.start) !== String(b.start)) {
      return String(a.start) < String(b.start) ? -1 : 1;
    }
    return String(a.title || '') < String(b.title || '') ? -1 : 1;
  }

  /**
   * Renders all seven grouped days, each ending with one open-slot row; there is no whole-week empty state.
   * @param {Object} opts
   * @param {Date} opts.weekStart Sunday of the rendered week
   * @param {Object[]} opts.instances expanded calendar instances
   * @param {Object[]} [opts.reminders] persisted reminder records; projected
   *   onto the rendered days and interleaved with events by clock time
   * @param {Date} opts.now
   * @param {string} [opts.selectedDayKey] day highlighted from the rail month
   * @param {Map} [opts.journalByEntity] `${entity}:${entityId}` -> the live
   *   assistant journal entry for that record; rows whose record has one get an
   *   undo affordance (renderer-dashboard-calendar-reminders.buildJournalIndex)
   * @param {Function} [opts.actionButton]
   */
  function buildAgendaMarkup({
    weekStart, instances, reminders, categories, now, selectedDayKey, journalByEntity, actionButton,
  } = {}) {
    const button = resolveActionButton({ actionButton });
    if (!button || !weekStart) {
      return '';
    }
    const safeInstances = Array.isArray(instances) ? instances : [];
    const nowDate = now instanceof Date ? now : new Date();
    const todayKey = formatLocalDate(nowDate);
    const nowMs = nowDate.getTime();
    const days = Array.from({ length: 7 }, (_, index) => addLocalDays(weekStart, index));

    const remindersModule = resolveRemindersModule();
    const safeReminders = Array.isArray(reminders) ? reminders : [];
    const standing = remindersModule?.listStandingReminders?.(safeReminders) || [];

    const categoryLabels = new Map((Array.isArray(categories) ? categories : [])
      .map((category) => [String(category.id || ''), String(category.label || category.id || '')]));
    const groups = [];
    let nextMarked = false;
    for (const day of days) {
      const dayKey = formatLocalDate(day);
      const dayStartMs = startOfLocalDay(day).getTime();
      const dayEndMs = addLocalDays(day, 1).getTime();
      const isToday = dayKey === todayKey;
      // Reminder pseudo-instances join the day's events BEFORE the sort, so a
      // reminder lands in clock order among them rather than in a side list.
      const dayInstances = safeInstances
        .filter((instance) => instanceOnDay(instance, dayStartMs, dayEndMs))
        .concat(remindersModule?.remindersForDay?.(safeReminders, day) || [])
        .sort(compareForAgenda);
      const distinctCategories = new Set(dayInstances
        .filter((instance) => instance.kind !== 'reminder')
        .map((instance) => String(instance.categoryId || 'default')));
      const rows = dayInstances.map((instance) => {
        let isNext = false;
        // "Up next" = today's first not-yet-ended timed event. A reminder is
        // never "up next": nothing fires it, so it makes no promise about time.
        if (isToday && !nextMarked && instance.allDay !== true && instance.kind !== 'reminder') {
          const end = parseLocalDateTime(instance.end);
          if (end && end.getTime() > nowMs) {
            isNext = true;
            nextMarked = true;
          }
        }
        const categoryId = String(instance.categoryId || 'default');
        return buildAgendaRow(button, instance, {
          isNext,
          now: nowDate,
          journalByEntity,
          categoryLabel: distinctCategories.size > 1
            ? (categoryLabels.get(categoryId) || categoryId)
            : '',
        });
      });
      const dayLabel = formatAgendaDayLabel(day, nowDate);
      const headClasses = 'cal-agenda__day'
        + (isToday ? ' cal-agenda__day--today' : '')
        + (dayKey === selectedDayKey ? ' cal-agenda__day--selected' : '');
      const eventCount = dayInstances.filter((instance) => instance.kind !== 'reminder').length;
      const reminderCount = dayInstances.length - eventCount;
      const countLabel = rows.length
        ? `${eventCount} event${eventCount === 1 ? '' : 's'}`
          + (reminderCount ? ` · ${reminderCount} reminder${reminderCount === 1 ? '' : 's'}` : '')
        : '—';
      groups.push('<div class="cal-agenda__group" data-cal-agenda-day="' + escapeHtml(dayKey) + '">'
        + `<div class="${headClasses}" role="heading" aria-level="3">`
        + `<span class="cal-agenda__day-label">${escapeHtml(dayLabel)}</span>`
        + '<span class="cal-agenda__day-rule" aria-hidden="true"></span>'
        + `<span class="cal-agenda__day-count">${escapeHtml(countLabel)}</span>`
        + '</div>'
        + '<ul class="cal-agenda__list" role="list">'
        + rows.join('')
        // Exactly one open slot per day, always last — a full day still offers
        // the same affordance an empty one does.
        + buildOpenSlotRow(button, dayKey, dayLabel)
        + '</ul>'
        + '</div>');
    }

    // Interval-cadence reminders have no clock position, so they sit under the
    // week rather than inside it. Legacy-only: the Daybook offers daily/once
    // cadences, and this footer exists so an older interval reminder stays
    // visible (and removable) instead of silently vanishing.
    const standingMarkup = standing.length
      ? '<div class="cal-agenda__standing">'
        + '<span class="cal-agenda__standing-label">Standing reminders</span>'
        + standing.map((reminder) => '<span class="cal-agenda__standing-row">'
          + `<span class="cal-agenda__standing-title">${escapeHtml(reminder.label)}</span>`
          + `<span class="cal-agenda__standing-cadence">every ${escapeHtml(String(reminder.intervalMinutes))} min</span>`
          + button({
            variant: 'ghost', size: 'sm', label: 'Done',
            ariaLabel: `Mark reminder done: ${reminder.label}`,
            dataset: { 'cal-reminder-dismiss': reminder.id },
          })
          + '</span>').join('')
        + '</div>'
      : '';

    return '<div class="cal-agenda" aria-label="Agenda for the week">'
      + groups.join('')
      + standingMarkup
      + '</div>';
  }

  // ---- natural-language quick-add ----

  // Single time token: "9am", "9:30am", "14:00", "9:30". A bare integer is NOT
  // matched (so "level 9 review" doesn't capture a phantom time).
  const TIME_TOKEN = /(\b\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b/gi;
  // Range with a single trailing meridiem: "9-10am", "9:30–10:30am", "1-3pm".
  // (Ranges where each side carries its own meridiem — "9am-10am" — fall to the
  // two-single-token path below.)
  const RANGE_TOKEN = /\b(\d{1,2})(?::(\d{2}))?\s*(?:-|–|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;

  function clock12ToMinutes(hour12, minute, meridiem) {
    if (hour12 < 1 || hour12 > 12 || minute > 59) {
      return null;
    }
    let hour = hour12 % 12;
    if (meridiem.toLowerCase() === 'pm') {
      hour += 12;
    }
    return hour * 60 + minute;
  }

  function tokenToMinutes(match) {
    if (match[3]) {
      return clock12ToMinutes(Number(match[1]), match[2] ? Number(match[2]) : 0, match[3]);
    }
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    if (hour > 23 || minute > 59) {
      return null;
    }
    return hour * 60 + minute;
  }

  function stripWords(text, pattern) {
    return text.replace(pattern, ' ');
  }

  // Collapse whitespace, then trim dangling connector/preposition words left by
  // token removal — but only at the EDGES, so interior words survive ("talk to
  // sam" keeps "to"; "lunch at" / "at lunch" lose the stray "at").
  function cleanTitle(text) {
    let t = String(text).replace(/[\s,]+/g, ' ').replace(/^[\s,–-]+|[\s,–-]+$/g, '').trim();
    const edge = /^(?:at|on|from|to|the|@)\s+|\s+(?:at|on|from|to|the|@)$/i;
    let prev;
    do {
      prev = t;
      t = t.replace(edge, '').trim();
    } while (t !== prev);
    return t;
  }

  /**
   * Deterministic, dependency-free parse of a quick-add phrase. Never throws.
   * @returns {{ok:boolean, ambiguous?:boolean, allDay?:boolean, title?:string,
   *   date?:string, start?:string, end?:string}}
   *   ok=false   -> nothing usable (empty / no title)
   *   ambiguous  -> title parsed but no time/all-day -> open the form prefilled
   *   otherwise  -> a complete descriptor ready for createEvent
   */
  function parseQuickAdd(text, now) {
    const raw = String(text || '').trim();
    const nowDate = now instanceof Date ? now : new Date();
    if (!raw) {
      return { ok: false };
    }
    let working = ` ${raw} `;
    let allDay = false;
    let day = null; // resolved local-day Date

    if (/\ball[\s-]?day\b/i.test(working)) {
      allDay = true;
      working = stripWords(working, /\ball[\s-]?day\b/gi);
    }

    if (/\btoday\b/i.test(working)) {
      day = startOfLocalDay(nowDate);
      working = stripWords(working, /\btoday\b/gi);
    } else if (/\btomorrow\b/i.test(working)) {
      day = addLocalDays(nowDate, 1);
      working = stripWords(working, /\btomorrow\b/gi);
    } else if (/\bnext\s+week\b/i.test(working)) {
      day = addLocalDays(nowDate, 7);
      working = stripWords(working, /\bnext\s+week\b/gi);
    } else {
      const weekdayMatch = /\b(sun|sunday|mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday)\b/i.exec(working);
      if (weekdayMatch) {
        const target = WEEKDAY_WORDS[weekdayMatch[1].toLowerCase()];
        const todayDow = nowDate.getDay();
        const ahead = (target - todayDow + 7) % 7; // today if same weekday
        day = addLocalDays(nowDate, ahead);
        working = working.slice(0, weekdayMatch.index) + ' ' + working.slice(weekdayMatch.index + weekdayMatch[0].length);
      }
    }

    // Time parsing: try a shared-meridiem range first ("9-10am"), else collect
    // up to two single tokens ("9am", "9am-10am", "9:00-9:30").
    const times = [];
    let invalidSharedRange = false;
    const rangeMatch = RANGE_TOKEN.exec(working);
    if (rangeMatch) {
      const meridiem = rangeMatch[5];
      let rangeStart = clock12ToMinutes(Number(rangeMatch[1]), rangeMatch[2] ? Number(rangeMatch[2]) : 0, meridiem);
      const rangeEnd = clock12ToMinutes(Number(rangeMatch[3]), rangeMatch[4] ? Number(rangeMatch[4]) : 0, meridiem);
      if (rangeStart !== null && rangeEnd !== null && rangeEnd <= rangeStart) {
        const inferredStart = clock12ToMinutes(
          Number(rangeMatch[1]),
          rangeMatch[2] ? Number(rangeMatch[2]) : 0,
          meridiem.toLowerCase() === 'pm' ? 'am' : 'pm'
        );
        if (inferredStart !== null && inferredStart < rangeEnd) {
          rangeStart = inferredStart;
        }
      }
      if (rangeStart !== null && rangeEnd !== null && rangeEnd > rangeStart) {
        times.push({ minutes: rangeStart, raw: rangeMatch[0] });
        times.push({ minutes: rangeEnd, raw: '' });
        working = working.replace(rangeMatch[0], ' ');
      } else {
        invalidSharedRange = true;
        working = working.replace(rangeMatch[0], ' ');
      }
    }
    if (!times.length && !invalidSharedRange) {
      let match;
      TIME_TOKEN.lastIndex = 0;
      while ((match = TIME_TOKEN.exec(working)) !== null && times.length < 2) {
        const minutes = tokenToMinutes(match);
        if (minutes !== null) {
          times.push({ minutes, raw: match[0] });
        }
      }
      for (const time of times) {
        working = working.replace(time.raw, ' ');
      }
    }

    const title = cleanTitle(working);
    if (!title) {
      return { ok: false };
    }

    if (!day) {
      day = startOfLocalDay(nowDate);
    }
    const dateStr = formatLocalDate(day);

    if (allDay) {
      return { ok: true, ambiguous: false, allDay: true, title, date: dateStr, start: '', end: '' };
    }

    if (!times.length) {
      // Title (and maybe a day) but no time — let the user pick it in the form.
      return { ok: true, ambiguous: true, allDay: false, title, date: dateStr, start: '', end: '' };
    }

    const startMin = times[0].minutes;
    const endMin = times.length > 1 && times[1].minutes > startMin
      ? times[1].minutes
      : Math.min(startMin + 60, 1439);
    return {
      ok: true,
      ambiguous: false,
      allDay: false,
      title,
      date: dateStr,
      start: minutesToHHMM(startMin),
      end: minutesToHHMM(endMin),
    };
  }

  // Overlap of a parsed timed descriptor against existing timed instances on
  // the same local day. All-day descriptors never report a conflict.
  function findConflicts(parsed, instances) {
    if (!parsed || parsed.ok !== true || parsed.allDay === true || !parsed.start) {
      return [];
    }
    const safeInstances = Array.isArray(instances) ? instances : [];
    const startMs = parseLocalDateTime(`${parsed.date}T${parsed.start}`)?.getTime();
    const endMs = parseLocalDateTime(`${parsed.date}T${parsed.end}`)?.getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return [];
    }
    const conflicts = [];
    for (const instance of safeInstances) {
      if (instance.allDay === true) {
        continue;
      }
      const iStart = parseLocalDateTime(instance.start);
      const iEnd = parseLocalDateTime(instance.end);
      if (!iStart || !iEnd) {
        continue;
      }
      if (iEnd.getTime() > startMs && iStart.getTime() < endMs) {
        conflicts.push({
          title: String(instance.title || '').trim() || '(no title)',
          timeLabel: formatTimeShort(iStart),
        });
      }
    }
    return conflicts;
  }

  function buildConflictNote(conflicts) {
    if (!conflicts.length) {
      return '';
    }
    const first = `${conflicts[0].title} (${conflicts[0].timeLabel})`;
    const more = conflicts.length > 1 ? ` +${conflicts.length - 1} more` : '';
    return `Overlaps ${first}${more}`;
  }

  /**
   * Collapsed quick-add affordance or its expanded text field + Add button,
   * plus optional conflict confirmation when a parsed slot overlaps an event.
   */
  function buildQuickAddMarkup({ value, pending, error, now, expanded = false, deps } = {}) {
    const textField = typeof deps?.textField === 'function'
      ? deps.textField
      : (typeof windowRef.inventoryTextField === 'function' ? windowRef.inventoryTextField : null);
    const button = resolveActionButton(deps);
    if (!textField || !button) {
      return '';
    }
    if (!expanded) {
      return '<div class="cal-quickadd" data-cal-quickadd="1">' + button({
        plain: true,
        className: 'cal-quickadd__affordance',
        ariaLabel: 'Expand quick add event',
        dataset: { 'cal-quickadd-expand': '1' },
        trustedHtml: '<span aria-hidden="true">＋</span><span>Add event — try &quot;standup Mon 9am&quot;</span>',
      }) + '</div>';
    }
    let suggest = '';
    if (pending && pending.parsed) {
      const p = pending.parsed;
      const day = parseLocalDateTime(`${p.date}T00:00`);
      const dayLabel = day ? formatAgendaDayLabel(day, now instanceof Date ? now : new Date()) : p.date;
      const timeLabel = p.allDay ? 'All day' : `${p.start}${p.end ? `–${p.end}` : ''}`;
      const conflictNote = buildConflictNote(Array.isArray(pending.conflicts) ? pending.conflicts : []);
      suggest = '<div class="cal-quickadd__suggest" role="status">'
        + '<div class="cal-quickadd__preview">'
        + `<span class="cal-quickadd__preview-title">${escapeHtml(p.title)}</span>`
        + `<span class="cal-quickadd__preview-when">${escapeHtml(`${dayLabel} · ${timeLabel}`)}</span>`
        + '</div>'
        + (conflictNote ? `<div class="cal-quickadd__conflict">${escapeHtml(conflictNote)}</div>` : '')
        + '<div class="cal-quickadd__suggest-actions">'
        + button({ variant: 'primary', label: 'Add anyway', dataset: { 'cal-quickadd-confirm': '1' } })
        + button({ variant: 'ghost', label: 'Edit', dataset: { 'cal-quickadd-edit': '1' } })
        + button({ variant: 'ghost', label: 'Dismiss', dataset: { 'cal-quickadd-dismiss': '1' } })
        + '</div>'
        + '</div>';
    }
    return '<div class="cal-quickadd" data-cal-quickadd="1">'
      + '<div class="cal-quickadd__bar">'
      + textField({
        id: 'calQuickAdd',
        ariaLabel: 'Quick add an event',
        placeholder: 'Add event — try "standup Mon 9am"',
        value: String(value || ''),
        maxLength: 200,
        spellcheck: true,
        className: 'cal-quickadd__input',
        dataset: { 'cal-quickadd-input': '1' },
      })
      + button({
        variant: 'secondary', label: 'Add',
        ariaLabel: 'Add event from text',
        dataset: { 'cal-quickadd-add': '1' },
      })
      + '</div>'
      + (error ? `<div class="cal-quickadd__error" role="alert">${escapeHtml(error)}</div>` : '')
      + suggest
      + '</div>';
  }

  return {
    buildAgendaMarkup,
    buildQuickAddMarkup,
    buildConflictNote,
    findConflicts,
    formatAgendaDayLabel,
    formatDuration,
    formatRelative,
    parseQuickAdd,
  };
});
