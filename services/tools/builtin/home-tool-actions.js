'use strict';

/* services/tools/builtin/home-tool-actions.js — the six `home` actions.
 *
 * Split out of home-tool.js so the tool module stays a thin descriptor +
 * dispatch shell. Every handler here is synchronous and pure with respect to
 * the injected HomeAssistantService: it normalizes the model's snake_case
 * input into schema field names, delegates, and shapes one result envelope.
 * No handler ever reaches calendarService / shellConfigService directly —
 * attribution and the undo journal live in the facade, and bypassing it would
 * produce an unattributed, un-undoable write. */

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');
const { normalizeString } = require('../../shared/normalize');
const { HOME_CALENDAR_COLOR_IDS } = require('../../home-config-schema');
const {
  HOME_CALENDAR_RECURRENCE_PRESETS,
  MAX_CALENDAR_EVENT_NOTES_CHARS,
  MAX_CALENDAR_EVENT_TITLE_CHARS,
  addWallClockMinutes,
  formatLocalDateTime,
  parseLocalDateTime,
  parseRangeBound,
  wallClockDurationMinutes,
} = require('../../home-calendar-schema');
const {
  MAX_PROACTIVE_REMINDER_LABEL_CHARS,
  MAX_PROACTIVE_REMINDER_PROMPT_CHARS,
} = require('../../shell-config-followups-schema');
const {
  computeOverlaps,
  shapeCalendarMetadata,
  shapeReceipt,
} = require('./home-calendar-result-shape');

const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const CLOCK_TIME_RE = /^\d{2}:\d{2}$/;
const MAX_LISTED_INSTANCES = 60;
const MAX_OVERLAP_LINES = 12;
const CALENDAR_HINT = '(The user sees this list rendered as a calendar in chat.'
  + ' Summarize what matters — conflicts, gaps, what changed — rather than repeating every entry.)';

// Validation reasons (invalid_*, *_required) are argument mistakes and a
// missing record is not_found; neither touched anything. Write failures keep
// the bare metadata so the sidecar still treats them as execution faults.
function failureClass(reason) {
  if (/^invalid_|_required$/.test(reason)) return { failure_class: 'bad_arguments', effects: 'none' };
  if (reason === 'not_found') return { failure_class: 'not_found', effects: 'none' };
  return {};
}

function failure({ reason, message, summary, errorCode = TOOL_ERROR_CODES.EXECUTION_FAILED }) {
  return {
    content: message,
    summary,
    isError: true,
    errorCode,
    metadata: { result_kind: 'home', status: 'failed', reason, ...failureClass(reason) },
  };
}

function success({ content, summary, status = 'ok', extra = {} }) {
  return {
    content,
    summary,
    isError: false,
    metadata: { result_kind: 'home', status, ...extra },
  };
}

function clip(value, max) {
  const text = typeof value === 'string' ? value.replace(/\0/g, '') : '';
  return { text: text.slice(0, max), clipped: text.length > max };
}

// The one parser for every model-supplied Home wall-clock field: the exact
// "YYYY-MM-DDTHH:MM" shape, then the calendar schema's strict local parse
// (rejects Feb 30 and a skipped DST minute).
function parseHomeDateTime(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  const date = LOCAL_DATETIME_RE.test(token) ? parseLocalDateTime(token) : null;
  return date ? { token, date } : null;
}

// An optional date argument: absent is `{ value: '' }`; anything present must
// parse or the call fails with `invalid_<key>` (never silently ignored).
function readLocalDateTime(input, key) {
  const raw = input?.[key];
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
    return { value: '' };
  }
  const parsed = parseHomeDateTime(raw);
  if (!parsed) {
    return {
      error: failure({
        reason: `invalid_${key}`,
        message: `${key} must be a real local date and time as "YYYY-MM-DDTHH:MM".`,
        summary: `Invalid ${key}`,
      }),
    };
  }
  return { value: parsed.token, parsed };
}

