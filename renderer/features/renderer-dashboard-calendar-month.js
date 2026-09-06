/* Month markup for the Home dashboard calendar widget: an Outlook-style
 * continuous vertical scroll of Sunday-start week rows, one cell per day
 * (empty days included). Pure builders — instances in, HTML string out, no
 * state / no IPC / no listeners (the controller owns delegation via the same
 * data-cal-instance hooks the agenda/week views emit). A few tiny imperative
 * helpers (scroll anchor / nav scroll / slot-from-day / range label) are
 * exported for the controller to call one-line. Multi-day events render as a
 * per-day line on each day they cover (matching the week view's per-day clip
 * model); overflow beyond a small cap collapses into a "+N more" chip that
 * opens an inline popover listing the day's events. Interactive nodes are
 * inventory primitives (raw form controls are forbidden here).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardCalendarMonth = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const {
    addLocalDays, formatLocalDate, formatTimeShort, parseLocalDateTime, startOfLocalDay,
  } = windowRef.rendererDashboardWidgetsCore
    || (typeof require === 'function' ? require('./renderer-dashboard-widgets-core') : {});
  const motionPreferenceUtils = (typeof globalThis !== 'undefined' && globalThis.rendererMotionPreferenceUtils)
    || (typeof require === 'function' ? require('../shared/renderer-motion-preference-utils') : null)
    || {};
  // UIUX-030: sole smooth-scroll gate — 'auto' (instant) under prefers-reduced-motion.
  const resolveScrollBehavior = typeof motionPreferenceUtils.resolveScrollBehavior === 'function'
    ? motionPreferenceUtils.resolveScrollBehavior
    : function fallbackResolveScrollBehavior() { return 'smooth'; };

  const DEFAULT_MAX_CHIPS = 3;
  // Sunday-first, matching grid.js's computeWeekStart anchor. The weekend test
  // below is POSITIONAL against this array, so the two must move together.
  const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WINDOW_PAST_DAYS = 7; // fallback window when the snapshot omits bounds
  const WINDOW_FUTURE_DAYS = 60;

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

  function resolveChip(deps) {
    if (typeof deps?.chip === 'function') {
      return deps.chip;
    }
    return typeof windowRef.inventoryChip === 'function' ? windowRef.inventoryChip : null;
  }

  function resolvePopover(deps) {
    if (typeof deps?.popover === 'function') {
      return deps.popover;
    }
    return typeof windowRef.inventoryPopover === 'function' ? windowRef.inventoryPopover : null;
  }

  // Accepts "YYYY-MM-DD" or a full "...THH:MM" stamp (window bounds arrive as
  // the latter; tolerate the former for safety).
  function parseLocalDay(value) {
    const direct = parseLocalDateTime(value);
    if (direct) {
      return direct;
    }
    return parseLocalDateTime(`${String(value || '')}T00:00`);
  }

  // The week anchor is NOT duplicated here: renderer-dashboard-calendar-grid.js
  // owns computeWeekStart (Sunday-anchored), and this module calls through to
  // it. A private copy is exactly how the month grid and the week grid drifted
  // apart before — the cross-module agreement test guards this seam.
  function resolveGridModule() {
    return windowRef.rendererDashboardCalendarGrid
      || (typeof require === 'function' ? require('./renderer-dashboard-calendar-grid') : null);
  }

  function computeWeekStart(reference) {
    return resolveGridModule().computeWeekStart(reference, 0);
  }

  function categoryClass(instance) {
    const categoryId = /^[a-z][a-z0-9-]*$/.test(String(instance.categoryId || ''))
      ? instance.categoryId
      : 'default';
    return `cal-event--${categoryId}`;
  }

  // All-day events lead the day; then by start string, then title. (Twin of the
  // agenda's comparator, which isn't exported.)
  function compareForCell(a, b) {
    if ((a.allDay === true) !== (b.allDay === true)) {
      return a.allDay === true ? -1 : 1;
    }
    if (String(a.start) !== String(b.start)) {
      return String(a.start) < String(b.start) ? -1 : 1;
    }
    return String(a.title || '') < String(b.title || '') ? -1 : 1;
  }

  /**
   * Span of week rows to render for a snapshot window.
   * @param {string} windowStart local-naive start bound ("YYYY-MM-DDT00:00")
   * @param {string} windowEnd   local-naive end bound (exclusive)
   * @returns {{ gridStart: Date, weekCount: number }} gridStart is the Sunday of
   *   the week containing windowStart; weekCount covers windowEnd.
   */
  function computeMonthSpan(windowStart, windowEnd) {
    const startBound = parseLocalDay(windowStart) || addLocalDays(startOfLocalDay(new Date()), -WINDOW_PAST_DAYS);
    const endBound = parseLocalDay(windowEnd) || addLocalDays(startOfLocalDay(new Date()), WINDOW_FUTURE_DAYS + 1);
    const gridStart = computeWeekStart(startBound);
    let weekCount = 0;
    let cursor = gridStart;
    // Step Sundays until one lands at/after the end bound; the row that contains
    // the end bound is the last one rendered.
    while (cursor.getTime() <= endBound.getTime()) {
      weekCount += 1;
      cursor = addLocalDays(cursor, 7);
    }
    return { gridStart, weekCount: Math.max(1, weekCount) };
  }

  // Bucket every instance into each local day it covers (half-open end, so a
  // Jun10T00:00->Jun12T00:00 all-day lands on Jun 10 + 11, not Jun 12). O(events
  // * days-spanned), built once per render — never re-filtered per cell.
  function bucketByDay(instances, gridStart, weekCount) {
    const byDay = new Map();
    const spanStartMs = gridStart.getTime();
    const spanEndMs = addLocalDays(gridStart, weekCount * 7).getTime();
    for (const instance of instances) {
      const start = parseLocalDateTime(instance.start);
      const end = parseLocalDateTime(instance.end);
      if (!start || !end) {
        continue;
      }
      const endMs = end.getTime();
      let cursor = startOfLocalDay(start);
      if (cursor.getTime() < spanStartMs) {
        cursor = new Date(spanStartMs);
      }
      while (cursor.getTime() < endMs && cursor.getTime() < spanEndMs) {
        const key = formatLocalDate(cursor);
        const bucket = byDay.get(key);
        if (bucket) {
          bucket.push(instance);
        } else {
          byDay.set(key, [instance]);
        }
        cursor = addLocalDays(cursor, 1);
      }
    }
    return byDay;
  }

  // One event line — same data-cal-instance/-id/-event-id dataset the agenda and
  // week views emit, so the controller's shared click handler opens the form.
  function buildMonthEvent(button, instance) {
    const readonly = instance.readonly === true;
    const title = String(instance.title || '').trim() || '(no title)';
    const start = parseLocalDateTime(instance.start);
    const timeLabel = instance.allDay ? 'All day' : (start ? formatTimeShort(start) : '');
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
    const markerGlyphs = `${instance.recurrenceUnsupported === true ? '↻' : ''}`
      + `${instance.tzApprox === true ? '~' : ''}`;
    const markerTitle = [
      instance.recurrenceUnsupported === true ? 'Recurrence only partially supported' : '',
      instance.tzApprox === true ? 'Approximate time (unrecognized feed time zone)' : '',
    ].filter(Boolean).join('; ');
    const marker = markerGlyphs
      ? `<span class="cal-event__marker" title="${escapeHtml(markerTitle)}">${markerGlyphs}</span>`
      : '';
    const labelBits = [title, timeLabel].filter(Boolean).join(', ') + (readonly ? ', read-only' : '');
    return button({
      plain: true,
      className: `cal-month__event ${categoryClass(instance)}${readonly ? ' cal-event--readonly' : ''}`,
      ariaLabel: labelBits,
      title: instance.notes ? `${title}\n${String(instance.notes)}` : title,
      dataset,
      trustedHtml: ''
        + '<span class="cal-month__event-dot" aria-hidden="true"></span>'
        + (timeLabel && !instance.allDay ? `<span class="cal-month__event-time">${escapeHtml(timeLabel)}</span>` : '')
        + `<span class="cal-month__event-title">${escapeHtml(title)}</span>`
        + marker,
    });
  }

  function buildDayCell(deps, day, dayInstances, ctx) {
    const { button, chip, popover } = deps;
    const { todayKey, todayStartMs, windowStartMs, windowEndMs, maxChipsPerCell } = ctx;
    const dayKey = formatLocalDate(day);
    const sorted = dayInstances.slice().sort(compareForCell);
    const shown = sorted.slice(0, maxChipsPerCell);
    const overflow = sorted.slice(maxChipsPerCell);
    const isToday = dayKey === todayKey;
    const isPast = day.getTime() < todayStartMs;
    const isOutside = day.getTime() < windowStartMs || day.getTime() >= windowEndMs;
    const isFirstOfMonth = day.getDate() === 1;
    const isWeekend = day.getDay() === 0 || day.getDay() === 6;
    const fullLabel = day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    const count = sorted.length;

    const numHtml = `<span class="cal-month__daynum">`
      + (isFirstOfMonth
        ? `<span class="cal-month__daynum-mon">${escapeHtml(day.toLocaleDateString(undefined, { month: 'short' }))}</span> `
        : '')
      + `${day.getDate()}</span>`;

    let eventsHtml = shown.map((instance) => buildMonthEvent(button, instance)).join('');
    if (overflow.length && chip && popover) {
      const popDomId = `calMonthPop-${dayKey}`;
      eventsHtml += chip({
        label: `+${overflow.length} more`,
        hasPopup: true,
        ariaControls: popDomId,
        ariaLabel: `${overflow.length} more event${overflow.length === 1 ? '' : 's'} on ${fullLabel}`,
        title: `${overflow.length} more event${overflow.length === 1 ? '' : 's'} on ${fullLabel}`,
        className: 'cal-month__more',
      });
      eventsHtml += popover({
        domId: popDomId,
        ariaLabel: `Events on ${fullLabel}`,
        className: 'cal-month__pop',
        trustedHtml: sorted.map((instance) => buildMonthEvent(button, instance)).join(''),
      });
    }

    const className = 'cal-month__cell'
      + (isPast ? ' cal-month__cell--past' : '')
      + (isOutside ? ' cal-month__cell--outside' : '')
      + (isWeekend ? ' cal-month__cell--weekend' : '');
    return `<div class="${className}" role="gridcell"`
      + ` data-cal-month-day="${escapeHtml(dayKey)}"`
      + ` aria-label="${escapeHtml(`${fullLabel}, ${count} event${count === 1 ? '' : 's'}`)}"`
      + (isToday ? ' data-today="true"' : '')
      + '>'
      + numHtml
      + `<div class="cal-month__events">${eventsHtml}</div>`
      + '</div>';
  }

  /**
   * Build the continuous-scroll month markup.
   * @param {Object} opts
   * @param {Date} opts.gridStart Sunday of the first rendered week
   * @param {number} opts.weekCount consecutive week rows
   * @param {Object[]} opts.instances FULL-window expanded instances
   * @param {Date} opts.now
   * @param {string} [opts.windowStart] snapshot bound (for out-of-window dimming)
   * @param {string} [opts.windowEnd]
   * @param {Function} [opts.actionButton]
   * @param {Function} [opts.chip]
   * @param {Function} [opts.popover]
   * @param {number} [opts.maxChipsPerCell=3]
   * @returns {string} HTML string
   */
  function buildMonthMarkup(opts = {}) {
    const button = resolveActionButton(opts);
    if (!button || !(opts.gridStart instanceof Date) || !(opts.weekCount > 0)) {
      return '';
    }
    const deps = { button, chip: resolveChip(opts), popover: resolvePopover(opts) };
    const gridStart = startOfLocalDay(opts.gridStart);
    const weekCount = Math.max(1, Math.floor(opts.weekCount));
    const safeInstances = Array.isArray(opts.instances) ? opts.instances : [];
    const nowDate = opts.now instanceof Date ? opts.now : new Date();
    const windowStartDate = parseLocalDay(opts.windowStart);
    const windowEndDate = parseLocalDay(opts.windowEnd);
    const ctx = {
      todayKey: formatLocalDate(nowDate),
      todayStartMs: startOfLocalDay(nowDate).getTime(),
      windowStartMs: windowStartDate ? startOfLocalDay(windowStartDate).getTime() : -Infinity,
      windowEndMs: windowEndDate ? startOfLocalDay(windowEndDate).getTime() : Infinity,
      maxChipsPerCell: Number.isFinite(opts.maxChipsPerCell) ? opts.maxChipsPerCell : DEFAULT_MAX_CHIPS,
    };
    const byDay = bucketByDay(safeInstances, gridStart, weekCount);

    const headerCells = WEEKDAY_LABELS
      .map((label, index) => `<span class="cal-month__weekday${index === 0 || index === 6 ? ' cal-month__weekday--weekend' : ''}" role="columnheader">${label}</span>`)
      .join('');

    const rows = [];
    for (let week = 0; week < weekCount; week += 1) {
      const rowStart = addLocalDays(gridStart, week * 7);
      const rowEnd = addLocalDays(rowStart, 7);
      const hasToday = ctx.todayStartMs >= rowStart.getTime() && ctx.todayStartMs < rowEnd.getTime();
      const cells = [];
      for (let col = 0; col < 7; col += 1) {
        const day = addLocalDays(rowStart, col);
        cells.push(buildDayCell(deps, day, byDay.get(formatLocalDate(day)) || [], ctx));
      }
      rows.push(`<div class="cal-month__week" role="row" data-cal-month-week="${escapeHtml(formatLocalDate(rowStart))}"`
        + (hasToday ? ' data-cal-month-today="1"' : '')
        + `>${cells.join('')}</div>`);
    }

    // The weekday header lives INSIDE the scroll container as a sticky row so it
    // shares the cells' width context (columns align exactly, no scrollbar-width
    // drift) and stays pinned while the weeks scroll under it.
    return '<div class="cal-month">'
      + '<div class="cal-month__scroll" data-cal-scroll="1" role="grid" aria-label="Month calendar, scroll for more weeks">'
      + `<div class="cal-month__weekdays" role="row">${headerCells}</div>`
      + rows.join('')
      + '</div>'
      + '</div>';
  }

  // ---- imperative helpers the controller calls (layout-dependent; jsdom has no
  // layout, so offsetTop/offsetHeight are 0 there — verified in the real app) ----

  // Scroll offset that lands today's week just below the sticky header (one row
  // of lead so the prior week peeks).
  function defaultScrollTop(scrollEl) {
    if (!scrollEl || typeof scrollEl.querySelector !== 'function') {
      return 0;
    }
    const todayRow = scrollEl.querySelector('[data-cal-month-today]');
    if (!todayRow) {
      return 0;
    }
    const lead = todayRow.offsetHeight || 0;
    return Math.max(0, (todayRow.offsetTop || 0) - lead);
  }

  function navScroll(scrollEl, direction) {
    if (!scrollEl) {
      return;
    }
    if (direction === 'today') {
      const top = defaultScrollTop(scrollEl);
      if (typeof scrollEl.scrollTo === 'function') {
        scrollEl.scrollTo({ top, behavior: resolveScrollBehavior(null, windowRef) });
      } else {
        scrollEl.scrollTop = top;
      }
      return;
    }
    const row = scrollEl.querySelector('[data-cal-month-week]');
    const rowHeight = (row && row.offsetHeight) || 120;
    const delta = (direction === 'next' ? 1 : -1) * rowHeight * 4;
    if (typeof scrollEl.scrollBy === 'function') {
      scrollEl.scrollBy({ top: delta, behavior: resolveScrollBehavior(null, windowRef) });
    } else {
      scrollEl.scrollTop = Math.max(0, (scrollEl.scrollTop || 0) + delta);
    }
  }

  // A day-cell click creates at 09:00 local on that day (the empty-cell create
  // affordance). Rejects malformed or rolled dates (e.g. Feb 30).
  function slotFromDay(dayKey) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ''));
    if (!match) {
      return null;
    }
    const date = new Date(+match[1], +match[2] - 1, +match[3], 9, 0);
    if (Number.isNaN(date.getTime())
      || date.getFullYear() !== +match[1]
      || date.getMonth() !== +match[2] - 1
      || date.getDate() !== +match[3]) {
      return null;
    }
    return date;
  }

  function formatRangeLabel(date) {
    const value = date instanceof Date ? date : new Date();
    return value.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  return {
    buildMonthMarkup,
    computeMonthSpan,
    defaultScrollTop,
    navScroll,
    slotFromDay,
    formatRangeLabel,
  };
});
