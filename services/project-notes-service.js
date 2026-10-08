'use strict';

const { EventEmitter } = require('events');
const { GENERAL_PROJECT_ID, normalizeProjectId } = require('./projects/project-schema');
const {
  MAX_NOTE_CHARS,
  ProjectNotesStore,
  stripNul,
} = require('./project-notes-store');

// Electron-owned service over the per-project note. Three callers share it:
//   - the renderer's note editor (`save`, `undo`, `lease`, `get`),
//   - the model's note tool in a later wave (`append`, `replace`), and
//   - project deletion (`deleteProjectNotes`).
//
// Concurrency model: the renderer holds a short in-memory edit lease while the
// user is typing, and Jenny's tool paths refuse (`note_being_edited`) while it
// is held, so the assistant never races the user mid-keystroke. The renderer's
// own saves are optimistic: a stale `baseRevision` is rejected with the current
// note so the editor can reconcile instead of clobbering a Jenny write. Every
// public method returns `{ ok: false, reason }` for bad input; none throws.
const LEASE_TTL_MS = 30000;
const MAX_HEADINGS = 5;
const MAX_HEADING_CHARS = 80;
const HEADING_PREFIX = '## ';

function lineCount(text) {
  return text === '' ? 0 : text.replace(/\n$/u, '').split('\n').length;
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return count;
    count += 1;
    // Overlapping occurrences count too: `aa` in `aaa` is ambiguous, not unique.
    from = index + 1;
    if (count > 1) return count;
  }
}

function diffLineCounts(before, after) {
  const beforeLines = lineCount(before);
  const afterLines = lineCount(after);
  const added = Math.max(0, afterLines - beforeLines);
  const removed = Math.max(0, beforeLines - afterLines);
  return { added, removed, changed: added === 0 && removed === 0 && before !== after ? 1 : 0 };
}

// The journal's view of a write: the changed-range counts plus where the new
// lines start (indices into `after.split('\n')`, which is how the rail renders).
function journalLines(before, after) {
  // One trailing newline is not a line, as the rail's diffLines and diffLineCounts both read it.
  const split = (text) => { const body = text.replace(/\n$/u, ''); return body === '' ? [] : body.split('\n'); };
  const beforeLines = split(before);
  const afterLines = split(after);
  const { start, end } = changedRange(beforeLines, afterLines);
  const added = end - start;
  return { added, removed: beforeLines.length - afterLines.length + added, start };
}

function isHeadingLine(line) {
  return line.startsWith(HEADING_PREFIX);
}

function headingText(line) {
  return line.slice(HEADING_PREFIX.length).replace(/\s+$/u, '').slice(0, MAX_HEADING_CHARS);
}

// Index range [start, end) of the lines that differ in `after`, found by
// trimming the common prefix and suffix. A pure deletion yields an empty range.
function changedRange(beforeLines, afterLines) {
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
    start += 1;
  }
  let suffix = 0;
  while (
    suffix < beforeLines.length - start
    && suffix < afterLines.length - start
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { start, end: afterLines.length - suffix };
}

function governingHeading(lines, index) {
  for (let cursor = Math.min(index, lines.length - 1); cursor >= 0; cursor -= 1) {
    if (isHeadingLine(lines[cursor])) return headingText(lines[cursor]);
  }
  return '';
}

// The `## ` headings whose sections contain changed lines, in document order.
function changedHeadings(before, after) {
  const afterLines = after.split('\n');
  const { start, end } = changedRange(before.split('\n'), afterLines);
  const probes = [];
  if (end > start) {
    for (let index = start; index < end; index += 1) probes.push(index);
  } else {
    probes.push(Math.max(0, start - 1));
  }
  const headings = [];
  for (const index of probes) {
    const heading = governingHeading(afterLines, index);
    if (heading && !headings.includes(heading)) headings.push(heading);
    if (headings.length >= MAX_HEADINGS) break;
  }
  return headings;
}

function appendAtEnd(before, text) {
  if (before === '') return text;
  return `${before}${before.endsWith('\n') ? '' : '\n'}${text}`;
}

function normalizeHeading(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n]+/gu, ' ').replace(/^#+\s*/u, '').trim().slice(0, MAX_HEADING_CHARS);
}

function findSection(lines, heading) {
  const wanted = `${HEADING_PREFIX}${heading}`;
  const start = lines.findIndex((line) => line.replace(/\s+$/u, '') === wanted);
  if (start === -1) return null;
  let end = lines.findIndex((line, index) => index > start && isHeadingLine(line));
  if (end === -1) end = lines.length;
  // Keep blank separator lines after the section body, before the next heading.
  while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
  return { start, insertAt: end };
}

