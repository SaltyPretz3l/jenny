'use strict';

/**
 * The browser service's fixed wording and small pure helpers (row 114). Messages
 * are written for the model. Logs carry event names and generic reasons only.
 */

const { fail } = require('./result-format');

const KNOWN_ACTIONS = Object.freeze(['navigate', 'read', 'find', 'click', 'type', 'select', 'scroll', 'press', 'screenshot', 'close', 'ad_block']);
const MAX_TARGET_CHARS = 80;
const noop = () => {};

const MESSAGES = Object.freeze({
  noPage: 'No page is open. Use navigate to open one.',
  paused: 'The user still has the browser and has stopped using it. Stop here and tell them what you were about to do.',
  handedBack: 'The user handed the browser back. Your last step may not have run and the page may have changed, so check the page below and carry on.',
  crashed: 'The page crashed and was reset. Use navigate to open it again. Sign-ins are gone.',
  stepFailed: 'The browser step failed.',
  couldNotStart: 'The browser could not start.',
  unavailable: 'The browser is not available.',
  cancelled: 'The action was cancelled.',
  closed: 'Closed the browser page. Its sign-ins and site data are gone.',
  userHasPage: 'The user has the browser right now, so it was not closed. Ask them to close it or hand it back.',
  adBlockOn: 'Ad blocking is on for this chat. The page reloaded.',
  adBlockOff: 'Ad blocking is off for this chat. The page reloaded. The user can see that you turned it off.',
  adBlockSame: 'Ad blocking was already set that way, so nothing changed.',
  adBlockNeedsValue: 'ad_block needs enabled set to true or false.',
  adBlockUserHas: 'The user has the browser right now, so ad blocking was not changed.',
  unknownAction: `action must be one of ${KNOWN_ACTIONS.join(', ')}.`,
});

// `reason` is what the panel says about a page that is gone; the rest is for the model.
const NOTES = Object.freeze({
  evicted: { status: 'browser_closed', reason: 'evicted', message: 'The browser page was closed to make room for another chat. Use navigate to open a new one. Sign-ins are gone.' },
  idle: { status: 'browser_closed', reason: 'idle', message: 'The browser page was closed because it sat unused. Use navigate to open a new one. Sign-ins are gone.' },
  userClosed: { status: 'browser_closed', reason: 'user', message: 'The user closed the browser page. Do not reopen it unless they ask.' },
  modelClosed: { status: 'browser_closed', reason: 'user', message: 'You closed the browser page. Use navigate to open a new one if the user asks.' },
  finished: { status: 'browser_closed', reason: 'user', message: 'The browser page is already closed: it was closed when this chat reported back, so nothing is left open. Use navigate to open a new one if the user asks.' },
  crashFatal: { status: 'browser_closed', reason: 'crash', message: 'The page crashed and could not be restarted. Use navigate to open a new one. Sign-ins are gone.' },
});

const CLOSED_STATE = Object.freeze({
  open: false,
  mode: 'model',
  url: '',
  title: '',
  loading: false,
  busy: false,
  action: '',
  target: '',
  asking: false,
  waiting: false,
  closed_reason: '',
});

function validBounds(bounds) {
  return Boolean(bounds) && typeof bounds === 'object'
    && ['x', 'y', 'width', 'height'].every((key) => Number.isInteger(bounds[key]))
    && bounds.width > 0 && bounds.height > 0;
}

// What the panel's status line names. A navigate shows the host only: the rest of an address can hold a token.
function targetOf(input) {
  if (input.action === 'press') return String(input.key ?? '').slice(0, MAX_TARGET_CHARS);
  if (input.action !== 'navigate') return '';
  try {
    return new URL(String(input.url)).hostname.slice(0, MAX_TARGET_CHARS);
  } catch (_error) {
    return '';
  }
}

/** Aborts `controller` when `signal` fires, running `onStop` first. Returns the unlink function. */
function linkAbort(signal, controller, onStop) {
  if (!signal) return noop;
  const onAbort = () => {
    try { onStop(); } catch (_error) { /* stopping a page is best effort */ }
    controller.abort();
  };
  signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/** The model's ad_block step. Reloading is the only effect on the page. */
function runAdBlockAction(entry, input) {
  if (typeof input.enabled !== 'boolean') return fail('invalid_arguments', MESSAGES.adBlockNeedsValue);
  if (entry.mode === 'user') return fail('refused', MESSAGES.adBlockUserHas);
  const changed = entry.host.setAdBlock(input.enabled, 'model');
  const status = input.enabled ? 'ad_block_on' : 'ad_block_off';
  if (!changed) return { ok: true, status, message: MESSAGES.adBlockSame };
  return { ok: true, status, message: input.enabled ? MESSAGES.adBlockOn : MESSAGES.adBlockOff };
}

/** One chat's page, or the standard answer that it has none. */
function createEntryLookup(entries) {
  const noPage = () => ({ ok: false, reason: 'no_page' });
  const withEntry = (sessionId, run) => {
    const entry = entries.get(sessionId);
    return entry ? run(entry) : noPage();
  };
  return { noPage, withEntry };
}

module.exports = {
  CLOSED_STATE, KNOWN_ACTIONS, MAX_TARGET_CHARS, MESSAGES, NOTES, createEntryLookup, linkAbort, noop, runAdBlockAction, targetOf, validBounds,
};
