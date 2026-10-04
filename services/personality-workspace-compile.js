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
const PERSONALITY_PRECEDENCE_TEMPLATE = 'Your name is {name}. You are software, not a living being: you have no body, feelings, or consciousness, and you never claim otherwise. Personality shapes tone, not facts; the current request and the runtime, workspace, and tool instructions take precedence over everything below.';
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

// Keep the preview pipeline in lockstep with sidecar personality.sanitization.
const PYTHON_WHITESPACE = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u; // eslint-disable-line no-control-regex -- Python str.split whitespace.
const PYTHON_WORD_BOUNDARY = '(?:(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_])|(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_]))';

function previewPattern(pattern) {
  let source = pattern.source.replace(/\[\\s\\S\]|\[\^\\s[^\]]*\]|\\s/g,
    token => token.startsWith('[') ? token.replace('\\s', '\\s\\u0085') : '[\\s\\u0085]');
  if (pattern.ignoreCase) source = source.replace(/[iI]/g, '[iI\\u0130\\u0131]')
    .replace(/\[A-Za-z/g, '[A-Za-z\\u0130\\u0131');
  return new RegExp(source.replace(/\\b/g, PYTHON_WORD_BOUNDARY), `${pattern.flags}u`);
}

const INJECTION_PATTERNS = [
  /<!--(?=[\s\S]{0,1000}?(?:ignore|disregard|reveal|system\s+prompt|developer\s+prompt|instructions?|exfiltrat|upload|send|post))[\s\S]*?-->/gi,
  /\b(?:base64|encode|zip|tar|cat|read|copy|extract)[\s\S]{0,120}\b(?:secret|token|password|api[_-]?key|credential|\.env|id_rsa|ssh|private\s+key)[\s\S]{0,160}\b(?:https?:\/\/|post|send|upload|exfiltrat|curl|wget)/gi,
  /ignore\s+all\s+previous\s+instructions/gi,
  /(?:ignore|disregard)\s+(?:all\s+)?(?:prior|previous|above)\s+(?:instructions|directives|rules)/gi,
  /ignore\s+the\s+system\s+prompt/gi,
  /reveal\s+(?:the\s+)?(?:system|developer)\s+prompt/gi,
  /act\s+as\s+system/gi,
  /pretend\s+to\s+be\s+(?:the\s+)?(?:system|developer)/gi,
  /\bdo\s+not\s+follow\s+the\s+rules\b/gi,
  /\byou\s+are\s+now\b/gi,
  /(?:new|updated|override)\s+instructions/gi,
  /(?:begin|start)\s+(?:a\s+)?new\s+(?:conversation|session)/gi,
  /(?:output|repeat|print)\s+(?:the\s+)?(?:above|previous|system)/gi,
  /\[(?:SYSTEM|USER|ASSISTANT)\]/g,
].map(previewPattern);
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9]{8,}\b/g,
  /\b(?:ghp|gho|ghs|ghr|ghu)_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(api[_-]?key|api-key|authorization|token|secret|password|dsn)\s*[:=]\s*(?:Bearer\s+)?([^\s,;'"{}]+)/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(?:X-Amz-(?:Signature|Credential|Security-Token)|signature|sig)\s*[:=]\s*([^\s,;'"{}&]+)/gi,
  /\beyJ[A-Za-z0-9_=-]+\.eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_.+/=-]{8,}\b/g,
].map(previewPattern);
const LANGUAGE_NAMES = {
  es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', 'pt-br': 'Brazilian Portuguese',
  nl: 'Dutch', pl: 'Polish', ru: 'Russian', uk: 'Ukrainian', tr: 'Turkish', ar: 'Arabic',
  hi: 'Hindi', id: 'Indonesian', vi: 'Vietnamese', ja: 'Japanese', ko: 'Korean',
  'zh-cn': 'Simplified Chinese', 'zh-tw': 'Traditional Chinese',
};

function sanitizePersonalityPreview(value) {
  let text = Array.from(String(value || ''), char => /^[\uD800-\uDFFF]$/.test(char) ? '\ufffd' : char).join('')
    // eslint-disable-next-line no-control-regex -- Mirrors Python's bootstrap control-character removal.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\r\n?/g, '\n').normalize('NFKC')
    .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(previewPattern(/<\|(?:im_start|im_end|endoftext|system|user|assistant|tool_response|tool_call|eot_id|start_header_id|end_header_id|end|pad)\|>|<\|(?:tool_response|tool_call)>|\[\/?INST\]|<\/?s>|<(?:eos|bos|pad|end_of_turn|start_of_turn)>|<channel\|>|<\|channel\|>/gi), '[TOKEN_REDACTED]');
  for (const pattern of INJECTION_PATTERNS) text = text.replace(pattern, '[FILTERED_INSTRUCTION]');
  text = text.replace(previewPattern(/<!--\s*CACHE_BOUNDARY\s*-->/gi), '<!-- CACHE_BOUNDARY (escaped) -->')
    .replace(previewPattern(/<<\s*\/\s*SYS\s*>>/gi), '[SYS_CLOSE_ESCAPED]')
    .replace(previewPattern(/<<\s*SYS\s*>>/gi), '[SYS_OPEN_ESCAPED]');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[REDACTED]');
  return text.replace(/^[\s\u0085]+|[\s\u0085]+$/g, '');
}

function promptAgentName(value) {
  if (typeof value !== 'string') return DEFAULT_AGENT_NAME;
  const normalized = value.split(PYTHON_WHITESPACE).filter(Boolean).join(' ');
  if (!normalized || sanitizePersonalityPreview(normalized) !== normalized) return DEFAULT_AGENT_NAME;
  const name = normalized.replace(/[^\p{L}\p{N} ._'-]/gu, ' ').trim().split(/\s+/u).join(' ');
  return Array.from(name).slice(0, 80).join('') || DEFAULT_AGENT_NAME;
}

/**
 * Build the full `## Personality` system message (heading + name line +
 * sections). Mirrors `build_personality_system_message` in the sidecar.
 *
 * @param {string} agentName
 * @param {string} content compiled section text (may be empty)
 * @returns {string}
 */
function buildPersonalityMessage(agentName, content, { uiLanguage = 'en' } = {}) {
  let header = `${PERSONALITY_HEADING}\n${
    PERSONALITY_PRECEDENCE_TEMPLATE.replace('{name}', promptAgentName(agentName))
  }`;
  const languageToken = typeof uiLanguage === 'string'
    ? uiLanguage.split(PYTHON_WHITESPACE).filter(Boolean).join(' ').toLowerCase().replace(/\u017f/g, 's') : '';
  const language = Object.prototype.hasOwnProperty.call(LANGUAGE_NAMES, languageToken) ? LANGUAGE_NAMES[languageToken] : '';
  if (language) header += `\nReply in ${language} unless the user writes in another language; then match the user's language.`;
  const body = sanitizePersonalityPreview(content);
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
