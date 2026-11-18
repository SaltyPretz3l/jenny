/* Team tab: a project conversation's unsent box text (row 175 F6). The text is kept in renderer memory per conversation
 * (the view's `memory` map, at most `cap` kept, the newest last) and on this PC through main (`projectDraftSet`, a
 * local file; never the host). Writes wait `SAVE_MS` behind the last change; Send, a deleted conversation and closing
 * the view write at once. On open the saved text is read once (`projectDraftGet`) and fills the box only while the box
 * is still empty and nothing was typed or kept in memory since: what was typed is never replaced.
 * `createDrafts({ memory, key, cap, call(method, payload), timers })` -> { text, save(text, now), restore(apply),
 * flush, forget, dispose }. `call` answers the bridge's answer or null; a failed call loses nothing here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamProjectDrafts = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SAVE_MS = 500;

  function createDrafts({ memory, key, cap, call, timers }) {
    let timer = null;
    let pending = null; // the text main has not been told yet, or null
    let touched = false;
    let closed = false;
    const remember = (text) => { memory.delete(key); memory.set(key, text); while (memory.size > cap) memory.delete(memory.keys().next().value); };
    const ask = (method, payload) => { try { return Promise.resolve(call(method, payload)).catch(() => null); } catch (_error) { return Promise.resolve(null); } };

    function flush() {
      if (timer !== null) { timers.clear(timer); timer = null; }
      if (pending === null) return;
      const text = pending;
      pending = null;
      void ask('projectDraftSet', { text });
    }

    return {
      text: () => memory.get(key) || '',
      // The box now holds `text`; `now` writes it without the pause (Send emptied the box).
      save(text, now = false) {
        touched = true;
        if (text) remember(text); else memory.delete(key);
        pending = text;
        if (now) { flush(); return; }
        if (timer === null) timer = timers.set(() => { timer = null; flush(); }, SAVE_MS);
      },
      // The text main kept, handed to `apply(text)` once when nothing newer exists.
      async restore(apply) {
        if (memory.has(key)) return;
        const answer = await ask('projectDraftGet', {});
        if (closed || touched || memory.has(key) || !answer || answer.ok !== true || typeof answer.text !== 'string' || !answer.text) return;
        remember(answer.text);
        apply(answer.text);
      },
      flush,
      // The conversation is gone: nothing is kept anywhere.
      forget() { memory.delete(key); pending = ''; touched = true; flush(); },
      dispose() { closed = true; flush(); },
    };
  }

  return { SAVE_MS, createDrafts };
});
