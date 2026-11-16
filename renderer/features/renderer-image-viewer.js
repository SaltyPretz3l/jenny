/* Full-screen, view-only image overlay over one image or a gallery of artifact/source items.
 * Two optional `source` item fields only the Team tab sets (row 123 slice 2c renderer): `caption`, a line shown in
 * place of the pixel size, and `actions` { copy?, 'save-as'? }, functions that run that action for the item (only
 * those are shown; Show in folder stays hidden). Every other caller's items behave as before. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/image-viewer'), require('./renderer-image-selection'), require('../inventory/artifact-figure'), require('./renderer-image-viewer-strip'));
    return;
  }
  root.rendererImageViewer = factory(root.inventoryImageViewer, root.rendererImageSelection, root.inventoryArtifactFigure, root.rendererImageViewerStrip);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inventory, selectionUtils, figure, stripModule) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback
    || ((key, fallback, params) => (params ? fallback.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : fallback));
  const FILE_ACTIONS = new Set(['copy', 'save-as', 'open', 'open-with', 'reveal', 'placeholder-reveal', 'copy-prompt', 'menu-copy-prompt']);
  const IMAGE_SOURCE = /^data:image\/(?:png|jpe?g|webp|gif|bmp);base64,[A-Za-z0-9+/=]+$/;
  const FILE_SOURCE = /^file:\/\/\//;
  const STATUS_MS = 1800;
  const STEP_WAIT_MS = 250; // a gallery step shows the loading note only after this long
  const KEEP_PX = 96; // pan keeps at least this much of the image on the stage
  const CACHE_MAX = 6;
  const withKey = (label, key) => jt('imageViewer.withKey', '{label} ({key})', { label, key });

  function viewerLabels() {
    const labels = {
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
      showInChat: jt('imageViewer.showInChat', 'Show in chat'),
      strip: jt('imageViewer.strip', 'Images in this chat'),
    };
    labels.tips = { in: withKey(labels.zoomIn, '+'), out: withKey(labels.zoomOut, '−'), actual: withKey(labels.actual, '1'), fit: withKey(labels.fit, '0'),
      'rotate-right': withKey(labels.rotateRight, 'R'), details: withKey(labels.details, 'I'), prev: withKey(labels.previous, '←'), next: withKey(labels.next, '→'),
      copy: withKey(labels.copy, 'Ctrl+C'), 'save-as': withKey(labels.saveAs, 'Ctrl+S'), close: withKey(labels.close, 'Esc') };
    return labels;
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
    let epoch = 0; let generation = 0; let disposed = false;
    let items = [];
    let index = 0;
    let detach = [];
    let ready = false; let failed = false; let busy = false;
    let fitMode = true; let zoom = 1; let rotation = 0; let panX = 0; let panY = 0;
    let drag = null;
    let statusTimer = 0; let stepTimer = 0; let frame = 0;
    let painted = false; // an image is showing (kept across a gallery step)
    let canChat = false; let strip = null;
    let stageSize = { width: 0, height: 0 };
    const reads = stripModule.createReadCache((sessionId, artifactId) => options.readArtifact(sessionId, artifactId), CACHE_MAX);
    let editing = false; let detailsOpen = false; let openWith = false;
    const selection = selectionUtils.createSelection();
    let editAvailable = false; let editCapability = false; let editSizes = []; let pngSource = false;

    const current = () => items[index];
    const sourceOk = (src) => typeof src === 'string' && (IMAGE_SOURCE.test(src) || FILE_SOURCE.test(src));
    const artifactSrc = (result) => { const src = result?.asset_data_url || result?.assetDataUrl; return typeof src === 'string' && IMAGE_SOURCE.test(src) ? src : ''; };
    const decodeImage = options.decodeImage || ((src) => stripModule.decodeImage(doc, src));
    const prefetch = () => [items[index - 1], items[index + 1]].filter((item) => item?.kind === 'artifact' && !reads.has(item))
      .forEach((item) => reads.read(item).catch(() => { /* a prefetch failure is silent */ }));
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
      if (action === 'show-in-chat') return canChat;
      if (action === 'open') return !source;
      if (action === 'open-with') return !source && openWith;
      // A file action of an item with its own actions shows only when it has one; every other control keeps its rule.
      if (source && item.actions && FILE_ACTIONS.has(action)) return typeof item.actions[action] === 'function';
      if (action === 'copy' || action === 'save-as' || action === 'reveal') return !source || Boolean(item.ref);
      if (action === 'placeholder-reveal') return failed && (!source || Boolean(item.ref));
      if (action === 'details') return Boolean(item.details);
      if (action === 'copy-prompt' || action === 'menu-copy-prompt') return Boolean(item.details?.prompt && options.copyText);
      if (action === 'actual') return fitMode;
      if (action === 'fit') return !fitMode;
      return true;
    }

    function paintTransform(redraw = true) {
      if (!view) return;
      view.image.style.transform = `translate(-50%, -50%) translate(${panX}px, ${panY}px) rotate(${rotation}deg) scale(${zoom})`;
      view.selectionCanvas.style.transform = view.image.style.transform;
      if (ready && redraw) selectionUtils.draw(view.selectionCanvas, selection.current(), view.image.naturalWidth, view.image.naturalHeight, zoom);
      view.stage.classList.toggle('image-viewer-stage--selecting', selection.mode() !== 'pan');
      view.percent.value = String(Math.round(zoom * 1000) / 10);
    }
    /* A pan drag only moves the transform: one paint per animation frame, flushed when the drag ends. */
    const cancelFrame = () => { if (frame) win.cancelAnimationFrame?.(frame); frame = 0; };
    function schedulePaint() {
      if (frame) return;
      if (win.requestAnimationFrame) frame = win.requestAnimationFrame(() => { frame = 0; paintTransform(false); });
      else paintTransform(false);
    }
    function flushPaint() { if (frame) { cancelFrame(); paintTransform(false); } }

    function paintControls() {
      if (!view) return;
      for (const button of view.buttons) {
        const action = button.dataset.imageViewerAction;
        const free = action === 'close' || action === 'prev' || action === 'next' || action === 'placeholder-reveal' || action === 'show-in-chat';
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
      view.pill.hidden = !(ready || painted);
      if (view.strip) view.strip.hidden = !strip || editing;
      view.viewControls.hidden = editing;
      view.editEntry.hidden = !editAvailable;
      view.editControls.hidden = !(editAvailable && editing);
      view.percent.disabled = !ready;
    }
    function paint() { paintTransform(); paintControls(); }

    function measureStage() {
      const rect = view.stage.getBoundingClientRect();
      stageSize = { width: rect.width, height: rect.height };
    }
    const fitZoom = (width, height) => Math.min(1, Math.max(1, stageSize.width - (items.length > 1 ? 144 : 48)) / width, Math.max(1, stageSize.height - 128) / height);

    function fit() {
      if (!ready) return;
      measureStage();
      const size = dimensions();
      zoom = fitZoom(size.width, size.height);
      panX = panY = 0;
      fitMode = true;
      paint();
    }

    /* Keeps at least min(96 px, the scaled size) of the image on the stage; uses the stored stage size, never a layout read. */
    function clampPan() {
      if (!ready || !stageSize.width || !stageSize.height) return;
      const size = dimensions();
      panX = stripModule.clampPan(panX, stageSize.width, size.width * zoom, KEEP_PX);
      panY = stripModule.clampPan(panY, stageSize.height, size.height * zoom, KEEP_PX);
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
      clampPan();
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
      view.meta.textContent = [typeof item.origin === 'string' ? item.origin : '', typeof item.caption === 'string' && item.caption ? item.caption : size,
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

    const clearStepTimer = () => { if (stepTimer) clearTimer(stepTimer); stepTimer = 0; };

    function close() {
      epoch += 1; generation += 1;
      detach.forEach((remove) => remove());
      detach = [];
      if (statusTimer) clearTimer(statusTimer);
      statusTimer = 0;
      clearStepTimer(); cancelFrame();
      painted = canChat = false;
      strip?.dispose(); strip = null; reads.clear();
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
      const own = current().kind === 'source' && current().actions ? current().actions[action] : null;
      return runGuarded(() => (typeof own === 'function' ? own() : options.onAction(action, { ...current() })), result => {
        if (result?.canceled) status(jt('imageViewer.actionCanceled', 'Canceled.'));
        else if (result?.ok === false || result?.success === false) status(jt('imageViewer.actionFailed', 'Could not complete this image action.'), true);
        else if (action === 'copy') status(jt('imageViewer.copied', 'Image copied'));
        else if (action === 'save-as') status(jt('imageViewer.saved', 'Saved'));
        else if (action === 'reveal') status(jt('imageViewer.revealed', 'Shown in folder'));
        else if (action === 'open' || action === 'open-with') status(jt('imageViewer.opened', 'Opened'));
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
    function goTo(target) {
      if (editing || target < 0 || target >= items.length || target === index) return;
      index = target;
      void load();
    }
    const step = (delta) => goTo(index + delta);
    function act(action) {
      if (action === 'close') { close(); return; }
      if (action === 'show-in-chat') { const copy = { ...current() }; close(); void Promise.resolve().then(() => options.onShowInChat?.(copy)); return; }
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
        else { clampPan(); paint(); }
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
      if ((event.key === 'Home' || event.key === 'End') && !editing && items.length > 1) { event.preventDefault(); goTo(event.key === 'Home' ? 0 : items.length - 1); return; }
      if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && event.target.closest?.('[data-image-viewer-index]')) {
        event.preventDefault(); goTo(index + (event.key === 'ArrowLeft' ? -1 : 1));
        view.strip.querySelector(`[data-image-viewer-index="${index}"]`)?.focus({ preventScroll: true });
        return;
      }
      const direction = { ArrowLeft: [-4, 0], ArrowRight: [4, 0], ArrowUp: [0, -4], ArrowDown: [0, 4] }[event.key];
      const angle = -rotation * Math.PI / 180;
      const imageDirection = direction && [Math.round(direction[0] * Math.cos(angle) - direction[1] * Math.sin(angle)), Math.round(direction[0] * Math.sin(angle) + direction[1] * Math.cos(angle))];
      if (imageDirection && selection.nudge(...imageDirection, event.shiftKey, view.image.naturalWidth, view.image.naturalHeight)) { event.preventDefault(); paint(); return; }
      if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && fitMode && !editing && items.length > 1) {
        event.preventDefault(); act(event.key === 'ArrowLeft' ? 'prev' : 'next'); return;
      }
      const actions = { '+': 'in', '=': 'in', '-': 'out', '0': 'fit', '1': 'actual', f: 'fit', r: 'rotate-right', R: 'rotate-left', i: 'details' };
      const arrows = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] };
      if (actions[event.key]) { event.preventDefault(); act(actions[event.key]); }
      else if (ready && arrows[event.key]) {
        event.preventDefault();
        panX += arrows[event.key][0]; panY += arrows[event.key][1];
        fitMode = false;
        clampPan();
        paint();
      }
    }

    function attachInteractions() {
      listen(view.root, 'click', (event) => {
        const button = event.target.closest('[data-image-viewer-action]');
        const action = button?.dataset.imageViewerAction;
        if (!view.more.hidden && action !== 'more') { setMore(false); if (view.more.contains(button)) control('more').focus(); }
        const thumb = event.target.closest('[data-image-viewer-index]');
        if (button && !button.disabled) act(action);
        else if (thumb) goTo(Number(thumb.dataset.imageViewerIndex));
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
        if (ready && editAvailable && selection.hasRegion()) { event.preventDefault(); showEditMenu(event); }
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
        clampPan();
        if (fitMode) { fitMode = false; paintControls(); }
        schedulePaint();
      });
      const endDrag = (event) => { if (!drag || drag.id !== event.pointerId) return; selection.end(); drag = null; flushPaint(); view?.stage.classList.remove('image-viewer-stage--dragging'); };
      for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(view.stage, event, endDrag);
      if (win.ResizeObserver) {
        const observer = new win.ResizeObserver((entries) => {
          const box = entries?.[0]?.contentRect;
          if (box) stageSize = { width: box.width, height: box.height };
          if (fitMode) fit();
          else { clampPan(); paint(); }
        });
        observer.observe(view.stage);
        detach.push(() => observer.disconnect());
      } else listen(win, 'resize', () => { if (fitMode) fit(); });
    }

    /* `event` places the menu at the pointer, kept inside the stage; without it (keyboard) the stylesheet's corner applies. */
    function showEditMenu(event) {
      if (!editAvailable || !selection.hasRegion()) return;
      const menu = view.menu;
      const rect = view.stage.getBoundingClientRect();
      const place = (offset, room) => `${Math.max(0, Math.min(offset, room))}px`;
      menu.hidden = false;
      for (const [property, value] of [['inset-inline-start', event && place(event.clientX - rect.left, rect.width - menu.offsetWidth)],
        ['inset-block-start', event && place(event.clientY - rect.top, rect.height - menu.offsetHeight)]]) {
        if (value) menu.style.setProperty(property, value);
        else menu.style.removeProperty(property);
      }
      menu.querySelector('button').focus();
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

    /* One path for the first image and every gallery step: the epoch fence drops stale reads and loads. A step keeps the
     * picture on screen until the next one is decoded; only a slow step (250 ms) falls back to the loading note. */
    async function load() {
      const item = current();
      const loadEpoch = ++epoch;
      const stepping = painted;
      clearStepTimer();
      ready = busy = failed = editing = editAvailable = pngSource = false;
      drag = null; selection.clear(true);
      rotation = panX = panY = 0; zoom = 1; fitMode = true;
      canChat = Boolean(item.messageId) && options.canShowInChat?.(item) === true;
      view.menu.hidden = true;
      view.image.onload = view.image.onerror = null;
      view.selectionCanvas.width = view.selectionCanvas.height = 0;
      if (stepping) stepTimer = setTimer(() => { stepTimer = 0; if (loadEpoch === epoch && view) { hideImage(); placeholder('loading'); paintControls(); } }, STEP_WAIT_MS);
      else { hideImage(); placeholder('loading'); }
      view.title.textContent = view.image.alt = item.title || jt('imageViewer.title', 'Image viewer');
      status(''); describe();
      if (stepping) paintControls(); else paint();
      strip?.setCurrent(index);
      if (!view.root.contains(doc.activeElement) || doc.activeElement.disabled) view.stage.focus({ preventScroll: true });
      try {
        let src = item.src;
        if (item.kind === 'source') {
          if (!sourceOk(src)) throw new Error('invalid_image');
        } else {
          const result = await reads.read(item);
          if (loadEpoch !== epoch) return;
          src = artifactSrc(result);
          if (!src) throw new Error('invalid_image');
          pngSource = src.startsWith('data:image/png;base64,');
          view.title.textContent = view.image.alt = result.artifact?.title || result.title || item.title || jt('imageViewer.title', 'Image viewer');
        }
        const size = await decodeImage(src);
        if (loadEpoch !== epoch) return;
        const scaled = size?.width > 0 && size?.height > 0 && stageSize.width > 0;
        if (scaled) zoom = fitZoom(size.width, size.height);
        view.image.onload = () => {
          if (loadEpoch !== epoch) return;
          if (!view.image.naturalWidth || !view.image.naturalHeight) { unavailable(); return; }
          clearStepTimer();
          ready = painted = true;
          updateEligibility();
          view.image.hidden = false;
          placeholder(null); describe();
          fit();
          prefetch();
        };
        view.image.onerror = () => { if (loadEpoch === epoch) unavailable(); };
        // The decoded picture swaps in with this src write; its fit goes out in the same task, so the old picture is never rescaled.
        view.image.src = src;
        if (scaled) paintTransform();
      } catch (_error) { if (loadEpoch === epoch) unavailable(); }
    }

    function hideImage() { view.image.hidden = true; view.image.removeAttribute('src'); painted = false; }

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
      measureStage();
      if (items.length > 1) {
        strip = stripModule.createStrip({ documentRef: doc, container: view.strip, items: items.map((item) => (item.kind !== 'source' || sourceOk(item.src) ? item : { ...item, src: '' })), label: jt('imageViewer.title', 'Image viewer'),
          getThumbnail: (item) => options.getThumbnail?.(item) || '',
          // The current image and its neighbours share the read cache; any other thumbnail reads around it, so it never evicts them.
          readThumbnail: async (item) => artifactSrc(await (reads.has(item) || Math.abs(items.indexOf(item) - index) <= 1
            ? reads.read(item) : options.readArtifact(item.sessionId, item.artifactId))),
          thumbLabel: (title, position, count) => jt('imageViewer.thumbLabel', '{title}, {index} of {count}', { title, index: position, count }),
          createThumb: inventory.createStripThumb });
      }
      view.stage.focus({ preventScroll: true });
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
      clearStepTimer(); hideImage();
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
