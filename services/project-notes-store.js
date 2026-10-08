'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { FileJsonStore } = require('./backend/file-json-store');
const { normalizeProjectId } = require('./projects/project-schema');

// Per-project scratch note with a small attribution/undo journal.
//
// One JSON file per project at <userData>/project-notes/<projectId>.json. The
// note is plain text the user and Jenny both write; Jenny's writes append a
// journal entry carrying the text BEFORE the write plus a `postHash` of the
// text as Jenny left it. A later undo can therefore prove nothing else touched
// the note in between: it restores `previousText` only while the current text
// still hashes to the entry's `postHash`, and refuses (never clobbers) after a
// user edit or a later change. Undoing the newest entry re-exposes the
// previous entry's hash, so a stack of undos works.
//
// Pure persistence: no Electron imports, sync API (same shape as the Home
// journal store), persist-then-swap on every write (the next record is built
// on copies and written before it is handed back, so a throwing disk leaves
// the stored note exactly as it was).
const PROJECT_NOTES_DIR = 'project-notes';
const NOTE_STORE_VERSION = 1;
const MAX_NOTE_CHARS = 20000;
const MAX_JOURNAL_ENTRIES = 10;
const MAX_SUMMARY_CHARS = 200;
const JOURNAL_OPS = Object.freeze(['append', 'replace']);
const UPDATED_BY_VALUES = Object.freeze(['user', 'assistant']);

function stripNul(value) {
  return String(value).split(String.fromCharCode(0)).join('');
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function assertProjectId(projectId) {
  const id = normalizeProjectId(projectId);
  if (!id || id !== projectId) {
    throw new TypeError('project notes require a valid project id');
  }
  return id;
}

function emptyRecord(projectId) {
  return {
    version: NOTE_STORE_VERSION,
    projectId,
    text: '',
    revision: 0,
    updatedAt: '',
    updatedBy: 'user',
    journal: [],
  };
}

// The line diff of a Jenny write ({ added, removed, start }), kept so a rail
// opened after the write can still describe and tint it. null when unknown.
function normalizeLines(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!source) return null;
  const pick = (key) => (Number.isInteger(source[key]) && source[key] >= 0 ? source[key] : 0);
  return { added: pick('added'), removed: pick('removed'), start: pick('start') };
}

function normalizeJournalEntry(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!source || typeof source.id !== 'string' || !source.id) return null;
  if (!JOURNAL_OPS.includes(source.op)) return null;
  if (typeof source.previousText !== 'string' || typeof source.postHash !== 'string') return null;
  return {
    id: source.id,
    at: typeof source.at === 'string' ? source.at : '',
    op: source.op,
    summary: typeof source.summary === 'string' ? source.summary.slice(0, MAX_SUMMARY_CHARS) : '',
    previousText: stripNul(source.previousText).slice(0, MAX_NOTE_CHARS),
    postHash: source.postHash,
    undoneAt: typeof source.undoneAt === 'string' ? source.undoneAt : '',
    lines: normalizeLines(source.lines),
  };
}

// Returns null for anything unrecognised (the caller reads that as the empty note).
function normalizeRecord(projectId, raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
  if (!source || source.version !== NOTE_STORE_VERSION || typeof source.text !== 'string') {
    return null;
  }
  const revision = Number.isSafeInteger(source.revision) && source.revision >= 0 ? source.revision : 0;
  const journal = (Array.isArray(source.journal) ? source.journal : [])
    .map((entry) => normalizeJournalEntry(entry))
    .filter(Boolean)
    .slice(-MAX_JOURNAL_ENTRIES);
  return {
    version: NOTE_STORE_VERSION,
    projectId,
    text: stripNul(source.text).slice(0, MAX_NOTE_CHARS),
    revision,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
    updatedBy: UPDATED_BY_VALUES.includes(source.updatedBy) ? source.updatedBy : 'user',
    journal,
  };
}

function cloneRecord(record) {
  return { ...record, journal: record.journal.map((entry) => ({ ...entry })) };
}

function noteUnavailableError() {
  const error = new Error('the note file exists but cannot be read; refusing to overwrite it');
  error.code = 'note_unavailable';
  return error;
}

function noteFullError() {
  const error = new Error('note exceeds the maximum length');
  error.code = 'note_full';
  return error;
}

class ProjectNotesStore {
  constructor({
    userDataPath,
    logger = () => {},
    now = () => new Date(),
    fileStoreFactory = (filePath, options) => new FileJsonStore(filePath, options),
  } = {}) {
    if (!userDataPath || typeof userDataPath !== 'string') {
      throw new Error('userDataPath is required for ProjectNotesStore.');
    }
    this.root = path.resolve(userDataPath, PROJECT_NOTES_DIR);
    this._logger = typeof logger === 'function' ? logger : () => {};
    this._now = typeof now === 'function' ? now : () => new Date();
    this._fileStoreFactory = fileStoreFactory;
    this._idCounter = 0;
  }

