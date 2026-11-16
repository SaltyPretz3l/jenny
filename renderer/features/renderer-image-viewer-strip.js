/* Filmstrip under the image viewer's stage: one small button per gallery image, the current one marked. The viewer owns
 * navigation (it listens for clicks and arrows on the `data-image-viewer-index` buttons); this module only builds the
 * buttons and fills their pictures, lazily for artifacts that are not cached. It also holds the viewer's small pure
 * helpers (read cache, pan clamp, off-screen decode) so the viewer file stays under its size ceiling. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.rendererImageViewerStrip = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* options: documentRef, container (the empty strip element), items (viewer items; a source item's `src` must already be
   * a displayable URL), getThumbnail(item) -> '' | URL, readThumbnail(item) -> Promise<'' | URL>, label (fallback title),
   * thumbLabel(title, position, count) -> accessible name, createThumb(documentRef, { index, title, label }) -> { button, image }. */
  function createStrip({ documentRef, container, items, getThumbnail, readThumbnail, label, thumbLabel, createThumb }) {
    const win = documentRef.defaultView;
    const buttons = [];
    let observer = null;
    let disposed = false;

    function fill(image, src) {
      if (!disposed && src) image.setAttribute('src', src);
    }
    // Reads of uncached thumbnails, two at a time, so a long chat never floods the main process.
    const queue = [];
    let running = 0;
    function pump() {
      while (!disposed && running < 2 && queue.length) {
        const { item, image } = queue.shift();
        running += 1;
        Promise.resolve().then(() => readThumbnail(item)).then((src) => fill(image, src), () => { /* no picture */ })
          .finally(() => { running -= 1; pump(); });
      }
    }
    function load(item, image) { queue.push({ item, image }); pump(); }

    const lazy = [];
    const show = (entry) => (entry.known ? fill(entry.image, entry.known) : load(entry.item, entry.image));
    items.forEach((item, index) => {
      const title = item.title || label;
      const { button, image } = createThumb(documentRef, { index, title, label: thumbLabel(title, index + 1, items.length) });
      buttons.push(button);
      const known = item.kind === 'source' ? item.src : getThumbnail?.(item);
      if (typeof known === 'string' && known) lazy.push({ item, image, button, known });
      else if (item.kind !== 'source') lazy.push({ item, image, button }); // a source without a showable src stays empty
    });
    container.replaceChildren(...buttons);

    if (lazy.length) {
      if (win?.IntersectionObserver) {
        const byButton = new Map(lazy.map((entry) => [entry.button, entry]));
        observer = new win.IntersectionObserver((entries) => {
          for (const entry of entries) {
            const target = byButton.get(entry.target);
            if (!entry.isIntersecting || !target) continue;
            byButton.delete(entry.target);
            observer?.unobserve(entry.target);
            show(target);
          }
        }, { root: container, rootMargin: '0px 200px' });
        for (const entry of lazy) observer.observe(entry.button);
      } else for (const entry of lazy) show(entry);
    }

    function setCurrent(index) {
      buttons.forEach((button, position) => {
        if (position === index) button.setAttribute('aria-current', 'true');
        else button.removeAttribute('aria-current');
      });
      const current = buttons[index];
      if (current && typeof current.scrollIntoView === 'function') current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    function dispose() {
      disposed = true;
      observer?.disconnect();
      observer = null;
      container.replaceChildren();
    }

    return { setCurrent, dispose };
  }

  /* Reads of artifact images, least recently used first and shared by the viewer, its prefetch and the strip. The entries are
   * promises, so two callers of one image share one read; a failed or empty read is dropped so a later call tries again. */
  function createReadCache(read, max) {
    const entries = new Map();
    const keyOf = (item) => `${item.sessionId}:${item.artifactId}`;
    return {
      has: (item) => entries.has(keyOf(item)),
      clear: () => entries.clear(),
      read(item) {
        const key = keyOf(item);
        let entry = entries.get(key);
        if (entry) { entries.delete(key); entries.set(key, entry); return entry; }
        try { entry = Promise.resolve(read(item.sessionId, item.artifactId)); } catch (error) { entry = Promise.reject(error); }
        entries.set(key, entry);
        while (entries.size > max) entries.delete(entries.keys().next().value);
        const drop = () => { if (entries.get(key) === entry) entries.delete(key); };
        entry.then((result) => { if (!(result?.asset_data_url || result?.assetDataUrl)) drop(); }, drop);
        return entry;
      },
    };
  }

  /* One axis of the pan limit: at least min(keep, extent) px of the image stays inside a stage of `stage` px. */
  function clampPan(pan, stage, extent, keep) {
    const limit = Math.max(0, stage / 2 + extent / 2 - Math.min(keep, extent));
    return Math.max(-limit, Math.min(limit, pan));
  }

  /* Decodes `src` off screen so the viewer can swap pictures without a blank frame; null when the browser cannot. */
  async function decodeImage(documentRef, src) {
    const image = documentRef.createElement('img');
    if (typeof image.decode !== 'function') return null;
    image.src = src;
    try { await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight }; } catch (_error) { return null; }
  }

  return { createStrip, createReadCache, clampPan, decodeImage };
});
