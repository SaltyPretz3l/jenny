/* Week time-grid markup for the Home dashboard calendar widget. Pure
 * functions: instances in, HTML string out — no state, no IPC, no listeners
 * (the calendar controller owns delegation). Columns run Sun..Sat — this module
 * owns computeWeekStart, the single week anchor every calendar surface calls.
 * Geometry is pixel-based on a
 * 1440px day canvas (1px per minute) inside a scrollable body, so block math
 * stays exact. Overlapping timed events split into side-by-side lanes via
 * greedy interval packing. Interactive nodes are inventory action-buttons
 * wrapped in positioned slot divs (raw form controls are forbidden here).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardCalendarGrid = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const {
    addLocalDays, formatLocalDate, formatTimeShort, parseLocalDateTime, startOfLocalDay,
  } = windowRef.rendererDashboardWidgetsCore
    || (typeof require === 'function' ? require('./renderer-dashboard-widgets-core') : {});

  const MINUTES_PER_DAY = 1440;
  const MIN_BLOCK_PX = 18;
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

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

  // Minutes since local midnight — the y-geometry unit of the 1px/min day canvas
  // (now-line offset, scroll anchor).
  function minutesOfDay(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  // CANONICAL week anchor for every calendar surface: Sunday-anchored (matches
  // the layout's Sun..Sat columns and the Daybook week strip). getDay() is
  // already 0 on Sunday, so the back-shift IS the weekday index — no rotation.
  // Do not copy this into a sibling module: the month grid and the rail both
  // call through here so the two can never drift.
  function computeWeekStart(reference, weekOffset = 0) {
    const day = startOfLocalDay(reference);
    return addLocalDays(day, -day.getDay() + weekOffset * 7);
  }

  function listWeekDays(weekStart) {
    return Array.from({ length: 7 }, (_, index) => addLocalDays(weekStart, index));
  }

  function formatWeekRangeLabel(weekStart) {
    const weekEnd = addLocalDays(weekStart, 6);
    const startLabel = `${weekStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    const endLabel = weekStart.getMonth() === weekEnd.getMonth()
      ? String(weekEnd.getDate())
      : weekEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${startLabel} – ${endLabel}`;
  }

  // Full, unabbreviated date for screen-reader labels ("Monday, June 9") so a
  // day column/header announces its date rather than the bare "Mon 9" text.
  function formatFullDateLabel(date) {
    return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }

  // Greedy interval lane packing: blocks sorted by start claim the first free
  // lane; every block in an overlap cluster shares the cluster's lane count.
  function assignDayLanes(blocks) {
    const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
    let cluster = [];
    let laneEnds = [];
    let clusterEnd = -1;
    const finalizeCluster = () => {
      for (const block of cluster) {
        block.laneCount = laneEnds.length;
      }
    };
    for (const block of sorted) {
      if (cluster.length && block.startMin >= clusterEnd) {
        finalizeCluster();
        cluster = [];
        laneEnds = [];
        clusterEnd = -1;
      }
      let lane = laneEnds.findIndex((end) => end <= block.startMin);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[lane] = block.endMin;
      block.lane = lane;
      cluster.push(block);
      clusterEnd = Math.max(clusterEnd, block.endMin);
    }
    finalizeCluster();
    return sorted;
  }

  function categoryClass(instance) {
    const categoryId = /^[a-z][a-z0-9-]*$/.test(String(instance.categoryId || ''))
      ? instance.categoryId
      : 'default';
    return `cal-event--${categoryId}`;
  }

  // showTime hides the visible time line on short blocks (where it would crowd
  // the title) WITHOUT dropping it from the accessible name — the aria-label
  // always carries the time so the event reads fully to assistive tech.
  function buildEventButton(actionButton, instance, timeLabel, showTime = true) {
    const readonly = instance.readonly === true;
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
    const title = String(instance.title || '').trim() || '(no title)';
    // Recurrence-unsupported (↻) and approximate-time (~) hints share one
    // corner marker; the title carries the full reason for assistive tech.
    const markerGlyphs = `${instance.recurrenceUnsupported === true ? '↻' : ''}`
      + `${instance.tzApprox === true ? '~' : ''}`;
    const markerTitle = [
      instance.recurrenceUnsupported === true ? 'Recurrence only partially supported' : '',
      instance.tzApprox === true ? 'Approximate time (unrecognized feed time zone)' : '',
    ].filter(Boolean).join('; ');
    const marker = markerGlyphs
      ? `<span class="cal-event__marker" title="${escapeHtml(markerTitle)}">${markerGlyphs}</span>`
      : '';
    return actionButton({
      plain: true,
      className: `cal-event ${categoryClass(instance)}${readonly ? ' cal-event--readonly' : ''}`,
      ariaLabel: timeLabel ? `${title}, ${timeLabel}` : title,
      title: instance.notes ? `${title}\n${String(instance.notes)}` : title,
      dataset,
      trustedHtml: ''
        + `<span class="cal-event__title">${escapeHtml(title)}</span>`
        + (timeLabel && showTime ? `<span class="cal-event__time">${escapeHtml(timeLabel)}</span>` : '')
        + marker,
    });
  }

  // Timed blocks for one day column: instances clipped to the day's bounds
  // (a multi-day timed event paints a clipped block in each day it crosses).
  function buildDayBlocks(actionButton, day, instances) {
    const dayStart = startOfLocalDay(day).getTime();
    const dayEnd = addLocalDays(day, 1).getTime();
    const blocks = [];
    for (const instance of instances) {
      if (instance.allDay) {
        continue;
      }
      const start = parseLocalDateTime(instance.start);
      const end = parseLocalDateTime(instance.end);
      if (!start || !end || end.getTime() <= dayStart || start.getTime() >= dayEnd) {
        continue;
      }
      const startMin = Math.max(0, Math.round((start.getTime() - dayStart) / 60000));
      const endMin = Math.min(MINUTES_PER_DAY, Math.round((end.getTime() - dayStart) / 60000));
      blocks.push({
        instance,
        startMin,
        endMin: Math.max(endMin, startMin + 1),
        timeLabel: formatTimeShort(start),
      });
    }
    return assignDayLanes(blocks).map((block) => {
      const heightPx = Math.max(block.endMin - block.startMin, MIN_BLOCK_PX);
      const widthPct = 100 / (block.laneCount || 1);
      const style = `top:${block.startMin}px;height:${heightPx}px;`
        + `left:${(block.lane * widthPct).toFixed(3)}%;width:${widthPct.toFixed(3)}%;`;
      return `<div class="cal-event-slot" style="${style}">`
        + buildEventButton(actionButton, block.instance, block.timeLabel, block.endMin - block.startMin >= 30)
        + '</div>';
    }).join('');
  }

  function buildAllDayChip(actionButton, instance) {
    return `<div class="cal-allday-chip">${buildEventButton(actionButton, instance, '')}</div>`;
  }

  function buildAllDayChips({ actionButton, chip, popover }, day, instances) {
    const dayStart = startOfLocalDay(day).getTime();
    const dayEnd = addLocalDays(day, 1).getTime();
    const dayInstances = [];
    for (const instance of instances) {
      if (!instance.allDay) {
        continue;
      }
      const start = parseLocalDateTime(instance.start);
      const end = parseLocalDateTime(instance.end);
      if (!start || !end || end.getTime() <= dayStart || start.getTime() >= dayEnd) {
        continue;
      }
      dayInstances.push(instance);
    }
    const visibleMarkup = dayInstances.slice(0, 3)
      .map((instance) => buildAllDayChip(actionButton, instance))
      .join('');
    const overflow = dayInstances.slice(3);
    if (!overflow.length) {
      return visibleMarkup;
    }
    // Missing/older inventory primitives must not make valid events unreachable.
    if (!chip || !popover) {
      return dayInstances.map((instance) => buildAllDayChip(actionButton, instance)).join('');
    }
    const dayKey = formatLocalDate(day);
    const fullLabel = formatFullDateLabel(day);
    const popoverId = `calAllDayPop-${dayKey}`;
    const count = overflow.length;
    return visibleMarkup + chip({
      label: `+${count} more`,
      hasPopup: true,
      ariaControls: popoverId,
      ariaLabel: `${count} more all-day event${count === 1 ? '' : 's'} on ${fullLabel}`,
      title: `${count} more all-day event${count === 1 ? '' : 's'} on ${fullLabel}`,
      className: 'cal-week__allday-more',
    }) + popover({
      domId: popoverId,
      ariaLabel: `More all-day events on ${fullLabel}`,
      className: 'cal-week__allday-pop',
      trustedHtml: overflow.map((instance) => buildAllDayChip(actionButton, instance)).join(''),
    });
  }

  function buildHourGutter() {
    const labels = [];
    for (let hour = 2; hour < 24; hour += 2) {
      const sample = new Date(2026, 0, 1, hour, 0);
      labels.push(
        `<span class="cal-week__hour" style="top:${hour * 60}px">${escapeHtml(formatTimeShort(sample))}</span>`
      );
    }
    return `<div class="cal-week__gutter" role="presentation" aria-hidden="true">${labels.join('')}</div>`;
  }

  function buildNowLine(day, now) {
    if (formatLocalDate(day) !== formatLocalDate(now)) {
      return '';
    }
    return `<div class="cal-week__now-line" style="top:${minutesOfDay(now)}px" aria-hidden="true"></div>`;
  }

  function computeWeekOffsetForDate(now, targetDate) {
    if (!(now instanceof Date) || !(targetDate instanceof Date)
      || Number.isNaN(now.getTime()) || Number.isNaN(targetDate.getTime())) {
      return 0;
    }
    const base = computeWeekStart(now, 0);
    const target = computeWeekStart(targetDate, 0);
    // Noon anchors keep DST transitions away from the subtraction endpoints;
    // rounding absorbs the one-hour seasonal offset without using UTC methods.
    const baseNoon = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 12);
    const targetNoon = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 12);
    return Math.round((targetNoon.getTime() - baseNoon.getTime()) / (7 * 24 * 60 * 60 * 1000));
  }

  /**
   * Full week-grid markup: header row, all-day band, scrollable 24h canvas.
   * @param {Object} opts
   * @param {Date} opts.weekStart Sunday of the rendered week
   * @param {Object[]} opts.instances expanded calendar instances
   * @param {Date} opts.now
   * @param {Function} [opts.actionButton] inventory primitive override
   * @param {Function} [opts.chip] inventory chip primitive override
   * @param {Function} [opts.popover] inventory popover primitive override
   */
  function buildCalendarGridMarkup({ weekStart, instances, now, actionButton, chip, popover } = {}) {
    const button = resolveActionButton({ actionButton });
    if (!button || !weekStart) {
      return '';
    }
    const safeInstances = Array.isArray(instances) ? instances : [];
    const nowDate = now instanceof Date ? now : new Date();
    const allDayDeps = {
      actionButton: button,
      chip: resolveChip({ chip }),
      popover: resolvePopover({ popover }),
    };
    const days = listWeekDays(weekStart);
    const todayKey = formatLocalDate(nowDate);
    const isEmpty = safeInstances.length === 0;

    const headerCells = days.map((day) => {
      const key = formatLocalDate(day);
      const weekend = day.getDay() === 0 || day.getDay() === 6;
      return `<div class="cal-week__head-cell${weekend ? ' cal-week__head-cell--weekend' : ''}" role="columnheader"`
        + ` aria-label="${escapeHtml(formatFullDateLabel(day))}"${key === todayKey ? ' data-today="true"' : ''}>`
        + `<span class="cal-week__head-name" aria-hidden="true">${DAY_NAMES[day.getDay()]}</span>`
        + `<span class="cal-week__head-date" aria-hidden="true">${day.getDate()}</span>`
        + '</div>';
    }).join('');

    const allDayCells = days.map((day) =>
      `<div class="cal-week__allday-cell${day.getDay() === 0 || day.getDay() === 6 ? ' cal-week__allday-cell--weekend' : ''}" role="gridcell"`
      + ` aria-label="${escapeHtml(`All-day events, ${formatFullDateLabel(day)}`)}"`
      + ` data-cal-day="${formatLocalDate(day)}">`
      + buildAllDayChips(allDayDeps, day, safeInstances)
      + '</div>'
    ).join('');

    const dayColumns = days.map((day) => {
      const key = formatLocalDate(day);
      const weekend = day.getDay() === 0 || day.getDay() === 6;
      return `<div class="cal-week__day${weekend ? ' cal-week__day--weekend' : ''}" role="gridcell"`
        + ` aria-label="${escapeHtml(formatFullDateLabel(day))}"`
        + ` data-cal-day="${key}"${key === todayKey ? ' data-today="true"' : ''}>`
        + '<span class="cal-week__offhours cal-week__offhours--before" aria-hidden="true"></span>'
        + '<span class="cal-week__offhours cal-week__offhours--after" aria-hidden="true"></span>'
        + buildDayBlocks(button, day, safeInstances)
        + buildNowLine(day, nowDate)
        + '</div>';
    }).join('');

    // A free week shows a centered prompt in place of the tall canvas so it
    // reads as open space (and is visible without scrolling), never as a load
    // failure or a bare grid.
    const scrollBody = isEmpty
      ? '<div class="cal-week__empty">'
        + '<span class="cal-week__empty-title">No events this week</span>'
        + '<span class="cal-week__empty-hint">Use New or press n to add one</span>'
        + '</div>'
      : '<div class="cal-week__scroll" data-cal-scroll="1" role="presentation">'
        + `<div class="cal-week__canvas" role="row">${buildHourGutter()}${dayColumns}</div>`
        + '</div>';

    return ''
      + `<div class="cal-week" role="grid"`
      + ` aria-label="${escapeHtml(`Week calendar, ${formatWeekRangeLabel(weekStart)}`)}"`
      + ` data-week-start="${formatLocalDate(weekStart)}">`
      + '<div class="cal-week__header" role="row">'
      + '<div class="cal-week__gutter-spacer" role="presentation"></div>'
      + `${headerCells}</div>`
      + '<div class="cal-week__allday" role="row">'
      + '<div class="cal-week__gutter-spacer cal-week__allday-label" role="rowheader">all-day</div>'
      + `${allDayCells}</div>`
      + scrollBody
      + '</div>';
  }

  return {
    MINUTES_PER_DAY,
    assignDayLanes,
    buildCalendarGridMarkup,
    computeWeekStart,
    computeWeekOffsetForDate,
    formatFullDateLabel,
    formatLocalDate,
    formatTimeShort,
    formatWeekRangeLabel,
    listWeekDays,
    minutesOfDay,
    parseLocalDateTime,
  };
});