// calendar_list bounds are looser than event fields: the calendar accepts a
// bare date and strips a trailing zone, and a bare range_end covers that whole
// day (parseRangeBound, shared with CalendarService). An unparseable bound
// used to be ignored silently; now it is refused.
function readRangeBound(input, key) {
  const raw = input?.[key];
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) {
    return { value: '' };
  }
  const token = typeof raw === 'string' ? raw.trim() : '';
  const date = parseRangeBound(token, key === 'range_end');
  if (!date) {
    return {
      error: failure({
        reason: `invalid_${key}`,
        message: `${key} must be a local date ("YYYY-MM-DD") or date and time ("YYYY-MM-DDTHH:MM").`,
        summary: `Invalid ${key}`,
      }),
    };
  }
  return { value: token, date };
}

// 'YYYY-MM-DDTHH:MM' is a one-shot ('once_at'); a bare 'HH:MM' is the daily
// cadence. Anything else is rejected rather than coerced — a reminder that
// silently lands on the wrong cadence is worse than a refusal.
function reminderScheduleFromRemindAt(value) {
  const token = normalizeString(value);
  const parsed = parseHomeDateTime(token);
  if (parsed) {
    return { scheduleType: 'once_at', onceAt: parsed.token };
  }
  if (CLOCK_TIME_RE.test(token)) {
    const [hour, minute] = token.split(':').map(Number);
    if (hour > 23 || minute > 59) return null;
    return { scheduleType: 'daily_at', dailyAt: token };
  }
  return null;
}

// The undo promise is only honest when the journal entry actually landed. A
// journal-persist failure leaves the entity written and attributed but with no
// inverse recorded, so the sentence — and metadata.journaled — say so rather
// than pointing the user at an undo control that will refuse.
function undoSentence(outcome) {
  return outcome?.journaled === false
    ? ' It is marked as created by Jenny, but it could NOT be added to the undo'
      + ' journal, so it cannot be undone from Home.'
    : ' It is marked as created by Jenny and can be undone from the receipt in chat or from Home.';
}

function describeInstance(instance) {
  const when = instance.allDay ? `${instance.start.slice(0, 10)} (all day)` : instance.start;
  const origin = instance.source === 'feed'
    ? ' [feed, read-only]'
    : instance.sourceKind === 'assistant' ? ' [created by Jenny]' : '';
  return `- ${when} · ${instance.title || '(untitled)'}`
    + `${instance.eventId ? ` · id=${instance.eventId}` : ''}${origin}`;
}

function describeOverlaps(instances, overlaps) {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance]));
  const lines = [];
  for (const [laterId, earlierInstances] of overlaps) {
    const later = byId.get(laterId);
    if (!later) continue;
    for (const earlier of earlierInstances) {
      lines.push(`- ${later.title || '(untitled)'} (${later.start || ''}) overlaps`
        + ` ${earlier.title || '(untitled)'} (${earlier.start})`);
    }
  }
  return lines;
}

