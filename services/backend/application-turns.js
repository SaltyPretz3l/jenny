'use strict';

// App-started turns nobody typed (row 70 wake, F6 auto-resume). Their persisted user row carries
// `application_turn` like the New session preparation turn (session-handoff-context.js): the
// timeline draws no bubble for it, and Retry/Edit never replay its label as an ordinary prompt.
// Application-authored only: the renderer submission contract has no field that reaches it.
const APPLICATION_TURN_WAKE = 'wake';
const APPLICATION_TURN_AUTO_RESUME = 'auto_resume';
const REQUEST_APPLICATION_TURNS = new Set([APPLICATION_TURN_WAKE, APPLICATION_TURN_AUTO_RESUME]);

// A label marker never decides authority, so an unknown value is dropped, not refused.
function normalizeRequestApplicationTurn(value) {
  return REQUEST_APPLICATION_TURNS.has(value) ? value : '';
}

module.exports = {
  APPLICATION_TURN_AUTO_RESUME,
  APPLICATION_TURN_WAKE,
  normalizeRequestApplicationTurn,
};
