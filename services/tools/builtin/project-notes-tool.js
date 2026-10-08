'use strict';

/* Model access to the per-project note: a single markdown page the user also
 * edits in the Notes rail.
 *
 * The sidecar reaches this Electron-owned tool through tool.execute_electron.
 * ProjectNotesService remains the sole persistence owner (attribution, the
 * undo journal, the user's edit lease and the size cap all live there); this
 * module only validates model input, resolves the project from the trusted
 * execution authority, and renders a bounded plain-text result. It never logs
 * note text. */

const { TOOL_ERROR_CODES } = require('../../backend/error-codes');
const { normalizeString } = require('../../shared/normalize');
const { normalizeProjectId } = require('../../projects/project-schema');
const { MAX_NOTE_CHARS } = require('../../project-notes-store');

const PROJECT_NOTES_ACTIONS = Object.freeze(['read', 'append', 'replace']);
const MAX_APPEND_TEXT_CHARS = 4000;
const MAX_HEADING_CHARS = 120;
const MAX_SUMMARY_CHARS = 140;
const UNDO_LINE = 'Undo: available in the chat and the Notes rail.';

const FAILURE_COPY = Object.freeze({
  project_unavailable: 'The chat has no project; project notes are unavailable.',
  note_being_edited: 'The user is editing the project notes right now; try again in a moment.',
  no_match: 'old_text was not found in the project notes; read them first and copy the passage exactly.',
  ambiguous_match: 'old_text appears more than once; include more surrounding text.',
  note_full: 'The project notes are at their 20,000-character limit; replace or trim text instead of appending.',
  invalid_text: 'The text is missing or not a valid string.',
  note_unavailable: 'The project notes file cannot be read right now; nothing was changed.',
  write_failed: 'The project notes could not be saved.',
});

// The user's open editor is contention, not a fault: nothing was written and the same call
// succeeds once they pause, so the model is told to retry unchanged (failure taxonomy
// `transient`) instead of the internal-error default of never retrying.
const TRANSIENT_REASONS = new Set(['note_being_edited']);

function failure(reason, content, summary, errorCode = TOOL_ERROR_CODES.EXECUTION_FAILED) {
  const metadata = { result_kind: 'project_notes', status: 'failed', reason };
  if (TRANSIENT_REASONS.has(reason)) Object.assign(metadata, { failure_class: 'transient', effects: 'none' });
  return {
    content,
    summary,
    isError: true,
    errorCode,
    metadata,
  };
}

function serviceFailure(rawReason) {
  // A canonicalised project id that the service still rejects is, to the
  // model, the same condition as no project.
  const reason = rawReason === 'invalid_project_id' ? 'project_unavailable' : rawReason;
  const content = FAILURE_COPY[reason] || FAILURE_COPY.write_failed;
  return failure(
    FAILURE_COPY[reason] ? reason : 'write_failed',
    content,
    'Project notes unavailable'
  );
}

function success(action, content, summary, extra) {
  return {
    content,
    summary,
    isError: false,
    metadata: { result_kind: 'project_notes', action, status: 'ok', ...extra },
  };
}

