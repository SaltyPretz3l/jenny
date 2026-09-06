'use strict';

const { EventEmitter } = require('events');
const { normalizeString } = require('./backend/path-utils');
const { HomeAiJournalStore } = require('./home-ai-journal-store');

// Facade the assistant (the `home` tool) writes Home through — never the raw
// calendar/config services. Three things happen on every mutation, atomically
// from the caller's point of view:
//
//   1. a NEW entity is stamped `sourceKind: 'assistant'` + a bounded `sourceId`
//      so any Home surface can badge who created it; an EDIT carries the prior
//      record's attribution through unchanged (see _attribution),
//   2. the write is delegated to the SAME service the user's own edits use, so
//      there is exactly one normalizer and one persistence path, and
//   3. a journal entry records the inverse operation plus a `postHash` of the
//      entity as Jenny left it.
//
// The postHash is the safety property: undo refuses when the record no longer
// matches what Jenny wrote (the user edited it since), when the entry was
// already undone, or when a later Jenny write superseded it. An undo that
// cannot prove it is reverting its own change does nothing and says why.
//
// Reads (listCalendar/readScratchpad) are pass-throughs; the scratchpad has no
// write path here at all — v1 is deliberately read-only for the assistant.
const CALENDAR_EVENT = 'calendar_event';
const REMINDER = 'reminder';

function emptyProactive() {
  return { reminders: [] };
}

class HomeAssistantService extends EventEmitter {
  constructor({
    userDataPath,
    store,
    calendarService,
    configService,
    logger = () => {},
    nowProvider = () => new Date(),
  } = {}) {
    super();
    if (!calendarService) {
      throw new Error('calendarService is required for HomeAssistantService.');
    }
    if (!configService) {
      throw new Error('configService is required for HomeAssistantService.');
    }
    this.calendarService = calendarService;
    this.configService = configService;
    this.logger = typeof logger === 'function' ? logger : () => {};
    this.nowProvider = typeof nowProvider === 'function' ? nowProvider : () => new Date();
    this.journal = new HomeAiJournalStore({ userDataPath, store, logger: this.logger });
  }

  // ---- reads ------------------------------------------------------------

  listCalendar(range = {}) {
    const state = this.calendarService.getState();
    const start = normalizeString(range?.start) || state.windowStart;
    const end = normalizeString(range?.end) || state.windowEnd;
    const instances = (Array.isArray(state.instances) ? state.instances : [])
      .filter((instance) => instance.end > start && instance.start < end);
    return {
      windowStart: state.windowStart,
      windowEnd: state.windowEnd,
      rangeStart: start,
      rangeEnd: end,
      instances,
    };
  }

  readScratchpad() {
    const home = typeof this.configService.getHomeConfig === 'function'
      ? this.configService.getHomeConfig()
      : this.configService.getState?.()?.home;
    const notes = Array.isArray(home?.scratchpad?.notes) ? home.scratchpad.notes : [];
    return {
      activeNoteId: normalizeString(home?.scratchpad?.activeNoteId),
      notes: notes.map((note) => ({
        id: note.id,
        title: note.title,
        text: typeof note.text === 'string' ? note.text : '',
      })),
    };
  }

  listJournal() {
    return { entries: this.journal.list() };
  }

  // Public because callers that need to know whether an event EXISTS must not
  // ask `listCalendar`: that answers from the expanded -7d/+60d instance
  // window, so an event three months out reads as missing. Deletes and updates
  // operate on the full events array, and so must their prechecks.
  readEvent(id) {
    const event = this._readEvent(id);
    return event ? { ...event } : null;
  }

  getProactive() {
    const reminders = this.configService.getState?.()?.proactive?.reminders;
    return { reminders: Array.isArray(reminders) ? reminders.map((entry) => ({ ...entry })) : [] };
  }

  // ---- calendar mutations ----------------------------------------------

  // An id the model made up is a refusal, not a create: falling through to the
  // create branch would silently mint a SECOND event and report `op: 'update'`
  // semantics the caller never asked for.
  upsertEvent(input = {}, meta = {}) {
    const requestedId = normalizeString(input?.id);
    const prior = requestedId ? this._readEvent(requestedId) : null;
    if (requestedId && !prior) {
      return { ok: false, reason: 'not_found', entityId: requestedId };
    }
    const payload = { ...input, ...this._attribution(meta, prior) };
    let entityId = requestedId;
    if (prior) {
      this.calendarService.updateEvent(requestedId, payload);
    } else {
      const before = new Set(this._calendarEvents().map((event) => event.id));
      delete payload.id;
      entityId = this._createdEventId(this.calendarService.createEvent(payload), before);
    }
    const post = this._readEvent(entityId);
    return this._record({
      entity: CALENDAR_EVENT,
      entityId,
      op: prior ? 'update' : 'create',
      label: post?.title || prior?.title || 'Untitled event',
      meta,
      prior,
      post,
    });
  }

