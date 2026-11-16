'use strict';

// The exact-argument presentation of an approval card and the command card's "Always allow" scope, moved out of
// chat-stream-tool-approval.js unchanged (slice 3-12 kept that file under its line budget).
const crypto = require('node:crypto');
const { deriveCommandScope } = require('../tools/command-prefix');

// The arguments that decide what a command runs or a write writes, in display order. The
// persisted snapshot redacts secret-shaped text and clips every string at 512 chars, so the
// approval card would ask over text that is not what runs. The live request instead carries
// these fields exactly (plus any other argument but `purpose`, after them), and Electron keeps
// the hash of that presentation: an approval whose signed arguments no longer hash the same, or
// whose presentation was too large to show, is denied. Transcripts and logs keep the snapshot.
const EXACT_APPROVAL_FIELDS = Object.freeze({
  run_command: ['command', 'cwd', 'run_in_background'],
  run_temp_script: ['script', 'language', 'cwd'],
  python_execute: ['code'],
  monitor: ['command', 'cwd'],
  write_file: ['path', 'file_path', 'content', 'file_content'],
  edit_file: ['file_path', 'old_string', 'new_string', 'replace_all', 'edits'],
  // Row 94 P2: the folder a new project binds; the placement port proved it is the folder bound.
  project_create: ['folder', 'name'],
  // Row 94 P4: the chat a copy is made of (its title, which the export port proved is that chat's), and the exact
  // command line typed into the user's terminal.
  session_export: ['chat_title', 'session_id'],
  terminal_run: ['command'],
});
const EXACT_APPROVAL_MAX_BYTES = 32 * 1024;

function exactFieldText(value) {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? String(value) : json;
  } catch (_error) {
    return String(value);
  }
}

function buildExactApprovalPresentation(toolName, args) {
  const decisive = Object.hasOwn(EXACT_APPROVAL_FIELDS, toolName) ? EXACT_APPROVAL_FIELDS[toolName] : null;
  if (!decisive) return null;
  const source = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const names = [
    ...decisive.filter((name) => Object.hasOwn(source, name)),
    ...Object.keys(source).filter((name) => name !== 'purpose' && !decisive.includes(name)).sort(),
  ];
  const fields = names.filter((name) => source[name] !== undefined)
    .map((name) => ({ name, text: exactFieldText(source[name]) }));
  const bytes = fields.reduce((total, field) => total
    + Buffer.byteLength(field.name, 'utf8') + Buffer.byteLength(field.text, 'utf8'), 0);
  if (bytes > EXACT_APPROVAL_MAX_BYTES) {
    return { schema_version: 1, too_large: true, bytes, limit_bytes: EXACT_APPROVAL_MAX_BYTES };
  }
  const sha256 = crypto.createHash('sha256')
    .update(JSON.stringify(fields.map((field) => [field.name, field.text])), 'utf8').digest('hex');
  return { schema_version: 1, fields, bytes, sha256 };
}

// Row 103: what "Always allow" on a command card covers, derived exactly as the permission store
// will derive the grant: `{kind:'prefix', prefix}`, `{kind:'exact'}`, or `{kind:'none'}` (chained:
// allowed once only). Null for every other tool.
function commandAlwaysAllowScope(toolName, input) {
  if (toolName !== 'run_command') return null;
  const derived = deriveCommandScope(input.command);
  return derived.scope === 'prefix' ? { kind: 'prefix', prefix: derived.prefix } : { kind: derived.scope };
}

// The arguments Electron signs (the bridge's noteApproved input) must still hash to what was shown.
function exactInputStillShown(toolName, params, displayedSha256) {
  try {
    return Boolean(displayedSha256) && buildExactApprovalPresentation(
      toolName, params.tool_input || params.arguments || {}
    )?.sha256 === displayedSha256;
  } catch (_error) {
    return false;
  }
}

module.exports = { EXACT_APPROVAL_FIELDS, buildExactApprovalPresentation, commandAlwaysAllowScope, exactInputStillShown };
