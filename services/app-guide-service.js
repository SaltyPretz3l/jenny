'use strict';

// The bundled app guide (row 69 W4b): hand-authored pages under config/app-guide/ with an index, read once
// and searched in memory for the `jenny_help` tool. The folder ships in the packaged `files` globs; nothing
// outside it is ever read (a page path is always `<id>.md`, a symlink is refused). Page text is data for the
// model: it is returned verbatim and never logged.
const fs = require('node:fs');
const path = require('node:path');

const GUIDE_DIR = path.join(__dirname, '..', 'config', 'app-guide');
const ID_PATTERN = /^[a-z][a-z0-9-]{1,48}$/;
const INDEX_KEYS = ['id', 'keywords', 'path', 'summary', 'title'];
const MAX_PAGE_CHARS = 16000;
const MAX_QUERY_CHARS = 200;
const MAX_RESULTS = 6;
const MAX_EXCERPT_CHARS = 320;
const MIN_KEYWORDS = 6;
const MAX_KEYWORDS = 16;
const STOP_WORDS = new Set(['the', 'is', 'of', 'to', 'in', 'on', 'and', 'or', 'how', 'do', 'does', 'what', 'can', 'my', 'it', 'for', 'with', 'are']);

function unavailable(reason) {
  return new Error(`App guide unavailable (${reason})`);
}

function nonEmptyString(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function validateEntry(entry, seen) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)
    || Object.keys(entry).sort().join() !== INDEX_KEYS.join()) throw unavailable('index_entry_shape');
  if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id) || seen.has(entry.id)) throw unavailable('index_entry_id');
  if (entry.path !== `${entry.id}.md`) throw unavailable('index_entry_path');
  if (!nonEmptyString(entry.title, 120) || !nonEmptyString(entry.summary, 400)) throw unavailable('index_entry_text');
  const keywords = entry.keywords;
  if (!Array.isArray(keywords) || keywords.length < MIN_KEYWORDS || keywords.length > MAX_KEYWORDS
    || new Set(keywords).size !== keywords.length
    || !keywords.every(keyword => nonEmptyString(keyword, 80) && keyword === keyword.toLowerCase())) {
    throw unavailable('index_entry_keywords');
  }
  seen.add(entry.id);
}

function tokenize(value) {
  const tokens = String(value).toLowerCase().match(/[a-z0-9]+/g) || [];
  return [...new Set(tokens.filter(token => token.length >= 2 && !STOP_WORDS.has(token)))];
}

// A whole-word matcher for one term (a trailing "s"/"es" plural still counts as the word).
function wordPattern(term) {
  return new RegExp(`(?:^|[^a-z0-9])${term}(?:e?s)?(?![a-z0-9])`, 'g');
}

function countWord(haystack, pattern) {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(haystack)) count += 1;
  return count;
}

function loadGuide(guideDir, fsImpl) {
  let index;
  try {
    index = JSON.parse(fsImpl.readFileSync(path.join(guideDir, 'index.json'), 'utf8'));
  } catch (_error) {
    throw unavailable('index_unreadable');
  }
  if (!index || index.schema_version !== 1 || !Array.isArray(index.pages) || index.pages.length === 0) {
    throw unavailable('index_shape');
  }
  const seen = new Set();
  const pages = [];
  for (const entry of index.pages) {
    validateEntry(entry, seen);
    const file = path.join(guideDir, entry.path);
    let text;
    try {
      if (!fsImpl.lstatSync(file).isFile()) throw new Error('not a regular file');
      text = fsImpl.readFileSync(file, 'utf8');
    } catch (_error) {
      throw unavailable('page_unreadable');
    }
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_PAGE_CHARS) throw unavailable('page_size');
    if (text.split('\n', 1)[0] !== `# ${entry.title}`) throw unavailable('page_title');
    pages.push({
      id: entry.id, title: entry.title, summary: entry.summary, keywords: entry.keywords, text,
      lowerTitle: entry.title.toLowerCase(), lowerSummary: entry.summary.toLowerCase(),
      lowerText: text.toLowerCase(), units: textUnits(text),
    });
  }
  return { pages, byId: new Map(pages.map(page => [page.id, page])), ids: pages.map(page => page.id) };
}

// Paragraph-sized units (one per non-heading line, list markers dropped) for excerpts.
function textUnits(text) {
  return text.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
    .map(line => line.replace(/^[-*]\s+/, ''));
}

function scorePage(page, phrase, patterns) {
  let meta = 0;
  if (phrase && (page.lowerTitle.includes(phrase) || page.keywords.some(keyword => keyword.includes(phrase)))) meta += 8;
  for (const pattern of patterns) {
    if (countWord(page.lowerTitle, pattern)) meta += 6;
    if (page.keywords.some(keyword => countWord(keyword, pattern))) meta += 5;
    if (countWord(page.lowerSummary, pattern)) meta += 2;
  }
  let text = 0;
  for (const pattern of patterns) {
    const count = countWord(page.lowerText, pattern);
    if (count > 0) text += 1 + Math.min(count - 1, 4) * 0.1;
  }
  return { meta, text };
}

function excerptFor(page, patterns) {
  const unit = page.units.find(candidate => {
    const lower = candidate.toLowerCase();
    return patterns.some(pattern => countWord(lower, pattern) > 0);
  });
  return (unit || page.summary).slice(0, MAX_EXCERPT_CHARS);
}

function createAppGuideService({ guideDir = GUIDE_DIR, fsImpl = fs } = {}) {
  let guide = null;
  // A failed load is not cached: the next call retries (a broken install should fail loudly, not stick).
  const ensure = () => (guide ||= loadGuide(guideDir, fsImpl));

  return {
    listPages() {
      return ensure().pages.map(({ id, title, summary }) => ({ id, title, summary }));
    },
    read(page) {
      if (typeof page !== 'string') return { ok: false, reason: 'invalid_request' };
      const { byId, ids } = ensure();
      const found = byId.get(page);
      if (!found) return { ok: false, reason: 'not_found', pages: [...ids] };
      return { ok: true, page: found.id, title: found.title, text: found.text };
    },
    search(query) {
      if (typeof query !== 'string' || query.trim().length === 0 || query.trim().length > MAX_QUERY_CHARS) {
        return { ok: false, reason: 'invalid_request' };
      }
      const { pages } = ensure();
      const terms = tokenize(query);
      if (terms.length === 0) return { ok: true, results: [] };
      const patterns = terms.map(wordPattern);
      const phrase = terms.length > 1 ? terms.join(' ') : '';
      const ranked = pages.map((page, order) => ({ page, order, ...scorePage(page, phrase, patterns) }))
        .filter(row => row.meta > 0 || row.text > 0)
        .sort((a, b) => b.meta - a.meta || b.text - a.text || a.order - b.order)
        .slice(0, MAX_RESULTS);
      return {
        ok: true,
        results: ranked.map(({ page }) => ({ page: page.id, title: page.title, excerpt: excerptFor(page, patterns) })),
      };
    },
  };
}

let defaultService = null;
function getAppGuideService() {
  return (defaultService ||= createAppGuideService());
}

module.exports = { createAppGuideService, getAppGuideService, GUIDE_DIR };
