'use strict';

/* services/computer-use/grant-gate.js: the per-chat grants of computer use (row 196).
 *
 * A grant names a program by its file and lives in memory for the chat (D1). A person answers every
 * ask: a program grant, every `open`, and the first time a program shows the standard Open or Save
 * dialog in a chat (D9; Full auto never answers a `computer` approval, full-auto-gate.js). Programs of
 * kind `never` are refused without a card; `view_only` programs may be granted for looking only.
 *
 * One gate lives per chat; forCall() binds it to one tool call's approver and abort signal, as the
 * browser's consent gate does. */

const { allowsInput, normalizeProgramPath, programKind } = require('./program-rules');

const APPROVAL_SCHEMA_VERSION = 1;
const MAX_GRANTS = 64;
const MAX_NAME_CHARS = 120;
const MAX_PATH_CHARS = 512;
const ASK_KINDS = Object.freeze(['grant', 'open', 'file_dialog']);

// Control characters out: a name or path from a window or a file must not shape the card.
function withoutControls(value, replacement) {
  return [...String(value || '')].map((ch) => {
    const code = ch.codePointAt(0);
    return code < 0x20 || code === 0x7f ? replacement : ch;
  }).join('');
}

function cleanName(value, fallback) {
  const text = withoutControls(value, ' ').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, MAX_NAME_CHARS);
}

function displayPath(programPath) {
  const text = withoutControls(programPath, '');
  return text.length > MAX_PATH_CHARS ? `...${text.slice(-(MAX_PATH_CHARS - 3))}` : text;
}

/**
 * @param {object} [deps]
 * @param {() => string[]} [deps.jennyPrograms] Jenny's own program files, read on every judgement
 * @param {string} [deps.windowsDir]
 * @param {() => number} [deps.now]
 */
