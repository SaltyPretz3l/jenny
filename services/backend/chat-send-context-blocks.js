/**
 * services/backend/chat-send-context-blocks.js
 *
 * Normalization and bounding for the TYPED trusted-context channel
 * (`chat.send params.context_blocks`).
 *
 * ── Why a separate channel exists ──
 * Electron assembles five per-turn context overlays (the open file / @-mentions,
 * git status, the personality workspace, codebase grounding and
 * linked-session recall). These used to be spliced into `params.messages` as
 * `{role:'system'}` rows. Request history is UNTRUSTED on the sidecar: the
 * semantic admission gate (sidecar/ai/context/messages.py) drops every system
 * row it carries except our own compaction summary — so all five overlays were
 * silently discarded before inference. Widening that gate is not an option; it
 * is a correct trust boundary that must keep rejecting forged system rows.
 *
 * So the overlays ride their own typed, bounded field instead, and the sidecar
 * folds them into the trusted system tier itself. This module is the Electron
 * half of that contract: a frozen `kind` allowlist, one block per kind
 * (first-wins), and per-block plus aggregate byte ceilings. The bounds mirror
 * `sidecar/runtime/chat_normalization.py::normalize_context_blocks` exactly —
 * change one and you must change the other, or blocks that pass here get
 * dropped there.
 *
 * NOTE: this is NOT the budget trimmer. `context-budget-trimmer.js` decides
 * which blocks fit the model's measured context window (priority ordering,
 * shrink/drop); this module is the wire-shape guard that runs after it.
 */

// Must stay identical to CONTEXT_BLOCK_KINDS in
// sidecar/runtime/chat_normalization.py.
const CONTEXT_BLOCK_KINDS = Object.freeze([
  'active_file',
  'git',
  'personality',
  'codebase',
  'linked_session',
]);
const CONTEXT_BLOCK_KIND_SET = new Set(CONTEXT_BLOCK_KINDS);
const MAX_CONTEXT_BLOCKS = 5;
// Generous by design: context-budget-trimmer.js already trims these blocks to
// the model's MEASURED effective window, so these ceilings are a
// transport-integrity backstop against a runaway block, not a context policy. A
// tight bound would silently clip legitimate overlays on wide-window models.
const MAX_CONTEXT_BLOCK_BYTES = 512 * 1024;
const MAX_CONTEXT_BLOCKS_TOTAL_BYTES = 2 * 1024 * 1024;

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Truncate to at most `maxBytes` UTF-8 bytes without emitting a replacement
 * character for a split multi-byte sequence (which could push the result back
 * OVER the limit and then be dropped by the sidecar's own bound).
 */
function truncateToBytes(text, maxBytes) {
  if (byteLength(text) <= maxBytes) {
    return text;
  }
  const buffer = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  let truncated = buffer.toString('utf8');
  while (truncated.length > 0 && byteLength(truncated) > maxBytes) {
    truncated = truncated.slice(0, -1);
  }
  return truncated;
}

/**
 * Validate + bound the ordered context blocks for `chat.send`.
 *
 * Fail-soft per entry: an unknown kind, a duplicate kind, an empty body or an
 * over-budget block is dropped (and reported through `onDrop` so the caller can
 * log it) rather than failing the turn. Returns a new array; the input is not
 * mutated.
 *
 * @param {Array<{kind: string, content: string}>} blocks
 * @param {{onDrop?: (info: {reason: string, kind: string, index: number}) => void}} [options]
 * @returns {Array<{kind: string, content: string}>}
 */
function normalizeContextBlocksForSend(blocks, options = {}) {
  const onDrop = typeof options.onDrop === 'function' ? options.onDrop : null;
  const report = (reason, kind, index) => {
    if (onDrop) {
      onDrop({ reason, kind, index });
    }
  };
  if (!Array.isArray(blocks)) {
    return [];
  }
  const normalized = [];
  const seenKinds = new Set();
  let totalBytes = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block || typeof block !== 'object') {
      report('not_an_object', '', index);
      continue;
    }
    const kind = String(block.kind || '').trim();
    if (!CONTEXT_BLOCK_KIND_SET.has(kind)) {
      report('unknown_kind', kind, index);
      continue;
    }
    if (seenKinds.has(kind)) {
      report('duplicate_kind', kind, index);
      continue;
    }
    const content = String(block.content == null ? '' : block.content).trim();
    if (!content) {
      report('empty_content', kind, index);
      continue;
    }
    if (normalized.length >= MAX_CONTEXT_BLOCKS) {
      report('max_blocks_exceeded', kind, index);
      continue;
    }
    const bounded = truncateToBytes(content, MAX_CONTEXT_BLOCK_BYTES);
    if (bounded !== content) {
      report('block_bytes_truncated', kind, index);
    }
    const blockBytes = byteLength(bounded);
    if (totalBytes + blockBytes > MAX_CONTEXT_BLOCKS_TOTAL_BYTES) {
      report('total_bytes_exceeded', kind, index);
      continue;
    }
    totalBytes += blockBytes;
    seenKinds.add(kind);
    normalized.push({ kind, content: bounded });
  }
  return normalized;
}

module.exports = {
  CONTEXT_BLOCK_KINDS,
  MAX_CONTEXT_BLOCKS,
  MAX_CONTEXT_BLOCK_BYTES,
  MAX_CONTEXT_BLOCKS_TOTAL_BYTES,
  truncateToBytes,
  normalizeContextBlocksForSend,
};