function invalid(reason, content) {
  return failure(reason, content, 'Project notes input rejected');
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// A present field must be a string within its bound. Returns { text } or { error }.
function boundedString(value, field, limit) {
  if (value === undefined || value === null) return { text: '' };
  if (typeof value !== 'string') return { error: invalid('invalid_input', `${field} must be a string.`) };
  const text = value.replace(/\0/gu, '');
  if (text.length > limit) {
    return { error: invalid('invalid_input', `${field} exceeds the ${limit} character limit.`) };
  }
  return { text };
}

function readSummary(input) {
  const summary = boundedString(input?.summary, 'summary', MAX_SUMMARY_CHARS);
  return summary.error ? summary : { text: summary.text.replace(/\s+/gu, ' ').trim() };
}

function prepareAppend(input) {
  if (typeof input?.text !== 'string' || !input.text.replace(/\0/gu, '').trim()) {
    return { error: invalid('invalid_text', 'text is required and must be a non-empty string.') };
  }
  const text = boundedString(input.text, 'text', MAX_APPEND_TEXT_CHARS);
  if (text.error) return text;
  const heading = boundedString(input.heading, 'heading', MAX_HEADING_CHARS);
  if (heading.error) return heading;
  const summary = readSummary(input);
  if (summary.error) return summary;
  const headingText = heading.text.replace(/[\r\n]+/gu, ' ').trim();
  const defaultSummary = headingText ? `Added under "${headingText}"` : 'Added to the notes';
  return {
    payload: { text: text.text, heading: headingText },
    summary: summary.text || defaultSummary,
  };
}

function prepareReplace(input) {
  if (typeof input?.old_text !== 'string' || !input.old_text.replace(/\0/gu, '')) {
    return { error: invalid('invalid_text', 'old_text is required and must be a non-empty string.') };
  }
  if (typeof input.new_text !== 'string') {
    return { error: invalid('invalid_text', 'new_text is required; use an empty string to delete the passage.') };
  }
  const oldText = boundedString(input.old_text, 'old_text', MAX_NOTE_CHARS);
  if (oldText.error) return oldText;
  const newText = boundedString(input.new_text, 'new_text', MAX_NOTE_CHARS);
  if (newText.error) return newText;
  const summary = readSummary(input);
  if (summary.error) return summary;
  return {
    payload: { oldText: oldText.text, newText: newText.text },
    summary: summary.text || 'Edited the notes',
  };
}

function readNote(service, projectId) {
  const result = service.get(projectId);
  if (!result?.ok) return serviceFailure(result?.reason);
  const note = result.note || {};
  const text = typeof note.text === 'string' ? note.text : '';
  return success('read', text.trim() ? text : 'Project notes are empty.', 'Read project notes', {
    project_id: projectId,
    revision: note.revision,
    chars: text.length,
    updated_at: typeof note.updatedAt === 'string' ? note.updatedAt : '',
    updated_by: typeof note.updatedBy === 'string' ? note.updatedBy : '',
  });
}

function writeResult(action, result, projectId, summary) {
  const lines = {
    added: result.lines?.added || 0,
    removed: result.lines?.removed || 0,
    changed: result.lines?.changed || 0,
  };
  const headline = action === 'append'
    ? `Added ${plural(lines.added, 'line')} to the project notes.`
    : `Replaced a passage in the project notes (+${lines.added} −${lines.removed}).`;
  return success(action, `${headline}\n${UNDO_LINE}`, action === 'append' ? 'Added to project notes' : 'Edited project notes', {
    project_id: projectId,
    revision: result.note?.revision,
    journal_entry_id: result.journalEntryId || '',
    summary,
    lines,
    // The `## ` sections the write touched (the service bounds the list).
    headings: Array.isArray(result.headings) ? result.headings.filter((h) => typeof h === 'string').slice(0, 6) : [],
  });
}

// The Notes rail frees its edit lease 5 s after the user's last keystroke. A write that meets
// the lease waits that out once, so a pause lets it land in this call; back-to-back model
// retries (about a second apart) could never outlast the window on their own (row 21 gate).
const LEASE_WAIT_MS = 6000;
const LEASE_POLL_MS = 250;
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function writeNote(service, projectId, action, input, leaseWait) {
  const prepared = action === 'append' ? prepareAppend(input) : prepareReplace(input);
  if (prepared.error) return prepared.error;
  const write = () => (action === 'append'
    ? service.append(projectId, prepared.payload, { summary: prepared.summary })
    : service.replace(projectId, prepared.payload, { summary: prepared.summary }));
  let result = write();
  for (let waited = 0; result?.reason === 'note_being_edited' && waited < leaseWait.totalMs; waited += LEASE_POLL_MS) {
    await leaseWait.sleep(LEASE_POLL_MS);
    result = write();
  }
  if (!result?.ok) return serviceFailure(result?.reason);
  return writeResult(action, result, projectId, prepared.summary);
}

module.exports = {
  name: 'project_notes',
  description: "Read and edit Jenny's notes for the current chat's project: a single markdown page the user also edits in the Notes rail. read returns the note; append adds text at the end or under a `## Heading`; replace swaps one exact passage for another. Writes are attributed to Jenny and one-click undoable from the chat and the Notes rail. Keep notes short and factual: decisions, conventions, open questions, where things live.",
  category: 'builtin',
  readOnly: false,
  workspaceRequired: false,
  parameters: { type: 'object', properties: {}, required: ['action'] },

  summarize(input) {
    const action = normalizeString(input?.action);
    return `Project notes: ${action || 'action'}`;
  },

  async execute(input, context) {
    const service = context?.projectNotesService;
    if (!service || typeof service.get !== 'function'
      || typeof service.append !== 'function' || typeof service.replace !== 'function') {
      return failure(
        'service_unavailable',
        'The project notes store is unavailable.',
        'Project notes unavailable',
        TOOL_ERROR_CODES.DISABLED
      );
    }
    // The project comes from the trusted execution authority, never from model arguments.
    const projectId = normalizeProjectId(context?.projectAuthority?.project_id);
    if (!projectId) {
      return failure('project_unavailable', FAILURE_COPY.project_unavailable, 'Project notes unavailable');
    }
    const action = normalizeString(input?.action).toLowerCase();
    if (!PROJECT_NOTES_ACTIONS.includes(action)) {
      return invalid('unsupported_action', `action must be one of: ${PROJECT_NOTES_ACTIONS.join(', ')}.`);
    }
    // `projectNotesLeaseWaitMs` and `sleep` are test seams; production waits LEASE_WAIT_MS.
    const leaseWait = {
      totalMs: Number.isFinite(context?.projectNotesLeaseWaitMs) ? Math.max(0, context.projectNotesLeaseWaitMs) : LEASE_WAIT_MS,
      sleep: typeof context?.sleep === 'function' ? context.sleep : defaultSleep,
    };
    try {
      return action === 'read'
        ? readNote(service, projectId)
        : await writeNote(service, projectId, action, input, leaseWait);
    } catch (error) {
      // Never log note text or the error message (it may quote the note).
      context?.logger?.('WARN', 'project_notes.action_failed', {
        action,
        error_name: String(error?.name || 'Error').slice(0, 64),
      });
      return failure('write_failed', FAILURE_COPY.write_failed, 'Project notes action failed');
    }
  },
};