function createGrantGate({ jennyPrograms = () => [process.execPath], windowsDir, now = Date.now } = {}) {
  // program file (normalised) -> { program, name, kind }
  const grants = new Map();
  // programs whose file dialog a person has allowed in this chat
  const fileDialogs = new Set();

  function readJennyPrograms() {
    try {
      const value = jennyPrograms();
      return Array.isArray(value) ? value : [];
    } catch (_error) {
      return [];
    }
  }

  function judge(programPath) {
    return programKind(programPath, { windowsDir, jennyPrograms: readJennyPrograms() });
  }

  function granted(programPath) {
    const key = normalizeProgramPath(programPath);
    const grant = grants.get(key);
    // Judged again on every read: a rule change or a renamed Jenny never leaves a stale grant usable.
    if (!grant || judge(programPath) !== grant.kind) return null;
    return grant;
  }

  /** The grant for a program, or null. `input` true asks for a grant that allows input. */
  function check(programPath, { input = false } = {}) {
    const grant = granted(programPath);
    if (!grant) return null;
    return input && !allowsInput(grant.kind) ? null : grant;
  }

  function list() {
    return [...grants.values()].map(({ program, name, kind }) => ({ program, name, kind }));
  }

  function revoke(programPath) {
    const key = normalizeProgramPath(programPath);
    fileDialogs.delete(key);
    return grants.delete(key);
  }

  function clear() {
    grants.clear();
    fileDialogs.clear();
  }

  /** Whether a person already answered this program's first file dialog in this chat. */
  function fileDialogAnswered(programPath) {
    return fileDialogs.has(normalizeProgramPath(programPath));
  }

  async function ask(kind, { program, name, view_only: viewOnly }, { authorize, callId, toolInput, signal }) {
    if (!ASK_KINDS.includes(kind)) throw new TypeError(`unknown ask kind ${kind}`);
    if (typeof authorize !== 'function') return { allowed: false, unanswerable: true, waitedMs: 0 };
    const startedAt = now();
    let answer;
    try {
      answer = await authorize({
        tool_name: 'computer', tool_call_id: callId, tool_input: toolInput,
        // A grant lasts the chat at most, so the card never offers a saved rule.
        one_off_only: true,
        messageFields: { computer_approval: {
          schema_version: APPROVAL_SCHEMA_VERSION,
          kind, program_name: name, program_path: displayPath(program), view_only: viewOnly === true,
        } },
      }, signal);
    } catch (_error) {
      answer = null;
    }
    return { allowed: answer === true || answer?.approved === true, waitedMs: Math.max(0, now() - startedAt) };
  }

  /**
   * Bind the gate to one tool call. Every method resolves
   * `{ allowed, reason, waitedMs, grant? }`; `reason` is '' when allowed, else one of
   * `never`, `view_only`, `declined`, `unanswerable`, `too_many`.
   */
  function forCall({ authorize, callId, toolInput, signal } = {}) {
    const call = { authorize, callId, toolInput, signal };

    /** Make sure the program is granted (asking once per chat). `input` true needs a grant that allows input. */
    async function ensureGranted(programPath, { name, input = false } = {}) {
      const kind = judge(programPath);
      if (kind === 'never') return { allowed: false, reason: 'never', waitedMs: 0 };
      if (input && !allowsInput(kind)) return { allowed: false, reason: 'view_only', waitedMs: 0 };
      const existing = granted(programPath);
      if (existing) return { allowed: true, reason: '', waitedMs: 0, grant: existing };
      if (grants.size >= MAX_GRANTS) return { allowed: false, reason: 'too_many', waitedMs: 0 };
      const label = cleanName(name, 'this program');
      const answer = await ask('grant', { program: programPath, name: label, view_only: kind === 'view_only' }, call);
      if (!answer.allowed) {
        return { allowed: false, reason: answer.unanswerable ? 'unanswerable' : 'declined', waitedMs: answer.waitedMs };
      }
      // The answer came after a wait: judge again before recording, as the program list may have changed.
      if (judge(programPath) !== kind) return { allowed: false, reason: 'never', waitedMs: answer.waitedMs };
      const grant = { program: String(programPath), name: label, kind };
      grants.set(normalizeProgramPath(programPath), grant);
      return { allowed: true, reason: '', waitedMs: answer.waitedMs, grant };
    }

    /** `open`: a person answers every one, granted or not; a yes also grants the program. */
    async function allowOpen(programPath, { name } = {}) {
      const kind = judge(programPath);
      if (kind === 'never') return { allowed: false, reason: 'never', waitedMs: 0 };
      if (!granted(programPath) && grants.size >= MAX_GRANTS) return { allowed: false, reason: 'too_many', waitedMs: 0 };
      const label = cleanName(name, 'this program');
      const answer = await ask('open', { program: programPath, name: label, view_only: kind === 'view_only' }, call);
      if (!answer.allowed) {
        return { allowed: false, reason: answer.unanswerable ? 'unanswerable' : 'declined', waitedMs: answer.waitedMs };
      }
      if (judge(programPath) !== kind) return { allowed: false, reason: 'never', waitedMs: answer.waitedMs };
      const grant = granted(programPath) || { program: String(programPath), name: label, kind };
      grants.set(normalizeProgramPath(programPath), grant);
      return { allowed: true, reason: '', waitedMs: answer.waitedMs, grant };
    }

    /** The first standard Open or Save dialog of a granted program in this chat asks a person. */
    async function allowFileDialog(programPath) {
      const grant = check(programPath, { input: true });
      if (!grant) return { allowed: false, reason: 'never', waitedMs: 0 };
      const key = normalizeProgramPath(programPath);
      if (fileDialogs.has(key)) return { allowed: true, reason: '', waitedMs: 0, grant };
      const answer = await ask('file_dialog', { program: grant.program, name: grant.name, view_only: false }, call);
      if (!answer.allowed) {
        return { allowed: false, reason: answer.unanswerable ? 'unanswerable' : 'declined', waitedMs: answer.waitedMs };
      }
      fileDialogs.add(key);
      return { allowed: true, reason: '', waitedMs: answer.waitedMs, grant };
    }

    return { ensureGranted, allowOpen, allowFileDialog };
  }

  return { check, list, revoke, clear, fileDialogAnswered, forCall, judge };
}

module.exports = { APPROVAL_SCHEMA_VERSION, ASK_KINDS, MAX_GRANTS, createGrantGate };