  deleteEvent(id, meta = {}) {
    const entityId = normalizeString(id);
    const prior = this._readEvent(entityId);
    if (!prior) {
      return { ok: false, reason: 'not_found', entityId };
    }
    this.calendarService.deleteEvent(entityId);
    return this._record({
      entity: CALENDAR_EVENT,
      entityId,
      op: 'delete',
      label: prior.title || 'Untitled event',
      meta,
      prior,
      post: null,
    });
  }

  // ---- reminder mutations ----------------------------------------------

  // Same refusal as upsertEvent, and for a sharper reason: normalizeReminder
  // HONOURS whatever id it is handed, so an unknown id does not even produce a
  // duplicate — it mints a brand-new defaults-filled reminder (09:00 daily,
  // empty prompt) living under the id the model invented. Refuse instead.
  //
  // ShellConfigService.upsertReminder is a full REPLACE (normalizeReminder
  // rebuilds every field from the payload and fills defaults for what is
  // missing), so forwarding a bare patch would blank the fields the model did
  // not mention — a label-only edit would reset the cadence to 09:00 daily and
  // drop the prompt. Merge the prior record under the patch first; the
  // normalizer's per-type gating still clears the OTHER cadence's field when
  // the patch carries a new scheduleType, so a merge cannot resurrect a stale
  // onceAt/dailyAt.
  upsertReminder(input = {}, meta = {}) {
    const requestedId = normalizeString(input?.id);
    const prior = requestedId ? this._readReminder(requestedId) : null;
    if (requestedId && !prior) {
      return { ok: false, reason: 'not_found', entityId: requestedId };
    }
    const before = new Set(this._allReminders().map((reminder) => reminder.id));
    this.configService.upsertReminder({
      ...(prior || {}),
      ...input,
      ...this._attribution(meta, prior),
    });
    // `requestedId` is necessarily empty on this branch — the refusal above
    // means an id that reaches here always resolved to a prior record.
    const entityId = prior
      ? requestedId
      : this._allReminders().map((reminder) => reminder.id).find((id) => !before.has(id)) || '';
    const post = this._readReminder(entityId);
    return this._record({
      entity: REMINDER,
      entityId,
      op: prior ? 'update' : 'create',
      label: post?.label || prior?.label || 'Reminder',
      meta,
      prior,
      post,
    });
  }

  deleteReminder(id, meta = {}) {
    const entityId = normalizeString(id);
    const prior = this._readReminder(entityId);
    if (!prior) {
      return { ok: false, reason: 'not_found', entityId };
    }
    this.configService.deleteReminder(entityId);
    return this._record({
      entity: REMINDER,
      entityId,
      op: 'delete',
      label: prior.label || 'Reminder',
      meta,
      prior,
      post: null,
    });
  }

  // ---- undo -------------------------------------------------------------

  undo(entryId) {
    const entry = this.journal.find(entryId);
    if (!entry) {
      return { ok: false, reason: 'entry_not_found' };
    }
    if (entry.undoneAt) {
      return { ok: false, reason: 'already_undone' };
    }
    if (entry.supersededAt) {
      return { ok: false, reason: 'superseded' };
    }
    const current = entry.entity === CALENDAR_EVENT
      ? this._readEvent(entry.entityId)
      : this._readReminder(entry.entityId);
    if (JSON.stringify(current) !== entry.postHash) {
      return { ok: false, reason: 'changed_since' };
    }
    this._applyInverse(entry);
    this.journal.markUndone(entry.id, this.nowProvider());
    const payload = this._changedPayload();
    this.emit('changed', payload);
    return {
      ok: true,
      entryId: entry.id,
      journal: payload.journal,
      calendar: this.calendarService.getState(),
      proactive: payload.proactive,
    };
  }

  // A restored calendar event is re-created rather than resurrected in place:
  // CalendarService owns id minting, so the record comes back with all its
  // fields but a fresh id. The journal entry is stamped undone either way, so
  // the identity change is terminal, never chained.
  _applyInverse(entry) {
    const { kind, payload } = entry.inverse;
    const isEvent = entry.entity === CALENDAR_EVENT;
    if (kind === 'delete') {
      if (isEvent) {
        this.calendarService.deleteEvent(entry.entityId);
      } else {
        this.configService.deleteReminder(entry.entityId);
      }
      return;
    }
    if (!payload) {
      return;
    }
    if (kind === 'restore') {
      if (isEvent) {
        const { id: _droppedId, ...fields } = payload;
        this.calendarService.createEvent(fields);
      } else {
        this.configService.upsertReminder(payload);
      }
      return;
    }
    if (isEvent) {
      this.calendarService.updateEvent(entry.entityId, payload);
    } else {
      this.configService.upsertReminder(payload);
    }
  }