function calendarList(service, input, meta) {
  const rangeStart = readRangeBound(input, 'range_start');
  if (rangeStart.error) return rangeStart.error;
  const rangeEnd = readRangeBound(input, 'range_end');
  if (rangeEnd.error) return rangeEnd.error;
  if (rangeStart.date && rangeEnd.date && rangeEnd.date <= rangeStart.date) {
    return failure({
      reason: 'invalid_range',
      message: 'range_end must be after range_start.',
      summary: 'Invalid calendar range',
    });
  }
  const listing = service.listCalendar({ start: rangeStart.value, end: rangeEnd.value });
  let journalEntries;
  try {
    const journal = service.listJournal?.();
    journalEntries = Array.isArray(journal?.entries) ? journal.entries : [];
  } catch {
    journalEntries = [];
  }
  const shown = listing.instances.slice(0, MAX_LISTED_INSTANCES);
  const lines = shown.map((instance) => describeInstance(instance));
  const omitted = listing.instances.length - shown.length;
  const overlaps = computeOverlaps(listing.instances);
  const allOverlapLines = describeOverlaps(listing.instances, overlaps);
  const overlapLines = allOverlapLines.slice(0, MAX_OVERLAP_LINES);
  const omittedOverlaps = allOverlapLines.length - overlapLines.length;
  const body = lines.length
    ? lines.join('\n')
    : 'No events in that range.';
  return success({
    content: `Calendar ${listing.rangeStart} .. ${listing.rangeEnd}\n${body}`
      + (omitted > 0 ? `\n(${omitted} more not shown)` : '')
      + (overlapLines.length
        ? `\nOverlaps:\n${overlapLines.join('\n')}`
          + (omittedOverlaps > 0 ? `\n(${omittedOverlaps} more overlaps not shown)` : '')
        : '')
      + (listing.rangeClamped ? '\n(Range shortened to 180 days.)' : '')
      + (listing.uncoveredFeeds?.length
        ? `\n(Not fetched yet, so not included: ${listing.uncoveredFeeds.join(', ')}.)` : '')
      + `\n${CALENDAR_HINT}`,
    summary: `Listed ${shown.length} calendar entr${shown.length === 1 ? 'y' : 'ies'}`,
    // instance_count is the full listing everywhere (top level and
    // calendar metadata); listed_count is how many the text above names.
    extra: {
      action: 'calendar_list',
      range_start: listing.rangeStart,
      range_end: listing.rangeEnd,
      instance_count: listing.instances.length,
      listed_count: shown.length,
      calendar: shapeCalendarMetadata({
        listing,
        journalEntries,
        sessionId: meta?.sessionId,
        now: typeof service.now === 'function' ? service.now() : new Date(),
        overlaps,
      }),
    },
  });
}

// Moving an event's start without naming an end keeps its length: the
// calendar would otherwise keep the OLD end and stretch or invert the event.
function preservedEnd(service, eventId, start, input) {
  const prior = typeof service.readEvent === 'function' ? service.readEvent(eventId) : null;
  if (!prior) return '';
  if (input?.all_day !== undefined && (input.all_day === true) !== (prior.allDay === true)) return '';
  const priorStart = parseLocalDateTime(prior.start);
  const priorEnd = parseLocalDateTime(prior.end);
  if (!priorStart || !priorEnd || priorEnd <= priorStart) return '';
  // Wall-clock minutes, so a move across a DST change keeps the local length.
  const minutes = wallClockDurationMinutes(priorStart, priorEnd);
  return formatLocalDateTime(addWallClockMinutes(start.date, minutes));
}

