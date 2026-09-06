/* Inline create/edit event form for the Home dashboard calendar widget.
 * Pure markup + DOM read helpers — the calendar controller owns state and
 * submission. All controls are inventory primitives (text/date/time/select
 * fields, toggle switch, action buttons); raw form elements are forbidden
 * outside renderer/inventory.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererDashboardCalendarForm = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const { pad2 } = windowRef.rendererDashboardWidgetsCore
    || (typeof require === 'function' ? require('./renderer-dashboard-widgets-core') : {});

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function resolvePrimitives(deps = {}) {
    return {
      actionButton: deps.actionButton
        || (typeof windowRef.inventoryActionButton === 'function' ? windowRef.inventoryActionButton : null),
      urlField: deps.urlField
        || (typeof windowRef.inventoryUrlField === 'function' ? windowRef.inventoryUrlField : null),
      textField: deps.textField
        || (typeof windowRef.inventoryTextField === 'function' ? windowRef.inventoryTextField : null),
      dateField: deps.dateField
        || (typeof windowRef.inventoryDateField === 'function' ? windowRef.inventoryDateField : null),
      timeField: deps.timeField
        || (typeof windowRef.inventoryTimeField === 'function' ? windowRef.inventoryTimeField : null),
      selectField: deps.selectField
        || (typeof windowRef.inventorySelectField === 'function' ? windowRef.inventorySelectField : null),
      toggleSwitch: deps.toggleSwitch
        || windowRef.inventoryToggleSwitch
        || null,
    };
  }

  const RECURRENCE_OPTIONS = [
    { value: 'none', label: 'Does not repeat' },
    { value: 'daily', label: 'Daily' },
    { value: 'weekdays', label: 'Weekdays (Mon–Fri)' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'biweekly', label: 'Every two weeks' },
    { value: 'monthly', label: 'Monthly' },
    { value: 'yearly', label: 'Yearly' },
  ];

  // Default create values: the next half-hour slot (or an explicit slot the
  // controller derived from a grid click).
  function buildDefaultCreateValues(now, slot = null) {
    const reference = slot instanceof Date ? slot : (() => {
      const rounded = new Date(now.getTime());
      rounded.setMinutes(now.getMinutes() < 30 ? 30 : 60, 0, 0);
      return rounded;
    })();
    const end = new Date(reference.getTime() + 30 * 60000);
    const endValue = reference.getHours() === 23 && reference.getMinutes() === 30
      ? '23:59'
      : `${pad2(end.getHours())}:${pad2(end.getMinutes())}`;
    return {
      id: '',
      title: '',
      date: `${reference.getFullYear()}-${pad2(reference.getMonth() + 1)}-${pad2(reference.getDate())}`,
      start: `${pad2(reference.getHours())}:${pad2(reference.getMinutes())}`,
      end: endValue,
      allDay: false,
      categoryId: 'default',
      recurrence: 'none',
      notes: '',
    };
  }

  // Edit values seeded from the stored event (whole-series semantics: the
  // anchor start/end define the series, not the clicked occurrence).
  function buildEditValues(event) {
    const start = String(event?.start || '');
    const end = String(event?.end || '');
    return {
      id: String(event?.id || ''),
      title: String(event?.title || ''),
      date: start.slice(0, 10),
      start: start.slice(11, 16),
      end: end.slice(11, 16),
      allDay: event?.allDay === true,
      categoryId: String(event?.categoryId || 'default'),
      recurrence: String(event?.recurrence || 'none'),
      notes: String(event?.notes || ''),
    };
  }

  function buildEventFormMarkup({ values, categories, error, deps } = {}) {
    const p = resolvePrimitives(deps);
    if (!p.actionButton || !p.textField || !p.dateField || !p.timeField || !p.selectField || !p.toggleSwitch) {
      return '';
    }
    const v = values || buildDefaultCreateValues(new Date());
    const isEdit = Boolean(v.id);
    // A recurring event opened from a specific occurrence can be saved for just
    // that occurrence or the whole series (scope buttons below).
    const occScope = isEdit && v.recurrence !== 'none' && Boolean(v.occurrenceStart);
    const categoryOptions = (Array.isArray(categories) && categories.length
      ? categories
      : [{ id: 'default', label: 'Default' }]
    ).map((category) => ({ value: category.id, label: category.label }));

    const timeFields = v.allDay ? '' : ''
      + p.timeField({
        id: 'calFormStart', label: 'Start', value: v.start, step: '300',
        dataset: { 'cal-form-field': 'start' },
      })
      + p.timeField({
        id: 'calFormEnd', label: 'End', value: v.end, step: '300',
        dataset: { 'cal-form-field': 'end' },
      });

    return ''
      + '<div class="cal-form" data-cal-form="1" role="dialog" aria-labelledby="calFormHeading">'
      + `<div class="cal-form__heading" id="calFormHeading">${isEdit ? 'Edit event' : 'New event'}`
      + (isEdit && v.recurrence !== 'none'
        ? `<span class="cal-form__series-note">${occScope
          ? 'recurring event — choose a scope when saving'
          : 'edits apply to the whole series'}</span>`
        : '')
      + '</div>'
      + (error ? `<div class="cal-form__error" role="alert">${escapeHtml(error)}</div>` : '')
      + '<div class="cal-form__row cal-form__row--title">'
      + p.textField({
        id: 'calFormTitle', label: 'Title', value: v.title, maxLength: 200,
        placeholder: 'Event title', spellcheck: true, dataset: { 'cal-form-field': 'title' },
      })
      + '</div>'
      + '<div class="cal-form__row">'
      + p.dateField({
        id: 'calFormDate', label: 'Date', value: v.date,
        dataset: { 'cal-form-field': 'date' },
      })
      + timeFields
      + `<div class="cal-form__toggle">${p.toggleSwitch.toggleSwitch({
        id: 'calFormAllDay', label: 'All day', checked: v.allDay === true,
      })}</div>`
      + '</div>'
      + '<div class="cal-form__row">'
      + p.selectField({
        id: 'calFormCategory', label: 'Category', value: v.categoryId,
        options: categoryOptions, dataset: { 'cal-form-field': 'category' },
      })
      + p.selectField({
        id: 'calFormRecurrence', label: 'Repeats', value: v.recurrence,
        options: RECURRENCE_OPTIONS, dataset: { 'cal-form-field': 'recurrence' },
      })
      + '</div>'
      + '<div class="cal-form__row cal-form__row--notes">'
      + p.textField({
        id: 'calFormNotes', label: 'Notes', value: v.notes, multiline: true, maxLength: 2000,
        spellcheck: true,
        dataset: { 'cal-form-field': 'notes' },
      })
      + '</div>'
      + '<div class="cal-form__actions">'
      + (occScope
        ? p.actionButton({ variant: 'primary', label: 'Save this event', dataset: { 'cal-form-action': 'save-occurrence' } })
          + p.actionButton({ variant: 'secondary', label: 'Save all events', dataset: { 'cal-form-action': 'save' } })
        : p.actionButton({ variant: 'primary', label: isEdit ? 'Save' : 'Create', dataset: { 'cal-form-action': 'save' } }))
      + p.actionButton({ variant: 'ghost', label: 'Cancel', dataset: { 'cal-form-action': 'cancel' } })
      + (isEdit
        ? p.actionButton({
          variant: 'danger', label: occScope ? 'Delete series' : 'Delete',
          dataset: { 'cal-form-action': 'delete' },
        })
        : '')
      + '</div>'
      + '</div>';
  }

  // Reads live field values back out of a rendered form (used on save, and
  // before any repaint that would rebuild the form's DOM).
  function readEventFormValues(rootEl, previous = {}) {
    if (!rootEl) {
      return { ...previous };
    }
    const read = (selector) => rootEl.querySelector(selector)?.value;
    const allDayEl = rootEl.querySelector('[data-inv-toggle="calFormAllDay"]');
    return {
      ...previous,
      title: read('#calFormTitle') ?? previous.title ?? '',
      date: read('#calFormDate') ?? previous.date ?? '',
      start: read('#calFormStart') ?? previous.start ?? '',
      end: read('#calFormEnd') ?? previous.end ?? '',
      allDay: allDayEl
        ? allDayEl.getAttribute('aria-checked') === 'true'
        : previous.allDay === true,
      categoryId: read('#calFormCategory') ?? previous.categoryId ?? 'default',
      recurrence: read('#calFormRecurrence') ?? previous.recurrence ?? 'none',
      notes: read('#calFormNotes') ?? previous.notes ?? '',
    };
  }

  // Converts form values into a calendar.createEvent/updateEvent payload.
  // Returns { payload } or { error } — the schema-side normalizer is the
  // real validator; this only catches what would silently misfire.
  function buildEventPayload(values) {
    const v = values || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v.date || ''))) {
      return { error: 'Pick a date for the event.' };
    }
    if (v.allDay !== true) {
      if (!/^\d{2}:\d{2}$/.test(String(v.start || ''))) {
        return { error: 'Pick a start time (or mark the event all-day).' };
      }
      if (!/^\d{2}:\d{2}$/.test(String(v.end || ''))) {
        return { error: 'Pick an end time (or mark the event all-day).' };
      }
      // The form is single-date, so end must follow start on the same day.
      // Without this the schema silently self-heals end -> start+30min, which
      // looks to the user like their chosen end time was ignored.
      if (String(v.end) <= String(v.start)) {
        return { error: 'End time must be after start time.' };
      }
    }
    const start = v.allDay === true ? `${v.date}T00:00` : `${v.date}T${v.start}`;
    const end = v.allDay === true ? `${v.date}T00:00` : `${v.date}T${v.end}`;
    return {
      payload: {
        title: String(v.title || ''),
        start,
        end,
        allDay: v.allDay === true,
        categoryId: String(v.categoryId || 'default'),
        recurrence: String(v.recurrence || 'none'),
        notes: String(v.notes || ''),
      },
    };
  }

  // ---- ICS feed manager panel ----

  function buildFeedRowMarkup(p, feed, meta) {
    const status = meta
      ? (meta.ok ? 'ok' : 'error')
      : 'pending';
    const statusText = meta?.warning || (status === 'ok' ? 'OK' : 'waiting for first fetch');
    return ''
      + `<div class="cal-feeds__row" data-state="${status}">`
      + `<span class="cal-feeds__name">${escapeHtml(feed.name || feed.id)}</span>`
      + `<span class="cal-feeds__url">${escapeHtml(feed.url || '')}</span>`
      + `<span class="cal-feeds__status">${escapeHtml(statusText)}</span>`
      + p.actionButton({
        variant: 'ghost', size: 'sm', label: 'Remove',
        ariaLabel: `Remove feed ${feed.name || feed.id}`,
        title: `Remove feed ${feed.name || feed.id}`,
        dataset: { 'cal-feed-remove': String(feed.id || '') },
      })
      + '</div>';
  }

  /**
   * Feeds panel: configured ICS subscriptions (from homeConfig) with their
   * live fetch status (from the calendar snapshot's feeds meta), plus an
   * add-feed row. Colors come from the palette-safe category enum.
   */
  function buildFeedsPanelMarkup({ feeds, feedsMeta, categories, error, deps } = {}) {
    const p = resolvePrimitives(deps);
    if (!p.actionButton || !p.textField || !p.urlField || !p.selectField) {
      return '';
    }
    const configured = Array.isArray(feeds) ? feeds : [];
    const metaById = new Map((Array.isArray(feedsMeta) ? feedsMeta : []).map((meta) => [meta.id, meta]));
    const colorOptions = (Array.isArray(categories) && categories.length
      ? categories
      : [{ id: 'default', label: 'Default' }]
    ).map((category) => ({ value: category.id, label: category.label }));
    return ''
      + '<div class="cal-feeds" data-cal-feeds="1">'
      + '<div class="cal-form__heading">Calendar feeds'
      + '<span class="cal-form__series-note">read-only ICS subscriptions (Outlook/Google publish links)</span>'
      + '</div>'
      + (error ? `<div class="cal-form__error" role="alert">${escapeHtml(error)}</div>` : '')
      + (configured.length
        ? configured.map((feed) => buildFeedRowMarkup(p, feed, metaById.get(feed.id))).join('')
        : '<div class="cal-feeds__empty">No feeds yet.</div>')
      + '<div class="cal-feeds__add">'
      + p.textField({
        id: 'calFeedName', label: 'Name', placeholder: 'Team calendar', maxLength: 80,
        dataset: { 'cal-feed-field': 'name' },
      })
      + p.urlField({
        id: 'calFeedUrl', label: 'ICS URL', placeholder: 'https://…/calendar.ics',
        dataset: { 'cal-feed-field': 'url' },
      })
      + p.selectField({
        id: 'calFeedColor', label: 'Color', value: 'default', options: colorOptions,
        dataset: { 'cal-feed-field': 'color' },
      })
      + p.actionButton({ variant: 'secondary', size: 'sm', label: 'Add feed', dataset: { 'cal-feed-add': '1' } })
      + '</div>'
      + `<div class="cal-form__actions">${p.actionButton({
        variant: 'ghost', label: 'Done', dataset: { 'cal-feeds-close': '1' },
      })}</div>`
      + '</div>';
  }

  function readFeedFormValues(rootEl) {
    if (!rootEl) {
      return { name: '', url: '', colorId: 'default' };
    }
    return {
      name: String(rootEl.querySelector('#calFeedName')?.value || '').trim(),
      url: String(rootEl.querySelector('#calFeedUrl')?.value || '').trim(),
      colorId: String(rootEl.querySelector('#calFeedColor')?.value || 'default'),
    };
  }

  return {
    RECURRENCE_OPTIONS,
    buildDefaultCreateValues,
    buildEditValues,
    buildEventFormMarkup,
    buildEventPayload,
    buildFeedsPanelMarkup,
    readEventFormValues,
    readFeedFormValues,
  };
});