  // ---- internals --------------------------------------------------------

  // Attribution is CREATION-ONLY. Jenny editing a record the USER created must
  // not re-stamp it 'assistant': the agenda chip reads "Added by jenny", it is
  // permanent, and it cannot be dismissed, so one assistant edit would mislabel
  // the record's origin for the rest of its life. "Jenny recently changed this"
  // is a different question, and the journal already answers it better — the
  // Undo affordance is journal-driven and expires honestly with the ring.
  //
  // sourceId travels WITH sourceKind because they are one attribution pair: a
  // sourceId pointing at the editing tool call while sourceKind says the record
  // is the user's would be incoherent.
  //
  // Carrying `prior` last in the payload spread also pins the pair against a
  // model-supplied sourceKind/sourceId in `input`, which the create branch has
  // always overridden.
  _attribution(meta = {}, prior = null) {
    if (prior) {
      return {
        sourceKind: normalizeString(prior.sourceKind),
        sourceId: normalizeString(prior.sourceId),
      };
    }
    return {
      sourceKind: 'assistant',
      sourceId: normalizeString(meta?.sourceId || meta?.callId || meta?.sessionId),
    };
  }

  // NOTE: not `_events` — EventEmitter already owns that instance property.
  _calendarEvents() {
    const state = this.calendarService.getState();
    return Array.isArray(state?.events) ? state.events : [];
  }

  _allReminders() {
    const reminders = this.configService.getState?.()?.proactive?.reminders;
    return Array.isArray(reminders) ? reminders : [];
  }

  _readEvent(id) {
    const entityId = normalizeString(id);
    return entityId ? this._calendarEvents().find((event) => event.id === entityId) || null : null;
  }

  // CalendarService.createEvent returns the full POST-state and appends the new
  // record last, so the id is read straight out of the value the write already
  // handed back — no second getState() round-trip, and no dependence on a
  // set-difference the caller has to re-derive. Scanning from the end makes the
  // newest unseen id win; `beforeIds` only guards against a store that reorders.
  _createdEventId(postState, beforeIds) {
    const events = Array.isArray(postState?.events) ? postState.events : this._calendarEvents();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const id = normalizeString(events[index]?.id);
      if (id && !beforeIds.has(id)) {
        return id;
      }
    }
    return '';
  }

  _readReminder(id) {
    const entityId = normalizeString(id);
    return entityId ? this._allReminders().find((entry) => entry.id === entityId) || null : null;
  }

  // The entity write has ALREADY landed by the time this runs, so a journal
  // failure must not be reported as a failed call: the model would read
  // `action_failed`, retry, and create a duplicate record. The entity store is
  // the source of truth; journaling is the recoverable half. A failure here
  // degrades to an attributed-but-un-undoable write, marked `journaled: false`
  // so the tool layer can say so instead of promising an undo that is not
  // there.
  _record({ entity, entityId, op, label, meta, prior, post }) {
    const now = this.nowProvider();
    let entry = null;
    try {
      if (!entityId) {
        throw new Error(`${entity} id could not be resolved after the write`);
      }
      entry = this.journal.append({
        id: this.journal.nextId(now),
        at: now.toISOString(),
        entity,
        entityId,
        op,
        label,
        sessionId: normalizeString(meta?.sessionId),
        inverse: op === 'create'
          ? { kind: 'delete', payload: null }
          : { kind: op === 'delete' ? 'restore' : 'update', payload: prior },
        postHash: JSON.stringify(post ?? null),
        undoneAt: '',
        supersededAt: '',
      }, now);
    } catch (error) {
      this.logger('WARN', 'home_assistant.journal_append_failed', {
        entity,
        op,
        entity_id: String(entityId || '').slice(0, 128),
        error_name: String(error?.name || 'Error').slice(0, 64),
        error_message: String(error?.message || error).slice(0, 200),
      });
    }
    const payload = this._changedPayload();
    this.emit('changed', payload);
    return {
      ok: true,
      entryId: entry ? entry.id : '',
      entityId,
      entity,
      op,
      entityState: post,
      journaled: entry !== null,
      journal: payload.journal,
      proactive: payload.proactive,
    };
  }

  _changedPayload() {
    let proactive;
    try {
      proactive = this.getProactive();
    } catch (_error) {
      proactive = emptyProactive();
    }
    return { journal: this.listJournal(), proactive };
  }
}

module.exports = {
  CALENDAR_EVENT,
  REMINDER,
  HomeAssistantService,
  emptyProactive,
};