  // Only ids that pass normalizeProjectId ever reach the filesystem; the
  // containment check is belt-and-braces over that regex.
  filePathFor(projectId) {
    const id = assertProjectId(projectId);
    const filePath = path.join(this.root, `${id}.json`);
    const relative = path.relative(this.root, filePath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new TypeError('project notes path escapes the notes directory');
    }
    return filePath;
  }

  _fileStore(projectId) {
    // redactReadErrors: a corrupt note must not put its text in the logs.
    return this._fileStoreFactory(this.filePathFor(projectId), { logger: this._logger, redactReadErrors: true });
  }

  // `unavailable` is true when a file exists but cannot be used (unreadable,
  // corrupt, or another store version): reads see the empty note, every
  // write path refuses, so the bytes on disk are never replaced blindly.
  readStatus(projectId) {
    const id = assertProjectId(projectId);
    const result = this._fileStore(id).readWithStatus(null);
    if (result.missing) {
      return { record: emptyRecord(id), unavailable: false };
    }
    const record = result.corrupted || result.unreadable ? null : normalizeRecord(id, result.value);
    if (!record) {
      this._logger('WARN', 'project_notes.store_unreadable', { projectId: id });
      return { record: emptyRecord(id), unavailable: true };
    }
    return { record, unavailable: false };
  }

  read(projectId) {
    return this.readStatus(projectId).record;
  }

  _nextEntryId() {
    this._idCounter += 1;
    return `pnj_${this._now().getTime().toString(36)}_${this._idCounter.toString(36)}`;
  }

  _persist(projectId, record) {
    this._fileStore(projectId).writeImmediate(record);
  }

  write(projectId, { text, updatedBy, journalEntry = null } = {}) {
    const id = assertProjectId(projectId);
    if (typeof text !== 'string') {
      throw new TypeError('project note text must be a string');
    }
    const nextText = stripNul(text);
    if (nextText.length > MAX_NOTE_CHARS) {
      throw noteFullError();
    }
    const status = this.readStatus(id);
    if (status.unavailable) throw noteUnavailableError();
    const current = status.record;
    const stampedAt = this._now().toISOString();
    const journal = current.journal.map((entry) => ({ ...entry }));
    if (journalEntry) {
      if (!JOURNAL_OPS.includes(journalEntry.op)) {
        throw new TypeError('project note journal op is invalid');
      }
      journal.push({
        id: this._nextEntryId(),
        at: stampedAt,
        op: journalEntry.op,
        summary: String(journalEntry.summary || '').slice(0, MAX_SUMMARY_CHARS),
        previousText: current.text,
        postHash: sha256(nextText),
        undoneAt: '',
        lines: normalizeLines(journalEntry.lines),
      });
    }
    const next = {
      version: NOTE_STORE_VERSION,
      projectId: id,
      text: nextText,
      revision: current.revision + 1,
      updatedAt: stampedAt,
      updatedBy: UPDATED_BY_VALUES.includes(updatedBy) ? updatedBy : 'user',
      journal: journal.slice(-MAX_JOURNAL_ENTRIES),
    };
    this._persist(id, next);
    return cloneRecord(next);
  }

  isUndoable(record, entryId) {
    const entry = record.journal.find((candidate) => candidate.id === entryId);
    return Boolean(entry) && !entry.undoneAt && sha256(record.text) === entry.postHash;
  }

  undo(projectId, entryId) {
    const id = assertProjectId(projectId);
    const status = this.readStatus(id);
    if (status.unavailable) return { ok: false, reason: 'note_unavailable' };
    const current = status.record;
    const entry = current.journal.find((candidate) => candidate.id === entryId);
    if (!entry) return { ok: false, reason: 'entry_not_found' };
    if (entry.undoneAt) return { ok: false, reason: 'already_undone' };
    if (sha256(current.text) !== entry.postHash) return { ok: false, reason: 'changed_since' };
    const stampedAt = this._now().toISOString();
    const next = {
      version: NOTE_STORE_VERSION,
      projectId: id,
      text: entry.previousText,
      revision: current.revision + 1,
      updatedAt: stampedAt,
      // The user asked for the undo; the restored text is theirs again.
      updatedBy: 'user',
      journal: current.journal.map((candidate) => (
        candidate.id === entryId ? { ...candidate, undoneAt: stampedAt } : { ...candidate }
      )),
    };
    this._persist(id, next);
    return { ok: true, record: cloneRecord(next) };
  }

  deleteProject(projectId) {
    const id = assertProjectId(projectId);
    this._fileStore(id).delete();
  }

  listProjects() {
    let names;
    try {
      names = fs.readdirSync(this.root);
    } catch (error) {
      if (error && error.code === 'ENOENT') return [];
      throw error;
    }
    return names
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((id) => normalizeProjectId(id) === id)
      .sort();
  }
}

module.exports = {
  MAX_JOURNAL_ENTRIES,
  MAX_NOTE_CHARS,
  MAX_SUMMARY_CHARS,
  PROJECT_NOTES_DIR,
  ProjectNotesStore,
  sha256,
  stripNul,
};
