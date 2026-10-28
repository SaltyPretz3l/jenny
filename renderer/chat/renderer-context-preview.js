/* Shared next-send projection and refresh subscriptions. No prompt contents leave the service.

   Row 63: the composer context ring and the Session summary rail read ONE next-send estimate
   (the sidecar `context.preview`), so they cannot disagree. The rail publishes the preview its
   summary carries, the ring's details popover publishes the one it loads, and the composer
   refreshes it when a chat's inputs change; both surfaces render the same projection and the
   same breakdown markup from here. 100% is the auto-compact point when the sidecar reports
   one (`compact_at_tokens`), else the model window. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-context-usage-model'), require('../shared/string-utils'));
    return;
  }
  root.rendererContextPreview = factory(root.rendererContextUsageModel, root.stringUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (usage, stringUtils) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = stringUtils.escapeHtml;
  const MAX_SESSIONS = 32;
  const REFRESH_MIN_INTERVAL_MS = 1500;
  // [key, label()]: the labels resolve at render time (the i18n ledger reads literal keys).
  const CATEGORIES = Object.freeze([
    ['messages', () => jt('chat.messages.review.eyebrow', 'Messages')],
    ['system_prompt', () => jt('chat.sessionRail.context.systemPrompt', 'System prompt')],
    ['tools', () => jt('chat.sessionRail.context.tools', 'Tool definitions')],
    ['instructions', () => jt('chat.sessionRail.context.instructions', 'Workspace instructions')],
    ['skills', () => jt('composer.slash.skills', 'Skills')],
    ['other', () => jt('chat.sessionRail.context.other', 'Other context')],
  ]);

  function markStale(summary, sectionKeys) {
    if (!summary || typeof summary !== 'object') return summary;
    const next = { ...summary };
    sectionKeys.forEach((key) => {
      if (next[key]?.state === 'available') next[key] = { ...next[key], state: 'stale' };
    });
    return next;
  }

  function withDraft(preview, text, attachments) {
    if (!preview?.breakdown || !Number.isSafeInteger(preview.used_tokens)) return preview;
    const draftTokens = usage.estimateTextTokens(text) + usage.estimateAttachmentTokens(attachments);
    const used = preview.used_tokens + draftTokens;
    return { ...preview, used_tokens: used,
      available_tokens: preview.capacity_tokens == null ? null : Math.max(0, preview.capacity_tokens - used),
      breakdown: { ...preview.breakdown, messages: preview.breakdown.messages + draftTokens } };
  }

  function bindRefresh({ pane, win, listen, syncSession, scheduleFetch, paint, visible, options, getSessionId }) {
    const draftSelector = '[data-chat-node="chatInput"], #chatInput';
    let inputsKey = options.getSummaryKey?.() ?? null; // mount already fetched for these inputs
    let paintedDraft;
    const paintDraft = () => { paintedDraft = pane.querySelector?.(draftSelector)?.value; paint(); };
    listen(pane, 'composer-state-rendered', () => {
      const changed = syncSession();
      const next = options.getSummaryKey?.() ?? null;
      if (!changed && next !== inputsKey) scheduleFetch();
      inputsKey = next;
      paintDraft();
    });
    listen(win, 'focus', scheduleFetch);
    // A keystroke already painted by composer-state-rendered is not painted twice.
    listen(pane, 'input', (event) => {
      if (event.target.matches?.(draftSelector) && event.target.value !== paintedDraft) paintDraft();
    });
    // External prompt/instruction edits have no renderer event. Resync first: a
    // rail that missed the switch event would poll a stale session (syncSession fetches on a change).
    const timer = options.refreshIntervalMs > 0 ? win.setInterval(() => {
      if (!visible() || pane.ownerDocument.visibilityState === 'hidden') return;
      if (!syncSession()) scheduleFetch();
    }, options.refreshIntervalMs) : null;
    // An estimate the ring or its popover fetched repaints the rail too (one frame, coalesced).
    let frame = 0;
    const unsubscribe = subscribe((sessionId) => {
      if (frame || sessionId !== sessionKey(getSessionId?.())) return;
      frame = win.requestAnimationFrame(() => { frame = 0; paint(); });
    });
    return () => { unsubscribe(); if (frame) win.cancelAnimationFrame(frame); if (timer) win.clearInterval(timer); };
  }

  // ── Projection ─────────────────────────────────────────────────────────
  function count(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  function positive(value) {
    const n = count(value);
    return n !== null && n > 0 ? n : null;
  }

  /* `{used, capacity, compactAt, target}`: target is the auto-compact point when known, else the
     window. A compaction point at or past the window means none applies. Unknown stays null. */
  function project(data) {
    const used = count(data?.used_tokens);
    const capacity = positive(data?.capacity_tokens);
    let compactAt = positive(data?.compact_at_tokens);
    if (compactAt !== null && capacity !== null && compactAt >= capacity) compactAt = null;
    const target = compactAt ?? capacity;
    return { used, capacity, compactAt, target, breakdown: data?.breakdown || null };
  }

  /* One percent rule for every context surface: '' when unknown, '<1%' under one percent,
     capped at 100%. */
  function formatPercent(used, target) {
    const limit = Number(target || 0);
    const value = Number(used || 0);
    if (!(limit > 0) || !(value >= 0)) return '';
    const raw = (value / limit) * 100;
    if (!Number.isFinite(raw) || raw < 0) return '';
    if (raw > 0 && raw < 1) return '<1%';
    return Math.min(100, Math.round(raw)) + '%';
  }

  function formatTokens(value) {
    const n = count(value);
    if (n === null) return '';
    if (n < 1000) return String(n);
    const unit = n >= 1000000 ? 1000000 : 1000;
    const scaled = n / unit;
    return `${scaled.toFixed(scaled >= 100 ? 0 : 1).replace(/\.0$/, '')}${unit === 1000000 ? 'M' : 'k'}`;
  }

  /* The headline sentence under the percent, shared by the rail and the ring popover. */
  function describeLine(projection) {
    const p = projection || {};
    if (p.used === null || p.used === undefined || !p.target) return '';
    return p.compactAt
      ? jt('chat.contextUsage.untilCompactLine', '{used} of {target} · then Jenny summarizes older messages', { used: formatTokens(p.used), target: formatTokens(p.compactAt) })
      : jt('chat.contextUsage.windowLine', '{used} of {target} token context window', { used: formatTokens(p.used), target: formatTokens(p.target) });
  }

  function categoryRow(key, label, tokens, capacity) {
    const share = capacity && tokens !== null ? `${(tokens / capacity * 100).toFixed(1)}%` : '—';
    return `<div class="session-context-category" data-row-key="${escapeHtml(key)}">`
      + `<span class="session-context-swatch" data-context-category="${escapeHtml(key)}" aria-hidden="true"></span>`
      + `<span>${escapeHtml(label)}</span><span>${tokens === null ? '—' : escapeHtml(formatTokens(tokens))}</span><strong>${share}</strong></div>`;
  }

  /* The window bar (category fills, or one "used" fill without a breakdown) with the auto-compact
     marker, then the category rows and the room left. Unknown counts read as dashes. */
  function breakdownHtml(projection) {
    const p = projection || {};
    const capacity = p.capacity || null;
    const width = (tokens) => (capacity && tokens !== null ? Math.min(100, tokens / capacity * 100) : 0);
    const fills = p.breakdown
      ? CATEGORIES.map(([key]) => `<span data-context-category="${key}" style="flex-basis:${width(count(p.breakdown[key]))}%"></span>`).join('')
      : `<span data-context-category="used" style="flex-basis:${width(p.used ?? null)}%"></span>`;
    const marker = p.compactAt && capacity
      ? `<span class="session-context-marker" style="inset-inline-start:${width(p.compactAt)}%" aria-hidden="true"></span>` : '';
    let html = `<div class="session-context-meter" aria-hidden="true"><div class="session-context-bar">${fills}</div>${marker}</div>`;
    if (capacity) {
      html += `<div class="session-context-scale" aria-hidden="true"><span>0</span><span>${escapeHtml(jt('chat.contextUsage.windowScale', '{count} window', { count: formatTokens(capacity) }))}</span></div>`;
    }
    if (p.breakdown) {
      html += CATEGORIES.map(([key, label]) => categoryRow(key, label(), count(p.breakdown[key]), capacity)).join('');
    } else if (p.used === null || p.used === undefined) {
      html += CATEGORIES.map(([key, label]) => categoryRow(key, label(), null, capacity)).join('');
    }
    if (p.compactAt && p.used !== null && p.used !== undefined) {
      html += categoryRow('free', jt('chat.contextUsage.roomBeforeCompact', 'Room before auto-compact'), Math.max(0, p.compactAt - p.used), capacity);
    } else {
      html += categoryRow('free', jt('chat.sessionRail.context.available', 'Available'), capacity && p.used !== null && p.used !== undefined ? Math.max(0, capacity - p.used) : null, capacity);
    }
    if (p.compactAt) {
      html += `<div class="session-context-category" data-row-key="compact_at"><span class="session-context-marker-swatch" aria-hidden="true"></span>`
        + `<span>${escapeHtml(jt('chat.contextUsage.autoCompactsAt', 'Auto-compacts at'))}</span><span>${escapeHtml(formatTokens(p.compactAt))}</span>`
        + `<strong>${capacity ? `${(p.compactAt / capacity * 100).toFixed(0)}%` : '—'}</strong></div>`;
    }
    return html;
  }

  // ── Per-session store ──────────────────────────────────────────────────
  const entries = new Map(); // sessionId -> { data, at }
  const listeners = new Set();
  const inFlight = new Map(); // sessionId -> promise

  function sessionKey(sessionId) {
    return String(sessionId || '').trim();
  }

  function isEstimate(data) {
    return Boolean(data && typeof data === 'object' && (data.status === undefined || data.status === 'estimated')
      && Number.isSafeInteger(data.used_tokens) && data.used_tokens > 0 && data.breakdown && typeof data.breakdown === 'object');
  }

  function sameEstimate(a, b) {
    return a.used_tokens === b.used_tokens && a.capacity_tokens === b.capacity_tokens
      && a.compact_at_tokens === b.compact_at_tokens && JSON.stringify(a.breakdown) === JSON.stringify(b.breakdown);
  }

  /* Keep the latest next-send estimate for a chat. Listeners hear only real changes. */
  function remember(sessionId, data, now = Date.now()) {
    const key = sessionKey(sessionId);
    if (!key || !isEstimate(data)) return false;
    const previous = entries.get(key);
    const sampled = Date.parse(data.sampled_at || '');
    const at = Number.isFinite(sampled) ? sampled : now;
    if (previous && previous.at > at) return false; // an older answer never replaces a newer one
    entries.delete(key);
    entries.set(key, { data, at });
    while (entries.size > MAX_SESSIONS) entries.delete(entries.keys().next().value);
    if (previous && sameEstimate(previous.data, data)) return false;
    listeners.forEach((listener) => { try { listener(key); } catch (_error) { /* a listener never blocks the others */ } });
    return true;
  }

  function latest(sessionId) {
    return entries.get(sessionKey(sessionId)) || null;
  }

  function forget(sessionId) {
    entries.delete(sessionKey(sessionId));
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /* Ask for a fresh estimate (`request(sessionId)` resolves to the next-turn context summary).
     Calls for one chat share a flight, and one answered within the last moment is reused. */
  function refresh(sessionId, request, options = {}) {
    const key = sessionKey(sessionId);
    if (!key || typeof request !== 'function') return Promise.resolve(null);
    if (inFlight.has(key)) {
      return options.force ? inFlight.get(key).then(() => refresh(key, request, options)) : inFlight.get(key);
    }
    const now = typeof options.now === 'function' ? options.now() : Date.now();
    const current = entries.get(key);
    if (!options.force && current && now - current.at < REFRESH_MIN_INTERVAL_MS) return Promise.resolve(current);
    const flight = Promise.resolve()
      .then(() => request(key))
      .then((summary) => {
        const data = summary?.preview;
        if (data?.status === 'estimated') remember(key, data, now);
        return entries.get(key) || null;
      })
      .catch(() => null)
      .finally(() => { if (inFlight.get(key) === flight) inFlight.delete(key); });
    inFlight.set(key, flight);
    return flight;
  }

  /* The composer ring's feed: repaint when this chat's estimate changes or the draft moves,
     and refresh the estimate when the chat's inputs change outside a reply. The rail does its
     own fetching; whichever answers first serves both. */
  function bindComposerFeed({ win, doc, getSessionId, getInputsKey, isTurnActive, request, paint, delayMs = 250 }) {
    let frame = 0;
    let timer = 0;
    let lastKey = null;
    const schedulePaint = () => {
      if (frame) return;
      frame = win.requestAnimationFrame(() => { frame = 0; paint(); });
    };
    const unsubscribe = subscribe((sessionId) => { if (sessionId === sessionKey(getSessionId())) schedulePaint(); });
    const onInput = (event) => {
      if (event.target?.matches?.('[data-chat-node="chatInput"], #chatInput')) schedulePaint();
    };
    doc.addEventListener('input', onInput);
    function sync() {
      const key = getInputsKey();
      if (key === lastKey || isTurnActive()) return;
      lastKey = key;
      if (timer) win.clearTimeout(timer);
      timer = win.setTimeout(() => {
        timer = 0;
        const sessionId = sessionKey(getSessionId());
        if (sessionId && !isTurnActive()) void refresh(sessionId, request, { force: true });
      }, delayMs);
    }
    return {
      sync,
      dispose() {
        unsubscribe();
        doc.removeEventListener('input', onInput);
        if (frame) win.cancelAnimationFrame(frame);
        if (timer) win.clearTimeout(timer);
      },
    };
  }

  function resetForTests() {
    entries.clear();
    listeners.clear();
    inFlight.clear();
  }

  return {
    withDraft, bindRefresh, markStale,
    project, formatPercent, formatTokens, describeLine, breakdownHtml,
    remember, latest, forget, subscribe, refresh, bindComposerFeed, resetForTests,
  };
});
