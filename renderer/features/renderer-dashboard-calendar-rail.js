/* Left-rail markup and projections for the Home dashboard calendar. The rail
 * derives entirely from the visible week and current snapshot; it owns no
 * independent navigation or persistence state.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardCalendarRail = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};
  // Sunday-first single letters, matching grid.js's computeWeekStart anchor —
  // the mini-month and the week strip both index straight off this array.
  const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const MAX_STRIP_DOTS = 3;

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function resolveActionButton(actionButton) {
    if (typeof actionButton === 'function') {
      return actionButton;
    }
    return typeof windowRef.inventoryActionButton === 'function'
      ? windowRef.inventoryActionButton
      : null;
  }

  function addLocalDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
  }

  function startOfLocalDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
  }

  function categoryClass(instance) {
    const id = /^[a-z][a-z0-9-]*$/.test(String(instance?.categoryId || ''))
      ? instance.categoryId
      : 'default';
    return `cal-event--${id}`;
  }

  function instanceOverlapsDay(instance, day, gridModule) {
    const start = gridModule.parseLocalDateTime(instance?.start);
    const end = gridModule.parseLocalDateTime(instance?.end);
    if (!start || !end) {
      return false;
    }
    const dayStart = startOfLocalDay(day).getTime();
    const dayEnd = addLocalDays(day, 1).getTime();
    return end.getTime() > dayStart && start.getTime() < dayEnd;
  }

  function findUpNext(instances, now, gridModule) {
    return (Array.isArray(instances) ? instances : [])
      .filter((instance) => {
        if (instance.allDay === true || !instanceOverlapsDay(instance, now, gridModule)) {
          return false;
        }
        const end = gridModule.parseLocalDateTime(instance.end);
        return end && end.getTime() > now.getTime();
      })
      .sort((a, b) => String(a.start).localeCompare(String(b.start)))[0] || null;
  }

  function formatRelative(now, start) {
    const minutes = Math.round((start.getTime() - now.getTime()) / 60000);
    if (minutes <= 0) return 'now';
    if (minutes < 60) return `in ${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
  }

  function buildUpNextMarkup({ instances, now, gridModule, compact = false } = {}) {
    if (!gridModule || !(now instanceof Date)) {
      return '';
    }
    const instance = findUpNext(instances, now, gridModule);
    if (!instance) {
      return '';
    }
    const start = gridModule.parseLocalDateTime(instance.start);
    const end = gridModule.parseLocalDateTime(instance.end);
    if (!start || !end) {
      return '';
    }
    const title = String(instance.title || '').trim() || '(no title)';
    const time = `${gridModule.formatTimeShort(start)} – ${gridModule.formatTimeShort(end)}`;
    if (compact) {
      return '<div class="cal-compact-up-next">'
        + '<span class="cal-rail__eyebrow">Up next</span>'
        + `<span class="cal-compact-up-next__text">${escapeHtml(title)} · ${escapeHtml(time)} · <span data-cal-rel="1" data-cal-start="${escapeHtml(instance.start)}">${escapeHtml(formatRelative(now, start))}</span></span>`
        + '</div>';
    }
    return '<section class="cal-rail__section cal-rail__up-next">'
      + '<div class="cal-rail__eyebrow">Up next</div>'
      + `<div class="cal-rail__up-next-title">${escapeHtml(title)}</div>`
      + `<div class="cal-rail__up-next-meta">${escapeHtml(time)} · <span data-cal-rel="1" data-cal-start="${escapeHtml(instance.start)}">${escapeHtml(formatRelative(now, start))}</span></div>`
      + '</section>';
  }

  function chooseDayCategory(instances) {
    const counts = new Map();
    let best = null;
    for (let index = 0; index < instances.length; index += 1) {
      const instance = instances[index];
      const id = String(instance.categoryId || 'default');
      const current = counts.get(id) || { count: 0, firstIndex: index, instance };
      current.count += 1;
      counts.set(id, current);
      if (!best || current.count > best.count
        || (current.count === best.count && current.firstIndex < best.firstIndex)) {
        best = current;
      }
    }
    return best?.instance || null;
  }

  function buildMiniMonth({ weekStart, instances, now, selectedDayKey, actionButton, gridModule } = {}) {
    const button = resolveActionButton(actionButton);
    if (!button || !gridModule || !(weekStart instanceof Date)) {
      return '';
    }
    const rangeAnchor = addLocalDays(weekStart, 3);
    const monthDate = new Date(rangeAnchor.getFullYear(), rangeAnchor.getMonth(), 1);
    const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
    const gridStart = gridModule.computeWeekStart(monthDate, 0);
    const finalWeekStart = gridModule.computeWeekStart(monthEnd, 0);
    const dayCount = Math.round((startOfLocalDay(finalWeekStart) - startOfLocalDay(gridStart)) / 86400000) + 7;
    const todayKey = gridModule.formatLocalDate(now);
    const days = [];
    for (let index = 0; index < dayCount; index += 1) {
      const day = addLocalDays(gridStart, index);
      const dayKey = gridModule.formatLocalDate(day);
      const dayInstances = (Array.isArray(instances) ? instances : [])
        .filter((instance) => instanceOverlapsDay(instance, day, gridModule))
        .sort((a, b) => String(a.start).localeCompare(String(b.start)));
      const dotInstance = chooseDayCategory(dayInstances);
      const outside = day.getMonth() !== monthDate.getMonth();
      const fullLabel = gridModule.formatFullDateLabel(day);
      days.push(button({
        plain: true,
        className: `cal-rail-month__day${outside ? ' cal-rail-month__day--outside' : ''}`,
        ariaPressed: dayKey === selectedDayKey,
        ariaLabel: `${dayKey === todayKey ? 'Today, ' : ''}${fullLabel}, ${dayInstances.length} event${dayInstances.length === 1 ? '' : 's'}`,
        dataset: { 'cal-day-cell': dayKey },
        trustedHtml: `<span class="cal-rail-month__number${dayKey === todayKey ? ' cal-rail-month__number--today' : ''}">${day.getDate()}</span>`
          + `<span class="cal-rail-month__dot ${dotInstance ? categoryClass(dotInstance) : ''}" aria-hidden="true"></span>`,
      }));
    }
    const weekdays = WEEKDAY_LABELS.map((label) => `<span>${label}</span>`).join('');
    return '<section class="cal-rail__section cal-rail-month">'
      + '<div class="cal-rail-month__heading">'
      + `<span class="cal-rail__eyebrow">${escapeHtml(monthDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))}</span>`
      + '<span class="cal-rail-month__nav">'
      + button({ variant: 'ghost', size: 'sm', label: '‹', ariaLabel: 'Previous month', dataset: { 'cal-rail-nav': 'prev' } })
      + button({ variant: 'ghost', size: 'sm', label: '›', ariaLabel: 'Next month', dataset: { 'cal-rail-nav': 'next' } })
      + '</span></div>'
      + `<div class="cal-rail-month__weekdays" aria-hidden="true">${weekdays}</div>`
      + `<div class="cal-rail-month__grid" role="group" aria-label="Jump to a date">${days.join('')}</div>`
      + '</section>';
  }

  // Distinct category ids for a day, in first-appearance order, capped so a busy
  // day shows a legible cluster instead of a smear.
  function stripDotCategories(dayInstances) {
    const seen = [];
    for (const instance of dayInstances) {
      const id = String(instance?.categoryId || 'default');
      if (!seen.includes(id)) {
        seen.push(id);
      }
      if (seen.length >= MAX_STRIP_DOTS) {
        break;
      }
    }
    return seen;
  }

  function listStripDays(weekStart, weekInstances, gridModule) {
    const safeInstances = Array.isArray(weekInstances) ? weekInstances : [];
    return Array.from({ length: 7 }, (_, index) => {
      const day = addLocalDays(weekStart, index);
      const dayInstances = safeInstances
        .filter((instance) => instanceOverlapsDay(instance, day, gridModule))
        .sort((a, b) => String(a.start).localeCompare(String(b.start)));
      return {
        day,
        index,
        dayKey: gridModule.formatLocalDate(day),
        count: dayInstances.length,
        dots: stripDotCategories(dayInstances),
      };
    });
  }

  /**
   * Seven-cell week strip that lives INSIDE the Daybook agenda card. Cells reuse
   * the mini-month's `data-cal-day-cell` hook, so the calendar controller's
   * existing delegation selects a day (and re-anchors the week) for free.
   */
  function buildWeekStripMarkup({
    weekStart, weekInstances, now, selectedDayKey, actionButton, gridModule,
  } = {}) {
    const button = resolveActionButton(actionButton);
    if (!button || !gridModule || !(weekStart instanceof Date)) {
      return '';
    }
    const todayKey = now instanceof Date ? gridModule.formatLocalDate(now) : '';
    const cells = listStripDays(weekStart, weekInstances, gridModule).map((entry) => {
      const isToday = entry.dayKey === todayKey;
      const dots = entry.dots
        .map((id) => `<span class="cal-week-strip__dot ${categoryClass({ categoryId: id })}"></span>`)
        .join('');
      return button({
        plain: true,
        className: `cal-week-strip__day${isToday ? ' cal-week-strip__day--today' : ''}`
          + `${entry.dayKey === selectedDayKey ? ' cal-week-strip__day--selected' : ''}`,
        ariaPressed: entry.dayKey === selectedDayKey,
        ariaLabel: `${isToday ? 'Today, ' : ''}${gridModule.formatFullDateLabel(entry.day)}`
          + `, ${entry.count} event${entry.count === 1 ? '' : 's'}`,
        dataset: { 'cal-day-cell': entry.dayKey },
        trustedHtml: `<span class="cal-week-strip__letter" aria-hidden="true">${WEEKDAY_LABELS[entry.index]}</span>`
          + `<span class="cal-week-strip__num" aria-hidden="true">${entry.day.getDate()}</span>`
          + `<span class="cal-week-strip__dots" aria-hidden="true">${dots}</span>`,
      });
    });
    return '<div class="cal-week-strip" role="group" aria-label="Jump to a day this week">'
      + cells.join('')
      + '</div>';
  }

  // Repaint key for the strip: the anchor, today, the selection, and each day's
  // count + dot categories. Without it a category change inside an unchanged
  // week would leave stale dots on screen.
  function computeWeekStripDigest({ weekStart, weekInstances, now, selectedDayKey, gridModule } = {}) {
    if (!gridModule || !(weekStart instanceof Date)) {
      return null;
    }
    return [
      gridModule.formatLocalDate(weekStart),
      now instanceof Date ? gridModule.formatLocalDate(now) : '',
      String(selectedDayKey || ''),
      listStripDays(weekStart, weekInstances, gridModule)
        .map((entry) => [entry.dayKey, entry.count, entry.dots]),
    ];
  }

  function buildAgendaSummary({ weekInstances, categories, configFeeds, feeds, actionButton } = {}) {
    const button = resolveActionButton(actionButton);
    if (!button) {
      return '';
    }
    const safeInstances = Array.isArray(weekInstances) ? weekInstances : [];
    const categoryCounts = new Map();
    safeInstances.forEach((instance) => {
      const id = String(instance.categoryId || 'default');
      categoryCounts.set(id, (categoryCounts.get(id) || 0) + 1);
    });
    const categoryRows = (Array.isArray(categories) ? categories : [])
      .filter((category) => categoryCounts.has(String(category.id)))
      .map((category) => '<div class="cal-rail__summary-row">'
        + `<span class="cal-rail__summary-dot ${categoryClass({ categoryId: category.id })}" aria-hidden="true"></span>`
        + `<span>${escapeHtml(category.label || category.id)}</span>`
        + `<span class="cal-rail__summary-count">${categoryCounts.get(String(category.id))}</span>`
        + '</div>');
    const metaById = new Map((Array.isArray(feeds) ? feeds : []).map((feed) => [String(feed.id), feed]));
    const feedRows = (Array.isArray(configFeeds) ? configFeeds : []).map((feed, index) => {
      const meta = metaById.get(String(feed.id));
      const ok = meta?.ok === true && !meta?.warning;
      const status = ok ? '✓' : '!';
      return button({
        plain: true,
        className: 'cal-rail__feed-row',
        ariaLabel: `Manage feed ${feed.name || feed.id}, ${ok ? 'healthy' : 'needs attention'}`,
        dataset: {
          'cal-feeds-toggle': '1',
          'cal-feed-id': String(feed.id || ''),
          'cal-feed-focus': `feed-${index}`,
        },
        trustedHtml: '<span class="cal-rail__feed-icon" aria-hidden="true">◔</span>'
          + `<span>${escapeHtml(feed.name || feed.id)}</span>`
          + `<span class="cal-rail__feed-status" data-state="${ok ? 'ok' : 'warning'}" aria-hidden="true">${status}</span>`,
      });
    });
    if (!categoryRows.length && !feedRows.length) {
      return '';
    }
    return '<section class="cal-rail__section cal-rail__summary">'
      + '<div class="cal-rail__eyebrow">This week</div>'
      + categoryRows.join('')
      + feedRows.join('')
      + '</section>';
  }

  function formatBookedMinutes(minutes) {
    const safe = Math.max(0, Math.round(minutes));
    const hours = Math.floor(safe / 60);
    const rest = safe % 60;
    return hours ? `${hours}h${rest ? ` ${rest}m` : ''}` : `${rest}m`;
  }

  function buildWeekSummary({ weekStart, weekInstances, actionButton, gridModule } = {}) {
    const button = resolveActionButton(actionButton);
    if (!button || !gridModule || !(weekStart instanceof Date)) {
      return '';
    }
    const weekEnd = addLocalDays(weekStart, 7);
    const safeInstances = Array.isArray(weekInstances) ? weekInstances : [];
    let bookedMinutes = 0;
    safeInstances.forEach((instance) => {
      if (instance.allDay === true) return;
      const start = gridModule.parseLocalDateTime(instance.start);
      const end = gridModule.parseLocalDateTime(instance.end);
      if (!start || !end) return;
      const clippedStart = Math.max(start.getTime(), weekStart.getTime());
      const clippedEnd = Math.min(end.getTime(), weekEnd.getTime());
      bookedMinutes += Math.max(0, clippedEnd - clippedStart) / 60000;
    });
    const allDay = safeInstances.filter((instance) => instance.allDay === true);
    const allDayRows = allDay.map((instance) => {
      const title = String(instance.title || '').trim() || '(no title)';
      const dataset = { 'cal-instance': '1' };
      if (instance.instanceId) dataset['cal-instance-id'] = String(instance.instanceId);
      if (instance.readonly === true) dataset['cal-readonly'] = '1';
      else if (instance.eventId) dataset['cal-event-id'] = String(instance.eventId);
      return button({
        plain: true,
        className: `cal-rail__allday-row ${categoryClass(instance)}`,
        ariaLabel: `${title}, all day${instance.readonly === true ? ', read-only' : ''}`,
        dataset,
        trustedHtml: '<span class="cal-rail__summary-dot" aria-hidden="true"></span>'
          + `<span>${escapeHtml(title)}</span>`,
      });
    });
    return '<section class="cal-rail__section cal-rail__week-summary">'
      + '<div class="cal-rail__eyebrow">This week</div>'
      + `<div class="cal-rail__booked">${safeInstances.length} event${safeInstances.length === 1 ? '' : 's'} · ${escapeHtml(formatBookedMinutes(bookedMinutes))} booked</div>`
      + (allDayRows.length
        ? `<div class="cal-rail__allday"><div class="cal-rail__eyebrow">All day</div>${allDayRows.join('')}</div>`
        : '')
      + '</section>';
  }

  function buildRailMarkup(opts = {}) {
    const gridModule = opts.gridModule || windowRef.rendererDashboardCalendarGrid || null;
    if (!gridModule || opts.mode === 'month') {
      return '';
    }
    const upNext = buildUpNextMarkup({ ...opts, gridModule });
    if (opts.mode === 'week') {
      return '<aside class="cal-rail" aria-label="Calendar summary">'
        + upNext
        + buildWeekSummary({ ...opts, gridModule })
        + '</aside>';
    }
    return '<aside class="cal-rail" aria-label="Calendar navigation and summary">'
      + buildMiniMonth({ ...opts, gridModule })
      + upNext
      + buildAgendaSummary(opts)
      + '</aside>';
  }

  function buildCompactUpNextMarkup(opts = {}) {
    const gridModule = opts.gridModule || windowRef.rendererDashboardCalendarGrid || null;
    if (!gridModule || opts.mode === 'month') {
      return '';
    }
    return buildUpNextMarkup({ ...opts, compact: true, gridModule });
  }

  function computeRailDigest({ weekStart, instances, weekInstances, categories, configFeeds, feeds, mode, gridModule, now } = {}) {
    if (!gridModule || mode === 'month') {
      return null;
    }
    const rangeAnchor = weekStart instanceof Date ? addLocalDays(weekStart, 3) : null;
    const monthKey = rangeAnchor ? `${rangeAnchor.getFullYear()}-${rangeAnchor.getMonth() + 1}` : '';
    const visibleMonthInstances = mode === 'agenda' && rangeAnchor
      ? (Array.isArray(instances) ? instances : []).filter((instance) => {
        const key = String(instance.start || '').slice(0, 7);
        const adjacentStart = new Date(rangeAnchor.getFullYear(), rangeAnchor.getMonth() - 1, 1);
        const adjacentEnd = new Date(rangeAnchor.getFullYear(), rangeAnchor.getMonth() + 1, 1);
        return key >= `${adjacentStart.getFullYear()}-${String(adjacentStart.getMonth() + 1).padStart(2, '0')}`
          && key <= `${adjacentEnd.getFullYear()}-${String(adjacentEnd.getMonth() + 1).padStart(2, '0')}`;
      })
      : [];
    const upNext = now instanceof Date ? findUpNext(instances, now, gridModule) : null;
    return [
      monthKey,
      upNext ? [upNext.instanceId, upNext.start, upNext.end, upNext.title] : null,
      visibleMonthInstances.map((instance) => [instance.instanceId, instance.start, instance.end, instance.categoryId]),
      (Array.isArray(weekInstances) ? weekInstances : []).map((instance) => [
        instance.instanceId, instance.start, instance.end, instance.title, instance.categoryId, instance.allDay,
      ]),
      (Array.isArray(categories) ? categories : []).map((category) => [category.id, category.label]),
      (Array.isArray(configFeeds) ? configFeeds : []).map((feed) => [feed.id, feed.name]),
      (Array.isArray(feeds) ? feeds : []).map((feed) => [feed.id, feed.ok, feed.warning]),
    ];
  }

  return {
    buildCompactUpNextMarkup,
    buildMiniMonth,
    buildRailMarkup,
    buildWeekStripMarkup,
    chooseDayCategory,
    computeRailDigest,
    computeWeekStripDigest,
    findUpNext,
    formatBookedMinutes,
  };
});