function eventUpsert(service, input, meta) {
  const requestedId = normalizeString(input?.id);
  const startArg = readLocalDateTime(input, 'start');
  if (startArg.error) return startArg.error;
  const start = startArg.value;
  if (!requestedId && !start) {
    return failure({
      reason: 'invalid_start',
      message: 'A new event needs start as a local "YYYY-MM-DDTHH:MM" string.',
      summary: 'Event needs a start time',
    });
  }
  const endArg = readLocalDateTime(input, 'end');
  if (endArg.error) return endArg.error;
  let end = endArg.value;
  if (start && end && end < start) {
    return failure({
      reason: 'invalid_range',
      message: 'end must not be before start.',
      summary: 'Event ends before it starts',
    });
  }
  if (requestedId && start && !end) {
    end = preservedEnd(service, requestedId, startArg.parsed, input);
  }
  const category = normalizeString(input?.category).toLowerCase();
  if (category && !HOME_CALENDAR_COLOR_IDS.includes(category)) {
    return failure({
      reason: 'invalid_category',
      message: `category must be one of: ${HOME_CALENDAR_COLOR_IDS.join(', ')}.`,
      summary: 'Invalid category',
    });
  }
  const recurrence = normalizeString(input?.recurrence).toLowerCase();
  if (recurrence && !HOME_CALENDAR_RECURRENCE_PRESETS.includes(recurrence)) {
    return failure({
      reason: 'invalid_recurrence',
      message: `recurrence must be one of: ${HOME_CALENDAR_RECURRENCE_PRESETS.join(', ')}.`,
      summary: 'Invalid recurrence',
    });
  }
  const title = clip(input?.title, MAX_CALENDAR_EVENT_TITLE_CHARS);
  const notes = clip(input?.notes, MAX_CALENDAR_EVENT_NOTES_CHARS);
  const patch = {
    ...(requestedId ? { id: requestedId } : {}),
    ...(input?.title === undefined ? {} : { title: title.text }),
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(input?.all_day === undefined ? {} : { allDay: input.all_day === true }),
    ...(category ? { categoryId: category } : {}),
    ...(input?.notes === undefined ? {} : { notes: notes.text }),
    ...(recurrence ? { recurrence } : {}),
  };
  let outcome;
  try {
    outcome = service.upsertEvent(patch, meta);
  } catch (error) {
    return failure({
      reason: 'calendar_write_failed',
      message: `The calendar refused that event: ${String(error?.message || error)}`,
      summary: 'Calendar write failed',
    });
  }
  // An id that resolves to nothing is refused, never quietly turned into a
  // create: the model asked to edit a specific record, and inventing a second
  // one under a fresh id is the failure mode this names out loud.
  if (outcome?.ok === false) {
    return failure({
      reason: outcome.reason || 'calendar_write_failed',
      message: outcome.reason === 'not_found'
        ? `No calendar event with id "${requestedId}" exists.`
          + ' Use calendar_list to find the right id, or omit id to create a new event.'
        : 'The calendar event could not be saved.',
      summary: outcome.reason === 'not_found' ? 'Event not found' : 'Calendar write failed',
    });
  }
  const state = outcome.entityState;
  return success({
    content: `${outcome.op === 'create' ? 'Added' : 'Updated'} "${state?.title || 'Untitled event'}"`
      + ` (${state?.start || start}).${undoSentence(outcome)}`
      + `${title.clipped || notes.clipped ? ' Some text was truncated to fit the field limits.' : ''}`,
    summary: `${outcome.op === 'create' ? 'Created' : 'Updated'} calendar event`,
    extra: {
      action: 'event_upsert',
      op: outcome.op,
      event_id: outcome.entityId,
      journal_entry_id: outcome.entryId,
      journaled: outcome.journaled !== false,
      calendar_receipt: shapeReceipt({
        kind: 'event',
        op: outcome.op,
        entityState: state,
        journalEntryId: outcome.entryId,
        journaled: outcome.journaled !== false,
        fallback: { ...patch, id: outcome.entityId },
      }),
    },
  });
}

