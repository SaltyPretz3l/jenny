/**
 * Personality compile layer (schema v3).
 *
 * Single source of the on-the-wire personality block: body normalization,
 * per-section budgets and clipping, and the full `## Personality` message that
 * the Settings preview renders. The sidecar owns the same two literal strings
 * (`PERSONALITY_HEADING` / `PERSONALITY_PRECEDENCE_TEMPLATE` in
 * `sidecar/ai/personality/__init__.py`); `tests/personality-prompt-contract.test.js`
 * asserts they stay byte-identical across the JSON-RPC seam, and
 * `tests/personality-normalize-parity.test.js` asserts `normalizeBody` /
 * `clipToBudget` agree with the renderer twin in
 * `renderer/features/renderer-personality-counters.js`.
 *
 * Electron emits ONLY the `### …` sections on the wire
 * (`context_blocks[kind=personality].content`); the sidecar prepends the
 * heading + name line. `buildPersonalityMessage` exists so the Settings preview
 * and the sidebar token estimate can show the exact same full message the model
 * will receive without a round trip.
 *
 * @module personality-workspace-compile
 */

const PERSONALITY_HEADING = '## Personality';
const PERSONALITY_PRECEDENCE_TEMPLATE = 'Your name is {name}. Personality shapes tone, not facts; the current request and the runtime, workspace, and tool instructions take precedence over everything below.';
const DEFAULT_AGENT_NAME = 'Jenny';

const ADVANCED_CONTEXT_MAX_BYTES = 4 * 1024;
const CLIP_MARKER = ' […]';
const CLIP_MARKER_BYTES = Buffer.byteLength(CLIP_MARKER, 'utf8');
const SECTION_SEPARATOR = '\n\n';
const SECTION_SEPARATOR_BYTES = Buffer.byteLength(SECTION_SEPARATOR, 'utf8');

const SECTION_BUDGETS = Object.freeze({
  personality: 1500,
  user: 1000,
  memory: 1500,
});

const SECTION_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'personality', heading: '### Voice' }),
  Object.freeze({ id: 'user', heading: '### About the user' }),
  Object.freeze({ id: 'memory', heading: '### Notes' }),
]);

const FRONTMATTER_PATTERN = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const H1_PATTERN = /^#[ \t]+[^\r\n]*(?:\r?\n|$)/;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
// An unterminated `<!--` is a comment to end-of-text as far as every markdown
// renderer is concerned. Treating it as literal text would leak a half-written
// aside straight into the prompt.
const UNTERMINATED_COMMENT_PATTERN = /<!--[\s\S]*$/;

function stripLeadingMatch(text, pattern) {
  const match = text.match(pattern);
  return match ? text.slice(match[0].length) : text;
}

function stripBom(value) {
  const text = String(value ?? '');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Normalize a workspace file into the body the model actually receives:
 * drop a leading YAML frontmatter block (legacy USER.md), strip every HTML
 * comment (that is what makes a placeholder template compile to nothing, and
 * what hides the v3 merge comment), drop one leading H1, then trim.
 *
 * Historical note: legacy USER.md files carry the H1 *before* the frontmatter,
 * so both orders are tolerated.
 *
 * This is the COMPILED body only. What the editor shows is the raw file text
 * (see `PersonalityWorkspaceService._editorBody`) so that comments, headings
 * and thematic breaks survive a load/save round trip.
 *
 * @param {string} content raw file text
 * @returns {string} normalized body ('' when the file adds nothing)
 */
function normalizeBody(content) {
  let text = stripBom(content).replace(/\r\n/g, '\n').replace(/^\s+/, '');
  text = stripLeadingMatch(text, FRONTMATTER_PATTERN).replace(/^\s+/, '');
  text = text
    .replace(HTML_COMMENT_PATTERN, '')
    .replace(UNTERMINATED_COMMENT_PATTERN, '')
    .replace(/^\s+/, '');
  text = stripLeadingMatch(text, H1_PATTERN).replace(/^\s+/, '');
  text = stripLeadingMatch(text, FRONTMATTER_PATTERN);
  return text.trim();
}

/**
 * Return the leading YAML frontmatter block verbatim (including its trailing
 * newline) so a save can re-emit user-authored frontmatter byte-for-byte.
 * Returns '' when the file has none.
 *
 * @param {string} content raw file text
 * @returns {string}
 */
function extractFrontmatterBlock(content) {
  let rest = stripBom(content).replace(/^\s+/, '');
  const direct = rest.match(FRONTMATTER_PATTERN);
  if (direct) return direct[0];
  const heading = rest.match(H1_PATTERN);
  if (!heading) return '';
  rest = rest.slice(heading[0].length).replace(/^\s+/, '');
  const afterHeading = rest.match(FRONTMATTER_PATTERN);
  return afterHeading ? afterHeading[0] : '';
}

/**
 * Clip one section body to its char budget, never splitting a surrogate pair.
 *
 * @param {string} body normalized body
 * @param {number} budget max chars including the marker
 * @returns {{ text: string, clipped: boolean }}
 */
function clipToBudget(body, budget) {
  const text = String(body || '');
  const limit = Number.isSafeInteger(budget) && budget > 0 ? budget : 0;
  if (text.length <= limit) return { text, clipped: false };
  let kept = text.slice(0, Math.max(limit - CLIP_MARKER.length, 0));
  if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1);
  return { text: `${kept}${CLIP_MARKER}`, clipped: true };
}

