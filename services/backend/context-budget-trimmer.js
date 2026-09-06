/**
 * services/backend/context-budget-trimmer.js
 *
 * Deterministic, priority-ordered trim of the optional context blocks so the
 * per-turn request fits the model's *measured effective budget* on small local
 * context windows — with graceful degradation (drop/shrink the lowest-priority
 * block; never hard-error). Zero model calls; pure function of its inputs.
 *
 * ── Why this seam (the JS context-assembly layer) and not the sidecar ──
 * The token-budget layer in the sidecar (sidecar/ai/context/token_budget.py)
 * has the most accurate token accounting (the real per-family tokenizer) and
 * the authoritative per-request budget (TokenBudget.effective_context()), but
 * by the time it runs the context blocks have been flattened into opaque
 * {role:'system', content} message dicts with NO block identity or priority —
 * it can only pass / auto-compact / hard-error, never drop ONE block. Giving it
 * per-block priority would require tagging every block in JS and threading the
 * tags across the RPC boundary intact (plus stripping them before the provider
 * call) — real cross-process plumbing and serialization risk for a default-OFF
 * feature whose blocks are already bounded.
 *
 * The blocks are *born here* (chat-stream-context-assembly.js), where their
 * identity and priority are unambiguous and free. Trimming at birth is
 * self-contained (no IPC, no tag-survival risk), fully deterministic, trivially
 * unit-testable, and parallel-safe (services/backend only). The one cost is
 * token-count accuracy: we estimate with the same ~4-chars/token heuristic the
 * sidecar's DEFAULT CharEstimationBackend uses, so the two layers agree on the
 * common path; for family-specific tokenizers the estimate is approximate, so
 * the trim is intentionally *conservative* (reserves headroom and only engages
 * when the estimate already exceeds budget). On large windows it is inert.
 *
 * computeEffectiveContextBudget mirrors token_budget.py
 * TokenBudget.effective_context so the JS budget tracks the sidecar per-request
 * ceiling without crossing the process boundary.
 */

'use strict';

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_TOKENS = 4; // mirrors token_budget.py _MESSAGE_OVERHEAD_TOKENS

// Mirrors token_budget.py constants.
const MIN_OUTPUT_RESERVATION = 1024;
const DEFAULT_RESERVED_FOR_SUMMARY = 8192;

// Headroom withheld from the blocks for context the JS layer cannot measure:
// the sidecar's own base system prompt + tool schemas. Conservative on purpose
// — better to trim a little early than to overflow the window.
const DEFAULT_SYSTEM_RESERVE_TOKENS = 1500;

// A block shrunk below this is not worth keeping (header + a useless sliver):
// drop it instead so the budget goes to the next-priority block.
const DEFAULT_MIN_BLOCK_TOKENS = 64;

function estimateTokensFromChars(text) {
  const length = String(text == null ? '' : text).length;
  if (length <= 0) {
    return 0;
  }
  return Math.ceil(length / CHARS_PER_TOKEN);
}

// Estimated tokens of an existing message list (history + any pre-staged system
// messages), mirroring sidecar estimate_messages_tokens(): content chars/4 plus
// a fixed per-message framing overhead.
function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) {
    return 0;
  }
  let total = 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      continue;
    }
    if (typeof message.content === 'string' && message.content) {
      total += estimateTokensFromChars(message.content);
    }
    total += MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}

/**
 * Mirror of token_budget.py TokenBudget.effective_context() for a chat turn
 * with no tools counted. We don't know max_output_tokens in JS, so we make the
 * same conservative assumption the sidecar makes for typical small local models
 * (where max_output defaults to min(window, 16384) ≥ window/4): the output
 * reservation binds at the quarter cap. This matches the sidecar's post-16e7863
 * number on the common path (e.g. 32768 → 16384, 16384 → 8192, 8192 → 4096).
 *
 * @param {number} contextWindow effective context length (status field)
 * @returns {number|null} usable input budget in tokens, or null when unknown
 *   (caller treats null as "inert — keep every block unchanged").
 */
function computeEffectiveContextBudget(contextWindow) {
  const window = Math.floor(Number(contextWindow) || 0);
  if (window <= 0) {
    return null;
  }
  const quarter = Math.floor(window / 4);
  const outputReservation = Math.max(quarter, MIN_OUTPUT_RESERVATION);
  const summaryReservation = Math.min(DEFAULT_RESERVED_FOR_SUMMARY, quarter);
  return Math.max(0, window - outputReservation - summaryReservation);
}