function reminderUpsert(service, input, meta) {
  const requestedId = normalizeString(input?.id);
  const remindAt = normalizeString(input?.remind_at);
  const schedule = remindAt ? reminderScheduleFromRemindAt(remindAt) : null;
  if (remindAt && !schedule) {
    return failure({
      reason: 'invalid_remind_at',
      message: 'remind_at must be "YYYY-MM-DDTHH:MM" for a one-shot or "HH:MM" for a daily reminder.',
      summary: 'Invalid remind_at',
    });
  }
  if (!requestedId && !schedule) {
    return failure({
      reason: 'remind_at_required',
      message: 'A new reminder needs remind_at ("YYYY-MM-DDTHH:MM" or "HH:MM").',
      summary: 'Reminder needs a time',
    });
  }
  const label = clip(input?.label, MAX_PROACTIVE_REMINDER_LABEL_CHARS);
  const prompt = clip(input?.prompt, MAX_PROACTIVE_REMINDER_PROMPT_CHARS);
  const patch = {
    ...(requestedId ? { id: requestedId } : {}),
    ...(input?.label === undefined ? {} : { label: label.text }),
    ...(input?.prompt === undefined ? {} : { prompt: prompt.text }),
    ...(schedule || {}),
  };
  let outcome;
  try {
    outcome = service.upsertReminder(patch, meta);
  } catch (error) {
    return failure({
      reason: 'reminder_write_failed',
      message: `The reminder was refused: ${String(error?.message || error)}`,
      summary: 'Reminder write failed',
    });
  }
  // Same refusal as event_upsert: an id that matches nothing is an error, not
  // an implicit create. Reminder ids are honoured verbatim by the normalizer,
  // so falling through would strand a defaults-filled reminder under an id the
  // model invented.
  if (outcome?.ok === false) {
    return failure({
      reason: outcome.reason || 'reminder_write_failed',
      message: outcome.reason === 'not_found'
        ? `No reminder with id "${requestedId}" exists.`
          + ' Omit id to create a new reminder.'
        : 'The reminder could not be saved.',
      summary: outcome.reason === 'not_found' ? 'Reminder not found' : 'Reminder write failed',
    });
  }
  const state = outcome.entityState;
  const when = state?.scheduleType === 'once_at' ? state.onceAt : state?.dailyAt || remindAt;
  return success({
    content: `${outcome.op === 'create' ? 'Added' : 'Updated'} reminder "${state?.label || 'Reminder'}"`
      + ` for ${when}. At that time Jenny raises it as a notification while she is running,`
      + ' and it is listed on Home.'
      + `${outcome.journaled === false
        ? ' It could NOT be added to the undo journal, so it cannot be undone from Home.'
        : ' It can be undone from the receipt in chat or from Home.'}`
      + `${label.clipped || prompt.clipped ? ' Some text was truncated to fit the field limits.' : ''}`,
    summary: `${outcome.op === 'create' ? 'Created' : 'Updated'} reminder`,
    extra: {
      action: 'reminder_upsert',
      op: outcome.op,
      reminder_id: outcome.entityId,
      journal_entry_id: outcome.entryId,
      journaled: outcome.journaled !== false,
      calendar_receipt: shapeReceipt({
        kind: 'reminder',
        op: outcome.op,
        entityState: state,
        journalEntryId: outcome.entryId,
        journaled: outcome.journaled !== false,
        fallback: { ...patch, id: outcome.entityId },
      }),
    },
  });
}

function readReminder(service, id) {
  if (typeof service.readReminder === 'function') return service.readReminder(id);
  return service.getProactive().reminders.find((reminder) => reminder.id === id) || null;
}

// What a confirmed delete removes, so the model can say it before asking:
// deleting a recurring event's id removes the whole series.
function deleteScope(existing, isEvent) {
  if (isEvent) {
    const recurrence = normalizeString(existing?.recurrence).toLowerCase();
    if (recurrence && recurrence !== 'none') {
      return {
        kind: 'series',
        text: `a ${recurrence} recurring event, so EVERY occurrence in the series is removed, not just one`,
      };
    }
    return { kind: 'single', text: `a single event at ${existing?.start || 'an unknown time'}` };
  }
  if (existing?.scheduleType === 'daily_at') {
    return { kind: 'series', text: `a daily reminder at ${existing.dailyAt || '?'}, so it stops for every day` };
  }
  if (existing?.scheduleType === 'interval_minutes') {
    return {
      kind: 'series',
      text: `a repeating reminder every ${existing.intervalMinutes || '?'} minutes, so every repeat stops`,
    };
  }
  return { kind: 'single', text: `a one-time reminder at ${existing?.onceAt || 'an unknown time'}` };
}