function appendUnderHeading(before, text, heading) {
  const lines = before.split('\n');
  const section = findSection(lines, heading);
  if (!section) {
    const base = before === '' ? '' : `${before}${before.endsWith('\n') ? '' : '\n'}\n`;
    return `${base}${HEADING_PREFIX}${heading}\n${text}`;
  }
  const inserted = text.replace(/\n+$/u, '').split('\n');
  lines.splice(section.insertAt, 0, ...inserted);
  return lines.join('\n');
}

class ProjectNotesService extends EventEmitter {
  constructor({
    userDataPath,
    store = null,
    logger = () => {},
    now = () => new Date(),
    // Optional `(projectId) => boolean`: when given, writes and leases for a
    // project that no longer exists are refused (a late autosave after a project
    // delete must not recreate its note file). General always exists.
    projectExists = null,
  } = {}) {
    super();
    this._projectExists = typeof projectExists === 'function' ? projectExists : null;
    this._logger = typeof logger === 'function' ? logger : () => {};
    this._now = typeof now === 'function' ? now : () => new Date();
    this._store = store || new ProjectNotesStore({ userDataPath, logger: this._logger, now: this._now });
    this._leases = new Map();
  }

  // ---- reads ------------------------------------------------------------

  get(projectId) {
    const id = this._validId(projectId, 'get');
    if (!id) return { ok: false, reason: 'invalid_project_id' };
    return this._guard('get', () => {
      const status = this._store.readStatus(id);
      if (status.unavailable) return { ok: false, reason: 'note_unavailable' };
      return { ok: true, note: this._publicNote(status.record) };
    });
  }

  // ---- renderer write path ---------------------------------------------

  save(projectId, text, baseRevision) {
    const id = this._validId(projectId, 'save');
    if (!id) return { ok: false, reason: 'invalid_project_id' };
    if (typeof text !== 'string') return { ok: false, reason: 'invalid_text' };
    if (!this._projectKnown(id)) return { ok: false, reason: 'project_unavailable' };
    const cleaned = stripNul(text);
    if (cleaned.length > MAX_NOTE_CHARS) return { ok: false, reason: 'note_full' };
    return this._guard('save', () => {
      const status = this._store.readStatus(id);
      if (status.unavailable) return { ok: false, reason: 'note_unavailable' }; // never a conflict against the empty stand-in
      const current = status.record;
      if (baseRevision !== current.revision) {
        return { ok: false, reason: 'stale', current: this._publicNote(current) };
      }
      const record = this._store.write(id, { text: cleaned, updatedBy: 'user' });
      this._emitChanged(record, 'save', '');
      return { ok: true, note: this._publicNote(record) };
    });
  }

  // ---- tool write paths (wave 2) ----------------------------------------

  append(projectId, input, { summary = '' } = {}) {
    const id = this._validId(projectId, 'append');
    if (!id) return { ok: false, reason: 'invalid_project_id' };
    if (!this._projectKnown(id)) return { ok: false, reason: 'project_unavailable' };
    if (this.isLeased(id)) return { ok: false, reason: 'note_being_edited' };
    const text = typeof input?.text === 'string' ? stripNul(input.text) : '';
    if (!text) return { ok: false, reason: 'invalid_text' };
    const heading = normalizeHeading(input.heading);
    return this._toolWrite(id, 'append', summary, (before) => ({
      ok: true,
      after: heading ? appendUnderHeading(before, text, heading) : appendAtEnd(before, text),
    }));
  }

  replace(projectId, input, { summary = '' } = {}) {
    const id = this._validId(projectId, 'replace');
    if (!id) return { ok: false, reason: 'invalid_project_id' };
    if (!this._projectKnown(id)) return { ok: false, reason: 'project_unavailable' };
    if (this.isLeased(id)) return { ok: false, reason: 'note_being_edited' };
    if (typeof input?.oldText !== 'string' || !input.oldText || typeof input.newText !== 'string') {
      return { ok: false, reason: 'invalid_text' };
    }
    const oldText = stripNul(input.oldText);
    const newText = stripNul(input.newText);
    return this._toolWrite(id, 'replace', summary, (before) => {
      const matches = countOccurrences(before, oldText);
      if (matches === 0) return { ok: false, reason: 'no_match' };
      if (matches > 1) return { ok: false, reason: 'ambiguous_match' };
      const index = before.indexOf(oldText);
      return { ok: true, after: `${before.slice(0, index)}${newText}${before.slice(index + oldText.length)}` };
    });
  }

