/* Presence reports for the team chat (row 123, slice 2a-5b). The tab's gate
 * starts one with the chat store (after first paint, Team flag on, at least
 * one membership) and stops it with the store.
 *
 * Input in the window (keys, pointer, wheel, touch; passive listeners) keeps
 * this Jenny active. Ten minutes without any reports `idle`; the next input
 * reports `active`. Each connected team hears each transition once
 * (`presenceSet`); a team that is not connected, or that is locked out, hears
 * nothing, and one that connects later hears the current state only when it
 * is `idle` (a connected member starts active). Main holds and dedups as
 * well. A refused report is forgotten, so the next input, transition or store
 * change tells that team again (never on a timer). One timer, re-armed at the
 * idle deadline instead of on every input. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTeamPresence = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const IDLE_MS = 10 * 60 * 1000;
  const EVENTS = Object.freeze(['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart']);
  const LISTEN = Object.freeze({ passive: true, capture: true });

  function createPresence({ windowRef, store }) {
    let state = 'active';
    let lastInput = Date.now();
    let timer = null;
    let stopped = false;
    const told = new Map(); // team id -> the state it last heard (a connected member starts active; null: unknown)

    // Each connected team that has not heard the current state hears it once.
    function tell() {
      const teams = (store.snapshot().teams || []).filter((team) => team && team.state === 'online');
      const listed = new Set(teams.map((team) => team.team_id));
      for (const id of [...told.keys()]) if (!listed.has(id)) told.delete(id);
      for (const team of teams) {
        const id = team.team_id;
        if ((told.has(id) ? told.get(id) : 'active') === state) continue;
        const sent = state;
        told.set(id, sent);
        void store.call('presenceSet', { team_id: id, state: sent }).then((answer) => {
          if (!(answer && answer.ok) && told.get(id) === sent) told.set(id, null);
        });
      }
    }

    function check() {
      timer = null;
      if (stopped) return;
      const quiet = Date.now() - lastInput;
      if (quiet < IDLE_MS) { timer = setTimeout(check, IDLE_MS - quiet); return; }
      if (state !== 'idle') { state = 'idle'; tell(); }
    }

    function onInput() {
      if (stopped) return;
      lastInput = Date.now();
      if (state !== 'active') { state = 'active'; tell(); }
      if (!timer) timer = setTimeout(check, IDLE_MS);
    }

    for (const type of EVENTS) windowRef.addEventListener(type, onInput, LISTEN);
    const unsubscribe = store.subscribe(() => { if (!stopped) tell(); });
    timer = setTimeout(check, IDLE_MS);

    return {
      stop() {
        if (stopped) return;
        stopped = true;
        for (const type of EVENTS) windowRef.removeEventListener(type, onInput, LISTEN);
        clearTimeout(timer);
        timer = null;
        try { unsubscribe(); } catch (_error) { /* best effort */ }
      },
    };
  }

  return { createPresence };
});
