'use strict';

/**
 * What a person can do to a browser page from the panel (row 117): go somewhere,
 * find, zoom, right-click. None of it asks: only the hard refusals apply to a
 * person, and every navigation is marked as theirs before it starts, so a
 * redirect is never judged or reported as the model's.
 */

const { createEntryLookup } = require('./service-support');

const MAX_ADDRESS_CHARS = 4096;
const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?([/?#]|$)/iu;
const HOST_AND_PORT = /^[^/\s:]+:\d+([/?#]|$)/u;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const NAVIGATION_OPS = new Set(['back', 'forward', 'reload', 'stop']);
const ZOOM_CHANGES = new Set(['in', 'out', 'reset']);

/** What the address bar was given, as a URL or the reason it is not one. */
function addressToUrl(text) {
  const typed = String(text ?? '').trim();
  if (!typed || typed.length > MAX_ADDRESS_CHARS || /\s/u.test(typed)) return { problem: 'not_address' };
  let candidate = typed;
  if (!/^https?:\/\//iu.test(typed)) {
    if (HAS_SCHEME.test(typed) && !HOST_AND_PORT.test(typed)) return { problem: 'not_web' };
    const loopback = LOOPBACK_HOST.test(typed);
    if (!loopback && !typed.split(/[/?#:]/u)[0].includes('.')) return { problem: 'not_address' };
    candidate = `${loopback ? 'http' : 'https'}://${typed}`;
  }
  try {
    return { url: new URL(candidate).href };
  } catch (_error) {
    return { problem: 'not_address' };
  }
}

function buildContextMenu(params, { labels, page, writeClipboard }) {
  const flags = params?.editFlags || {};
  const items = [
    { label: labels.back, enabled: page.canGoBack(), click: page.back },
    { label: labels.reload, click: page.reload },
    { type: 'separator' },
  ];
  if (params?.isEditable) items.push({ label: labels.cut, enabled: flags.canCut === true, role: 'cut' });
  items.push({ label: labels.copy, enabled: flags.canCopy === true, role: 'copy' });
  if (params?.isEditable) items.push({ label: labels.paste, enabled: flags.canPaste === true, role: 'paste' });
  items.push({ label: labels.selectAll, role: 'selectAll' });
  const link = String(params?.linkURL || '');
  const hasImage = params?.mediaType === 'image';
  if (link || hasImage) items.push({ type: 'separator' });
  if (link) items.push({ label: labels.copyLink, click: () => writeClipboard?.(link) });
  if (hasImage) items.push({ label: labels.copyImage, click: () => page.copyImageAt(params.x, params.y) });
  return items;
}

const DEFAULT_LABELS = Object.freeze({
  back: 'Back', reload: 'Reload', cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select all', copyLink: 'Copy link address', copyImage: 'Copy image',
});

function createUserControls({
  entries, openForUser, driveByHand, finishByHand, pushCommand, focusApp, canOpen, showMenu, writeClipboard, revealFile, log = () => {},
}) {
  let labels = DEFAULT_LABELS;
  let background = '';

  const { withEntry } = createEntryLookup(entries);

  function goTo(sessionId, text) {
    const { url, problem } = addressToUrl(text);
    if (problem) return { ok: false, reason: problem };
    let entry = entries.get(sessionId);
    if (!entry) {
      if (canOpen?.(sessionId) !== true) return { ok: false, reason: 'browser_unavailable' };
      const opened = openForUser(sessionId, url);
      if (opened.failure) return { ok: false, reason: opened.failure };
      ({ entry } = opened);
    }
    const verdict = entry.urlGuard.classify(url, { kind: 'navigation' });
    if (verdict.allowed !== true) return { ok: false, reason: verdict.reason || 'refused' };
    driveByHand(entry);
    entry.host.loadUrl(url);
    finishByHand(entry);
    return { ok: true };
  }

  function runOp(entry, op) {
    if (op === 'stop') {
      entry.host.stopLoading();
      return;
    }
    driveByHand(entry);
    if (op === 'back') entry.host.goBack();
    else if (op === 'forward') entry.host.goForward();
    else entry.host.reload();
    finishByHand(entry);
  }

  function navigate(sessionId, request) {
    if (typeof request?.url === 'string') return goTo(sessionId, request.url);
    if (!NAVIGATION_OPS.has(request?.op)) return { ok: false, reason: 'invalid_payload' };
    return withEntry(sessionId, (entry) => {
      runOp(entry, request.op);
      return { ok: true };
    });
  }

  function zoom(sessionId, change) {
    if (!ZOOM_CHANGES.has(change)) return { ok: false, reason: 'invalid_payload' };
    return withEntry(sessionId, (entry) => {
      entry.host.zoom(change);
      return { ok: true };
    });
  }

  const find = (sessionId, { text, forward, next }) => withEntry(sessionId, (entry) => {
    entry.host.findText(text, { forward, next });
    return { ok: true };
  });

  const stopFind = (sessionId) => withEntry(sessionId, (entry) => {
    entry.host.stopFind();
    return { ok: true };
  });

  const siteInfo = (sessionId) => withEntry(sessionId, (entry) => ({ ok: true, sites: entry.consent.otherGrantedSites() }));

  const removeSite = (sessionId, site) => withEntry(sessionId, (entry) => ({ ok: entry.consent.removeGrant(site) }));

  function revealDownload(sessionId) {
    return withEntry(sessionId, (entry) => {
      const saved = entry.host.savedPath();
      if (!saved) return { ok: false, reason: 'no_download' };
      revealFile?.(saved);
      return { ok: true };
    });
  }

  function configure(_sessionId, { background: color, labels: nextLabels }) {
    background = color;
    labels = { ...DEFAULT_LABELS, ...nextLabels };
    for (const entry of entries.values()) entry.host.setBackground(color);
    return { ok: true };
  }

  // A new page starts on the app's own background, not white.
  function dress(entry) {
    if (background) entry.host.setBackground(background);
  }

  // A chord pressed inside the page. Find and the address bar belong to the panel, so the keyboard goes there.
  function onChord(entry, chord) {
    if (chord === 'address' || chord === 'find') {
      focusApp();
      pushCommand(entry, chord === 'find' ? 'open_find' : 'focus_address');
      return;
    }
    if (chord === 'zoom_in' || chord === 'zoom_out' || chord === 'zoom_reset') {
      entry.host.zoom(chord.slice('zoom_'.length));
      return;
    }
    runOp(entry, chord);
  }

  function onContextMenu(entry, params) {
    try {
      const { webContents } = entry.host;
      const page = {
        canGoBack: () => Boolean(webContents.navigationHistory?.canGoBack?.()),
        back: () => runOp(entry, 'back'),
        reload: () => runOp(entry, 'reload'),
        copyImageAt: (x, y) => webContents.copyImageAt?.(x, y),
      };
      showMenu?.(buildContextMenu(params, { labels, page, writeClipboard }));
    } catch (_error) {
      log('WARN', 'browser_use.context_menu_failed');
    }
  }

  return { navigate, zoom, find, stopFind, siteInfo, removeSite, revealDownload, configure, dress, onChord, onContextMenu };
}

module.exports = { addressToUrl, buildContextMenu, createUserControls };
