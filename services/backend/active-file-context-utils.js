/**
 * Active-file + @-mention context utilities for chat context injection
 * (Tier-3 "implicit active-file context + @-mentions").
 *
 * Unlike ./codebase-context-utils.js (which self-fetches by scanning the
 * workspace root), this builder is PURE: the renderer already captured the
 * active editor file's cursor-region slice and resolved every @-mentioned
 * file's content at send time, so the backend only formats the supplied data
 * into a single system-message block. The renderer owns the cross-source dedupe
 * (the active file is omitted when it is also @-mentioned or already attached);
 * this builder trusts that, and only adds defensive per-list caps (max mentions,
 * max chars) and drops duplicate mention paths at the IPC boundary.
 *
 * Mirrors the shape/return contract of ./codebase-context-utils.js: returns a
 * string suitable for splicing in as a system message, or null when there is
 * nothing useful to contribute (no slice and no mentions).
 */

// --- Bounds (keep the injected block predictable on small local context windows) ---
const ACTIVE_SLICE_MAX_CHARS = 6000; // the cursor-region slice (already line-bounded by the renderer)
const MENTION_MAX_CHARS = 6000; // per @-mentioned file
const MAX_MENTIONS = 8; // cap count (the renderer caps too; defense in depth)
const MAX_BLOCK_CHARS = 20000; // overall ceiling for the whole block
const BLOCK_TRUNCATION_NOTE = `… (active-file context truncated at ${MAX_BLOCK_CHARS} chars)`;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function truncateText(text, maxChars, label) {
  const value = String(text == null ? '' : text);
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n… (${label} truncated at ${maxChars} chars)`;
}

// A code-fence delimiter at least one backtick longer than the longest backtick
// run in the content, so a file that itself contains ``` cannot break out of the
// fence (CommonMark fenced-code rule). Own-files only, but keeps the injected
// block well-formed for the model's parser.
function fenceDelimiterFor(text) {
  const str = String(text == null ? '' : text);
  let longest = 0;
  let run = 0;
  for (let i = 0; i < str.length; i += 1) {
    if (str.charCodeAt(i) === 96) { // backtick
      run += 1;
      if (run > longest) {
        longest = run;
      }
    } else {
      run = 0;
    }
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

// A short code-fence language tag derived from the file extension (best-effort;
// the model reads the text regardless, this only steers markdown rendering).
function fenceLanguageForPath(relPath, fallback) {
  const name = String(relPath || '').split('/').pop() || '';
  const dotIndex = name.lastIndexOf('.');
  const ext = dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : '';
  if (ext && /^[a-z0-9]+$/.test(ext)) {
    return ext;
  }
  return isNonEmptyString(fallback) && /^[a-z0-9+#-]+$/i.test(fallback) ? fallback : '';
}

function clampLineNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

function buildActiveSliceSection(activeFileContext) {
  const ctx = activeFileContext && typeof activeFileContext === 'object' ? activeFileContext : null;
  const path = ctx ? String(ctx.path || '').trim() : '';
  const slice = ctx ? String(ctx.slice || '') : '';
  if (!path || !slice.trim()) {
    return null;
  }
  const startLine = clampLineNumber(ctx.startLine) || 1;
  const endLine = clampLineNumber(ctx.endLine) || startLine;
  const totalLines = clampLineNumber(ctx.totalLines);
  const cursorLine = clampLineNumber(ctx.cursor && ctx.cursor.lineNumber);
  const fence = fenceLanguageForPath(path, ctx.languageId);
  const rangeDetail = totalLines
    ? `lines ${startLine}-${endLine} of ${totalLines}`
    : `lines ${startLine}-${endLine}`;
  const cursorDetail = cursorLine ? `, cursor on line ${cursorLine}` : '';
  const languageDetail = isNonEmptyString(ctx.languageId) ? `, ${ctx.languageId}` : '';
  const sliceText = truncateText(slice, ACTIVE_SLICE_MAX_CHARS, 'active file');
  const delim = fenceDelimiterFor(sliceText);
  return [
    '[Active editor context — what the user is currently looking at in their editor]',
    `File: ${path} (${rangeDetail}${cursorDetail}${languageDetail})`,
    'This is the region around the user\'s cursor, attached automatically so you can ground your '
      + 'answer in the code they are viewing. Cite it as a `path:line` reference when you point at it.',
    delim + fence,
    sliceText,
    delim,
  ].join('\n');
}

function buildMentionSections(mentionContents) {
  const list = Array.isArray(mentionContents) ? mentionContents : [];
  const sections = [];
  const seen = new Set();
  for (const entry of list) {
    if (sections.length >= MAX_MENTIONS) {
      break;
    }
    const path = entry && typeof entry === 'object' ? String(entry.path || '').trim() : '';
    const content = entry && typeof entry === 'object' ? String(entry.content == null ? '' : entry.content) : '';
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    const fence = fenceLanguageForPath(path);
    const body = truncateText(content, MENTION_MAX_CHARS, 'mentioned file');
    const delim = fenceDelimiterFor(body);
    sections.push([
      `=== ${path} ===`,
      delim + fence,
      body,
      delim,
    ].join('\n'));
  }
  if (!sections.length) {
    return [];
  }
  return sections;
}

function joinCompleteSegmentsWithinBudget(segments) {
  const fullBlock = segments.map((segment) => `${segment.separator}${segment.text}`).join('');
  if (fullBlock.length <= MAX_BLOCK_CHARS) {
    return fullBlock;
  }

  let block = '';
  for (const segment of segments) {
    const candidate = `${block}${segment.separator}${segment.text}`;
    if (candidate.length + 1 + BLOCK_TRUNCATION_NOTE.length > MAX_BLOCK_CHARS) {
      break;
    }
    block = candidate;
  }
  return `${block}\n${BLOCK_TRUNCATION_NOTE}`;
}

/**
 * Build a single system-message context block from the renderer-supplied active
 * editor slice and @-mentioned file contents.
 *
 * @param {object|null} activeFileContext - { path, languageId, cursor:{lineNumber}, startLine, endLine, totalLines, slice } | null
 * @param {Array<{path:string, content:string}>} mentionContents - resolved @-mention file contents
 * @returns {string|null} a system-message string, or null when there is nothing to contribute.
 */
function buildActiveFileContextBlock(activeFileContext, mentionContents) {
  const segments = [];
  const activeSection = buildActiveSliceSection(activeFileContext);
  if (activeSection) {
    segments.push({ separator: '', text: activeSection });
  }
  const mentionSections = buildMentionSections(mentionContents);
  if (mentionSections.length) {
    segments.push({
      separator: activeSection ? '\n\n' : '',
      text: `[Files the user referenced with @ in their message]\n${mentionSections[0]}`,
    });
    for (const section of mentionSections.slice(1)) {
      segments.push({ separator: '\n', text: section });
    }
  }
  if (!segments.length) {
    return null;
  }
  return joinCompleteSegmentsWithinBudget(segments);
}

module.exports = {
  buildActiveFileContextBlock,
  fenceLanguageForPath,
};
