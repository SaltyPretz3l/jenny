'use strict';

/**
 * Main-process action layer for model-driven browsing. Each action validates
 * its arguments, asks the injected consent gate, drives trusted native input
 * through the injected in-page reader, waits for the page to settle and hands
 * back a plain ActionResult the tool layer can serialize as is.
 *
 * Messages are written for the model: short, plain, and free of paths and
 * stack traces. Typed text is never echoed, only its length.
 */

const {
  MAX_TYPE_TEXT_LENGTH,
  PRESS_KEY_CODES,
  normalizePressKey,
} = require('../browser-interaction-utils');
const {
  holdFrameProduction,
  isAbort,
  sendKeyPress,
  throwIfAborted,
  waitForAbortable,
  waitForFreshFrame,
} = require('../browser-session-input');
const { encodePreviewImage } = require('../preview-vision-image');
const { fail } = require('./result-format');
const { MAX_URL_LENGTH, withDefaultScheme } = require('./url-guard');

// One reference, as the outline prints it ([r12]) or bare (r12); spaces around it are ignored.
const REF_PATTERN = /^(?:\[(r[0-9]{1,12})\]|(r[0-9]{1,12}))$/;
const MAX_QUERY_LENGTH = 200;
const HISTORY_WORDS = new Set(['back', 'forward', 'reload']);
const SECRET_SAFE_KEYS = new Set(['Tab', 'Escape']);
const READER_TIMEOUT_MS = 5000;
const PAGE_SCRIPT_TIMEOUT_MS = 1000;
const MAX_LISTED_OPTIONS = 20;
const CLICK_TRIES = 2;
const SHOT_PAINT_CAP_MS = 500;
const SCREEN_ASLEEP_HINT = 'This can happen while the screen is asleep. Try again, or ask the user to wake the screen.';

class InvalidArguments extends Error {}
class PageUnavailable extends Error {}

function brief(value, max = 80) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function createReaderBridge({
  webContents, buildReaderCall, worldId, getGeneration, timeoutMs = READER_TIMEOUT_MS,
}) {
  return {
    call(op, args) {
      const merged = { ...args, generation: getGeneration() };
      return withTimeout(
        webContents.executeJavaScriptInIsolatedWorld(worldId, [{ code: buildReaderCall(op, merged) }]),
        timeoutMs,
        'The page reader timed out.'
      );
    },
  };
}

// ---- argument validation ---------------------------------------------------

function requireRef(value) {
  const match = typeof value === 'string' ? REF_PATTERN.exec(value.trim()) : null;
  if (!match) {
    throw new InvalidArguments('ref must be exactly one reference from the latest page outline, such as r12 (brackets as printed, [r12], are fine).');
  }
  return match[1] || match[2];
}

function requireUrl(value) {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url || url.length > MAX_URL_LENGTH) {
    throw new InvalidArguments(`url must be a full http:// or https:// address of 1 to ${MAX_URL_LENGTH} characters, or one of back, forward, reload.`);
  }
  return withDefaultScheme(url);
}

function requireQuery(value) {
  const query = typeof value === 'string' ? value.trim() : '';
  if (!query || query.length > MAX_QUERY_LENGTH) {
    throw new InvalidArguments(`query must be 1 to ${MAX_QUERY_LENGTH} characters.`);
  }
  return query;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.length > MAX_TYPE_TEXT_LENGTH) {
    throw new InvalidArguments(`${field} must be text of at most ${MAX_TYPE_TEXT_LENGTH} characters.`);
  }
  return value;
}

function oneOf(value, allowed, fallback, field) {
  if (value === undefined) return fallback;
  if (!allowed.includes(value)) throw new InvalidArguments(`${field} must be ${allowed.join(' or ')}.`);
  return value;
}

function optionalRef(value) {
  return value === undefined ? undefined : requireRef(value);
}

function requireKey(value) {
  try {
    return normalizePressKey(value);
  } catch (error) {
    throw new InvalidArguments(error.message);
  }
}

// ---- results ---------------------------------------------------------------

function staleMessage(ref) {
  return `${ref ? `${ref} is` : 'That element is'} no longer on the page. Call read again to get fresh refs.`;
}

// Maps a reader answer that is not "ready" to a model-facing failure.
function notReady(answer, ref) {
  switch (answer?.status) {
    case 'stale':
      return fail('stale_ref', staleMessage(ref));
    case 'changed':
      return fail('element_changed', `${ref} changed since it was read, so nothing was done. Read the page again.`);
    case 'obscured':
      return fail('element_obscured', `${ref} is covered by another element. Dismiss it or scroll, then try again.`,
        brief(answer.by) ? `What covers it: ${brief(answer.by)}.` : '');
    case 'not_visible':
      return fail('not_visible', `${ref} is not visible. Scroll it into view or read the page again.`);
    case 'not_editable':
      return fail('not_editable', `${ref} is not a text field you can type into.`);
    default:
      return fail('unavailable', `${ref} could not be used right now. Read the page again.`);
  }
}

