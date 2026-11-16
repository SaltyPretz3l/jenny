/**
 * renderer/features/renderer-sketch-markup.js: "Mark up" under a drawn sketch block
 * (the project board plan section 5.6, slice S8).
 *
 * Lazy action module of the sketch frame host (renderer-sketch-frame-host.js): attach(host) adds a
 * toggle that turns the viewer's drawing mode on and off inside the frame, and answers the questions
 * the viewer asks about the person's marks. A question goes into the message box as plain text and is
 * never sent for the person. The marked-up picture goes with it only when the current model takes
 * pictures, through the composer's own attachment path (renderer-attachment-queue-utils.js, reached
 * as globalThis.rendererComposerPictures). The marks live in the frame and are gone when the block is
 * drawn again. The viewer's own strings (the drawing tools, "Ask about your marks...") are English only.
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSketchMarkup = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const ORDER = 50;
  const PICTURE_ORDER = 51;
  const PICTURE_NAME = 'marked-up-drawing.png';
  // How the viewer opens a question about the marks; ours says it without the engine's name.
  const VIEWER_OPENING = /^I marked up the Sketchy drawing/;
  // 16 px stroke glyph of the approved mockup (the pencil).
  const ICON = '<svg class="markdown-sketch-markup-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.5 2.5 13.5 4.5 5 13 2 13.5 2.5 10.5Z"/><path d="M10 4 12 6"/></svg>';
  let reasonSequence = 0;

  function primitive(globalName, modulePath) {
    return globalThis[globalName] || (typeof require === 'function' ? require(modulePath) : null);
  }

  function pictureBridge() {
    return globalThis.rendererComposerPictures || null;
  }

  /** What the current model takes, as { supported: true | false | null, modelLabel }. null: not known yet, fail open. */
  function normalizeVision(raw) {
    const supported = raw && (raw.supported === true || raw.supported === false) ? raw.supported : null;
    const label = raw && typeof raw.modelLabel === 'string' && raw.modelLabel.trim() ? raw.modelLabel.trim() : jt('markdown.sketch.markupActiveModel', 'The active model');
    return { supported, modelLabel: label };
  }

  function attach(host, deps) {
    const options = deps || {};
    const entries = new Map();
    let detached = false;

    function readVision() {
      try {
        const resolve = options.resolveVision || (pictureBridge() && pictureBridge().resolveVision);
        return normalizeVision(typeof resolve === 'function' ? resolve() : null);
      } catch (_error) {
        return normalizeVision(null);
      }
    }

    function toast(message) {
      try {
        const show = options.showToast || (globalThis.rendererSuggestedChangesHost && globalThis.rendererSuggestedChangesHost.showToastMessage);
        if (typeof show === 'function') show(message, { tone: 'warning' });
      } catch (_error) { /* a toast is best-effort */ }
    }

    function insert(text) {
      try {
        const put = options.insertIntoComposer || (globalThis.rendererComposerInsert && globalThis.rendererComposerInsert.insertIntoComposer);
        return typeof put === 'function' && put({ text }) === true;
      } catch (_error) {
        return false;
      }
    }

    /* ── The controls ── */

    function makeButton(ownerDocument) {
      const make = primitive('inventoryActionButton', '../inventory/action-button');
      if (typeof make !== 'function') return null;
      const template = ownerDocument.createElement('template');
      template.innerHTML = make({
        variant: 'ghost',
        size: 'sm',
        className: 'markdown-sketch-markup',
        dataset: { 'sketch-action': 'markup' },
        ariaPressed: false,
        title: jt('markdown.sketch.markupHint', 'Draw on this picture, then ask Jenny about your marks'),
        trustedHtml: ICON + '<span>' + make.escapeHtml(jt('markdown.sketch.markup', 'Mark up')) + '</span>',
      });
      return template.content.firstElementChild;
    }

    function makePictureControl(ownerDocument, entry) {
      const inventory = primitive('inventoryCheckbox', '../inventory/checkbox');
      if (!inventory || typeof inventory.checkbox !== 'function') return null;
      const template = ownerDocument.createElement('template');
      template.innerHTML = inventory.checkbox({ label: jt('markdown.sketch.attachPicture', 'Attach the picture'), checked: true, className: 'markdown-sketch-picture-box' });
      const holder = ownerDocument.createElement('span');
      holder.className = 'markdown-sketch-picture';
      holder.appendChild(template.content.firstElementChild);
      const reason = ownerDocument.createElement('span');
      reason.id = 'markdown-sketch-picture-reason-' + (++reasonSequence);
      reason.hidden = true;
      holder.appendChild(reason);
      const input = holder.querySelector('input');
      input.addEventListener('change', function () { changePicture(entry, input.checked); });
      return { holder, input, reason, inventory };
    }

    function paintPicture(entry, checked) {
      const control = entry.picture;
      if (!control) return;
      control.input.checked = checked;
      control.inventory.setChecked(control.input, checked);
    }

    /** The picture option follows the model: off and disabled, with the reason, for one that takes no pictures. */
    function syncPicture(entry, vision) {
      const control = entry.picture;
      if (!control) return;
      const blind = vision.supported === false;
      control.input.disabled = blind;
      if (blind) {
        const reason = jt('markdown.sketch.attachPictureNoVision', '{model} does not take pictures, so only the words are sent.', { model: vision.modelLabel });
        control.reason.textContent = reason;
        control.holder.setAttribute('title', reason);
        control.input.setAttribute('title', reason);
        control.input.setAttribute('aria-describedby', control.reason.id);
        entry.wantsPicture = false;
        paintPicture(entry, false);
      } else {
        control.reason.textContent = '';
        control.holder.removeAttribute('title');
        control.input.removeAttribute('title');
        control.input.removeAttribute('aria-describedby');
      }
    }

    function showPicture(entry, vision) {
      if (entry.picture) return;
      const control = makePictureControl(entry.block.ownerDocument, entry);
      if (!control) return;
      entry.picture = control;
      entry.wantsPicture = vision.supported !== false;
      host.addAction(entry.block, control.holder, PICTURE_ORDER);
      paintPicture(entry, entry.wantsPicture);
      syncPicture(entry, vision);
    }

    function hidePicture(entry) {
      if (entry.picture && entry.picture.holder.parentNode) entry.picture.holder.parentNode.removeChild(entry.picture.holder);
      entry.picture = null;
    }

    function setOn(entry, on, vision) {
      entry.on = on;
      entry.button.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) showPicture(entry, vision || readVision());
      else hidePicture(entry);
    }

    function changePicture(entry, wanted) {
      if (!entry.on || !entry.picture) return;
      if (host.post(entry.block, { type: 'markup', on: true, picture: wanted })) {
        entry.wantsPicture = wanted;
        paintPicture(entry, wanted);
      } else {
        paintPicture(entry, entry.wantsPicture);
      }
    }

    function toggle(entry) {
      if (entry.on) {
        if (host.post(entry.block, { type: 'markup', on: false, picture: false })) setOn(entry, false);
        return;
      }
      const vision = readVision();
      if (host.post(entry.block, { type: 'markup', on: true, picture: vision.supported !== false })) setOn(entry, true, vision);
    }

    function drop(block) {
      const entry = entries.get(block);
      if (!entry) return;
      entries.delete(block);
      hidePicture(entry);
      if (entry.button.parentNode) entry.button.parentNode.removeChild(entry.button);
    }

    function drawn(info) {
      const block = info && info.block;
      if (detached || !block) return;
      // A block that left the page (another chat, a re-rendered row) is forgotten, so its nodes can be freed.
      for (const known of Array.from(entries.keys())) { if (known !== block && !known.isConnected) drop(known); }
      drop(block);
      const button = makeButton(block.ownerDocument);
      if (!button) return;
      const entry = { block, button, on: false, picture: null, wantsPicture: false };
      if (!host.addAction(block, button, ORDER)) return;
      button.addEventListener('click', function () { toggle(entry); });
      entries.set(block, entry);
    }

    /* ── What the frame says ── */

    function frameMarkup(block, message) {
      const entry = entries.get(block);
      if (!entry || entry.on === message.on) return;
      if (!message.on) {
        setOn(entry, false);
        return;
      }
      // The viewer's own Draw button: the button follows, and the frame is told whether a picture may go with a question.
      const vision = readVision();
      setOn(entry, true, vision);
      host.post(block, { type: 'markup', on: true, picture: vision.supported !== false });
    }

    function reword(text) {
      return text.replace(VIEWER_OPENING, function () { return jt('markdown.sketch.markupOpening', 'I marked up the drawing'); });
    }

    function decode(base64) {
      const binary = globalThis.atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return bytes;
    }

    function pictureNotAttached(reason) {
      if (reason === 'too_many') return jt('markdown.sketch.pictureLeftOutMany', 'The picture was left out: this message already has the most pictures it can take.');
      if (reason === 'too_large') return jt('markdown.sketch.pictureLeftOutLarge', 'The picture was left out: it is too large to attach.');
      return jt('markdown.sketch.pictureLeftOutFailed', 'The picture was left out: it could not be attached.');
    }

    /** The picture goes through the composer's own attachment path, after the words are in and the frame is answered. */
    async function attachPicture(base64) {
      let reason = 'failed';
      try {
        const attach = options.attachPicture || (pictureBridge() && pictureBridge().attachPicture);
        if (typeof attach === 'function') {
          const result = await attach({ bytes: decode(base64), mimeType: 'image/png', displayName: PICTURE_NAME });
          if (result && result.ok === true) return;
          if (result && typeof result.reason === 'string') reason = result.reason;
        }
      } catch (_error) { /* the words are in; the picture is the part that failed */ }
      toast(pictureNotAttached(reason));
    }

    function ask(block, message) {
      if (detached) return;
      const vision = readVision();
      const entry = entries.get(block);
      if (entry && entry.on && vision.supported === false) syncPicture(entry, vision);
      const inserted = insert(reword(message.text));
      host.post(block, { type: 'ask-result', askId: message.askId, ok: inserted });
      if (!inserted) {
        toast(jt('markdown.sketch.askNoComposer', 'Open a chat to ask about this drawing.'));
        return;
      }
      if (message.pngBase64 && vision.supported !== false) attachPicture(message.pngBase64);
    }

    const stops = [host.onDrawn(drawn), host.onMessage('markup', frameMarkup), host.onMessage('ask', ask)];

    return function detach() {
      if (detached) return;
      detached = true;
      for (const stop of stops) { if (typeof stop === 'function') stop(); }
      for (const entry of Array.from(entries.values())) {
        if (entry.on) host.post(entry.block, { type: 'markup', on: false, picture: false });
        drop(entry.block);
      }
      entries.clear();
    };
  }

  return { attach };
});
