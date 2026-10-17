/* renderer/chat/renderer-stream-activity-typed.js - what the activity row's typed state reads as, and who hears it change (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamActivityTyped = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || ((k, d, p) => p ? d.replace(/\{(\w+)\}/g, (m, n) => String(p[n] ?? m)) : d);
  /* The activity row (renderer-stream-activity-row.js) owns the tracked entries.
     The timeline sprite reads their typed state (tool-input drafting,
     compaction, a wait) from here instead of from the row's DOM: a frozen
     snapshot per stream, and a callback that fires only when that snapshot's
     tuple changes, never on a heartbeat or an elapsed-time tick. */

  const CHECKLIST_VALUE_MAX_CHARS = 300;
  const CHECKLIST_KEY_MAX_CHARS = 32;
  const JSON_ESCAPES = { n: ' ', r: ' ', t: ' ', b: '', f: '' };

  // Incremental reader for a checklist call's streaming JSON arguments. It
  // carries string/escape state across deltas, so keys and escapes split at
  // any byte, any JSON whitespace, and "content" text inside an item's own
  // value are all read correctly. Each watched key keeps a bounded decoded
  // value (the newest occurrence) and a count of how many values began.
  function createChecklistScanner(watchedKeys) {
    return {
      watched: new Set(watchedKeys),
      inString: false,
      escape: null,
      valueKey: '',
      text: '',
      candidateKey: '',
      pendingValueKey: '',
      counts: Object.create(null),
      values: Object.create(null),
    };
  }

  function appendScannedText(scanner, decoded) {
    if (scanner.valueKey) {
      const current = scanner.values[scanner.valueKey];
      if (current.length < CHECKLIST_VALUE_MAX_CHARS) {
        scanner.values[scanner.valueKey] = (current + decoded).slice(0, CHECKLIST_VALUE_MAX_CHARS);
      }
    } else if (scanner.text.length < CHECKLIST_KEY_MAX_CHARS) {
      scanner.text += decoded;
    }
  }

  function scanEscapeChar(scanner, ch) {
    if (scanner.escape === '') {
      if (ch === 'u') {
        scanner.escape = 'u';
        return;
      }
      scanner.escape = null;
      appendScannedText(scanner, Object.prototype.hasOwnProperty.call(JSON_ESCAPES, ch) ? JSON_ESCAPES[ch] : ch);
      return;
    }
    scanner.escape += ch;
    if (scanner.escape.length < 5) return;
    const code = parseInt(scanner.escape.slice(1), 16);
    scanner.escape = null;
    if (Number.isFinite(code)) appendScannedText(scanner, String.fromCharCode(code));
  }

  function scanStringChar(scanner, ch) {
    if (scanner.escape !== null) {
      scanEscapeChar(scanner, ch);
    } else if (ch === '\\') {
      scanner.escape = '';
    } else if (ch === '"') {
      scanner.inString = false;
      // A finished non-value string is a key only if a colon follows it.
      scanner.candidateKey = scanner.valueKey ? '' : scanner.text;
      scanner.valueKey = '';
    } else {
      appendScannedText(scanner, ch);
    }
  }

  function scanStructuralChar(scanner, ch) {
    if (ch === '"') {
      scanner.inString = true;
      scanner.text = '';
      scanner.valueKey = scanner.pendingValueKey;
      scanner.pendingValueKey = '';
      if (scanner.valueKey) {
        scanner.counts[scanner.valueKey] = (scanner.counts[scanner.valueKey] || 0) + 1;
        scanner.values[scanner.valueKey] = '';
      }
      return;
    }
    if (/\s/.test(ch)) return;
    scanner.pendingValueKey = ch === ':' && scanner.watched.has(scanner.candidateKey) ? scanner.candidateKey : '';
    scanner.candidateKey = '';
  }

  function scanChecklistArguments(scanner, argumentsDelta) {
    for (const ch of String(argumentsDelta || '')) {
      if (scanner.inString) scanStringChar(scanner, ch);
      else scanStructuralChar(scanner, ch);
    }
  }

  function checklistValue(scanner, key) {
    return scanner ? String(scanner.values[key] || '').replace(/\s+/g, ' ').trim() : '';
  }

  function checklistCount(scanner, key) {
    return scanner ? scanner.counts[key] || 0 : 0;
  }

  function normalizeId(value) {
    return String(value == null ? '' : value).trim();
  }

  // The tuple the sprite derives from. Checklist tools name the list work;
  // `waitState` is the waiting line's own classification ('stuck' or not).
  function readTypedActivity(entry) {
    const typed = entry && entry.typed;
    if (!typed) return null;
    return Object.freeze({
      kind: typed.kind,
      toolName: typed.kind === 'tool_input' ? typed.toolName : '',
      checklist: typed.checklist === true,
      waitState: typed.kind === 'waiting' ? typed.waitState : '',
    });
  }

  function typedActivityKey(entry) {
    const activity = readTypedActivity(entry);
    return activity ? [activity.kind, activity.toolName, activity.checklist, activity.waitState].join('\n') : '';
  }

  function createTypedActivityTracker(tracked) {
    const listeners = new Set();
    // entry -> the key its listeners last heard.
    const announced = new WeakMap();

    function announce(streamId, entry, key) {
      if (key) announced.set(entry, key);
      else announced.delete(entry);
      for (const listener of [...listeners]) {
        try { listener({ streamId, sessionId: entry.sessionId }); } catch (_error) { /* affordance only */ }
      }
    }

    return {
      // After an event settled: announce the stream's typed state if it changed.
      sync(streamId) {
        const entry = tracked.get(streamId);
        if (!entry) return;
        const key = typedActivityKey(entry);
        if (key !== (announced.get(entry) || '')) announce(streamId, entry, key);
      },
      // The entry is leaving the tracker: a typed state that was heard ends.
      release(streamId, entry) {
        if (announced.get(entry)) announce(streamId, entry, '');
      },
      queries: {
        getTypedActivity: (streamId) => readTypedActivity(tracked.get(normalizeId(streamId))),
        onTypedActivityChange(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
      },
    };
  }

  function applyPrefill(entry, payload, timestamp) {
    const p = payload.progress;
    if (!p || p.sessionId !== payload.sessionId || p.requestId !== payload.streamId) return false;
    if (p.state === 'start') {
      entry.prefill = { attemptId: p.attemptId, sequence: p.sequence, startedAt: timestamp, closed: false };
      entry.typed = null;
      return true;
    }
    const previous = entry.prefill;
    if (!previous || previous.closed || previous.attemptId !== p.attemptId || p.sequence <= previous.sequence) return true;
    previous.sequence = p.sequence;
    if (p.state !== 'sample' || ![p.total, p.cached, p.processed].every(Number.isSafeInteger)
        || p.cached < 0 || p.processed < p.cached || p.processed > p.total || p.total <= 0 || p.total > 1048576) {
      previous.closed = true;
      entry.typed = null;
      return true;
    }
    entry.typed = { kind: 'prefill', ...p, startedAt: previous.startedAt };
    entry.armed = true;
    return true;
  }

  function renderPrefill(node, typed, timestamp, formatElapsed) {
    const fresh = typed.total - typed.cached;
    const done = typed.processed - typed.cached;
    const locale = node.ownerDocument.documentElement.lang || undefined;
    const count = value => new Intl.NumberFormat(locale).format(value);
    const compact = value => new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
    const name = fresh > 0 ? jt('chat.streamActivity.readingConversation', 'Reading the conversation')
      : jt('chat.streamActivity.reusingTokens', 'Reusing {cached} cached tokens', { cached: count(typed.cached) });
    node.setAttribute('data-prefill-cached', String(fresh === 0));
    node.setAttribute('aria-label', name);
    node.setAttribute('aria-live', 'polite');
    node.setAttribute('aria-atomic', 'false');
    if (node.querySelector('.turn-activity-name').textContent !== name) node.querySelector('.turn-activity-name').textContent = name;
    node.querySelector('.turn-activity-name').hidden = false;
    const label = node.querySelector('.turn-activity-label');
    label.classList.remove('turn-activity-label--path');
    label.setAttribute('aria-live', 'off');
    label.hidden = fresh === 0;
    label.textContent = fresh > 0
      ? jt('chat.streamActivity.prefillTokens', '{done} of {total} new tokens', { done: count(done), total: count(fresh) })
      : jt('chat.streamActivity.reusingTokens', 'Reusing {cached} cached tokens', { cached: count(typed.cached) });
    let reused = node.querySelector('.turn-activity-reused');
    if (!reused) {
      reused = node.ownerDocument.createElement('span');
      reused.className = 'turn-activity-reused';
      reused.setAttribute('aria-live', 'off');
      label.after(reused);
    }
    reused.textContent = fresh > 0 && typed.cached > 0
      ? jt('chat.streamActivity.reusedTokens', '{cached} reused', { cached: compact(typed.cached) }) : '';
    const meta = node.querySelector('.turn-activity-elapsed');
    meta.removeAttribute('data-turn-elapsed');
    meta.setAttribute('aria-live', 'off');
    meta.textContent = `${formatElapsed(timestamp - typed.startedAt)}${fresh > 0 ? ` · ${new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(Math.floor(done / fresh * 100) / 100)}` : ''}`;
    node.style.setProperty('--prefill-cache', String(typed.cached / typed.total));
    node.style.setProperty('--prefill-done', String(typed.processed / typed.total));
  }

  return { createTypedActivityTracker, applyPrefill, renderPrefill,
    createChecklistScanner, scanChecklistArguments, checklistValue, checklistCount };
});
