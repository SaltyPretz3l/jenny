'use strict';

/**
 * services/backend/tool-result-source-metadata.js
 *
 * Bounded normalizer for web_search `sources`/`citations` tool-result payload
 * fields — the single chokepoint between UNTRUSTED tool output (AGENTS.md
 * §11) and the persisted `source_citations` turn-event payload. Mirrors
 * tool-result-diff-metadata.js: bound counts and per-field lengths, validate
 * schemes (http/https only), fixed sourceType vocabulary, dedupe by url.
 * Fields are NOT HTML-escaped here — the event payload stays clean data; the
 * renderer escapes every field at render time (renderer-citation-chips-utils).
 *
 * Live web_search contract (sidecar/ai/tools/builtins/web.py): citation ids
 * are `web:N` with N 1-BASED; `sources` entries carry {url, title, snippet,
 * source_type}, `citations` carry {id, url, title}. Sources are preferred
 * (they have the snippet); citations fill in urls the sources missed.
 */

const MAX_CITATIONS = 12;
const MAX_TITLE_CHARS = 200;
const MAX_SNIPPET_CHARS = 280;
const MAX_URL_CHARS = 2048;
// Upper bound for the output_text JSON-parse fallback below — web_search
// payloads are far smaller (the sidecar bounds provider responses at 1 MiB
// pre-shaping); anything bigger is not a citations payload.
const MAX_OUTPUT_TEXT_PARSE_CHARS = 262144;
const ALLOWED_SOURCE_TYPES = new Set(['web', 'news', 'image', 'video', 'knowledge']);

function safeString(value) {
  if (typeof value === 'symbol') return '';
  if (value == null) return '';
  try {
    return String(value);
  } catch (_error) {
    return '';
  }
}

function boundedString(value, limit) {
  return safeString(value).trim().slice(0, limit);
}

function normalizeHttpUrl(value) {
  const raw = safeString(value).trim();
  if (!raw || raw.length > MAX_URL_CHARS || raw.includes('\0')) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_error) {
    return '';
  }
  const protocol = String(parsed.protocol || '').toLowerCase();
  if (protocol !== 'http:' && protocol !== 'https:') return '';
  return parsed.toString();
}

function normalizeSourceType(value) {
  const token = safeString(value).trim().toLowerCase();
  return ALLOWED_SOURCE_TYPES.has(token) ? token : '';
}

function normalizeRef(entry, { withSnippet }) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const url = normalizeHttpUrl(entry.url);
  if (!url) return null;
  return {
    url,
    title: boundedString(entry.title, MAX_TITLE_CHARS),
    snippet: withSnippet ? boundedString(entry.snippet, MAX_SNIPPET_CHARS) : '',
    sourceType: normalizeSourceType(entry.source_type ?? entry.sourceType),
  };
}

// The LIVE wire shape (chat-stream-tool-handling.js noteEvent payload) never
// carries structured `sources`/`citations` keys: the web tool json.dumps its
// whole payload into the `output` notification param, which lands verbatim in
// `payload.output_text`. When the structured keys are absent, fall back to a
// guarded parse of that JSON text: bounded size, object-prefix sniff, cheap
// substring pre-check so non-citation tool outputs (grep/read/build logs)
// never pay for a full JSON.parse.
function resolveCitationBearingSource(payload) {
  if (Array.isArray(payload.sources) || Array.isArray(payload.citations)) {
    return payload;
  }
  const outputText = typeof payload.output_text === 'string' ? payload.output_text : '';
  if (!outputText || outputText.length > MAX_OUTPUT_TEXT_PARSE_CHARS) return null;
  const trimmed = outputText.trim();
  if (!trimmed.startsWith('{')) return null;
  if (!trimmed.includes('"citations"') && !trimmed.includes('"sources"')) return null;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (_error) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * normalizeSourceCitations(payload) -> { refs, truncated } | null
 * `payload` is the raw web_search tool_result payload — either an object
 * carrying structured `sources`/`citations` arrays, or the live wire shape
 * whose `output_text` embeds the web tool's JSON payload. Returns null when
 * nothing valid survives.
 */
function normalizeSourceCitations(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const source = resolveCitationBearingSource(payload);
  if (!source) return null;
  const sources = Array.isArray(source.sources) ? source.sources : [];
  const citations = Array.isArray(source.citations) ? source.citations : [];
  const byUrl = new Map();
  for (const entry of sources) {
    const ref = normalizeRef(entry, { withSnippet: true });
    if (!ref) continue;
    if (!byUrl.has(ref.url)) {
      byUrl.set(ref.url, ref);
    }
  }
  for (const entry of citations) {
    const ref = normalizeRef(entry, { withSnippet: false });
    if (!ref) continue;
    if (byUrl.has(ref.url)) continue; // sources win (they carry the snippet)
    byUrl.set(ref.url, ref);
  }
  if (byUrl.size === 0) return null;
  const refs = [...byUrl.values()].slice(0, MAX_CITATIONS);
  // Dedupe is not truncation: only a post-dedupe overflow past the cap counts.
  return { refs, truncated: byUrl.size > MAX_CITATIONS };
}

module.exports = {
  normalizeSourceCitations,
  MAX_CITATIONS,
  MAX_TITLE_CHARS,
  MAX_SNIPPET_CHARS,
};
