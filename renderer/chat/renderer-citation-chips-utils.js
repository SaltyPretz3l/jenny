/* renderer/chat/renderer-citation-chips-utils.js (UMD, row 154)
 * Turns `source_citations` events and the answer's `[web:N]` markers into superscript references and
 * one sources list under the final answer (DOM contract shared with renderer-source-card.js). Refs are
 * untrusted: every field is escaped and every url re-checked as http(s).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererCitationChipsUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const fallbackEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = globalThis.jennyI18n?.tn || ((k, count, params, one, other) => jt.call(null, k, count === 1 ? one : other, params));

  // `[web:N]` or the fullwidth `【web:N】` gpt-oss favours, optionally `[web:1,7]`, with one leading
  // space or tab (never a newline) so punctuation after a removed marker keeps no gap. The literal
  // `web:` keeps unrelated bracketed text ("[webinar: 1]", links) untouched.
  const CITATION_MARKER_PATTERN = /[ \t]?[[【]\s*web:\s*\d+(?:\s*,\s*\d+)*\s*[\]】]/gi;

  function stripCitationMarkers(text) {
    const raw = String(text ?? '');
    return raw && raw.replace(CITATION_MARKER_PATTERN, '');
  }

  // Any prefix of a marker (with its optional leading space) at the very end of the text.
  const PARTIAL_CITATION_MARKER_TAIL = /[ \t]?(?:[[【]\s*(?:w(?:e(?:b(?::[\s\d,]*)?)?)?)?)?$/i;

  // Streaming: also hold back a trailing marker still arriving, so it never flashes; holding back the
  // trailing space keeps each frame a prefix of the next for the incremental stream renderer.
  function stripCitationMarkersForStreaming(text) {
    return stripCitationMarkers(text).replace(PARTIAL_CITATION_MARKER_TAIL, '');
  }

  // Flag off renders the marker exactly as before.
  function stripCitationMarkersForFlags(text, featureFlags, options) {
    if (featureFlags?.source_citations !== true) return text;
    return options?.streaming ? stripCitationMarkersForStreaming(text) : stripCitationMarkers(text);
  }

  function safeHttpUrl(value) {
    try {
      const parsed = new URL(asText(value));
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  // Private-use sentinels carry a resolved reference number through the markdown renderer.
  const SENTINEL_OPEN = '\uE000';
  const SENTINEL_CLOSE = '\uE001';
  const SENTINEL_STRAY = /[\uE000\uE001]/g;
  const SENTINEL_RUN = /(?:[ \t]?\uE000\d+\uE001)+/g;
  const SENTINEL_ONE = /\uE000\d+\uE001/g;
  const MAX_OPEN_LISTS = 200;
  const LINK_ATTRS = 'target="_blank" rel="noopener noreferrer"';
  const NO_ROWS = [];

  function asText(value) {
    return String(value ?? '').trim();
  }

  function normalizeRef(raw) {
    const parsed = safeHttpUrl(raw?.url);
    if (!parsed) return null;
    const n = Number(raw.n);
    return {
      key: `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`,
      url: parsed.toString(),
      hostname: parsed.hostname,
      host: parsed.hostname.replace(/^www\./i, ''),
      path: parsed.pathname,
      title: asText(raw.title),
      snippet: asText(raw.snippet),
      sourceType: asText(raw.sourceType).toLowerCase(),
      n: Number.isInteger(n) && n > 0 ? n : 0,
      alsoN: Array.isArray(raw.alsoN) ? raw.alsoN.map(Number).filter((value) => Number.isInteger(value) && value > 0) : [],
    };
  }

  function parseMarkerIds(marker) {
    return (marker.match(/\d+/g) || []).map(Number);
  }

  // The latest call before the answer that holds a ref numbered `id`.
  function resolveInCalls(calls, id) {
    for (let i = id > 0 ? calls.length - 1 : -1; i >= 0; i -= 1) {
      const hit = calls[i].find((entry) => entry.n === id || entry.alsoN.includes(id));
      if (hit) return hit;
    }
    return null;
  }

  const indexMemo = new WeakMap();

  // One pass per rows array (memoised; rebuilt when its length changes). cited: {num, ref} numbered in
  // first-resolved order by url; uncited/all: deduped refs; rowNumbers: rowId -> markerId -> num.
  function buildTurnSourceIndex(turnRows) {
    const rows = Array.isArray(turnRows) ? turnRows : NO_ROWS;
    const memo = indexMemo.get(rows);
    if (memo && memo.length === rows.length) return memo.index;
    const calls = [];
    const all = new Map();
    const numberByKey = new Map();
    const cited = [];
    const rowNumbers = new Map();
    let finalAnswerRowId = '';
    let lastNoticeRowId = '';
    for (const row of rows) {
      if (!row) continue;
      const payload = row.payload || {};
      const rowId = asText(row.row_id);
      if (row.kind === 'system_notice' && asText(payload.subkind).toLowerCase() === 'source_citations') {
        const refs = (Array.isArray(payload.refs) ? payload.refs : []).map(normalizeRef).filter(Boolean);
        calls.push(refs);
        for (const entry of refs) if (!all.has(entry.key)) all.set(entry.key, entry);
        if (rowId) lastNoticeRowId = rowId;
        continue;
      }
      if (row.kind !== 'assistant_text' || !rowId || payload.discard_hidden === true || payload.discard_anchor === true) continue;
      const text = String(payload.text ?? '');
      if (!text.trim()) continue;
      finalAnswerRowId = rowId;
      if (!calls.length) continue; // nothing can resolve before the first source call
      const numbers = new Map();
      for (const match of text.matchAll(CITATION_MARKER_PATTERN)) {
        for (const id of parseMarkerIds(match[0])) {
          if (numbers.has(id)) continue;
          const entry = resolveInCalls(calls, id);
          if (!entry) continue;
          let num = numberByKey.get(entry.key);
          if (!num) {
            num = cited.length + 1;
            numberByKey.set(entry.key, num);
            cited.push({ num, ref: entry });
          }
          numbers.set(id, num);
        }
      }
      if (numbers.size) rowNumbers.set(rowId, numbers);
    }
    const index = Object.freeze({
      cited,
      uncited: [...all.values()].filter((entry) => !numberByKey.has(entry.key)),
      all: [...all.values()],
      resolvedAny: cited.length > 0,
      finalAnswerRowId,
      lastNoticeRowId,
      rowNumbers,
    });
    indexMemo.set(rows, { length: rows.length, index });
    return index;
  }

  // Title slot: the ref title unless empty or just the site (then the site, with no repeated site span);
  // a fetched page shows site + path and no snippet.
  function describeRef(entry) {
    const site = entry.host;
    if (entry.sourceType === 'page') {
      return { title: site + (entry.path === '/' ? '' : entry.path), site, showSite: false, snippet: '' };
    }
    const lower = entry.title.toLowerCase();
    const bare = !entry.title || lower === site.toLowerCase() || lower === entry.hostname.toLowerCase();
    return { title: bare ? site : entry.title, site, showSite: !bare, snippet: entry.snippet };
  }

  function dataAttrs(entry, num, info, esc) {
    return `data-source-ref="${num}" data-source-url="${esc(entry.url)}" data-source-title="${esc(info.title)}"`
      + ` data-source-site="${esc(info.site)}" data-source-snippet="${esc(info.snippet)}"`;
  }

  function referenceGroup(numbers, index, esc) {
    const links = [];
    for (const num of numbers) {
      const hit = index.cited[num - 1];
      if (!hit) continue;
      const info = describeRef(hit.ref);
      const label = jt('chat.sources.refLabel', 'Source {n}: {title}', { n: num, title: info.title });
      links.push(`<a class="source-ref-link" href="${esc(hit.ref.url)}" ${LINK_ATTRS} ${dataAttrs(hit.ref, num, info, esc)} aria-label="${esc(label)}">${num}</a>`);
    }
    return links.length ? `<sup class="source-ref">${links.join(',')}</sup>` : '';
  }

  // Sentinel runs (with the space kept before them so an autolink ends there) become reference groups. Runs inside <a>, <code> or <pre> (no nested anchors, no
  // references in code) and inside tag attributes are dropped; the markdown renderer escapes "<" in
  // text, so every "<" token is a tag.
  function injectReferenceGroups(html, index, esc) {
    if (html.indexOf(SENTINEL_OPEN) < 0) return html;
    let skip = 0;
    return html.split(/(<(?:"[^"]*"|'[^']*'|[^>"'])*>)/).map((token, position) => {
      if (position % 2 === 1) {
        const tag = /^<(\/?)(a|code|pre)\b/i.exec(token);
        if (tag) skip = Math.max(0, skip + (tag[1] ? -1 : (token.endsWith('/>') ? 0 : 1)));
        return token.replace(SENTINEL_ONE, '');
      }
      if (token.indexOf(SENTINEL_OPEN) < 0) return token;
      return token.replace(SENTINEL_RUN, (run) => (skip ? '' : referenceGroup([...new Set(parseMarkerIds(run))], index, esc)));
    }).join('');
  }

  /** Markdown with resolved markers as `<sup class="source-ref">` groups; unresolved markers and any
   *  stray sentinel in the model text are removed. */
  function renderTextWithReferences(text, { rowId, index, renderMarkdown, escapeHtml: esc = fallbackEscapeHtml } = {}) {
    const numbers = index?.rowNumbers?.get(asText(rowId));
    const prepared = String(text ?? '').replace(SENTINEL_STRAY, '').replace(CITATION_MARKER_PATTERN, (marker) => (numbers
      ? parseMarkerIds(marker).map((id) => numbers.get(id)).filter(Boolean).map((num) => ` ${SENTINEL_OPEN}${num}${SENTINEL_CLOSE}`).join('')
      : ''));
    return injectReferenceGroups(String(renderMarkdown(prepared)), index, esc).replace(SENTINEL_STRAY, '');
  }

  // Open state of the "Also searched" fold, per turn id; survives re-renders.
  const openLists = new Set();

  function isSourceListOpen(turnId) {
    return openLists.has(String(turnId ?? ''));
  }

  function setSourceListOpen(turnId, open) {
    const key = String(turnId ?? '');
    openLists.delete(key);
    if (open) openLists.add(key);
    if (openLists.size > MAX_OPEN_LISTS) openLists.delete(openLists.values().next().value);
  }

  function listItem(entry, num, esc) {
    const info = describeRef(entry);
    const site = info.showSite ? `<span class="source-list-site">${esc(info.site)}</span>` : '';
    const number = num ? `<span class="source-list-num" aria-hidden="true">${num}</span>` : '';
    return `<li class="source-list-item" data-source-ref="${num}">${number}<span class="source-list-body">`
      + `<a class="source-list-title" href="${esc(entry.url)}" ${LINK_ATTRS} ${dataAttrs(entry, num, info, esc)}>${esc(info.title)}</a>${site}</span></li>`;
  }

  /** The turn's sources list: the cited sources numbered, the rest behind "Also searched N more"; or,
   *  when no marker resolved, one unnumbered list of every source. '' when the turn has none. */
  function renderSourceList(index, { turnId: rawTurnId, escapeHtml: esc = fallbackEscapeHtml, actionButton } = {}) {
    if (!index?.all?.length) return '';
    const turnId = String(rawTurnId ?? '');
    const section = (inner) => `<section class="source-list" aria-label="${esc(jt('chat.sources.label', 'Sources'))}" data-source-list-turn="${esc(turnId)}">${inner}</section>`;
    if (!index.resolvedAny) {
      return section(`<ul class="source-list-cited source-list--plain">${index.all.map((entry) => listItem(entry, '', esc)).join('')}</ul>`);
    }
    const numbered = `<ol class="source-list-cited">${index.cited.map((hit) => listItem(hit.ref, hit.num, esc)).join('')}</ol>`;
    const button = actionButton || globalThis.inventoryActionButton || (typeof require === 'function' && require('../inventory/action-button'));
    if (!index.uncited.length || typeof button !== 'function') return section(numbered);
    const alsoId = `source-also-${turnId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
    const open = isSourceListOpen(turnId);
    const count = index.uncited.length;
    const toggle = button({
      plain: true,
      className: 'source-list-toggle',
      ariaExpanded: open,
      ariaControls: alsoId,
      dataset: { 'source-list-toggle': turnId },
      label: jtn('chat.sources.alsoSearched', count, { count }, 'Also searched {count} more', 'Also searched {count} more'),
    });
    const also = `<ul class="source-list-also" id="${esc(alsoId)}"${open ? '' : ' hidden'}>${index.uncited.map((entry) => listItem(entry, '', esc)).join('')}</ul>`;
    return section(numbered + toggle + also);
  }

  return {
    buildTurnSourceIndex,
    renderTextWithReferences,
    renderSourceList,
    isSourceListOpen,
    setSourceListOpen,
    stripCitationMarkers,
    stripCitationMarkersForStreaming,
    stripCitationMarkersForFlags,
  };
});
