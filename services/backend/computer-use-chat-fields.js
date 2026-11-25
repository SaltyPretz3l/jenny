'use strict';

/* Row 196: what the chat stream keeps of a `computer` call.
 *
 * computerApprovalFields validates the ask the grant gate (services/computer-use/grant-gate.js) sends
 * before it reaches a card; `{}` for any other tool or a malformed ask, which the approval path then
 * refuses. savedComputerOutput is what history keeps of a finished step: the one-line step summary,
 * never the picture, typed text or a window title. */

const COMPUTER_TOOL = 'computer';
const COMPUTER_APPROVAL_KINDS = new Set(['grant', 'open', 'file_dialog']);
const COMPUTER_APPROVAL_NAME_CHARS = 120;
const COMPUTER_APPROVAL_PATH_CHARS = 512;
const COMPUTER_STEP_FALLBACK = 'Computer step finished.';
const COMPUTER_STEP_FAILED = 'Computer step failed.';

function hasControls(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function boundedText(text, max, { allowEmpty = false } = {}) {
  return typeof text === 'string' && text.length <= max && (allowEmpty || text.trim().length > 0) && !hasControls(text);
}

function computerApprovalFields(params) {
  if (params?.tool_name !== COMPUTER_TOOL) return {};
  const value = params.messageFields?.computer_approval;
  if (value?.schema_version !== 1 || !COMPUTER_APPROVAL_KINDS.has(value.kind)
    || !boundedText(value.program_name, COMPUTER_APPROVAL_NAME_CHARS)
    || !boundedText(value.program_path, COMPUTER_APPROVAL_PATH_CHARS)
    || typeof value.view_only !== 'boolean'
    // A file dialog is only ever asked for a program that takes input.
    || (value.kind === 'file_dialog' && value.view_only)) return {};
  return { computer_approval: {
    schema_version: 1, kind: value.kind, program_name: value.program_name, program_path: value.program_path,
    view_only: value.view_only,
  } };
}

function savedComputerOutput(metadata) {
  const record = metadata && typeof metadata === 'object' ? metadata : {};
  const summary = typeof record.step_summary === 'string' ? record.step_summary.trim() : '';
  if (summary) return summary.slice(0, 200);
  return record.failure_class ? COMPUTER_STEP_FAILED : COMPUTER_STEP_FALLBACK;
}

module.exports = { COMPUTER_TOOL, COMPUTER_APPROVAL_KINDS, computerApprovalFields, savedComputerOutput };
