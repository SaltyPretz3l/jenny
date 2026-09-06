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
} = require('../../home-calendar-schema');
const {
  MAX_PROACTIVE_REMINDER_LABEL_CHARS,
  MAX_PROACTIVE_REMINDER_PROMPT_CHARS,
} = require('../../shell-config-followups-schema');

const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const CLOCK_TIME_RE = /^\d{2}:\d{2}$/;
const MAX_LISTED_INSTANCES = 60;

function failure({ reason, message, summary, errorCode = TOOL_ERROR_CODES.EXECUTION_FAILED }) {
  return {
    content: message,
    summary,
    isError: true,
    errorCode,
    metadata: { result_kind: 'home', status: 'failed', reason },
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

// 'YYYY-MM-DDTHH:MM' is a one-shot ('once_at'); a bare 'HH:MM' is the daily
// cadence. Anything else is rejected rather than coerced — a reminder that
// silently lands on the wrong cadence is worse than a refusal.
function reminderScheduleFromRemindAt(value) {
  const token = normalizeString(value);
  if (LOCAL_DATETIME_RE.test(token)) {
    const [dateToken, timeToken] = token.split('T');
    const [year, month, day] = dateToken.split('-').map(Number);
    const [hour, minute] = timeToken.split(':').map(Number);
    if (hour > 23 || minute > 59) return null;
    const date = new Date(year, month - 1, day, hour, minute);
    if (
      date.getFullYear() !== year
      || date.getMonth() !== month - 1
      || date.getDate() !== day
      || date.getHours() !== hour
      || date.getMinutes() !== minute
    ) {
      return null;
    }
    return { scheduleType: 'once_at', onceAt: token };
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
    : ' It is marked as created by Jenny and can be undone from Home.';
}

function describeInstance(instance) {
  const when = instance.allDay ? `${instance.start.slice(0, 10)} (all day)` : instance.start;
  const origin = instance.source === 'feed'
    ? ' [feed, read-only]'
    : instance.sourceKind === 'assistant' ? ' [created by Jenny]' : '';
  return `- ${when} · ${instance.title || '(untitled)'}`
    + `${instance.eventId ? ` · id=${instance.eventId}` : ''}${origin}`;
}

function calendarList(service, input) {
  const listing = service.listCalendar({
    start: normalizeString(input?.range_start),
    end: normalizeString(input?.range_end),
  });
  const shown = listing.instances.slice(0, MAX_LISTED_INSTANCES);
  const lines = shown.map((instance) => describeInstance(instance));
  const omitted = listing.instances.length - shown.length;
  const body = lines.length
    ? lines.join('\n')
    : 'No events in that range.';
  return success({
    content: `Calendar ${listing.rangeStart} .. ${listing.rangeEnd}\n${body}`
      + (omitted > 0 ? `\n(${omitted} more not shown)` : ''),
    summary: `Listed ${shown.length} calendar entr${shown.length === 1 ? 'y' : 'ies'}`,
    extra: {
      action: 'calendar_list',
      range_start: listing.rangeStart,
      range_end: listing.rangeEnd,
      instance_count: shown.length,
      omitted_count: Math.max(0, omitted),
    },
  });
}

function eventUpsert(service, input, meta) {
  const start = normalizeString(input?.start);
  const requestedId = normalizeString(input?.id);
  if (!requestedId && !LOCAL_DATETIME_RE.test(start)) {
    return failure({
      reason: 'invalid_start',
      message: 'A new event needs start as a local "YYYY-MM-DDTHH:MM" string.',
      summary: 'Event needs a start time',
    });
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
    ...(normalizeString(input?.end) ? { end: normalizeString(input.end) } : {}),
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
      + ` for ${when}. Reminders surface on Home as nudges — nothing fires automatically.`
      + `${outcome.journaled === false ? ' It could NOT be added to the undo journal, so it cannot be undone from Home.' : ''}`
      + `${label.clipped || prompt.clipped ? ' Some text was truncated to fit the field limits.' : ''}`,
    summary: `${outcome.op === 'create' ? 'Created' : 'Updated'} reminder`,
    extra: {
      action: 'reminder_upsert',
      op: outcome.op,
      reminder_id: outcome.entityId,
      journal_entry_id: outcome.entryId,
      journaled: outcome.journaled !== false,
    },
  });
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
  const existing = isEvent
    ? service.readEvent(entityId)
    : service.getProactive().reminders.find((reminder) => reminder.id === entityId);
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
    return success({
      status: 'confirmation_required',
      content: `This would delete the ${noun} "${name || '(untitled)'}" (id ${entityId}).`
        + ' Nothing has been deleted. Confirm with the user, then call again with confirm: true.',
      summary: `Confirm deletion of ${noun}`,
      extra: {
        action: isEvent ? 'event_delete' : 'reminder_delete',
        [isEvent ? 'event_id' : 'reminder_id']: entityId,
        target_label: name,
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
        : ' This can be undone from Home.'),
    summary: `Deleted ${noun}`,
    extra: {
      action: isEvent ? 'event_delete' : 'reminder_delete',
      [isEvent ? 'event_id' : 'reminder_id']: entityId,
      journal_entry_id: outcome.entryId,
      journaled: outcome.journaled !== false,
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
  calendar_list: (service, input) => calendarList(service, input),
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
