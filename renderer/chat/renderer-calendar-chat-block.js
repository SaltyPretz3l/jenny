(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererCalendarChatBlock = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };


  const DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  const CATEGORY_PATTERN = /^[a-z][a-z0-9-]*$/;
  const MAX_INSTANCES = 40;
  const MAX_OVERLAPS = 8;
  const MAX_VISIBLE_ROWS = 12;
  const MS_PER_MINUTE = 60 * 1000;

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    try {
      const prototype = Object.getPrototypeOf(value);
      return prototype === Object.prototype || prototype === null;
    } catch (_error) {
      return false;
    }
  }

  function safeString(value) {
    if (value == null || typeof value === 'symbol') return '';
    try {
      return String(value).trim();
    } catch (_error) {
      return '';
    }
  }

  function nonNegativeInteger(value) {
    try {
      const numeric = Number(value);
      return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : 0;
    } catch (_error) {
      return 0;
    }
  }

  function normalizeDateTime(value) {
    const normalized = safeString(value);
    if (!DATE_TIME_PATTERN.test(normalized)) return '';
    const core = resolveDateCore();
    const parsed = core.parseLocalDateTime(normalized);
    if (!parsed) return '';
    const rebuilt = `${core.formatLocalDate(parsed)}T${core.pad2(parsed.getHours())}:${core.pad2(parsed.getMinutes())}`;
    return rebuilt === normalized ? normalized : '';
  }

  function normalizeOverlap(value) {
    if (!isPlainObject(value)) return null;
    const start = normalizeDateTime(value.start);
    if (!start) return null;
    return {
      instance_id: safeString(value.instance_id),
      title: safeString(value.title),
      start,
    };
  }

  function normalizeOverlaps(value) {
    if (!Array.isArray(value)) return [];
    const overlaps = [];
    for (const entry of value) {
      if (overlaps.length >= MAX_OVERLAPS) break;
      const normalized = normalizeOverlap(entry);
      if (normalized) overlaps.push(normalized);
    }
    return overlaps;
  }

  function normalizeInstance(value) {
    if (!isPlainObject(value)) return null;
    const start = normalizeDateTime(value.start);
    if (!start) return null;
    return {
      instance_id: safeString(value.instance_id),
      event_id: safeString(value.event_id),
      title: safeString(value.title),
      start,
      end: normalizeDateTime(value.end),
      all_day: value.all_day === true,
      category: safeString(value.category) || 'default',
      source: safeString(value.source),
      source_kind: safeString(value.source_kind),
      readonly: value.readonly === true,
      tz_approx: value.tz_approx === true,
      recurrence_unsupported: value.recurrence_unsupported === true,
      kind: safeString(value.kind) || 'event',
      recent: safeString(value.recent),
      journal_entry_id: safeString(value.journal_entry_id),
      overlaps: normalizeOverlaps(value.overlaps),
    };
  }
  function normalizeCalendarMetadata(value) {
    if (!isPlainObject(value) || value.schema_version !== 1) return null;
    const rangeStart = normalizeDateTime(value.range_start);
    const rangeEnd = normalizeDateTime(value.range_end);
    if (!rangeStart || !rangeEnd || rangeEnd <= rangeStart) return null;
    const instances = [];
    if (Array.isArray(value.instances)) {
      for (const entry of value.instances) {
        if (instances.length >= MAX_INSTANCES) break;
        const normalized = normalizeInstance(entry);
        if (normalized) instances.push(normalized);
      }
    }
    return {
      schema_version: 1,
      range_start: rangeStart,
      range_end: rangeEnd,
      generated_at: normalizeDateTime(value.generated_at),
      instance_count: nonNegativeInteger(value.instance_count),
      omitted_count: nonNegativeInteger(value.omitted_count),
      instances,
    };
  }

  function normalizeReceiptMetadata(value) {
    if (!isPlainObject(value) || value.schema_version !== 1) return null;
    const kind = safeString(value.kind);
    const op = safeString(value.op);
    const id = safeString(value.id);
    const start = normalizeDateTime(value.start);
    const scheduleType = safeString(value.schedule_type);
    const rawWhen = safeString(value.when);
    let when = '';
    if (scheduleType === 'once_at') when = normalizeDateTime(rawWhen);
    if (scheduleType === 'daily_at' && /^\d{2}:\d{2}$/.test(rawWhen)) when = rawWhen;
    if (scheduleType === 'interval_minutes' && /^[1-9]\d*$/.test(rawWhen)) when = rawWhen;
    if (!['event', 'reminder'].includes(kind) || !['create', 'update', 'delete'].includes(op) || !id
      || (kind === 'event' && safeString(value.start) && !start)) return null;
    return {
      schema_version: 1,
      kind,
      op,
      id,
      title: safeString(value.title),
      start,
      end: normalizeDateTime(value.end),
      all_day: value.all_day === true,
      category: safeString(value.category) || 'default',
      schedule_type: scheduleType,
      when,
      journal_entry_id: safeString(value.journal_entry_id),
      journaled: value.journaled === true,
    };
  }

  function resolveDateCore() {
    return globalThis.rendererDashboardWidgetsCore
      || (typeof require === 'function' ? require('../features/renderer-dashboard-widgets-core') : {});
  }

  function parseDateKey(value) {
    const normalized = safeString(value);
    if (!DATE_PATTERN.test(normalized)) return null;
    const [year, month, day] = normalized.split('-').map(Number);
    const parsed = new Date(year, month - 1, day);
    const core = resolveDateCore();
    return core.formatLocalDate?.(parsed) === normalized ? parsed : null;
  }

  function parseLocalDateTime(value) {
    if (!DATE_TIME_PATTERN.test(safeString(value))) return null;
    return resolveDateCore().parseLocalDateTime?.(value) || null;
  }

  function formatDayHeading(dayKey, now) {
    const day = parseDateKey(dayKey);
    if (!day || !(now instanceof Date) || Number.isNaN(now.getTime())) return '';
    const core = resolveDateCore();
    const todayKey = core.formatLocalDate(now);
    const tomorrowKey = core.formatLocalDate(core.addLocalDays(now, 1));
    const datePart = day.toLocaleDateString(globalThis.jennyI18n?.tag?.(), {
      weekday: 'short', month: 'short', day: 'numeric',
    });
    const withYear = day.getFullYear() === now.getFullYear()
      ? datePart
      : `${datePart}, ${day.getFullYear()}`;
    if (dayKey === todayKey) return jt("calendarChatBlock.todayValue", "Today · {value1}", { value1: String(withYear) });
    if (dayKey === tomorrowKey) return jt("calendarChatBlock.tomorrowValue", "Tomorrow · {value1}", { value1: String(withYear) });
    return withYear;
  }

  function formatRangePart(date, includeYear) {
    return date.toLocaleDateString(globalThis.jennyI18n?.tag?.(), {
      month: 'short', day: 'numeric', ...(includeYear ? { year: 'numeric' } : {}),
    });
  }

  function lastIncludedDate(rangeEnd, wholeDaysOnly = false) {
    const end = parseLocalDateTime(rangeEnd);
    if (end && wholeDaysOnly) end.setHours(0, 0, 0, 0);
    // Subtract from the instant, rather than a fixed day, to honor local DST.
    return end ? new Date(end.getTime() - 1) : null;
  }

  function formatRangeLabel(rangeStart, rangeEnd, now) {
    const start = parseLocalDateTime(rangeStart);
    const end = lastIncludedDate(rangeEnd);
    if (!start || !end || end < start || !(now instanceof Date) || Number.isNaN(now.getTime())) return '';
    const currentYear = now.getFullYear();
    if (resolveDateCore().formatLocalDate(start) === resolveDateCore().formatLocalDate(end)) {
      return formatRangePart(start, start.getFullYear() !== currentYear);
    }
    const bothCurrentYear = start.getFullYear() === currentYear && end.getFullYear() === currentYear;
    if (!bothCurrentYear) return `${formatRangePart(start, true)} – ${formatRangePart(end, true)}`;
    if (start.getMonth() !== end.getMonth()) {
      return `${formatRangePart(start, false)} – ${formatRangePart(end, false)}`;
    }
    const startLabel = formatRangePart(start, false);
    return `${startLabel}–${end.getDate()}`;
  }

  function compareForAgenda(left, right) {
    if (left.all_day !== right.all_day) return left.all_day ? -1 : 1;
    if (left.start !== right.start) return left.start < right.start ? -1 : 1;
    if (left.instance_id !== right.instance_id) return left.instance_id < right.instance_id ? -1 : 1;
    if (left.title === right.title) return 0;
    return left.title < right.title ? -1 : 1;
  }

  function weekdayShort(dayKey) {
    return parseDateKey(dayKey)?.toLocaleDateString(globalThis.jennyI18n?.tag?.(), { weekday: 'short' }) || '';
  }

  function buildTail(lastDayKey, rangeEndKey) {
    const lastDay = parseDateKey(lastDayKey);
    const rangeEnd = parseDateKey(rangeEndKey);
    if (!lastDay || !rangeEnd || rangeEnd <= lastDay) return '';
    const core = resolveDateCore();
    const firstSkipped = core.addLocalDays(lastDay, 1);
    const firstKey = core.formatLocalDate(firstSkipped);
    const firstLabel = weekdayShort(firstKey);
    const endLabel = weekdayShort(rangeEndKey);
    return firstKey === rangeEndKey
      ? jt("calendarChatBlock.valueNothingScheduled", "{value1} · nothing scheduled", { value1: String(firstLabel) })
      : jt("calendarChatBlock.valueValueNothingScheduled", "{value1}–{value2} · nothing scheduled", { value1: String(firstLabel), value2: String(endLabel) });
  }

  function isPastRow(entry, dayKey, todayKey, now) {
    if (dayKey !== todayKey || entry.kind === 'reminder' || entry.all_day) return false;
    const end = parseLocalDateTime(entry.end);
    return Boolean(end && end < now);
  }

  function planVisibleRows(calendar, now) {
    const normalized = normalizeCalendarMetadata(calendar);
    const current = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    if (!normalized) {
      return { earlierCount: 0, days: [], remaining: 0, tail: '', empty: true, firstDayKey: '', rangeLabel: '' };
    }
    const core = resolveDateCore();
    const todayKey = core.formatLocalDate(current);
    const groups = new Map();
    let earlierCount = 0;
    for (const entry of normalized.instances) {
      const dayKey = entry.start.slice(0, 10);
      if (dayKey < todayKey) {
        earlierCount += 1;
        continue;
      }
      if (!groups.has(dayKey)) groups.set(dayKey, []);
      groups.get(dayKey).push(entry);
    }
    const eligibleCount = [...groups.values()].reduce((total, entries) => total + entries.length, 0);
    const days = [];
    let renderedCount = 0;
    for (const dayKey of [...groups.keys()].sort()) {
      if (renderedCount >= MAX_VISIBLE_ROWS) break;
      const available = MAX_VISIBLE_ROWS - renderedCount;
      const rows = groups.get(dayKey).sort(compareForAgenda).slice(0, available)
        .map((entry) => ({ ...entry, isPast: isPastRow(entry, dayKey, todayKey, current) }));
      const reminderCount = rows.filter((entry) => entry.kind === 'reminder').length;
      days.push({
        dayKey,
        heading: formatDayHeading(dayKey, current),
        eventCount: rows.length - reminderCount,
        reminderCount,
        rows,
      });
      renderedCount += rows.length;
    }
    const remaining = eligibleCount - renderedCount + normalized.omitted_count;
    const rangeStartKey = normalized.range_start.slice(0, 10);
    const rangeEndKey = core.formatLocalDate(lastIncludedDate(normalized.range_end));
    const tailEndKey = core.formatLocalDate(lastIncludedDate(normalized.range_end, true));
    const firstDayKey = days[0]?.dayKey || rangeStartKey;
    const lastRenderedKey = days.at(-1)?.dayKey
      || (rangeStartKey <= todayKey && rangeEndKey >= todayKey ? todayKey : rangeStartKey);
    return {
      earlierCount,
      days,
      remaining,
      tail: remaining === 0 ? buildTail(lastRenderedKey, tailEndKey) : '',
      empty: renderedCount === 0 && earlierCount === 0,
      firstDayKey,
      rangeLabel: formatRangeLabel(normalized.range_start, normalized.range_end, current),
    };
  }

  function fallbackEscapeHtml(value) {
    return safeString(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function resolveDeps(deps) {
    const options = deps || {};
    return {
      escapeHtml: typeof options.escapeHtml === 'function' ? options.escapeHtml : fallbackEscapeHtml,
      now: options.now instanceof Date && !Number.isNaN(options.now.getTime()) ? options.now : new Date(),
      actionButton: typeof options.actionButton === 'function'
        ? options.actionButton
        : globalThis.inventoryActionButton,
      hasLiveJournalEntry: typeof options.hasLiveJournalEntry === 'function'
        ? options.hasLiveJournalEntry
        : () => undefined,
    };
  }

  function eventCount(count) {
    return jtn('dashboard.calendar.agenda.eventCount', count, { count }, '{count} event', '{count} events');
  }

  function categoryClass(value) {
    const category = safeString(value);
    return CATEGORY_PATTERN.test(category) ? category : 'default';
  }

  function formatTime(value) {
    const parsed = parseLocalDateTime(value);
    return parsed ? resolveDateCore().formatTimeShort(parsed) : '';
  }

  function formatDuration(entry) {
    if (entry.all_day || entry.kind === 'reminder') return '';
    const start = parseLocalDateTime(entry.start);
    const end = parseLocalDateTime(entry.end);
    if (!start || !end || end <= start) return '';
    const minutes = Math.max(1, Math.round((end.getTime() - start.getTime()) / MS_PER_MINUTE));
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (!hours) return `${minutes}m`;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }

  function overlapText(entry) {
    const first = entry.overlaps[0];
    if (!first) return '';
    const title = first.title || jt("dashboard.calendar.agenda.noTitle", "(no title)");
    const time = formatTime(first.start);
    const additional = entry.overlaps.length > 1 ? ` +${entry.overlaps.length - 1}` : '';
    return jt("calendarChatBlock.overlapsValueValueValue", "overlaps {value1}{value2}{value3}", { value1: String(title), value2: String(time ? ` (${time})` : ''), value3: String(additional) });
  }

  function buildRowMeta(entry, escapeHtml) {
    const parts = [];
    const duration = formatDuration(entry);
    if (duration) parts.push(`<span class="cal-chat__duration">${escapeHtml(duration)}</span>`);
    if (entry.kind === 'reminder') {
      parts.push(`<span class="cal-chat__badge" title="${escapeHtml(jt("dashboard.calendar.agenda.reminderManualNudges", "Reminder — nudges are manual"))}">${escapeHtml(jt("calendarChatBlock.reminderBadge", "reminder"))}</span>`);
    } else {
      if (entry.source === 'feed') parts.push(`<span class="cal-chat__badge" title="${escapeHtml(jt("dashboard.calendar.agenda.subscribedFeedEvent", "Subscribed feed event"))}">${escapeHtml(jt("calendarChatBlock.feedBadge", "feed"))}</span>`);
      if (entry.tz_approx) parts.push(`<span class="cal-chat__badge" title="${escapeHtml(jt("dashboard.calendar.agenda.approximateFeedTime", "Approximate time (unrecognized feed time zone)"))}">~tz</span>`);
      if (entry.recurrence_unsupported) parts.push(`<span class="cal-chat__badge" title="${escapeHtml(jt("dashboard.calendar.agenda.partialRecurrence", "Recurrence only partially supported"))}">↻</span>`);
    }
    if (entry.source_kind === 'assistant') {
      parts.push(`<span class="cal-chat__jenny" title="${escapeHtml(jt("dashboard.calendar.agenda.addedByJenny", "Added by jenny"))}">${escapeHtml(jt("calendarChatBlock.jennyBadge", "jenny"))}</span>`);
    }
    if (entry.recent === 'created' || entry.recent === 'updated') {
      parts.push(`<span class="cal-chat__new">${entry.recent === 'created' ? 'new' : 'updated'}</span>`);
    }
    const overlap = overlapText(entry);
    if (overlap) parts.push(`<span class="cal-chat__overlap">${escapeHtml(overlap)}</span>`);
    return parts.join('');
  }

  function journalWasEvicted(hasLiveJournalEntry, journalEntryId) {
    try {
      return hasLiveJournalEntry(journalEntryId) === false;
    } catch (_error) {
      return false;
    }
  }

  function buildUndo(actionButton, entry, hasLiveJournalEntry) {
    if (!entry.journal_entry_id) return '';
    const title = entry.title || jt("dashboard.calendar.agenda.noTitle", "(no title)");
    const dataset = { 'cal-undo-journal': entry.journal_entry_id };
    if (journalWasEvicted(hasLiveJournalEntry, entry.journal_entry_id)) dataset['cal-undo-evicted'] = '1';
    return actionButton({
      variant: 'ghost',
      size: 'sm',
      label: jt("dashboard.calendar.agenda.undo", "Undo"),
      className: 'cal-chat__undo',
      ariaLabel: jt("calendarChatBlock.undoJennySChangeToValue", "Undo jenny's change to {value1}", { value1: String(title) }),
      title: jt("calendarChatBlock.undoJennySChangeToValue", "Undo jenny's change to {value1}", { value1: String(title) }),
      dataset,
    });
  }

  function buildCalendarRow(entry, day, options) {
    const { actionButton, escapeHtml, hasLiveJournalEntry } = options;
    const title = entry.title || jt("dashboard.calendar.agenda.noTitle", "(no title)");
    const time = entry.all_day ? jt("dashboard.calendar.agenda.allDay", "All day") : formatTime(entry.start);
    const overlap = overlapText(entry);
    const state = entry.recent === 'created' ? 'new' : entry.recent;
    const ariaParts = [title, day.heading, entry.all_day ? jt("calendarChatBlock.allDay2", "all day") : time];
    if (state === 'new' || state === 'updated') ariaParts.push(state);
    if (overlap) ariaParts.push(overlap);
    if (entry.readonly) ariaParts.push('read-only');
    const classes = [
      'cal-chat__row',
      `cal-event--${categoryClass(entry.category)}`,
      entry.isPast ? 'cal-chat__row--past' : '',
      entry.source === 'feed' ? 'cal-chat__row--feed' : '',
      entry.kind === 'reminder' ? 'cal-chat__row--reminder' : '',
      entry.all_day ? 'cal-chat__row--all-day' : '',
    ].filter(Boolean).join(' ');
    const dataset = {
      'cal-open-day': day.dayKey,
      'cal-instance-id': entry.instance_id,
    };
    if (entry.source === 'local' && entry.event_id) dataset['cal-event-id'] = entry.event_id;
    const row = actionButton({
      plain: true,
      className: classes,
      ariaLabel: ariaParts.join(', '),
      title,
      dataset,
      trustedHtml: `<span class="cal-chat__time">${escapeHtml(time || jt("dashboard.calendar.agenda.allDay", "All day"))}</span>`
        + '<span class="cal-chat__dot" aria-hidden="true"></span>'
        + `<span class="cal-chat__title">${escapeHtml(title)}</span>`
        + `<span class="cal-chat__meta">${buildRowMeta(entry, escapeHtml)}</span>`,
    });
    return `<div class="cal-chat__row-wrap">${row}${buildUndo(actionButton, entry, hasLiveJournalEntry)}</div>`;
  }

  function buildDayMarkup(day, todayKey, options) {
    const reminderSuffix = day.reminderCount
      ? jtn('dashboard.calendar.agenda.reminderCountSuffix', day.reminderCount, { count: day.reminderCount }, ' · {count} reminder', ' · {count} reminders')
      : '';
    const count = `${eventCount(day.eventCount)}${reminderSuffix}`;
    const headingClass = day.dayKey === todayKey ? ' cal-chat__day--today' : '';
    return `<div class="cal-chat__day${headingClass}" role="heading" aria-level="4">`
      + `<span class="cal-chat__day-label">${options.escapeHtml(day.heading)}</span>`
      + '<span class="cal-chat__day-rule" aria-hidden="true"></span>'
      + `<span class="cal-chat__day-count">${options.escapeHtml(count)}</span>`
      + '</div>'
      + day.rows.map((entry) => buildCalendarRow(entry, day, options)).join('');
  }

  function buildFooter(plan, options) {
    const more = plan.remaining > 0
      ? `<span class="cal-chat__more">${options.escapeHtml(jt("calendarChatBlock.valueMore", "{value1} more", { value1: String(plan.remaining) }))}</span>`
      : '';
    const openHome = options.actionButton({
      plain: true,
      className: 'cal-chat__open-home',
      label: jt("scratchpad.pin.openInHome", "Open in Home"),
      title: jt("calendarChatBlock.openTheHomeCalendarOnThisDay", "Open the Home calendar on this day"),
      ariaLabel: jt("scratchpad.pin.openInHome", "Open in Home"),
      dataset: { 'cal-open-day': plan.firstDayKey },
    });
    return `<div class="cal-chat__foot">${more}${openHome}</div>`;
  }

  function buildCalendarBlockMarkup(calendar, deps) {
    const normalized = normalizeCalendarMetadata(calendar);
    const options = resolveDeps(deps);
    if (!normalized || typeof options.actionButton !== 'function') return '';
    const plan = planVisibleRows(normalized, options.now);
    const todayKey = resolveDateCore().formatLocalDate(options.now);
    const body = [];
    if (plan.earlierCount > 0) {
      body.push(`<div class="cal-chat__quiet">${options.escapeHtml(jt('calendarChatBlock.earlierEvents', 'Earlier · {events}', { events: eventCount(plan.earlierCount) }))}</div>`);
    }
    if (plan.empty) {
      body.push(`<div class="cal-chat__quiet">${options.escapeHtml(jt('calendarChatBlock.noEventsInRange', 'No events {range}.', { range: plan.rangeLabel }))}</div>`);
    } else {
      body.push(...plan.days.map((day) => buildDayMarkup(day, todayKey, options)));
      if (plan.tail) body.push(`<div class="cal-chat__quiet">${options.escapeHtml(plan.tail)}</div>`);
    }
    body.push(buildFooter(plan, options));
    const aria = jt("calendarChatBlock.calendarValueValue", "Calendar, {value1}, {value2}", { value1: String(plan.rangeLabel), value2: String(eventCount(normalized.instance_count)) });
    return `<div class="cal-chat" role="group" aria-label="${options.escapeHtml(aria)}" data-cal-chat="list"`
      + ` data-cal-range-start="${options.escapeHtml(normalized.range_start.slice(0, 10))}">${body.join('')}</div>`;
  }

  function formatReceiptDay(date, now) {
    const base = date.toLocaleDateString(globalThis.jennyI18n?.tag?.(), { weekday: 'short', month: 'short', day: 'numeric' });
    return date.getFullYear() === now.getFullYear() ? base : `${base}, ${date.getFullYear()}`;
  }

  function formatReceiptWhen(receipt, now) {
    if (receipt.kind === 'reminder') {
      if (receipt.schedule_type === 'interval_minutes') {
        const minutes = Number(receipt.when);
        if (!Number.isSafeInteger(minutes) || minutes <= 0) return '';
        return minutes % 60 === 0 ? jt("calendarChatBlock.everyValueH", "Every {value1} h", { value1: String(minutes / 60) }) : jt("calendarChatBlock.everyValueMin", "Every {value1} min", { value1: String(minutes) });
      }
      if (receipt.schedule_type === 'daily_at' && /^\d{2}:\d{2}$/.test(receipt.when)) {
        return jt("calendarChatBlock.dailyValue", "Daily · {value1}", { value1: String(formatTime(`2000-01-01T${receipt.when}`)) });
      }
      if (receipt.schedule_type !== 'once_at') return '';
      const once = parseLocalDateTime(receipt.when);
      return once ? `${formatReceiptDay(once, now)} · ${formatTime(receipt.when)}` : '';
    }
    const start = parseLocalDateTime(receipt.start);
    if (!start) return '';
    const day = formatReceiptDay(start, now);
    if (receipt.all_day) return jt("calendarChatBlock.valueAllDay", "{value1} · All day", { value1: String(day) });
    const startTime = formatTime(receipt.start);
    const end = parseLocalDateTime(receipt.end);
    const endTime = end && end > start ? `–${formatTime(receipt.end)}` : '';
    return `${day} · ${startTime}${endTime}`;
  }

  const RECEIPT_VERBS = { create: 'Added', update: 'Updated', delete: 'Deleted' };

  function receiptDayKey(receipt) {
    if (receipt.kind === 'reminder') {
      return receipt.schedule_type === 'once_at' ? receipt.when.slice(0, 10) : '';
    }
    return receipt.start.slice(0, 10);
  }

  function buildReceiptMeta(receipt, escapeHtml) {
    const parts = [];
    if (receipt.kind !== 'reminder' && receipt.category !== 'default') {
      parts.push(`<span class="cal-chat__badge">${escapeHtml(receipt.category)}</span>`);
    }
    if (receipt.kind === 'reminder') {
      parts.push(`<span class="cal-chat__badge" title="${escapeHtml(jt("dashboard.calendar.agenda.reminderManualNudges", "Reminder — nudges are manual"))}">${escapeHtml(jt("calendarChatBlock.reminderBadge", "reminder"))}</span>`);
    }
    if (receipt.op === 'delete') parts.push('<span class="cal-chat__badge">deleted</span>');
    parts.push(`<span class="cal-chat__jenny" title="${escapeHtml(jt("dashboard.calendar.agenda.addedByJenny", "Added by jenny"))}">${escapeHtml(jt("calendarChatBlock.jennyBadge", "jenny"))}</span>`);
    return parts.join('');
  }

  function buildReceiptMarkup(receipt, deps) {
    const normalized = normalizeReceiptMetadata(receipt);
    const options = resolveDeps(deps);
    if (!normalized || typeof options.actionButton !== 'function') return '';
    const title = normalized.title || jt("dashboard.calendar.agenda.noTitle", "(no title)");
    const when = formatReceiptWhen(normalized, options.now);
    const dayKey = receiptDayKey(normalized);
    const classes = [
      'cal-chat__row',
      'cal-chat__row--receipt',
      `cal-event--${categoryClass(normalized.category)}`,
      normalized.kind === 'reminder' ? 'cal-chat__row--reminder' : '',
      normalized.op === 'delete' ? 'cal-chat__row--deleted' : '',
    ].filter(Boolean).join(' ');
    const dataset = dayKey ? { 'cal-open-day': dayKey } : {};
    const row = options.actionButton({
      plain: true,
      className: classes,
      ariaLabel: `${RECEIPT_VERBS[normalized.op]} ${normalized.kind}: ${title}${when ? `, ${when}` : ''}`,
      title,
      dataset,
      trustedHtml: '<span class="cal-chat__dot" aria-hidden="true"></span>'
        + `<span class="cal-chat__title">${options.escapeHtml(title)}</span>`
        + `<span class="cal-chat__when">${options.escapeHtml(when)}</span>`
        + `<span class="cal-chat__meta">${buildReceiptMeta(normalized, options.escapeHtml)}</span>`,
    });
    const undo = normalized.journaled
      ? buildUndo(options.actionButton, normalized, options.hasLiveJournalEntry)
      : '';
    return `<div class="cal-chat cal-chat--receipt" data-cal-chat="receipt" data-cal-receipt-op="${options.escapeHtml(normalized.op)}">`
      + `<div class="cal-chat__row-wrap">${row}${undo}</div></div>`;
  }

  function buildHomeResultBlockMarkup(metadata, deps) {
    try {
      if (!isPlainObject(metadata) || metadata.result_kind !== 'home') return '';
      if (safeString(metadata.status) === 'confirmation_required') return '';
      const calendar = normalizeCalendarMetadata(metadata.calendar);
      if (calendar) return buildCalendarBlockMarkup(calendar, deps);
      const receipt = normalizeReceiptMetadata(metadata.calendar_receipt);
      return receipt ? buildReceiptMarkup(receipt, deps) : '';
    } catch (_error) {
      return '';
    }
  }

  return {
    buildHomeResultBlockMarkup,
    buildCalendarBlockMarkup,
    buildReceiptMarkup,
    planVisibleRows,
    formatDayHeading,
    formatRangeLabel,
    normalizeCalendarMetadata,
    normalizeReceiptMetadata,
  };
});
