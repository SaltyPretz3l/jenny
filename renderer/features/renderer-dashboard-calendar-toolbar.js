/* Header markup for the Home dashboard calendar widget. Pure function: the
 * live region, range label, Agenda|Week|Month view toggle, navigation, New,
 * and overflow popover — HTML string out, no state, no IPC, no
 * listeners (the controller owns delegation via the data-* hooks). Split out of
 * the controller to keep it under the per-file line ceiling. Interactive nodes
 * are inventory action-buttons (raw form controls are forbidden here).
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardCalendarToolbar = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};
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

  // Range label: the week navigator shows the visible week ("Jun 9 – 15");
  // month mode has no single week, so it shows the anchor month ("June 2026")
  // derived from "now" (the today-anchored default view).
  function rangeLabel({ weekStart, now, mode, gridModule, monthModule }) {
    if (mode === 'month' && monthModule && typeof monthModule.formatRangeLabel === 'function') {
      return monthModule.formatRangeLabel(now);
    }
    return gridModule ? gridModule.formatWeekRangeLabel(weekStart) : '';
  }

  function buildToolbarMarkup({ weekStart, feeds, mode, now, actionButton, popover: popoverOverride, gridModule, monthModule } = {}) {
    const button = resolveActionButton({ actionButton });
    const popover = popoverOverride
      || (typeof windowRef.inventoryPopover === 'function' ? windowRef.inventoryPopover : null);
    if (!button || !gridModule || !popover) {
      return '';
    }
    const safeFeeds = Array.isArray(feeds) ? feeds : [];
    const warnings = safeFeeds
      .filter((feed) => feed.warning)
      .map((feed) => `${feed.name || feed.id}: ${feed.warning}`);
    const overflowId = 'calToolbarOverflow';
    return ''
      // Visually-hidden polite live region: navigation and mutation outcomes are
      // announced here so screen-reader users perceive changes without hunting
      // for the range label (WCAG 4.1.3).
      + '<span class="cal-sr-live" role="status" aria-live="polite" aria-atomic="true" data-cal-announce="1"></span>'
      + '<div class="cal-toolbar">'
      + '<div class="cal-toolbar__heading">'
      + '<span class="cal-toolbar__eyebrow">Calendar</span>'
      + `<span class="cal-toolbar__range">${escapeHtml(rangeLabel({ weekStart, now, mode, gridModule, monthModule }))}</span>`
      + '</div>'
      + '<div class="cal-toolbar__actions">'
      // Segmented Agenda | Week | Month toggle (aria-pressed marks the active view).
      + '<div class="cal-toolbar__views" role="group" aria-label="' + escapeHtml(jt('dashboard.calendar.toolbar.viewLabel', 'Calendar view')) + '">'
      + button({
        variant: 'ghost', size: 'sm', label: jt('dashboard.calendar.toolbar.agenda', 'Agenda'), className: 'cal-toolbar__view',
        ariaPressed: mode === 'agenda', dataset: { 'cal-view': 'agenda' },
      })
      + button({
        variant: 'ghost', size: 'sm', label: jt('dashboard.calendar.toolbar.week', 'Week'), className: 'cal-toolbar__view',
        ariaPressed: mode === 'week', dataset: { 'cal-view': 'week' },
      })
      + button({
        variant: 'ghost', size: 'sm', label: jt('dashboard.calendar.toolbar.month', 'Month'), className: 'cal-toolbar__view',
        ariaPressed: mode === 'month', dataset: { 'cal-view': 'month' },
      })
      + '</div>'
      + button({ variant: 'ghost', size: 'sm', label: jt('dashboard.calendar.toolbar.today', 'Today'), ariaLabel: mode === 'month' ? jt('dashboard.calendar.toolbar.jumpToday', 'Jump to today') : jt('dashboard.calendar.toolbar.jumpWeek', 'Jump to this week'), className: 'cal-toolbar__today', dataset: { 'cal-nav': 'today' } })
      + button({ variant: 'ghost', size: 'sm', label: '‹', ariaLabel: mode === 'month' ? jt('dashboard.calendar.toolbar.scrollBack', 'Scroll back') : jt('dashboard.calendar.toolbar.previousWeek', 'Previous week'), className: 'cal-toolbar__nav-btn', dataset: { 'cal-nav': 'prev' } })
      + button({ variant: 'ghost', size: 'sm', label: '›', ariaLabel: mode === 'month' ? jt('dashboard.calendar.toolbar.scrollForward', 'Scroll forward') : jt('dashboard.calendar.toolbar.nextWeek', 'Next week'), className: 'cal-toolbar__nav-btn', dataset: { 'cal-nav': 'next' } })
      + button({
        variant: 'primary',
        size: 'sm',
        label: jt('dashboard.calendar.toolbar.new', '＋ New'),
        ariaLabel: jt('dashboard.calendar.toolbar.newShortcutLabel', 'New event, shortcut n'),
        title: jt('dashboard.calendar.toolbar.newShortcutTitle', 'New event — press n'),
        dataset: { 'cal-new-event': '1' },
      })
      + button({
        variant: 'ghost', size: 'sm', label: '⋯', ariaLabel: jt('dashboard.calendar.toolbar.moreOptions', 'More calendar options'),
        ariaHaspopup: 'dialog', ariaExpanded: false, ariaControls: overflowId,
        className: `cal-toolbar__overflow-trigger${warnings.length ? ' cal-toolbar__overflow-trigger--warning' : ''}`,
        dataset: { 'cal-overflow-toggle': '1' },
      })
      + popover({
        id: 'calendar-toolbar',
        domId: overflowId,
        ariaLabel: jt('dashboard.calendar.toolbar.options', 'Calendar options'),
        className: 'cal-toolbar__overflow',
        trustedHtml: button({
          variant: 'ghost', size: 'sm', label: jt('dashboard.calendar.toolbar.feeds', 'Feeds'),
          ariaLabel: warnings.length ? jtn('dashboard.calendar.toolbar.manageFeedsWarnings', warnings.length, { count: warnings.length }, 'Manage calendar feeds, {count} warning', 'Manage calendar feeds, {count} warnings') : jt('dashboard.calendar.toolbar.manageFeeds', 'Manage calendar feeds'),
          dataset: { 'cal-feeds-toggle': '1' },
        }),
      })
      + '</div>'
      + '</div>'
      ;
  }

  return { buildToolbarMarkup };
});
