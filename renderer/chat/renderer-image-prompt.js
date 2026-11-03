/* renderer/chat/renderer-image-prompt.js — UMD
 * Row 91: /image arms the composer so the next message is drawn exactly as written.
 * The armed state is kept per chat (like a draft): the size, an optional "same seed"
 * and nothing else; the message text is the prompt. The send path reads it as
 * `imagePromptPin`; main persists it on the user row and the image tool uses it in
 * place of the model's arguments. Edit prompt on a generated image re-arms the
 * composer from that image's provenance. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererImagePrompt = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  // Every family preset offers these sizes (tests/renderer-image-prompt.test.js pins them to config/sdcpp-families.json).
  const SIZES = Object.freeze(['1024x1024', '1344x1344', '1472x1120', '1120x1472', '1664x928', '928x1664', '1600x1056', '1056x1600']);
  const MAX_PROMPT_CHARS = 2000;
  const MAX_SESSIONS = 16;
  const MAX_SEED = 4294967295;
  const COMMAND = /^\/image(?:\s+([\s\S]*))?$/i;
  const TYPED_COMMAND = /^\/image\s/i;
  const ID = /^[a-zA-Z0-9_-]{1,240}$/;
  const IMAGE_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="m2.5 11 3.5-3.5 3 3 2-2 2.5 2.5"/></svg>';

  function sizeKey(width, height) { return `${width}x${height}`; }

  /** The armed options, or null: a supported size, an optional seed and edit source.
   * An edit keeps its source image's size, so an edit pin carries no size at all. */
  function normalizePin(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const edit = value.source_artifact_id !== undefined;
    const width = Number.isInteger(value.width) ? value.width : 1024;
    const height = Number.isInteger(value.height) ? value.height : 1024;
    if (!edit && !SIZES.includes(sizeKey(width, height))) return null;
    const pin = edit ? {} : { width, height };
    if (value.seed !== undefined && value.seed !== null) {
      if (!Number.isInteger(value.seed) || value.seed < 0 || value.seed > MAX_SEED) return null;
      pin.seed = value.seed;
    }
    if (edit) {
      if (typeof value.source_artifact_id !== 'string' || !ID.test(value.source_artifact_id)) return null;
      pin.source_artifact_id = value.source_artifact_id;
      if (value.region && Array.isArray(value.region.points)) {
        pin.region = { kind: value.region.kind, points: value.region.points.map((point) => [point?.[0], point?.[1]]) };
      }
    }
    return pin;
  }

  function pins(state) {
    if (!state || typeof state !== 'object') return null;
    state.ui ||= {};
    if (!(state.ui.imagePromptPins instanceof Map)) state.ui.imagePromptPins = new Map();
    return state.ui.imagePromptPins;
  }

  function sessionKey(sessionId) { return String(sessionId || '').trim(); }

  function peek(state, sessionId) {
    const pin = pins(state)?.get(sessionKey(sessionId));
    return pin ? { ...pin } : null;
  }

  function arm(state, sessionId, pin) {
    const key = sessionKey(sessionId);
    const normalized = normalizePin(pin || {});
    const map = pins(state);
    if (!key || !normalized || !map) return null;
    map.delete(key);
    map.set(key, normalized);
    while (map.size > MAX_SESSIONS) map.delete(map.keys().next().value);
    return { ...normalized };
  }

  function clear(state, sessionId) {
    return Boolean(pins(state)?.delete(sessionKey(sessionId)));
  }

  /** "/image" or "/image words": the words (maybe ''), else null. */
  function splitCommand(text) {
    const match = COMMAND.exec(String(text || '').trim());
    return match ? String(match[1] || '').trim() : null;
  }

  /** The pin a send carries: the armed options plus an attached edit selection. */
  function sendPin(pin, imageEditDraft) {
    const normalized = normalizePin(pin);
    if (!normalized) return null;
    if (!imageEditDraft?.artifactId || !ID.test(imageEditDraft.artifactId)) return normalized;
    return normalizePin({ ...normalized, source_artifact_id: imageEditDraft.artifactId,
      ...(imageEditDraft.region ? { region: imageEditDraft.region } : {}) });
  }

  function chip(options) {
    const render = globalThis.inventoryChip;
    return typeof render === 'function' ? render(options) : '';
  }

  /** The tray chips for an armed composer: the image chip, the size and an optional seed. */
  function chipsHtml(pin) {
    const armed = normalizePin(pin);
    if (!armed) return '';
    const label = jt('composer.imagePrompt.chip', 'Image · drawn as written');
    const size = armed.width ? `${armed.width} × ${armed.height}` : '';
    return chip({ id: 'image-prompt', label, count: '×', iconHtml: IMAGE_ICON, className: 'composer-skill-chip composer-image-prompt-chip',
      ariaLabel: jt('composer.imagePrompt.chipRemoveLabel', 'Image prompt: drawn as written. Remove'),
      title: jt('composer.imagePrompt.chipRemoveTitle', 'Remove image prompt') })
      + (size ? chip({ id: 'image-prompt-size', label: size, count: '▾', hasPopup: true, className: 'composer-image-prompt-option',
        ariaLabel: jt('composer.imagePrompt.sizeLabel', 'Image size: {size}', { size }),
        title: jt('composer.imagePrompt.sizeTitle', 'Image size') }) : '')
      + (armed.seed !== undefined ? chip({ id: 'image-prompt-seed', count: '×', className: 'composer-image-prompt-option',
        label: jt('composer.imagePrompt.seed', 'Same seed {seed}', { seed: armed.seed }),
        ariaLabel: jt('composer.imagePrompt.seedRemoveLabel', 'Same seed {seed}. Remove', { seed: armed.seed }),
        title: jt('composer.imagePrompt.seedRemoveTitle', 'Remove to draw with a new seed') }) : '');
  }

  /** Wire the chips a tray just rendered. `rerender` repaints that tray. */
  function bindChips(tray, { state, sessionId, rerender, focusInput }) {
    if (!tray?.querySelector) return;
    tray.querySelector('[data-inv-chip="image-prompt"]')?.addEventListener('click', () => {
      if (clear(state, sessionId)) { rerender(); focusInput?.(); }
    });
    tray.querySelector('[data-inv-chip="image-prompt-seed"]')?.addEventListener('click', () => {
      const pin = peek(state, sessionId);
      if (!pin) return;
      delete pin.seed;
      arm(state, sessionId, pin);
      rerender();
    });
    const sizeChip = tray.querySelector('[data-inv-chip="image-prompt-size"]');
    sizeChip?.addEventListener('click', () => openSizeMenu(sizeChip, { state, sessionId, rerender }));
  }

  function openSizeMenu(anchor, { state, sessionId, rerender }) {
    const menu = globalThis.inventoryContextMenu;
    const pin = peek(state, sessionId);
    if (!pin || typeof menu?.show !== 'function') return;
    if (anchor.getAttribute('aria-expanded') === 'true') { menu.hide(); return; }
    const current = sizeKey(pin.width, pin.height);
    anchor.setAttribute('aria-expanded', 'true');
    menu.show({
      anchorEl: anchor, placement: 'above', restoreFocusTo: anchor, focusChecked: true,
      heading: jt('composer.imagePrompt.sizeTitle', 'Image size'),
      onHide: () => anchor.setAttribute('aria-expanded', 'false'),
      items: SIZES.map((size) => {
        const [width, height] = size.split('x').map(Number);
        return { label: `${width} × ${height}`, checked: size === current, value: size,
          action: () => { arm(state, sessionId, { ...peek(state, sessionId), width, height }); rerender(); } };
      }),
    });
  }

  /**
   * The composer side for one chat surface. `getInput(sessionId)` finds the composer
   * that shows a chat (null when none does); `repaint(sessionId)` redraws its tray.
   */
  function createController({ state, getInput, repaint, syncInput, setNotice, log } = {}) {
    const noop = () => {};
    const syncComposer = typeof syncInput === 'function' ? syncInput : noop;
    const notify = typeof setNotice === 'function' ? setNotice : noop;
    const clientLog = typeof log === 'function' ? log : noop;
    // Replaced through insertText where the browser has it, so one Ctrl+Z brings an unsent draft back.
    function setInput(input, text) {
      input.focus?.();
      input.select?.();
      let inserted;
      try { inserted = input.ownerDocument?.execCommand?.('insertText', false, text) === true; } catch (_error) { inserted = false; }
      if (!inserted || input.value !== text) input.value = text;
      input.setSelectionRange?.(text.length, text.length);
      syncComposer(input);
    }
    /** Edit prompt: the image's prompt, size and seed back in its chat's composer. */
    function editPrompt({ sessionId, prompt, width, height, seed }) {
      const input = typeof getInput === 'function' ? getInput(sessionId) : null;
      const text = String(prompt || '').slice(0, MAX_PROMPT_CHARS);
      if (!input || !text) return false;
      const size = SIZES.includes(sizeKey(width, height)) ? { width, height } : {};
      if (!arm(state, sessionId, { ...size, ...(Number.isInteger(seed) ? { seed } : {}) })) return false;
      setInput(input, text);
      repaint?.(sessionId);
      clientLog('INFO', 'image_prompt.edit_armed', { sessionId, chars: text.length, keepsSeed: Number.isInteger(seed) });
      return true;
    }
    /** A /image reply that drew nothing: the prompt goes back, armed again. */
    function restoreUndrawn({ sessionId, prompt, pin }) {
      const input = typeof getInput === 'function' ? getInput(sessionId) : null;
      if (!input || String(input.value || '').trim()) return false;
      if (!arm(state, sessionId, pin || {})) return false;
      setInput(input, String(prompt || ''));
      repaint?.(sessionId);
      notify(sessionId, jt('composer.imagePrompt.notDrawn', 'Jenny replied without drawing. Your prompt is back here; send it again to draw it.'));
      clientLog('INFO', 'image_prompt.not_drawn_restored', { sessionId });
      return true;
    }
    /** Main marks a finished /image turn that drew nothing (`imagePromptUndrawn`). */
    function onTerminal(event) {
      if (event?.kind !== 'complete' || event.payload?.imagePromptUndrawn !== true) return false;
      const sessionId = sessionKey(event.payload.sessionId);
      const messages = state?.messagesBySession?.get?.(sessionId);
      const row = Array.isArray(messages)
        ? [...messages].reverse().find((message) => message?.role === 'user' && message.image_prompt_pin) : null;
      if (!row || !String(row.content || '').trim()) return false;
      return restoreUndrawn({ sessionId, prompt: row.content, pin: row.image_prompt_pin });
    }
    return { editPrompt, restoreUndrawn, onTerminal };
  }

  return {
    SIZES, MAX_PROMPT_CHARS, TYPED_COMMAND, IMAGE_ICON,
    normalizePin, peek, arm, clear, splitCommand, sendPin, chipsHtml, bindChips, createController,
  };
});
