/* Team tab: the send queue of a shared conversation (row 171). Whoever may send now (the driver, or anyone when
 * nobody drives) may queue up to three messages while Jenny's turn runs. The host bumps the conversation's revision
 * silently when a turn ends and main learns the new one only from the snapshot it reads after the end event, so a
 * queued message is sent only after a clean `complete` AND the first snapshot after it with no active turn; one per
 * clean turn, because the sent message starts the next turn. Stop, a failure, a takeover or a lost lease pauses the
 * queue ("Not sent"); the member then sends, edits or discards each row by hand. The store is module-level, keyed by
 * team and conversation, so a queue outlives its view while the app runs, like the drafts. `send` is injected: this
 * module makes no host call and wires no DOM event. `footHtml` is the trusted markup of a waiting row's foot. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamProjectQueue = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  // The inventory's button builder: the app's global, or under Node the module at first use (the app's `require` throws).
  let nodeButton;
  const actionButton = (o) => ((globalThis.inventory || 0).actionButton || nodeButton || (nodeButton = require('../inventory/action-button')))(o);

  const CAP = 3; // the shared GPU serves one turn per queued message
  const KEYS = 16; // conversations kept; the least recently used goes
  const FAILS = new Set(['error', 'failed', 'cancelled', 'canceled']);
  const NOTE_MAX = 300;

  // key -> { entries: [{ id, text, state, note }], armed }. Map order is recency: a touched key moves to the end.
  const store = new Map();
  let counter = 0;

  const str = (v) => (typeof v === 'string' ? v : '');
  const notSent = () => jt('team.queue.notSent', 'Not sent');
  const copy = (e) => ({ id: e.id, text: e.text, state: e.state, note: e.note });

  function touch(key) {
    const rec = store.get(key);
    if (!rec) return null;
    store.delete(key);
    store.set(key, rec);
    return rec;
  }
  function open(key) {
    const rec = touch(key);
    if (rec) return rec;
    const made = { entries: [], armed: false };
    store.set(key, made);
    while (store.size > KEYS) store.delete(store.keys().next().value);
    return made;
  }
  function pauseWaiting(rec, alsoSending) {
    for (const e of rec.entries) {
      if (e.state === 'waiting' || (alsoSending && e.state === 'sending')) { e.state = 'paused'; e.note = notSent(); }
    }
  }

  function createQueue({ key, send, errorText, newId } = {}) {
    const k = String(key);
    const makeId = typeof newId === 'function' ? newId : () => 'q' + (counter += 1);
    const sentence = (error) => {
      let text;
      try { text = str(typeof errorText === 'function' ? errorText(error) : ''); } catch { text = ''; }
      return Array.from(text.trim() || notSent()).slice(0, NOTE_MAX).join('');
    };
    let detached = false;
    touch(k);

    const peek = () => store.get(k) || null;
    const find = (rec, id) => (rec ? rec.entries.find((e) => e.id === id) || null : null);
    const remove = (rec, entry) => { rec.entries.splice(rec.entries.indexOf(entry), 1); };

    // The answer applies to the store as it is when it arrives, even after detach; a cleared key ignores it.
    function settle(id, result) {
      const rec = peek();
      const entry = find(rec, id);
      if (!entry) return;
      if (result && result.ok === true) { remove(rec, entry); return; } // posted, even if lost() paused it meanwhile
      if (result === null || result === undefined) {
        if (entry.state === 'sending') { entry.state = 'paused'; entry.note = notSent(); }
        return;
      }
      entry.state = 'failed';
      entry.note = sentence(result.error);
      pauseWaiting(rec, false);
    }
    function dispatch(entry) {
      entry.state = 'sending';
      entry.note = '';
      const id = entry.id;
      return Promise.resolve()
        .then(() => send(entry.text))
        .then((result) => (result === null || result === undefined ? null : result), (error) => ({ ok: false, error }))
        .then((result) => { settle(id, result); return result; });
    }

    return {
      entries() { const rec = peek(); return rec ? rec.entries.map(copy) : []; },
      add(text) {
        if (detached) return { ok: false, reason: 'detached' };
        if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty' };
        const rec = open(k);
        if (rec.entries.length >= CAP) return { ok: false, reason: 'full' };
        const id = String(makeId());
        rec.entries.push({ id, text, state: 'waiting', note: '' });
        return { ok: true, id };
      },
      turnEnded(type) {
        const rec = peek();
        if (detached || !rec) return;
        if (type === 'complete') rec.armed = true;
        else if (FAILS.has(type)) { rec.armed = false; pauseWaiting(rec, false); }
      },
      // Every snapshot with no active turn. Only the first one after a clean end may send, and only one entry.
      idle({ maySend } = {}) {
        const rec = peek();
        if (detached || !rec || !rec.armed) return null;
        rec.armed = false;
        if (!maySend) { pauseWaiting(rec, false); return null; }
        // A paused row waits for its member's hand; the first waiting one behind it goes.
        const first = rec.entries.find((e) => e.state === 'waiting');
        if (!first || rec.entries.some((e) => e.state === 'sending')) return null;
        return dispatch(first);
      },
      // Armed means a turn just ended and its idle snapshot has not come: the revision is stale, so wait for it.
      sendNow(id, { running } = {}) {
        const rec = peek();
        const entry = find(rec, id);
        if (detached || !entry || running !== false || rec.armed || rec.entries.some((e) => e.state === 'sending')) return false;
        return dispatch(entry);
      },
      // A sending entry stays: the host may already hold it.
      edit(id) {
        const rec = peek();
        const entry = find(rec, id);
        if (!entry || entry.state === 'sending') return '';
        remove(rec, entry);
        return entry.text;
      },
      discard(id) {
        const rec = peek();
        const entry = find(rec, id);
        if (!entry || entry.state === 'sending') return false;
        remove(rec, entry);
        return true;
      },
      lost() {
        const rec = peek();
        if (!rec) return;
        rec.armed = false;
        pauseWaiting(rec, true);
      },
      detach() { detached = true; },
      clear() { store.delete(k); },
      counts() { const rec = peek(); return { entries: rec ? rec.entries.length : 0, armed: Boolean(rec && rec.armed) }; },
    };
  }

  function footHtml(entry, { running = false } = {}) {
    if (!entry || typeof entry !== 'object') return '';
    const id = str(entry.id);
    const state = entry.state;
    const words = state === 'waiting' ? jt('team.queue.waits', 'Waits for Jenny’s turn to end')
      : state === 'sending' ? jt('team.queue.sending', 'Sending…')
        : str(entry.note) || notSent();
    const button = (action, label, disabled) => actionButton({ plain: true, className: 'team-foot-btn', label, disabled: Boolean(disabled),
      dataset: { 'project-action': action, 'queue-id': id } });
    const busy = state === 'sending';
    return '<span class="team-queued" dir="auto">' + escapeHtml(words) + '</span>'
      + (state === 'paused' || state === 'failed' ? button('queue-send', jt('team.queue.sendNow', 'Send now'), running) : '')
      + button('queue-edit', jt('team.queue.edit', 'Edit'), busy)
      + button('queue-discard', jt('team.queue.discard', 'Discard'), busy);
  }

  function _reset() { store.clear(); }

  return { createQueue, footHtml, CAP, _reset };
});