// A search that finds nothing must say whether the page has anything to type into. Without that a model
// cannot tell a missing field from one the outline hides, and goes looking at the page some other way.
function noMatchHint(total, fields) {
  if (total !== 0 || !Number.isFinite(fields)) return '';
  if (fields === 0) return ' This page has no text fields or dropdowns at all, so there is nothing here to type into or submit. Tell the user.';
  return ` This page has ${fields} field${fields === 1 ? '' : 's'} to type or choose in. Find "textbox" or read with scope "full" to list them, including any with no label.`;
}

function describeFailureCode(error) {
  const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,48}$/.test(error.code) ? error.code : '';
  return code || 'unknown error';
}

function createPageActions({ webContents, reader, gate, settler, logger, onTarget, armView, getSound }) {
  const session = { webContents };
  const withSound = (args) => {
    const sound = getSound?.();
    return sound ? { ...args, sound } : args;
  };
  // sendKeyPress and waitForFreshFrame only ever call this one method.
  const frameService = {
    _executePageScript: (_session, script, timeoutMs, message) => withTimeout(
      webContents.executeJavaScript(script), timeoutMs || PAGE_SCRIPT_TIMEOUT_MS, message
    ),
  };

  async function execute(signal, body) {
    const ctx = { humanWaitMs: 0 };
    const stamp = (result) => (ctx.humanWaitMs > 0 ? { ...result, humanWaitMs: ctx.humanWaitMs } : result);
    try {
      throwIfAborted(signal);
      return stamp(await body(ctx));
    } catch (error) {
      if (isAbort(error)) return stamp(fail('cancelled', 'The action was cancelled.'));
      if (error instanceof InvalidArguments) return fail('invalid_arguments', error.message);
      if (error instanceof PageUnavailable) {
        return stamp(fail('page_unavailable', 'The page is not available right now (it may be loading or was replaced). Read the page again.'));
      }
      throw error;
    }
  }

  async function callReader(op, args, signal) {
    try {
      return await waitForAbortable(reader.call(op, args), signal);
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new PageUnavailable();
    }
  }

  // Returns a failure result when the gate says stop, otherwise null.
  async function askGate(ctx, signal, method, ...args) {
    let answer;
    try {
      answer = await waitForAbortable(gate[method](...args), signal);
    } catch (error) {
      if (isAbort(error)) throw error;
      logger?.warn?.(`browser-use gate ${method} failed`);
      return fail('declined', 'The consent check could not run, so the action was not taken.');
    }
    const waited = Number(answer?.humanWaitMs);
    if (Number.isFinite(waited) && waited > 0) ctx.humanWaitMs += waited;
    if (answer?.proceed === true) return null;
    return fail(answer?.status || 'declined', answer?.message || 'The user declined this action.');
  }

  // A page that cannot answer is treated as one that has stopped painting.
  async function paints(capMs) {
    try {
      return (await reader.call('paints', capMs ? { capMs } : {}))?.paints === true;
    } catch (_error) {
      return false;
    }
  }

  // Clicks and keys sent to a window that cannot show the page vanish without an error.
  async function inputBlocked(signal) {
    const ready = await waitForAbortable(Promise.resolve(armView?.({ paints })), signal);
    if (ready !== false) return null;
    return fail('window_hidden', 'The app window is minimized or hidden, so clicks and keys cannot reach the page. Ask the user to bring it back, then try again.');
  }

  async function settle(mode, signal) {
    try {
      await waitForAbortable(settler.waitForSettle({ mode, signal }), signal);
    } catch (error) {
      if (isAbort(error)) throw error;
      // Settling is best effort; the read below shows whatever state the page is in.
    }
  }

  function withBlocked(result) {
    const blocked = gate.takeBlockedNavigation?.();
    if (!blocked) return result;
    const note = blocked.reason === 'download'
      ? 'The page tried to download a file, and downloads are turned off.'
      : `The page tried to open ${brief(blocked.host)} and it was blocked. Use navigate if you want to ask the user about it.`;
    return { ...result, message: `${result.message} ${note}`, blockedNavigation: blocked };
  }

  // A page that reloads itself while loading cancels this load (YouTube does on a first visit). Where it landed is the result.
  function replacedByPage(error, urlBefore) {
    if (error?.code !== 'ERR_ABORTED' || gate.hasBlockedNavigation?.()) return false;
    const urlNow = String(webContents.getURL() || '');
    return urlNow !== '' && urlNow !== urlBefore;
  }

  // Shared tail of every page-changing action, once the page has settled.
  async function reportPage(signal, status, message) {
    const withheld = gate.takeWithheld?.();
    if (withheld) {
      const reason = brief(withheld.reason, 120);
      return withBlocked(fail('withheld', `The page content was withheld${reason ? ` (${reason})` : ''}. It is not shown to you.`));
    }
    let page = null;
    try {
      page = await waitForAbortable(reader.call('read', withSound({ scope: 'viewport' })), signal);
    } catch (error) {
      if (isAbort(error)) throw error;
    }
    if (page && typeof page === 'object') return withBlocked({ ok: true, status, message, page });
    return withBlocked({ ok: true, status, message: `${message} The page could not be read afterwards; call read to see it.` });
  }

  async function finishAction(signal, status, message, mode) {
    await settle(mode, signal);
    return reportPage(signal, status, message);
  }

  async function probeTarget(ref, signal) {
    const probe = await callReader('probe', { ref }, signal);
    if (probe?.status !== 'ready') return { failure: notReady(probe, ref) };
    onTarget?.(probe);
    return { probe };
  }

  // An error here means the page was replaced, which only a press that arrived can have done.
  async function pressLanded(signal) {
    try {
      return (await waitForAbortable(reader.call('pressSeen', {}), signal))?.seen !== false;
    } catch (error) {
      if (isAbort(error)) throw error;
      return true;
    }
  }

  // Confirms the target right before the press, since the ask may have taken minutes. Null once sent.
  async function sendClick(ref, fingerprint, signal) {
    const verified = await callReader('verify', { ref, fingerprint, watchPress: true }, signal);
    if (verified?.status !== 'ready') return notReady(verified, ref);
    const x = Math.round(Number(verified.rect?.centerX));
    const y = Math.round(Number(verified.rect?.centerY));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return notReady({ status: 'not_visible' }, ref);
    throwIfAborted(signal);
    webContents.sendInputEvent({ type: 'mouseMove', x, y });
    webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    return null;
  }

  // Sending again is only safe because the page said nothing arrived. Null once the press has landed.
  async function clickUntilLanded(ref, fingerprint, signal) {
    for (let tries = 0; tries < CLICK_TRIES; tries += 1) {
      const blocked = await inputBlocked(signal);
      if (blocked) return blocked;
      // The first press may have turned up during that touch, and must not get a second.
      if (tries > 0 && await pressLanded(signal)) return null;
      const stopped = await sendClick(ref, fingerprint, signal);
      if (stopped) return stopped;
      await settle('action', signal);
      if (await pressLanded(signal)) return null;
    }
    return fail('input_not_delivered', `The click on ${ref} did not reach the page, so nothing happened there. ${SCREEN_ASLEEP_HINT}`);
  }

  const refusal = (what) => fail('refused', what);

  // ---- actions ----

  async function read(args, { signal } = {}) {
    return execute(signal, async () => {
      const scope = oneOf(args?.scope, ['viewport', 'full'], 'viewport', 'scope');
      const ref = optionalRef(args?.ref);
      const page = await callReader('read', withSound(ref ? { scope, ref } : { scope }), signal);
      if (page?.status === 'stale') return fail('stale_ref', staleMessage(ref));
      return { ok: true, status: 'ok', message: 'Page read.', page };
    });
  }

  async function find(args, { signal } = {}) {
    return execute(signal, async () => {
      const query = requireQuery(args?.query);
      const found = await callReader('find', { query }, signal);
      const matches = Array.isArray(found?.matches) ? found.matches : [];
      const total = Number.isFinite(found?.total) ? found.total : matches.length;
      return { ok: true, status: 'ok', message: `Found ${total} match${total === 1 ? '' : 'es'}.${noMatchHint(total, found?.fields)}`, matches, total };
    });
  }

  async function navigate(args, { signal } = {}) {
    return execute(signal, async (ctx) => {
      const url = requireUrl(args?.url);
      const word = url.toLowerCase();
      if (HISTORY_WORDS.has(word)) {
        if (word === 'reload') {
          webContents.reload();
        } else {
          const history = webContents.navigationHistory;
          const can = word === 'back' ? history?.canGoBack?.() : history?.canGoForward?.();
          if (!can) return fail('no_history', `There is no page to go ${word} to.`);
          if (word === 'back') history.goBack(); else history.goForward();
        }
        return finishAction(signal, 'navigated', word === 'reload' ? 'Reloaded the page.' : `Went ${word}.`, 'navigation');
      }
      const stop = await askGate(ctx, signal, 'beforeNavigate', url);
      if (stop) return stop;
      throwIfAborted(signal);
      // The settle cap bounds this, not loadURL: a page that never finishes
      // loading would otherwise hold the call for the whole consent window.
      let loadError = null;
      const urlBefore = String(webContents.getURL() || '');
      const loading = Promise.resolve(webContents.loadURL(url)).catch((error) => { loadError = error; });
      await settle('navigation', signal);
      // A failure that arrived with the last poll may still be queued.
      await Promise.race([loading, new Promise(setImmediate)]);
      if (loadError && !replacedByPage(loadError, urlBefore)) {
        // A redirect the guard stopped surfaces here as ERR_ABORTED, so say why.
        return withBlocked(fail('load_failed', `The page failed to load (${describeFailureCode(loadError)}).`));
      }
      return reportPage(signal, 'navigated', `Navigated to ${brief(url, 200)}.`);
    });
  }

  async function click(args, { signal } = {}) {
    return execute(signal, async (ctx) => {
      const ref = requireRef(args?.ref);
      const { probe, failure } = await probeTarget(ref, signal);
      if (failure) return failure;
      if (probe.isFileInput) return refusal('File pickers cannot be opened by the model. Ask the user to choose the file.');
      const stop = await askGate(ctx, signal, 'beforeClick', probe);
      if (stop) return stop;
      const unsent = await clickUntilLanded(ref, probe.fingerprint, signal);
      if (unsent) return unsent;
      return reportPage(signal, 'clicked', `Clicked ${ref}.`);
    });
  }

  async function type(args, { signal } = {}) {
    return execute(signal, async (ctx) => {
      const ref = requireRef(args?.ref);
      const text = requireText(args?.text, 'text');
      if (args.submit !== undefined && typeof args.submit !== 'boolean') {
        throw new InvalidArguments('submit must be true or false.');
      }
      const submit = args.submit === true;
      const { probe, failure } = await probeTarget(ref, signal);
      if (failure) return failure;
      if (probe.isFileInput) return refusal('File pickers cannot be filled by the model. Ask the user to choose the file.');
      if (probe.isSecret) return refusal(`${ref} is a password or payment field. The user must fill it in themselves.`);
      if (!probe.isEditable) return notReady({ status: 'not_editable' }, ref);
      const stop = await askGate(ctx, signal, 'beforeType', probe, { submit });
      if (stop) return stop;
      const blocked = submit ? await inputBlocked(signal) : null;
      if (blocked) return blocked;
      const focused = await callReader('focusForTyping', { ref, fingerprint: probe.fingerprint, clear: true }, signal);
      if (focused?.status !== 'ready') return notReady(focused, ref);
      throwIfAborted(signal);
      await waitForAbortable(withTimeout(webContents.insertText(text), READER_TIMEOUT_MS, 'Typing timed out.'), signal);
      if (submit) {
        // Enter goes wherever the focus is by now, which a page can have moved to a field the model may not touch.
        const still = await callReader('focusIs', { ref }, signal);
        if (still?.status !== 'ready') {
          return fail('element_changed', `Typed into ${ref}, but the focus moved before Enter, so Enter was not pressed. Read the page again.`);
        }
        if (await sendKeyPress(frameService, session, signal, PRESS_KEY_CODES.Enter, { withChar: true }) === false) {
          return fail('input_not_delivered', `Typed ${text.length} character${text.length === 1 ? '' : 's'} into ${ref}, but Enter did not reach the page. ${SCREEN_ASLEEP_HINT}`);
        }
      }
      return finishAction(signal, 'typed', `Typed ${text.length} character${text.length === 1 ? '' : 's'} into ${ref}${submit ? ' and pressed Enter' : ''}.`, 'action');
    });
  }

  async function select(args, { signal } = {}) {
    return execute(signal, async (ctx) => {
      const ref = requireRef(args?.ref);
      const value = requireText(args?.value, 'value');
      const { probe, failure } = await probeTarget(ref, signal);
      if (failure) return failure;
      if (probe.isFileInput || probe.isSecret) return refusal(`${ref} cannot be changed by the model.`);
      const stop = await askGate(ctx, signal, 'beforeSelect', probe);
      if (stop) return stop;
      const chosen = await callReader('select', { ref, fingerprint: probe.fingerprint, value }, signal);
      if (chosen?.status === 'no_such_option') {
        const options = (Array.isArray(chosen.options) ? chosen.options : [])
          .slice(0, MAX_LISTED_OPTIONS).map(option => brief(option)).join(', ');
        return fail('no_such_option', `${ref} has no such option.`, `Available options: ${options || 'none'}.`);
      }
      if (chosen?.status === 'not_selectable') return fail('not_selectable', `${ref} is not a menu you can choose from.`);
      if (chosen?.status !== 'selected') return notReady(chosen, ref);
      return finishAction(signal, 'selected', `Selected an option in ${ref}.`, 'action');
    });
  }

  async function scroll(args, { signal } = {}) {
    return execute(signal, async () => {
      const direction = oneOf(args?.direction, ['up', 'down'], 'down', 'direction');
      const ref = optionalRef(args?.ref);
      const scrolled = await callReader('scroll', ref ? { direction, ref } : { direction }, signal);
      if (scrolled?.status !== 'scrolled') return notReady(scrolled, ref);
      const edge = direction === 'down' ? 'the bottom' : 'the top';
      const note = scrolled.atEnd ? ` You have reached ${edge}.` : scrolled.moved === 0 ? ' Nothing moved.' : '';
      return finishAction(signal, 'scrolled', `Scrolled ${direction}.${note}`, 'action');
    });
  }

  async function press(args, { signal } = {}) {
    return execute(signal, async (ctx) => {
      const key = requireKey(args?.key);
      const focusedFacts = async () => {
        const focused = await callReader('probeFocused', {}, signal);
        return focused?.status === 'none' || !focused ? null : focused;
      };
      const facts = await focusedFacts();
      // Refused before asking, so the user is not prompted for a key that
      // could submit or reveal a secret.
      if (facts?.isSecret && !SECRET_SAFE_KEYS.has(key)) {
        return refusal('A password or payment field has focus. Only Tab and Escape are allowed there.');
      }
      const stop = await askGate(ctx, signal, 'beforePress', key, facts);
      if (stop) return stop;
      const blocked = await inputBlocked(signal);
      if (blocked) return blocked;
      // The ask can take minutes, and a key goes wherever the focus is by then.
      if ((await focusedFacts())?.fingerprint !== facts?.fingerprint) {
        return fail('element_changed', 'The focus moved, so the key was not pressed. Read the page again.');
      }
      throwIfAborted(signal);
      if (await sendKeyPress(frameService, session, signal, PRESS_KEY_CODES[key], { withChar: key === 'Enter' || key === 'Space' }) === false) {
        return fail('input_not_delivered', `${key} did not reach the page. ${SCREEN_ASLEEP_HINT}`);
      }
      return finishAction(signal, 'pressed', `Pressed ${key}.`, 'action');
    });
  }

  async function screenshot(_args, { signal } = {}) {
    return execute(signal, async () => {
      let release = () => {};
      try {
        const masked = await callReader('secretMask', { on: true }, signal);
        if (masked?.status !== 'ok') return fail('screenshot_failed', 'The screenshot could not be taken.');
        // After the mask, so whatever wakes the view carries the masked page.
        // Best effort: where it cannot arm, the capture below fails and says so.
        await waitForAbortable(Promise.resolve(armView?.({ paints })), signal);
        release = holdFrameProduction(session);
        await waitForFreshFrame(frameService, session, signal);
        // A frame that cannot be confirmed may predate the mask, and no picture beats a leaked password.
        if (masked.count > 0 && !(await waitForAbortable(paints(SHOT_PAINT_CAP_MS), signal))) {
          return fail('screenshot_failed', `The screen is not updating, so a picture could show a password or card field. ${SCREEN_ASLEEP_HINT}`);
        }
        const capturing = webContents.capturePage(undefined, { stayHidden: true });
        const image = await waitForAbortable(withTimeout(capturing, READER_TIMEOUT_MS, 'The screenshot timed out.'), signal);
        const encoded = encodePreviewImage(image);
        if (!encoded) return fail('screenshot_failed', 'The screenshot could not be encoded.');
        return {
          ok: true,
          status: 'screenshot',
          message: `Screenshot captured (${encoded.width}x${encoded.height}).`,
          image: encoded,
        };
      } catch (error) {
        if (isAbort(error)) throw error;
        return fail('screenshot_failed', 'The screenshot could not be taken.');
      } finally {
        release();
        // Direct call, not abortable: the mask must come off even when cancelled.
        try {
          await reader.call('secretMask', { on: false });
        } catch (_error) {
          logger?.warn?.('browser-use could not remove the secret mask');
        }
      }
    });
  }

  return { navigate, read, find, click, type, select, scroll, press, screenshot };
}

module.exports = { createPageActions, createReaderBridge };