function truncateUtf8(value, maxBytes, suffix = CLIP_MARKER) {
  const source = String(value || '');
  if (Buffer.byteLength(source, 'utf8') <= maxBytes) return source;
  const contentLimit = Math.max(maxBytes - Buffer.byteLength(suffix, 'utf8'), 0);
  let result = '';
  let used = 0;
  for (const character of source) {
    const size = Buffer.byteLength(character, 'utf8');
    if (used + size > contentLimit) break;
    result += character;
    used += size;
  }
  return `${result}${suffix}`;
}

/**
 * Compile the wire content from normalized bodies.
 *
 * Two limits apply, in this order:
 *
 * 1. Per-section CHAR budgets (what the UI counters show).
 * 2. A shared 4 KiB UTF-8 BYTE backstop on the joined block. The char budgets
 *    sum to 4,000 which is under 4 KiB for ASCII but ~12 KiB for CJK, so the
 *    backstop is reachable in practice. It is applied per section, not by
 *    truncating the join: every section's heading is reserved up front and a
 *    marker's worth of bytes is reserved for each later section, so a huge
 *    Voice can never make `### Notes` disappear from the wire while the
 *    counters read green. Any section the backstop touches reports
 *    `clipped: true` and the result reports `backstopClipped: true`.
 *
 * @param {{personality?: string, user?: string, memory?: string}} bodies
 * @param {Record<string, number>} [budgets]
 * @param {number} [maxBytes]
 * @returns {{ content: string, sections: Array<{id: string, chars: number, budget: number, clipped: boolean}>, backstopClipped: boolean }}
 */
function compilePersonalitySections(bodies, budgets = SECTION_BUDGETS, maxBytes = ADVANCED_CONTEXT_MAX_BYTES) {
  const participating = [];
  for (const definition of SECTION_DEFINITIONS) {
    const body = String(bodies?.[definition.id] || '');
    if (!body) continue;
    const budget = Number.isSafeInteger(budgets?.[definition.id])
      ? budgets[definition.id]
      : SECTION_BUDGETS[definition.id];
    const { text, clipped } = clipToBudget(body, budget);
    participating.push({ definition, body, budget, text, clipped });
  }
  if (!participating.length) return { content: '', sections: [], backstopClipped: false };

  // Reserve every heading (and the joins between them) before distributing the
  // remaining bytes, so no section is ever dropped outright.
  const overheadBytes = participating.reduce(
    (total, entry) => total + Buffer.byteLength(`${entry.definition.heading}${SECTION_SEPARATOR}`, 'utf8'),
    0
  ) + SECTION_SEPARATOR_BYTES * (participating.length - 1);
  const bodyBudgetBytes = Math.max(maxBytes - overheadBytes, 0);

  const sections = [];
  const rendered = [];
  let usedBytes = 0;
  let backstopClipped = false;
  participating.forEach((entry, index) => {
    // Keep a marker's worth of room for each section still to come.
    const reservedForLater = CLIP_MARKER_BYTES * (participating.length - index - 1);
    const allowedBytes = Math.max(bodyBudgetBytes - usedBytes - reservedForLater, 0);
    let { text, clipped } = entry;
    if (Buffer.byteLength(text, 'utf8') > allowedBytes) {
      text = truncateUtf8(text, allowedBytes, CLIP_MARKER);
      clipped = true;
      backstopClipped = true;
    }
    usedBytes += Buffer.byteLength(text, 'utf8');
    sections.push({
      id: entry.definition.id,
      chars: entry.body.length,
      budget: entry.budget,
      clipped,
    });
    rendered.push(`${entry.definition.heading}${SECTION_SEPARATOR}${text}`);
  });

  const joined = rendered.join(SECTION_SEPARATOR);
  // Belt-and-braces: the reservation math above already keeps the join inside
  // the cap, so this only fires if a heading itself could not fit.
  const content = truncateUtf8(joined, maxBytes, CLIP_MARKER);
  return { content, sections, backstopClipped: backstopClipped || content !== joined };
}

function normalizeAgentName(value) {
  return String(value ?? '').trim() || DEFAULT_AGENT_NAME;
}

/**
 * Build the full `## Personality` system message (heading + name line +
 * sections). Mirrors `build_personality_system_message` in the sidecar.
 *
 * @param {string} agentName
 * @param {string} content compiled section text (may be empty)
 * @returns {string}
 */
function buildPersonalityMessage(agentName, content) {
  const header = `${PERSONALITY_HEADING}\n${
    PERSONALITY_PRECEDENCE_TEMPLATE.replace('{name}', normalizeAgentName(agentName))
  }`;
  const body = String(content || '').trim();
  return body ? `${header}\n\n${body}` : header;
}

/** Token estimate shared by the Settings preview, the sidebar, and the sidecar. */
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

module.exports = {
  ADVANCED_CONTEXT_MAX_BYTES,
  CLIP_MARKER,
  CLIP_MARKER_BYTES,
  DEFAULT_AGENT_NAME,
  PERSONALITY_HEADING,
  PERSONALITY_PRECEDENCE_TEMPLATE,
  SECTION_BUDGETS,
  buildPersonalityMessage,
  clipToBudget,
  compilePersonalitySections,
  estimateTokens,
  extractFrontmatterBlock,
  normalizeAgentName,
  normalizeBody,
  truncateUtf8,
};