  undo(projectId, entryId) {
    const id = this._validId(projectId, 'undo');
    if (!id) return { ok: false, reason: 'invalid_project_id' };
    return this._guard('undo', () => {
      const result = this._store.undo(id, typeof entryId === 'string' ? entryId : '');
      if (!result.ok) return { ok: false, reason: result.reason };
      this._emitChanged(result.record, 'undo', entryId);
      return { ok: true, note: this._publicNote(result.record) };
    });
  }

  // ---- edit lease -------------------------------------------------------

  lease(projectId, held) {
    const id = this._validId(projectId, 'lease');
    if (!id) return { ok: false, reason: 'invalid_project_id' };
    if (held === true && !this._projectKnown(id)) return { ok: false, reason: 'project_unavailable' };
    if (held !== true) {
      this._leases.delete(id);
      return { ok: true, held: false, expiresAt: '' };
    }
    const expiresMs = this._now().getTime() + LEASE_TTL_MS;
    this._pruneLeases();
    this._leases.set(id, expiresMs);
    return { ok: true, held: true, expiresAt: new Date(expiresMs).toISOString() };
  }

  isLeased(projectId) {
    const id = normalizeProjectId(projectId);
    const expiresMs = id ? this._leases.get(id) : undefined;
    if (expiresMs === undefined) return false;
    if (this._now().getTime() >= expiresMs) {
      this._leases.delete(id);
      return false;
    }
    return true;
  }

  // ---- lifecycle --------------------------------------------------------

  deleteProjectNotes(projectId) {
    const id = this._validId(projectId, 'deleteProjectNotes');
    if (!id) return { ok: false, reason: 'invalid_project_id' };
    this._leases.delete(id);
    return this._guard('deleteProjectNotes', () => {
      this._store.deleteProject(id);
      return { ok: true };
    });
  }

  // ---- internals --------------------------------------------------------

  _projectKnown(id) {
    if (!this._projectExists || id === GENERAL_PROJECT_ID) return true;
    try {
      return this._projectExists(id) !== false;
    } catch (_error) {
      return true;
    }
  }

  _validId(projectId, method) {
    const id = normalizeProjectId(projectId);
    if (!id || id !== projectId) {
      this._logger('WARN', 'project_notes.invalid_project_id', { method });
      return '';
    }
    return id;
  }

  // A throwing store (disk error, cap backstop) must not escape to IPC.
  _guard(method, run) {
    try {
      return run();
    } catch (error) {
      const reason = error && (error.code === 'note_full' || error.code === 'note_unavailable') ? error.code : 'write_failed';
      this._logger(reason === 'write_failed' ? 'ERROR' : 'WARN', 'project_notes.operation_failed', { method, reason });
      return { ok: false, reason };
    }
  }

  _toolWrite(id, op, summary, compute) {
    return this._guard(op, () => {
      const status = this._store.readStatus(id);
      if (status.unavailable) return { ok: false, reason: 'note_unavailable' };
      const current = status.record;
      const computed = compute(current.text);
      if (!computed.ok) return computed;
      if (computed.after.length > MAX_NOTE_CHARS) return { ok: false, reason: 'note_full' };
      const record = this._store.write(id, {
        text: computed.after,
        updatedBy: 'assistant',
        journalEntry: {
          op,
          summary: typeof summary === 'string' && summary ? summary : op,
          lines: journalLines(current.text, computed.after),
        },
      });
      const journalEntryId = record.journal[record.journal.length - 1].id;
      this._emitChanged(record, op, journalEntryId);
      return {
        ok: true,
        note: this._publicNote(record),
        journalEntryId,
        lines: diffLineCounts(current.text, record.text),
        headings: changedHeadings(current.text, record.text),
      };
    });
  }

  _pruneLeases() {
    const nowMs = this._now().getTime();
    for (const [id, expiresMs] of this._leases) {
      if (nowMs >= expiresMs) this._leases.delete(id);
    }
  }

  _publicNote(record) {
    return {
      projectId: record.projectId,
      text: record.text,
      revision: record.revision,
      updatedAt: record.updatedAt,
      updatedBy: record.updatedBy,
      journal: record.journal.map((entry) => ({
        id: entry.id,
        at: entry.at,
        op: entry.op,
        summary: entry.summary,
        undoable: this._store.isUndoable(record, entry.id),
        undone: Boolean(entry.undoneAt),
        lines: entry.lines || null,
      })),
    };
  }

  _emitChanged(record, reason, journalEntryId) {
    const payload = {
      projectId: record.projectId,
      revision: record.revision,
      updatedBy: record.updatedBy,
      journalEntryId: journalEntryId || '',
      reason,
    };
    try {
      this.emit('changed', payload);
    } catch (error) {
      this._logger('WARN', 'project_notes.listener_failed', { reason });
      void error;
    }
  }
}

module.exports = {
  LEASE_TTL_MS,
  ProjectNotesService,
};