// Deletes are the one destructive action, so they self-gate: the first call
// mutates NOTHING and reports exactly what would be removed; only a second
// call carrying confirm:true performs the delete. That round-trip is what puts
// the user in the loop, not an approval dialog.
function deleteAction(service, input, meta, kind) {
  const entityId = normalizeString(input?.id);
  const isEvent = kind === 'event';
  const noun = isEvent ? 'calendar event' : 'reminder';
  if (!entityId) {
    return failure({
      reason: 'id_required',
      message: `Deleting a ${noun} requires its id.`,
      summary: `Delete needs an id`,
    });
  }
  // Existence is asked of the FULL events array (service.readEvent), never of
  // listCalendar's expanded instances: instances only cover the -7d/+60d
  // window, so a precheck that read them would refuse to delete an event three
  // months out that deleteEvent itself can find and remove.
  const existing = isEvent ? service.readEvent(entityId) : readReminder(service, entityId);
  const name = isEvent
    ? existing?.title || ''
    : existing?.label || '';
  if (!existing) {
    return failure({
      reason: 'not_found',
      message: `No ${noun} with id "${entityId}" exists.`,
      summary: `${isEvent ? 'Event' : 'Reminder'} not found`,
    });
  }
  if (input?.confirm !== true) {
    const scope = deleteScope(existing, isEvent);
    return success({
      status: 'confirmation_required',
      content: `This would delete the ${noun} "${name || '(untitled)'}" (id ${entityId}): ${scope.text}.`
        + ' Nothing has been deleted. Tell the user exactly what will be removed, confirm with them,'
        + ' then call again with confirm: true.',
      summary: `Confirm deletion of ${noun}`,
      extra: {
        action: isEvent ? 'event_delete' : 'reminder_delete',
        [isEvent ? 'event_id' : 'reminder_id']: entityId,
        target_label: name,
        target_scope: scope.kind,
      },
    });
  }
  const outcome = isEvent
    ? service.deleteEvent(entityId, meta)
    : service.deleteReminder(entityId, meta);
  if (!outcome?.ok) {
    return failure({
      reason: outcome?.reason || 'delete_failed',
      message: `The ${noun} could not be deleted.`,
      summary: `Delete failed`,
    });
  }
  return success({
    content: `Deleted the ${noun} "${name || '(untitled)'}".`
      + (outcome.journaled === false
        ? ' It could NOT be added to the undo journal, so this cannot be undone from Home.'
        : ' This can be undone from the receipt in chat or from Home.'),
    summary: `Deleted ${noun}`,
    extra: {
      action: isEvent ? 'event_delete' : 'reminder_delete',
      [isEvent ? 'event_id' : 'reminder_id']: entityId,
      journal_entry_id: outcome.entryId,
      journaled: outcome.journaled !== false,
      calendar_receipt: shapeReceipt({
        kind,
        op: 'delete',
        existing,
        journalEntryId: outcome.entryId,
        journaled: outcome.journaled !== false,
        fallback: { id: outcome.entityId || entityId, [isEvent ? 'title' : 'label']: name },
      }),
    },
  });
}

function scratchpadRead(service) {
  const scratchpad = service.readScratchpad();
  const body = scratchpad.notes.length
    ? scratchpad.notes
      .map((note) => `## ${note.title || note.id}\n${note.text || '(empty)'}`)
      .join('\n\n')
    : '(the scratchpad has no notes)';
  return success({
    content: `Home scratchpad (read-only):\n\n${body}`,
    summary: `Read ${scratchpad.notes.length} scratchpad note${scratchpad.notes.length === 1 ? '' : 's'}`,
    extra: {
      action: 'scratchpad_read',
      note_count: scratchpad.notes.length,
      active_note_id: scratchpad.activeNoteId,
    },
  });
}

const HOME_ACTIONS = Object.freeze({
  calendar_list: (service, input, meta) => calendarList(service, input, meta),
  event_upsert: (service, input, meta) => eventUpsert(service, input, meta),
  event_delete: (service, input, meta) => deleteAction(service, input, meta, 'event'),
  reminder_upsert: (service, input, meta) => reminderUpsert(service, input, meta),
  reminder_delete: (service, input, meta) => deleteAction(service, input, meta, 'reminder'),
  scratchpad_read: (service) => scratchpadRead(service),
});

module.exports = {
  HOME_ACTIONS,
  failure,
};
