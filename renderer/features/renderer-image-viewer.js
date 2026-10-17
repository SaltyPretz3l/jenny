/* Full-screen, view-only image overlay over one image or a gallery of artifact/source items. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/image-viewer'), require('./renderer-image-selection'), require('../inventory/artifact-figure'));
    return;
  }
  root.rendererImageViewer = factory(root.inventoryImageViewer, root.rendererImageSelection, root.inventoryArtifactFigure);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inventory, selectionUtils, figure) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback
    || ((key, fallback, params) => (params ? fallback.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : fallback));
  const FILE_ACTIONS = new Set(['copy', 'save-as', 'open', 'open-with', 'reveal', 'placeholder-reveal', 'copy-prompt', 'menu-copy-prompt']);
  const IMAGE_SOURCE = /^data:image\/(?:png|jpe?g|webp|gif|bmp);base64,[A-Za-z0-9+/=]+$/;
  const FILE_SOURCE = /^file:\/\/\//;
  const STATUS_MS = 1800;

  function viewerLabels() {
    return {
      pan: jt('imageEdit.pan', 'Pan'), box: jt('imageEdit.box', 'Box'), ellipse: jt('imageEdit.ellipse', 'Ellipse'),
      freehand: jt('imageEdit.freehand', 'Freehand'), clearSelection: jt('imageEdit.clear', 'Clear selection'),
      sendEdit: jt('imageEdit.send', 'Send to chat'),
      title: jt('imageViewer.title', 'Image viewer'),
      close: jt('imageViewer.close', 'Close image viewer'),
      stage: jt('imageViewer.stageHint', 'Image. Drag or use arrow keys to pan; use + and − to zoom; double-click to toggle fit.'),
      zoom: jt('imageViewer.zoom', 'Zoom percent'),
      zoomIn: jt('imageViewer.zoomIn', 'Zoom in'),
      zoomOut: jt('imageViewer.zoomOut', 'Zoom out'),
      actual: jt('imageViewer.actual', 'Actual size'),
      fit: jt('imageViewer.fit', 'Fit'),
      rotateLeft: jt('imageViewer.rotateLeft', 'Rotate left'),
      rotateRight: jt('imageViewer.rotateRight', 'Rotate right'),
      reset: jt('imageViewer.resetView', 'Reset view'),
      copy: jt('chat.artifactFigure.copy', 'Copy'),
      saveAs: jt('chat.artifactFigure.saveAs', 'Save as…'),
      open: jt('imageViewer.open', 'Open externally'),
      openWith: jt('imageViewer.openWith', 'Open with…'),
      reveal: jt('chat.artifactFigure.reveal', 'Show in folder'),
      previous: jt('imageViewer.previous', 'Previous image'),
      next: jt('imageViewer.next', 'Next image'),
      details: jt('imageViewer.details', 'Details'),
      more: jt('imageViewer.more', 'More'),
      controls: jt('imageViewer.controls', 'Image controls'),
      editRegion: jt('imageViewer.editRegion', 'Edit region'),
      editHint: jt('imageViewer.editHint', 'Mark the area to change'),
      editCancel: jt('imageViewer.editCancel', 'Cancel'),
      copyPrompt: jt('imageViewer.copyPrompt', 'Copy prompt'),
      promptLabel: jt('imageViewer.promptLabel', 'Prompt'),
      avoidLabel: jt('imageViewer.avoidLabel', 'Avoid'),
    };
  }

  const present = (value) => value !== undefined && value !== null && value !== '';
  const validItem = (item) => Boolean(item) && (item.kind === 'source' ? typeof item.src === 'string'
    : item.kind === 'artifact' && Boolean(item.sessionId && item.artifactId));

  function createImageViewer(options) {
    const doc = options.documentRef || globalThis.document;
    const win = options.windowRef || doc.defaultView;
    const manager = options.overlayManager;
    const setTimer = options.setTimeout || ((callback, ms) => win.setTimeout(callback, ms));
    const clearTimer = options.clearTimeout || ((id) => win.clearTimeout(id));
    let view = null;
    let epoch = 0;
    let generation = 0;
    let disposed = false;
    let items = [];
    let index = 0;
    let detach = [];
    let ready = false;
    let failed = false;
    let busy = false;
    let fitMode = true;
    let zoom = 1;
    let rotation = 0;
    let panX = 0;
    let panY = 0;
    let drag = null;
    let statusTimer = 0;
    let editing = false;
    let detailsOpen = false;
    let openWith = false;
    const selection = selectionUtils.createSelection();
    let editAvailable = false; let editCapability = false; let editSizes = []; let pngSource = false;

    const current = () => items[index];
    const control = (action) => view.buttons.find((button) => button.dataset.imageViewerAction === action);
    function listen(node, type, callback, config) {
      node.addEventListener(type, callback, config);
      detach.push(() => node.removeEventListener(type, callback, config));
    }

    function dimensions() {
      const rotated = rotation % 180 !== 0;
      return { width: rotated ? view.image.naturalHeight : view.image.naturalWidth,
        height: rotated ? view.image.naturalWidth : view.image.naturalHeight };
    }

    function shown(action) {
      const item = current();
      const source = item.kind === 'source';
      if (action === 'prev' || action === 'next') return items.length > 1 && !editing;
      if (action === 'open') return !source;
      if (action === 'open-with') return !source && openWith;
      if (action === 'copy' || action === 'save-as' || action === 'reveal') return !source || Boolean(item.ref);
      if (action === 'placeholder-reveal') return failed && (!source || Boolean(item.ref));
      if (action === 'details') return Boolean(item.details);
      if (action === 'copy-prompt' || action === 'menu-copy-prompt') return Boolean(item.details?.prompt && options.copyText);
      if (action === 'actual') return fitMode;
      if (action === 'fit') return !fitMode;
      return true;
    }

    function paint() {
      if (!view) return;
      view.image.style.transform = `translate(-50%, -50%) translate(${panX}px, ${panY}px) rotate(${rotation}deg) scale(${zoom})`;
      view.selectionCanvas.style.transform = view.image.style.transform;
      if (ready) selectionUtils.draw(view.selectionCanvas, selection.current(), view.image.naturalWidth, view.image.naturalHeight, zoom);
      view.stage.classList.toggle('image-viewer-stage--selecting', selection.mode() !== 'pan');
      view.percent.value = String(Math.round(zoom * 1000) / 10);
      for (const button of view.buttons) {
        const action = button.dataset.imageViewerAction;
        const free = action === 'close' || action === 'prev' || action === 'next' || action === 'placeholder-reveal';
        button.hidden = !shown(action);
        button.disabled = (!free && !ready) || (busy && FILE_ACTIONS.has(action));
        if (action.startsWith('select-')) button.setAttribute('aria-pressed', String(action === 'select-' + selection.mode()));
        if (action.endsWith('send-edit') && (!editAvailable || busy || (selection.mode() !== 'pan' && !selection.hasRegion()))) button.disabled = true;
        if (action === 'in' && zoom >= 8) button.disabled = true;
        if (action === 'out' && zoom <= 0.001) button.disabled = true;
        if (action === 'prev' && index === 0) button.disabled = true;
        if (action === 'next' && index === items.length - 1) button.disabled = true;
      }
      control('details').setAttribute('aria-pressed', String(detailsOpen));
      view.details.hidden = !(detailsOpen && current().details);
      view.pill.hidden = !ready;
      view.viewControls.hidden = editing;
      view.editEntry.hidden = !editAvailable;
      view.editControls.hidden = !(editAvailable && editing);
      view.percent.disabled = !ready;
    }

    function fit() {
      if (!ready) return;
      const size = dimensions();
      const rect = view.stage.getBoundingClientRect();
      const inline = items.length > 1 ? 144 : 48;
      zoom = Math.min(1, Math.max(1, rect.width - inline) / size.width, Math.max(1, rect.height - 128) / size.height);
      panX = panY = 0;
      fitMode = true;
      paint();
    }

    function setZoom(next, point) {
      if (!ready || !Number.isFinite(next)) return;
      const previous = zoom;
      zoom = Math.max(0.001, Math.min(8, next));
      if (point) {
        panX = point.x - (point.x - panX) * zoom / previous;
        panY = point.y - (point.y - panY) * zoom / previous;
      } else {
        panX *= zoom / previous;
        panY *= zoom / previous;
      }
      fitMode = false;
      paint();
    }

    function status(text, error = false) {
      if (!view) return;
      if (statusTimer) clearTimer(statusTimer);
      statusTimer = 0;
      view.status.textContent = text;
      view.status.classList.toggle('image-viewer-status--error', error);
      view.status.classList.remove('image-viewer-status--echo');
      if (text && !error) statusTimer = setTimer(() => { statusTimer = 0; if (view) view.status.textContent = ''; }, STATUS_MS);
    }

    function describe() {
      const item = current();
      const details = item.details || {};
      const size = ready ? `${view.image.naturalWidth} × ${view.image.naturalHeight}` : '';
      view.meta.textContent = [size,
        present(details.seed) ? jt('imageViewer.seedMeta', 'seed {seed}', { seed: details.seed }) : '',
        items.length > 1 ? jt('imageViewer.position', '{index} of {count}', { index: index + 1, count: items.length }) : '',
      ].filter(Boolean).join(' · ');
      inventory.fillDetails(view, { prompt: details.prompt, negativePrompt: details.negativePrompt, rows: figure.detailRows(details, size) });
    }

    function placeholder(state) {
      view.placeholder.hidden = !state;
      view.spinner.hidden = state !== 'loading';
      view.placeholderText.textContent = state === 'loading' ? jt('imageViewer.loading', 'Loading image…')
        : jt('chat.artifactFigure.unavailable', 'Image unavailable');
    }

    function close() {
      epoch += 1; generation += 1;
      detach.forEach((remove) => remove());
      detach = [];
      if (statusTimer) clearTimer(statusTimer);
      statusTimer = 0;
      drag = null; selection.clear(true); editAvailable = editCapability = pngSource = openWith = editing = detailsOpen = false; editSizes = [];
      if (view) {
        view.image.onload = view.image.onerror = null;
        view.image.removeAttribute('src');
        view.selectionCanvas.width = view.selectionCanvas.height = 0;
        manager?.close('imageViewer');
        view.root.remove();
      }
      view = null; items = []; index = 0;
      ready = busy = failed = false;
    }

    async function runGuarded(operation, completed) {
      if (!view || busy) return;
      const actionEpoch = epoch; busy = true;
      status(jt('imageViewer.actionPending', 'Working…')); paint();
      try {
        const result = await operation();
        if (actionEpoch === epoch) completed(result);
      } catch (_error) { if (actionEpoch === epoch) status(jt('imageViewer.actionFailed', 'Could not complete this image action.'), true); }
      finally { if (actionEpoch === epoch) { busy = false; paint(); } }
    }
    function runFileAction(action) {
      return runGuarded(() => options.onAction(action, { ...current() }), result => {
        if (result?.canceled) status(jt('imageViewer.actionCanceled', 'Canceled.'));
        else if (result?.ok === false || result?.success === false) status(jt('imageViewer.actionFailed', 'Could not complete this image action.'), true);
        else if (action === 'copy') status(jt('imageViewer.copied', 'Image copied'));
        else if (action === 'save-as') status(jt('imageViewer.saved', 'Saved'));
        else status(jt('imageViewer.actionComplete', 'Done.'));
      });
    }
    function sendEdit() {
      if (!editAvailable || (selection.mode() !== 'pan' && !selection.hasRegion())) return;
      return runGuarded(() => options.onEdit?.({ ...current(), region: selection.snapshot(), width: view.image.naturalWidth, height: view.image.naturalHeight }), result => {
        if (result && result !== false) { close(); result.focus?.(); }
        else status(jt('imageEdit.draftFailed', 'Open the source chat to add this image to its draft.'), true);
      });
    }
    function setMore(open) {
      view.more.hidden = !open;
      control('more').setAttribute('aria-expanded', String(open));
      if (open) view.more.querySelector('button:not([hidden]):not(:disabled)')?.focus();
    }
    function setEditing(next) {
      if (next && !editAvailable) return;
      const hadFocus = view.editControls.contains(doc.activeElement);
      editing = next; view.menu.hidden = true;
      if (next) selection.choose('box', view.image.naturalWidth, view.image.naturalHeight);
      else selection.clear(true);
      paint();
      if (next) control('select-box').focus();
      else if (hadFocus) control('edit').focus();
    }
    function step(delta) {
      const target = index + delta;
      if (editing || target < 0 || target >= items.length) return;
      index = target;
      void load();
    }
    function act(action) {
      if (action === 'close') { close(); return; }
      if (action === 'prev' || action === 'next') { step(action === 'prev' ? -1 : 1); return; }
      if (action === 'placeholder-reveal') { if (failed) void runFileAction('reveal'); return; }
      if (!ready) return;
      if (view.status.classList.contains('image-viewer-status--error')) status('');
      if (action === 'more') { setMore(view.more.hidden); return; }
      if (action === 'details') { if (current().details) { detailsOpen = !detailsOpen; paint(); } return; }
      if (action === 'edit' || action === 'edit-cancel') { setEditing(action === 'edit'); return; }
      if (action.startsWith('select-') && editAvailable && editing) {
        selection.choose(action.slice(7), view.image.naturalWidth, view.image.naturalHeight);
        status(jt('imageEdit.instructions', 'Draw a region; drag corner handles to resize. Arrow keys move it; Shift+arrows resize. Enter sends to chat. Other details may change.'));
        paint(); return;
      }
      if (action === 'clear-selection') { selection.clear(); paint(); return; }
      if (action === 'send-edit' || action === 'menu-send-edit') { void sendEdit(); return; }
      if (action === 'copy-prompt' || action === 'menu-copy-prompt') {
        const prompt = current().details?.prompt;
        if (prompt && options.copyText) void runGuarded(() => options.copyText(prompt), () => status(jt('imageViewer.promptCopied', 'Prompt copied')));
        return;
      }
      if (FILE_ACTIONS.has(action)) { void runFileAction(action); return; }
      if (action === 'in') setZoom(zoom * 1.25);
      if (action === 'out') setZoom(zoom / 1.25);
      if (action === 'actual') { panX = panY = 0; setZoom(1); }
      if (action === 'fit') fit();
      if (action === 'reset') { rotation = 0; fit(); }
      if (action === 'rotate-left' || action === 'rotate-right') {
        rotation = (rotation + (action === 'rotate-left' ? 270 : 90)) % 360;
        if (fitMode) fit();
        else paint();
      }
    }

    function onKeydown(event) {
      if (event.isComposing || event.target === view.percent) return;
      if (view.more.contains(event.target)) {
        const entries = [...view.more.querySelectorAll('button:not([hidden]):not(:disabled)')];
        const offset = { ArrowDown: 1, ArrowUp: entries.length - 1 }[event.key];
        if (offset) { event.preventDefault(); entries[(entries.indexOf(event.target) + offset) % entries.length].focus(); }
        return;
      }
      if (event.ctrlKey || event.metaKey) {
        const chord = !event.altKey && !event.shiftKey && { c: 'copy', s: 'save-as' }[event.key.toLowerCase()];
        if (!chord || (chord === 'copy' && String(win.getSelection?.() || ''))) return;
        const button = control(chord);
        if (!button.hidden && !button.disabled) { event.preventDefault(); act(chord); }
        return;
      }
      if (event.altKey) return;
      if (event.key === 'Enter' && event.target === view.stage && editAvailable && selection.mode() !== 'pan' && selection.hasRegion()) { event.preventDefault(); void sendEdit(); return; }
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); showEditMenu(); return; }
      const direction = { ArrowLeft: [-4, 0], ArrowRight: [4, 0], ArrowUp: [0, -4], ArrowDown: [0, 4] }[event.key];
      const angle = -rotation * Math.PI / 180;
      const imageDirection = direction && [Math.round(direction[0] * Math.cos(angle) - direction[1] * Math.sin(angle)), Math.round(direction[0] * Math.sin(angle) + direction[1] * Math.cos(angle))];
      if (imageDirection && selection.nudge(...imageDirection, event.shiftKey, view.image.naturalWidth, view.image.naturalHeight)) { event.preventDefault(); paint(); return; }
      if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && fitMode && !editing && items.length > 1) {
        event.preventDefault(); act(event.key === 'ArrowLeft' ? 'prev' : 'next'); return;
      }
      const actions = { '+': 'in', '=': 'in', '-': 'out', '0': 'actual', '1': 'actual', f: 'fit', r: 'reset', i: 'details' };
      const arrows = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] };
      if (actions[event.key]) { event.preventDefault(); act(actions[event.key]); }
      else if (ready && arrows[event.key]) {
        event.preventDefault();
        panX += arrows[event.key][0]; panY += arrows[event.key][1];
        fitMode = false;
        paint();
      }
    }

    function attachInteractions() {
      listen(view.root, 'click', (event) => {
        const button = event.target.closest('[data-image-viewer-action]');
        const action = button?.dataset.imageViewerAction;
        if (!view.more.hidden && action !== 'more') { setMore(false); if (view.more.contains(button)) control('more').focus(); }
        if (button && !button.disabled) act(action);
        else if (!view.menu.contains(event.target)) view.menu.hidden = true;
      });
      listen(view.percent, 'change', () => { const value = view.percent.value.trim(); if (value && Number(value) > 0) setZoom(Number(value) / 100); paint(); });
      listen(view.root, 'keydown', onKeydown);
      const stagePoint = (event) => {
        const rect = view.stage.getBoundingClientRect();
        return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
      };
      listen(view.stage, 'wheel', (event) => {
        if (!ready || !event.deltaY) return;
        event.preventDefault();
        const rect = view.stage.getBoundingClientRect();
        const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
        setZoom(zoom * Math.exp(-Math.max(-500, Math.min(500, delta)) * 0.002), stagePoint(event));
      }, { passive: false });
      listen(view.stage, 'dblclick', (event) => {
        if (!ready || selection.mode() !== 'pan' || event.target.closest('button, input, .image-viewer-pill, .image-viewer-menu')) return;
        if (fitMode) setZoom(1, stagePoint(event));
        else fit();
      });
      const point = (event) => selectionUtils.imagePoint(event.clientX, event.clientY, {
        width: view.image.naturalWidth, height: view.image.naturalHeight, zoom, rotation, panX, panY, rect: view.stage.getBoundingClientRect(),
      });
      listen(view.stage, 'contextmenu', (event) => {
        if (ready && editAvailable && selection.hasRegion()) { event.preventDefault(); showEditMenu(); }
      });
      listen(view.stage, 'pointerdown', (event) => {
        if (!ready || drag || event.button !== 0 || event.target.closest('button, input, .image-viewer-menu, .image-viewer-pill')) return;
        view.menu.hidden = true;
        try { view.stage.setPointerCapture?.(event.pointerId); } catch (_error) { return; }
        event.preventDefault();
        view.stage.focus({ preventScroll: true });
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, selecting: selection.start(point(event), zoom) };
        paint();
        view.stage.classList.add('image-viewer-stage--dragging');
      });
      listen(view.stage, 'pointermove', (event) => {
        if (!drag || drag.id !== event.pointerId) return;
        if (drag.selecting) { selection.move(point(event), event.shiftKey); paint(); return; }
        panX += event.clientX - drag.x; panY += event.clientY - drag.y;
        drag.x = event.clientX; drag.y = event.clientY;
        fitMode = false;
        paint();
      });
      const endDrag = (event) => { if (!drag || drag.id !== event.pointerId) return; selection.end(); drag = null; view?.stage.classList.remove('image-viewer-stage--dragging'); };
      for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(view.stage, event, endDrag);
      if (win.ResizeObserver) {
        const observer = new win.ResizeObserver(() => { if (fitMode) fit(); });
        observer.observe(view.stage);
        detach.push(() => observer.disconnect());
      } else listen(win, 'resize', () => { if (fitMode) fit(); });
    }

    function showEditMenu() {
      if (!editAvailable || !selection.hasRegion()) return;
      view.menu.hidden = false; view.menu.querySelector('button').focus();
    }
    function updateEligibility() {
      editAvailable = ready && editCapability && pngSource && view.image.naturalWidth * view.image.naturalHeight <= 4194304
        && editSizes.includes(`${view.image.naturalWidth}x${view.image.naturalHeight}`);
    }
    function requestClose() {
      if (!view.menu.hidden) { view.menu.hidden = true; view.stage.focus(); }
      else if (!view.more.hidden) { setMore(false); control('more').focus(); }
      else if (editing) setEditing(false);
      else close();
    }

    /* One path for the first image and every gallery step: the epoch fence drops stale reads and loads. */
    async function load() {
      const item = current();
      const loadEpoch = ++epoch;
      ready = busy = failed = editing = editAvailable = pngSource = false;
      drag = null; selection.clear(true);
      rotation = panX = panY = 0; zoom = 1; fitMode = true;
      view.menu.hidden = true;
      view.image.onload = view.image.onerror = null;
      view.image.removeAttribute('src');
      view.image.hidden = true;
      view.selectionCanvas.width = view.selectionCanvas.height = 0;
      view.title.textContent = view.image.alt = item.title || jt('imageViewer.title', 'Image viewer');
      status(''); placeholder('loading'); describe(); paint();
      if (!view.root.contains(doc.activeElement) || doc.activeElement.disabled) view.stage.focus({ preventScroll: true });
      try {
        let src = item.src;
        if (item.kind === 'source') {
          if (typeof src !== 'string' || !(IMAGE_SOURCE.test(src) || FILE_SOURCE.test(src))) throw new Error('invalid_image');
        } else {
          const result = await options.readArtifact(item.sessionId, item.artifactId);
          if (loadEpoch !== epoch) return;
          src = result?.asset_data_url || result?.assetDataUrl;
          if (typeof src !== 'string' || !IMAGE_SOURCE.test(src)) throw new Error('invalid_image');
          pngSource = src.startsWith('data:image/png;base64,');
          view.title.textContent = view.image.alt = result.artifact?.title || result.title || item.title || jt('imageViewer.title', 'Image viewer');
        }
        view.image.onload = () => {
          if (loadEpoch !== epoch) return;
          if (!view.image.naturalWidth || !view.image.naturalHeight) { unavailable(); return; }
          ready = true;
          updateEligibility();
          view.image.hidden = false;
          placeholder(null); describe();
          fit();
        };
        view.image.onerror = () => { if (loadEpoch === epoch) unavailable(); };
        view.image.src = src;
      } catch (_error) { if (loadEpoch === epoch) unavailable(); }
    }

    async function open(request) {
      const list = Array.isArray(request?.items) ? request.items
        : request?.sessionId && request?.artifactId ? [{ kind: 'artifact', sessionId: request.sessionId, artifactId: request.artifactId }] : [];
      if (disposed || !manager || !list.length || !list.every(validItem)) return false;
      close();
      const openGeneration = generation;
      items = list.map((item) => ({ ...item }));
      index = Math.min(items.length - 1, Math.max(0, Math.trunc(Number(request.index) || 0)));
      view = inventory.createView(doc, viewerLabels());
      doc.body.appendChild(view.root);
      manager.open({ id: 'imageViewer', root: view.root, onRequestClose: requestClose,
        restoreFocusTo: request.contextNode, fallbackFocusTo: options.fallbackFocusTo,
        inertTargets: () => [doc.getElementById('appShell')].filter(Boolean) });
      attachInteractions();
      control('close').focus();
      Promise.resolve().then(() => options.getCapabilities?.()).then((capabilities) => {
        if (openGeneration === generation) {
          openWith = capabilities?.openWith === true;
          editCapability = capabilities?.imageEditing === true; editSizes = capabilities?.imageEditSizes || [];
          updateEligibility();
          paint();
        }
      }).catch(() => { /* unsupported remains hidden */ });
      await load();
      return true;
    }

    function unavailable() {
      if (!view) return;
      ready = false; failed = true;
      view.image.hidden = true;
      view.image.removeAttribute('src');
      placeholder('unavailable');
      status(jt('chat.artifactFigure.unavailable', 'Image unavailable'), true);
      view.status.classList.add('image-viewer-status--echo');
      paint();
    }

    function dispose() { close(); disposed = true; }
    return { open, close, dispose };
  }

  return { createImageViewer };
});