// Close an unterminated CommonMark code fence so a truncated block never spills
// past its marker — the active-file / git / codebase blocks are fenced, and a
// mid-fence cut would otherwise swallow the marker (and confuse a renderer)
// inside an open code block. Tracks the open delimiter length; a closing line
// needs at least as many backticks.
function closingFenceDelimiter(text) {
  const lines = String(text).split('\n');
  let openLen = 0;
  for (const line of lines) {
    const match = /^(`{3,})/.exec(line);
    if (!match) {
      continue;
    }
    if (openLen === 0) {
      openLen = match[1].length;
    } else if (match[1].length >= openLen) {
      openLen = 0;
    }
  }
  return openLen > 0 ? `\n${'`'.repeat(openLen)}` : '';
}

function closeDanglingFence(text) {
  return `${text}${closingFenceDelimiter(text)}`;
}

// Shrink a block's content to ~maxTokens, preserving its first line (the
// human-readable label, e.g. "[Active editor context …]") so the model still
// knows what the block is, closing any code fence the cut opened, and appending
// an explicit truncation marker.
function shrinkBlockContent(content, maxTokens) {
  const text = String(content == null ? '' : content);
  const maxChars = Math.max(0, maxTokens * CHARS_PER_TOKEN);
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }
  const marker = '\n… (trimmed to fit the model context budget)';
  const newlineIndex = text.indexOf('\n');
  const header = newlineIndex > 0 ? text.slice(0, newlineIndex) : '';
  // The body is the content AFTER the header line — slicing from index 0 would
  // duplicate the header into the kept text.
  const rest = newlineIndex > 0 ? text.slice(newlineIndex + 1) : text;
  // Reserve the fixed framing first, then fit the body around the actual
  // closing delimiter required by the retained fence.
  const reserved = (header ? header.length + 1 : 0) + marker.length;
  if (reserved >= maxChars) {
    // Budget too small for a useful body — hard-cap and bail.
    return text.slice(0, maxChars);
  }
  const bodyLimit = maxChars - reserved;
  let body = rest.slice(0, bodyLimit);
  let kept = header ? `${header}\n${body}` : body;
  let closingDelimiter = closingFenceDelimiter(kept);
  while (body.length + closingDelimiter.length > bodyLimit) {
    const nextBodyLength = Math.max(0, bodyLimit - closingDelimiter.length);
    if (nextBodyLength >= body.length) {
      return text.slice(0, maxChars);
    }
    body = rest.slice(0, nextBodyLength);
    kept = header ? `${header}\n${body}` : body;
    closingDelimiter = closingFenceDelimiter(kept);
  }
  return `${kept}${closingDelimiter}${marker}`;
}

/**
 * Deterministically select which context blocks survive within availableTokens,
 * shrinking the highest-priority shrinkable block(s) before dropping, and
 * dropping lowest-priority blocks first.
 *
 * @param {Array<{kind:string, content:string, priority:number, shrinkable?:boolean}>} blocks
 * @param {number|null} availableTokens budget for the blocks; null/Infinity ⇒ keep all
 * @param {object} [options]
 * @param {number} [options.minBlockTokens] smallest worthwhile shrunk block
 * @returns {{kept: Map<string,{content:string, tokens:number, shrunk:boolean}>, decisions: Array}}
 */
function trimContextBlocks(blocks, availableTokens, options) {
  const opts = options || {};
  const minBlockTokens = Number.isFinite(opts.minBlockTokens)
    ? opts.minBlockTokens
    : DEFAULT_MIN_BLOCK_TOKENS;
  const kept = new Map();
  const decisions = [];
  const candidates = (Array.isArray(blocks) ? blocks : []).filter(
    (block) => block && typeof block.content === 'string' && block.content.length > 0
  );

  // Unknown / unbounded budget ⇒ inert: every block kept unchanged.
  if (availableTokens == null || !Number.isFinite(availableTokens)) {
    for (const block of candidates) {
      kept.set(block.kind, {
        content: block.content,
        tokens: estimateTokensFromChars(block.content),
        shrunk: false,
      });
      decisions.push({ kind: block.kind, action: 'keep', reason: 'inert' });
    }
    return { kept, decisions };
  }

  // Highest priority first; ties broken by input order for determinism.
  const ordered = candidates
    .map((block, index) => ({ block, index }))
    .sort((a, b) => (b.block.priority - a.block.priority) || (a.index - b.index));

  let remaining = Math.max(0, Math.floor(availableTokens));
  for (const { block } of ordered) {
    const tokens = estimateTokensFromChars(block.content);
    if (tokens <= remaining) {
      kept.set(block.kind, { content: block.content, tokens, shrunk: false });
      remaining -= tokens;
      decisions.push({ kind: block.kind, action: 'keep', tokens });
      continue;
    }
    const shrinkable = block.shrinkable !== false;
    if (shrinkable && remaining >= minBlockTokens) {
      const shrunkContent = shrinkBlockContent(block.content, remaining);
      const shrunkTokens = estimateTokensFromChars(shrunkContent);
      kept.set(block.kind, { content: shrunkContent, tokens: shrunkTokens, shrunk: true });
      decisions.push({ kind: block.kind, action: 'shrink', tokens: shrunkTokens, from: tokens });
      remaining = Math.max(0, remaining - shrunkTokens);
      continue;
    }
    // Dropped: leave `remaining` untouched so a smaller lower-priority block can
    // still slip into the leftover space.
    decisions.push({ kind: block.kind, action: 'drop', tokens });
  }
  return { kept, decisions };
}

module.exports = {
  CHARS_PER_TOKEN,
  estimateTokensFromChars,
  estimateMessagesTokens,
  computeEffectiveContextBudget,
  closeDanglingFence,
  shrinkBlockContent,
  trimContextBlocks,
  DEFAULT_SYSTEM_RESERVE_TOKENS,
  DEFAULT_MIN_BLOCK_TOKENS,
};
