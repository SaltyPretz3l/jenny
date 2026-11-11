/* renderer/chat/renderer-browser-use-status.js - what the browser panel says (rows 114, 116).
 *
 * Pure: page state in, words out. The status line is always there and keeps its height, so the page under it never
 * moves. Page text never reaches this file; only the address, the title and which step is running do.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBrowserUseStatus = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (...args) => (globalThis.jennyI18n?.t || globalThis.jennyI18nFallback || ((key, fallback, params) =>
    params ? String(fallback).replace(/\{(\w+)\}/g, (match, name) => params[name] ?? match) : fallback))(...args);

  const NETWORK_PROBLEMS = new Set(['private_address', 'internal_name', 'resolves_to_private_address']);

  function stepText(action, target) {
    switch (action) {
      case 'navigate': return target ? jt('browserUse.step.openingSite', 'Opening {target}', { target }) : jt('browserUse.step.opening', 'Opening the page');
      case 'click': return target ? jt('browserUse.step.clickingNamed', 'Clicking "{target}"', { target }) : jt('browserUse.step.clicking', 'Clicking');
      case 'type': return target ? jt('browserUse.step.typingNamed', 'Typing in "{target}"', { target }) : jt('browserUse.step.typing', 'Typing');
      case 'select': return target ? jt('browserUse.step.choosingNamed', 'Choosing in "{target}"', { target }) : jt('browserUse.step.choosing', 'Choosing an option');
      case 'scroll': return jt('browserUse.step.scrolling', 'Scrolling');
      case 'press': return target ? jt('browserUse.step.pressingNamed', 'Pressing {target}', { target }) : jt('browserUse.step.pressing', 'Pressing a key');
      case 'screenshot': return jt('browserUse.step.looking', 'Looking at the page');
      case 'find': return jt('browserUse.step.searching', 'Searching the page');
      default: return jt('browserUse.step.reading', 'Reading the page');
    }
  }

  const signedInWarning = () => jt('browserUse.status.signedIn', "You're signed in here. If you hand back, Jenny can act as you.");
  const networkBlocked = () => jt('browserUse.note.network', "That link goes to a device on your network, which this browser won't open.");

  function noteText(note) {
    switch (note?.kind) {
      case 'blocked_network': return networkBlocked();
      case 'blocked_site': return jt('browserUse.note.site', 'This page tried to open {host}, which Jenny has not been allowed to use.', { host: note.host });
      case 'blocked_link': return jt('browserUse.note.link', "That link can't be opened in this browser.");
      case 'download_off': return jt('browserUse.note.download', 'Jenny can’t download files. To save this one, click it yourself.');
      case 'saved': return jt('browserUse.note.saved', 'Saved {file}', { file: note.file });
      case 'permission':
        if (note.what === 'location') return jt('browserUse.note.location', "This site asked for your location. The browser doesn't share it.");
        if (note.what === 'camera') return jt('browserUse.note.camera', "This site asked for your camera or microphone. The browser doesn't share them.");
        return jt('browserUse.note.notifications', "This site asked to send notifications. The browser doesn't allow them.");
      default: return '';
    }
  }

  /** The words for a refused address, when the address bar is the one refused. */
  function problemText(reason) {
    if (reason === 'not_address') return jt('browserUse.problem.notAddress', 'Type a full web address.');
    if (reason === 'not_web') return jt('browserUse.note.link', "That link can't be opened in this browser.");
    if (NETWORK_PROBLEMS.has(reason)) return networkBlocked();
    if (reason === 'too_many_pages') return jt('browserUse.problem.tooMany', 'Two pages are already open in other chats. Close one and try again.');
    return jt('browserUse.problem.refused', "This browser can't open that address.");
  }

  /** The status line. `view` is what only the renderer knows: whether a turn is running and what it last did. */
  function statusFor(page, view = {}) {
    const quiet = (text) => ({ quiet: true, tone: '', text, end: '' });
    if (view.problem) return { tone: 'note', text: view.problem, end: '' };
    if (page?.open !== true || page.failed || page.crashed) return quiet('');
    if (page.mode === 'user') {
      const text = page.signed_in ? signedInWarning() : page.waiting
        ? jt('browserUse.status.waiting', 'You have the page. Jenny is waiting.') : jt('browserUse.status.held', 'You have the page.');
      return { tone: 'user', text, end: 'back' };
    }
    if (page.asking === true) return { tone: 'ask', text: jt('browserUse.status.asking', 'Waiting for your answer in the chat'), end: 'take' };
    if (page.busy === true) return { tone: 'work', text: stepText(page.action, page.target), end: 'take' };
    // Between steps the model is thinking: dropping to the quiet line here would flash on every step.
    if (view.streaming && view.lastStep) return { tone: 'work', text: view.lastStep, end: 'take' };
    if (page.note) return { tone: 'note', text: noteText(page.note), end: page.note.kind === 'saved' ? 'show' : '' };
    if (view.doneOffer) {
      return { quiet: true, tone: '', text: page.signed_in ? signedInWarning() : jt('browserUse.status.done', 'Done with this page?'), end: 'continue' };
    }
    // Lowest of the notices: a standing fact never hides a question, a hold or a failure.
    if (page.ad_block === false) {
      if (page.ad_block_by === 'model') return { tone: 'note', text: jt('browserUse.status.adBlockOffByJenny', 'Jenny turned ad blocking off for this chat.'), end: '' };
      return quiet(jt('browserUse.status.adBlockOff', 'Ad blocking is off for this chat.'));
    }
    return quiet(String(page.title || ''));
  }

  const privacyLine = () => jt('browserUse.private', 'Private page. Sign-ins and site data are gone when it closes.');

  function hostOf(url) {
    try {
      return new URL(String(url)).hostname;
    } catch (_error) {
      return '';
    }
  }

  /** What stands in for the page when there is no page to show, or null when there is. */
  function pageMessage(page) {
    const gone = () => jt('browserUse.message.signInsGone', 'Anything you were signed in to on it is gone.');
    if (page?.open === true && page.failed) {
      return { title: jt('browserUse.message.failed', "Couldn't reach {host}", { host: hostOf(page.failed) }), body: jt('browserUse.message.failedBody', 'Nothing answered at that address.'), action: 'retry', actionLabel: jt('browserUse.action.retry', 'Try again') };
    }
    if (page?.open === true && page.crashed) {
      return { title: jt('browserUse.message.crashed', 'This page stopped working'), body: gone(), action: 'retry', actionLabel: jt('browserUse.action.reload', 'Reload') };
    }
    if (page?.open === true) return null;
    const reopen = { action: 'retry', actionLabel: jt('browserUse.action.reopen', 'Open it again'), body: gone() };
    switch (page?.closed_reason) {
      case 'idle': return { title: jt('browserUse.message.closedIdle', 'This page closed after sitting unused'), ...reopen };
      case 'evicted': return { title: jt('browserUse.message.closedEvicted', 'This page closed to make room for another chat'), ...reopen };
      case 'crash': return { title: jt('browserUse.message.crashed', 'This page stopped working'), ...reopen };
      case 'user': return { title: jt('browserUse.message.closed', 'This page is closed'), ...reopen };
      default:
        return {
          title: jt('browserUse.message.empty', 'Nothing open yet'),
          body: `${jt('browserUse.message.emptyBody', 'Type an address above, or ask Jenny to open a page.')} ${privacyLine()}`,
          action: '',
          actionLabel: '',
        };
    }
  }

  /** The address split for display: the site stands out, a page without encryption says so. */
  function addressParts(url) {
    const text = String(url || '');
    if (!/^https?:\/\//iu.test(text)) return { secure: true, host: '', rest: '', full: '' };
    try {
      const parsed = new URL(text);
      const rest = `${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}`;
      return { secure: parsed.protocol === 'https:', host: parsed.host.replace(/^www\./u, ''), rest, full: parsed.href };
    } catch (_error) {
      return { secure: false, host: text, rest: '', full: text };
    }
  }

  return { addressParts, noteText, pageMessage, privacyLine, problemText, statusFor, stepText };
});
