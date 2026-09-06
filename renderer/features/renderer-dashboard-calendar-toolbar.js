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
      + '<div class="cal-toolbar__views" role="group" aria-label="Calendar view">'
      + button({
        variant: 'ghost', size: 'sm', label: 'Agenda', className: 'cal-toolbar__view',
        ariaPressed: mode === 'agenda', dataset: { 'cal-view': 'agenda' },
      })
      + button({
        variant: 'ghost', size: 'sm', label: 'Week', className: 'cal-toolbar__view',
        ariaPressed: mode === 'week', dataset: { 'cal-view': 'week' },
      })
      + button({
        variant: 'ghost', size: 'sm', label: 'Month', className: 'cal-toolbar__view',
        ariaPressed: mode === 'month', dataset: { 'cal-view': 'month' },
      })
      + '</div>'
      + button({ variant: 'ghost', size: 'sm', label: 'Today', ariaLabel: mode === 'month' ? 'Jump to today' : 'Jump to this week', className: 'cal-toolbar__today', dataset: { 'cal-nav': 'today' } })
      + button({ variant: 'ghost', size: 'sm', label: '‹', ariaLabel: mode === 'month' ? 'Scroll back' : 'Previous week', className: 'cal-toolbar__nav-btn', dataset: { 'cal-nav': 'prev' } })
      + button({ variant: 'ghost', size: 'sm', label: '›', ariaLabel: mode === 'month' ? 'Scroll forward' : 'Next week', className: 'cal-toolbar__nav-btn', dataset: { 'cal-nav': 'next' } })
      + button({
        variant: 'primary',
        size: 'sm',
        label: '＋ New',
        ariaLabel: 'New event, shortcut n',
        title: 'New event — press n',
        dataset: { 'cal-new-event': '1' },
      })
      + button({
        variant: 'ghost', size: 'sm', label: '⋯', ariaLabel: 'More calendar options',
        ariaHaspopup: 'dialog', ariaExpanded: false, ariaControls: overflowId,
        className: `cal-toolbar__overflow-trigger${warnings.length ? ' cal-toolbar__overflow-trigger--warning' : ''}`,
        dataset: { 'cal-overflow-toggle': '1' },
      })
      + popover({
        id: 'calendar-toolbar',
        domId: overflowId,
        ariaLabel: 'Calendar options',
        className: 'cal-toolbar__overflow',
        trustedHtml: button({
          variant: 'ghost', size: 'sm', label: 'Feeds',
          ariaLabel: warnings.length ? `Manage calendar feeds, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : 'Manage calendar feeds',
          dataset: { 'cal-feeds-toggle': '1' },
        }),
      })
      + '</div>'
      + '</div>'
      ;
  }

  return { buildToolbarMarkup };
});
