// Per-turn compaction record for the stream diagnostics file (FG-008). Metadata
// is always kept; the summary text is a developer-only copy of conversation-
// derived content, so it is kept only when includeText (agent_test_hooks).
const crypto = require('crypto');

const MAX_COMPACTION_ENTRIES = 8;
const MAX_SUMMARY_TEXT_CHARS = 16384;
const MAX_WINDOW_ROWS = 128;

function nonNegativeInt(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

// Strings only: the params cross a process boundary, and coercing an arbitrary
// object could throw inside the notification handler.
function text(value, maxChars, fallback = '') {
  return typeof value === 'string' && value ? value.slice(0, maxChars) : fallback;
}

function normalizeWindowRow(row) {
  const out = {
    role: text(row?.role, 32),
    kind: text(row?.kind, 32),
    chars: nonNegativeInt(row?.chars),
  };
  const toolName = text(row?.tool_name, 128);
  if (toolName) out.tool_name = toolName;
  return out;
}

function buildEntry(params, { summaryPersisted, includeText }) {
  const summaryText = text(params?.summary_message?.content, Number.MAX_SAFE_INTEGER);
  const entry = {
    phase: text(params?.phase, 32, 'preflight'),
    strategy: text(params?.strategy, 32, 'micro'),
    summary_status: text(params?.summary_status, 32, 'not_created'),
    reason_code: text(params?.reason_code, 80),
    tokens_before: nonNegativeInt(params?.tokens_before),
    tokens_after: nonNegativeInt(params?.tokens_after),
    dropped_messages: nonNegativeInt(params?.dropped_messages),
    dropped_bytes: nonNegativeInt(params?.dropped_bytes),
    summary_source_dropped_messages: nonNegativeInt(params?.summary_source_dropped_messages),
    input_complete: params?.input_complete !== false,
    covered_through_tool_call_id: text(params?.covered_through_tool_call_id, 128),
    summary_persisted: summaryPersisted === true,
    at: new Date().toISOString(),
    summary_chars: summaryText.length,
    summary_sha256_16: crypto.createHash('sha256').update(summaryText, 'utf8').digest('hex').slice(0, 16),
  };
  if (includeText) entry.summary_text = summaryText.slice(0, MAX_SUMMARY_TEXT_CHARS);
  if (Array.isArray(params?.window_shape)) {
    entry.window = params.window_shape.slice(0, MAX_WINDOW_ROWS).map(normalizeWindowRow);
    if (params.window_shape.length > MAX_WINDOW_ROWS) {
      entry.window_rows_omitted = params.window_shape.length - MAX_WINDOW_ROWS;
    }
  }
  return entry;
}

function createCompactionDiagnostics({ includeText = false } = {}) {
  const entries = [];
  let omitted = 0;
  const snapshot = () => (entries.length > 0 ? entries.map((entry) => ({ ...entry })) : null);
  return {
    record(params, { summaryPersisted = false } = {}) {
      if (entries.length >= MAX_COMPACTION_ENTRIES) {
        omitted += 1;
        return;
      }
      entries.push(buildEntry(params, { summaryPersisted, includeText: includeText === true }));
    },
    snapshot,
    // dumpTurnDiagnostic's `compactions` input: the kept entries plus how many
    // later compactions the 8-entry cap dropped.
    forDump: () => ({ entries: snapshot(), omitted }),
  };
}

module.exports = {
  createCompactionDiagnostics,
  MAX_COMPACTION_ENTRIES,
  MAX_SUMMARY_TEXT_CHARS,
  MAX_WINDOW_ROWS,
};
