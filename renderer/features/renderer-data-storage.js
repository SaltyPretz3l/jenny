/* renderer/features/renderer-data-storage.js
 *
 * Settings > Profile, data & updates > "Your data" (row 95): what Jenny keeps on
 * this PC, largest first, with one action per row. The renderer sends category
 * ids, the preview token and the typed count to window.jennyShell.dataLifecycle
 * and nothing else; main resolves every path, and `locationDisplay` is display
 * text only. A clear always goes preview -> confirm modal -> clearCategory with
 * the token, then one quiet status line and a re-measure. No toast.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererDataStorage = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  const MODAL_ID = 'data-storage-clear';
  const MEASURE_ALL = '*';
  const MIN_SHARE = 2;

  // Fixed id order is the tie-break for equal sizes; the list itself sorts by bytes.
  const CATEGORY_ORDER = ['chats', 'artifacts', 'logs', 'caches', 'leftovers', 'engines', 'personal'];
  function categoryCopy(id) {
    switch (id) {
      case 'chats': return { title: jt('dataStorage.chats.title', 'Chats & attachments'), help: jt('dataStorage.chats.help', 'Your chats, their attachments and history.'), noun: jt('dataStorage.chats.noun', 'chats') };
      case 'artifacts': return { title: jt('dataStorage.artifacts.title', 'Artifacts & generated images'), help: jt('dataStorage.artifacts.help', 'Files Jenny made for chats in this project.'), noun: jt('dataStorage.artifacts.noun', 'artifacts & generated images') };
      case 'logs': return { title: jt('dataStorage.logs.title', 'Logs & diagnostics'), help: jt('dataStorage.logs.help', 'Kept 30 days to help fix problems. Clearing is safe.'), noun: jt('dataStorage.logs.noun', 'logs & diagnostics') };
      case 'caches': return { title: jt('dataStorage.caches.title', 'Caches'), help: jt('dataStorage.caches.help', 'Rebuilt automatically. Clearing can make the next start a little slower.'), noun: jt('dataStorage.caches.noun', 'caches') };
      case 'leftovers': return { title: jt('dataStorage.leftovers.title', 'Leftovers'), help: jt('dataStorage.leftovers.help', 'Copies kept by Reset, damaged files set aside, crash temp files.'), noun: jt('dataStorage.leftovers.noun', 'leftovers') };
      case 'engines': return { title: jt('dataStorage.engines.title', 'Engines & models'), help: jt('dataStorage.engines.help', 'Downloaded engines and models. Shared Ollama models are not counted.'), noun: jt('dataStorage.engines.noun', 'engines & models') };
      case 'personal': return { title: jt('dataStorage.personal.title', 'Settings & personal'), help: jt('dataStorage.personal.help', 'Preferences, personality, notes and calendar. Kept until you uninstall.'), noun: jt('dataStorage.personal.noun', 'settings & personal data') };
      default: return null;
    }
  }

  function wholeNumber(value) {
    return Math.max(0, Math.floor(Number(value) || 0));
  }
  function localeCount(count) {
    return count.toLocaleString(globalThis.jennyI18n?.tag?.());
  }
  function fileCount(value) {
    const count = wholeNumber(value);
    return jtn('dataStorage.fileCount', count, { count: localeCount(count) }, '{count} file', '{count} files');
  }

  // [{id,bytes,files,clearable,available,partial,locationDisplay}] largest first; unknown ids are dropped.
  function normalizeUsage(result) {
    if (!result || result.ok !== true || !Array.isArray(result.categories)) return null;
    const rows = result.categories
      .filter((entry) => entry && CATEGORY_ORDER.includes(String(entry.id)))
      .map((entry) => ({
        id: String(entry.id),
        bytes: Math.max(0, Number(entry.bytes) || 0),
        files: wholeNumber(entry.files),
        clearable: entry.clearable === true,
        available: entry.available !== false,
        partial: entry.partial === true,
        locationDisplay: String(entry.locationDisplay || ''),
      }));
    rows.sort((a, b) => (b.bytes - a.bytes) || (CATEGORY_ORDER.indexOf(a.id) - CATEGORY_ORDER.indexOf(b.id)));
    const reported = result.totalBytes == null ? NaN : Number(result.totalBytes); // a partial re-measure reports null
    const totalBytes = Number.isFinite(reported) && reported >= 0 ? reported : rows.reduce((sum, row) => sum + row.bytes, 0);
    return { categories: rows, totalBytes, partial: rows.some((row) => row.partial) };
  }

  // A re-measure of some categories (`next` from a categoryIds request) replaces just those rows of the last full result; a main that
  // answered with every category anyway simply wins. The total is summed here because main reports it as null for a partial answer.
  function mergeUsage(previous, next, ids) {
    if (!previous || previous.categories.every((row) => next.categories.some((fresh) => fresh.id === row.id))) return next;
    const rows = previous.categories.map((row) => (ids.includes(row.id) && next.categories.find((fresh) => fresh.id === row.id)) || row);
    rows.sort((a, b) => (b.bytes - a.bytes) || (CATEGORY_ORDER.indexOf(a.id) - CATEGORY_ORDER.indexOf(b.id)));
    return { categories: rows, totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0), partial: rows.some((row) => row.partial) };
  }

  function resolve(name, windowRef, modulePath) {
    if (windowRef && windowRef[name]) return windowRef[name];
    if (typeof require === 'function') {
      try { return require(modulePath); } catch (_error) { /* not available in this shell */ }
    }
    return null;
  }

  function createDataStorageController(deps) {
    const {
      windowRef,
      documentRef = windowRef && windowRef.document,
      state,
      appendClientLog = () => {},
      openSettingsSection = () => {},
      refreshSessions = () => {},
      overlayManager = null,
    } = deps || {};
    const doc = documentRef;
    const api = () => (windowRef && windowRef.jennyShell && windowRef.jennyShell.dataLifecycle) || null;
    const prim = {
      field: () => resolve('inventorySettingsField', windowRef, '../inventory/settings-field'),
      button: () => resolve('inventoryActionButton', windowRef, '../inventory/action-button'),
      text: () => resolve('inventoryTextField', windowRef, '../inventory/text-field'),
      progress: () => resolve('inventoryProgressBar', windowRef, '../inventory/progress-bar'),
      modal: () => resolve('inventoryStepModal', windowRef, '../inventory/step-modal'),
      utils: () => resolve('dataLifecycleUtils', windowRef, './renderer-data-lifecycle-utils'),
    };
    const log = (level, event, details) => { try { appendClientLog(level, event, details); } catch (_error) { /* diagnostics only */ } };
    const formatBytes = (bytes) => (prim.utils()?.formatBytes || ((value) => String(value) + ' B'))(bytes);

    let usage = null; // normalized getStorageUsage result
    let measuring = new Set(); // category ids (or MEASURE_ALL) whose size is being measured
    let loadFailed = false;
    let status = null; // { tone: 'ok'|'warn', text }
    let busy = false; // a preview or a clear is running
    let generation = 0; // drops a measure that a newer one replaced
    let wasVisible = false;
    let disposed = false;
    let pendingFocus = '';
    let modal = null; // { node, lifecycle, running, categoryId }
    let skeleton = null; // the mounted frame: total line, rows host, status line
    const cleanups = [];

    const group = () => doc.getElementById('dataStorageGroup');
    // The group's own card: the Settings nav button carries the same data-settings-section, so never query by it.
    const card = () => { const el = group(); return (el && el.closest('.settings-card')) || null; };
    const mount = () => doc.getElementById('dataStorageMount');
    const isEnabled = () => state?.features?.featureFlags?.data_usage_page !== false
      && typeof api()?.getStorageUsage === 'function' && Boolean(prim.field() && prim.button());

    // ── Rendering ────────────────────────────────────────────────────────────
    function ensureFrame() {
      const host = mount();
      if (!host) return null;
      if (skeleton && skeleton.host === host && host.contains(skeleton.rows)) return skeleton;
      // The status line is a live region: it exists before its text does.
      host.innerHTML = '<p class="data-storage-total" data-storage-total></p>'
        + '<div class="data-storage-rows" data-storage-rows></div>'
        + '<p class="data-storage-status" data-storage-status role="status" hidden></p>';
      skeleton = {
        host,
        total: host.querySelector('[data-storage-total]'),
        rows: host.querySelector('[data-storage-rows]'),
        status: host.querySelector('[data-storage-status]'),
      };
      return skeleton;
    }

    function sizeText(row) {
      const size = formatBytes(row.bytes);
      return row.partial ? jt('dataStorage.sizeAtLeast', '≥ {size}', { size }) : size;
    }

    function totalHtml() {
      if (loadFailed) return '';
      if (!usage) return escapeHtml(jt('dataStorage.measuring', 'Measuring…'));
      const marker = '\u0001';
      const text = usage.partial
        ? jt('dataStorage.totalAtLeast', 'Jenny uses at least {size} on this PC.', { size: marker })
        : jt('dataStorage.total', 'Jenny uses {size} on this PC.', { size: marker });
      const parts = text.split(marker);
      return escapeHtml(parts[0]) + '<strong>' + escapeHtml(formatBytes(usage.totalBytes)) + '</strong>' + escapeHtml(parts.slice(1).join(marker));
    }

    function actionHtml(row, copy) {
      const button = prim.button();
      const common = { size: 'sm', variant: 'ghost', className: 'data-storage-action', dataset: { category: row.id } };
      if (row.id === 'engines') {
        return button(Object.assign({ id: 'storage-manage', label: jt('dataStorage.manage', 'Manage'), ariaLabel: jt('dataStorage.manageLabel', 'Manage {category}', { category: copy.title }) }, common));
      }
      if (row.clearable && row.id === 'chats') {
        return button(Object.assign({ id: 'storage-clear', label: jt('dataStorage.deleteAll', 'Delete all…'), ariaLabel: jt('dataStorage.deleteAllLabel', 'Delete all chats…') }, common));
      }
      if (row.clearable) {
        return button(Object.assign({ id: 'storage-clear', label: jt('dataStorage.clear', 'Clear…'), ariaLabel: jt('dataStorage.clearLabel', 'Clear {category}…', { category: copy.noun }) }, common));
      }
      return '<span class="data-storage-kept">' + escapeHtml(jt('dataStorage.kept', 'Kept')) + '</span>';
    }

    function endHtml(row, copy) {
      if (!row) return '<span class="data-storage-end"><span class="data-storage-size" data-measuring>' + escapeHtml(jt('dataStorage.measuring', 'Measuring…')) + '</span></span>';
      if (!row.available) {
        return '<span class="data-storage-end"><span class="data-storage-size" data-measuring>' + escapeHtml(jt('dataStorage.noProject', 'No project open')) + '</span></span>';
      }
      const isMeasuring = measuring.has(MEASURE_ALL) || measuring.has(row.id);
      if (isMeasuring) {
        return '<span class="data-storage-end"><span class="data-storage-size" data-measuring>' + escapeHtml(jt('dataStorage.measuring', 'Measuring…')) + '</span>' + actionHtml(row, copy) + '</span>';
      }
      const total = usage ? usage.totalBytes : 0;
      const share = total > 0 ? Math.max(MIN_SHARE, Math.min(100, Math.round(row.bytes / total * 100))) : MIN_SHARE;
      // The meter repeats the size; screen readers get the size text and skip the bar.
      const meter = '<span class="data-storage-meter-slot" aria-hidden="true">' + (prim.progress()
        ? prim.progress()({ value: share, max: 100, label: copy.title, className: 'data-storage-meter', warningThreshold: 2, dangerThreshold: 2 })
        : '') + '</span>';
      return '<span class="data-storage-end">' + meter + '<span class="data-storage-size">' + escapeHtml(sizeText(row)) + '</span>' + actionHtml(row, copy) + '</span>';
    }

    function rowHtml(id, row) {
      const copy = categoryCopy(id);
      if (!copy) return '';
      return prim.field()({
        id: 'data-storage-' + id,
        variant: 'row',
        label: copy.title,
        help: copy.help,
        controlHtml: endHtml(row, copy),
        dataset: { category: id },
      });
    }

    // The folder is a link button at the end of the help line (display text only).
    function addLocations(rowsHost) {
      if (!usage) return;
      const button = prim.button();
      usage.categories.forEach((row) => {
        if (!row.available || !row.locationDisplay) return;
        const field = rowsHost.querySelector('[data-settings-field="data-storage-' + row.id + '"] .settings-field-help');
        if (!field) return;
        const copy = categoryCopy(row.id);
        field.insertAdjacentHTML('beforeend', ' <span class="data-storage-where">' + button({
          id: 'storage-reveal',
          label: row.locationDisplay,
          plain: true,
          className: 'data-storage-path',
          title: jt('dataStorage.revealTitle', 'Open in File Explorer'),
          ariaLabel: jt('dataStorage.revealLabel', 'Open {category} folder: {location}', { category: copy.title, location: row.locationDisplay }),
          dataset: { category: row.id },
        }) + '</span>');
      });
    }

    function render() {
      const groupEl = group();
      if (!groupEl) return;
      if (!isEnabled()) {
        groupEl.hidden = true;
        const host = mount();
        if (host) host.textContent = '';
        skeleton = null;
        return;
      }
      groupEl.hidden = false;
      const frame = ensureFrame();
      if (!frame) return;
      if (loadFailed) {
        frame.total.innerHTML = '';
        frame.rows.innerHTML = '';
        setStatus({ tone: 'warn', text: jt('dataStorage.unavailable', 'Storage sizes are not available right now.') });
        return;
      }
      frame.total.innerHTML = totalHtml();
      frame.rows.innerHTML = usage
        ? usage.categories.map((row) => rowHtml(row.id, row)).join('')
        : CATEGORY_ORDER.map((id) => rowHtml(id, null)).join('');
      addLocations(frame.rows);
      paintStatus();
      if (pendingFocus) focusRowAction(pendingFocus);
    }

    function paintStatus() {
      const frame = skeleton;
      if (!frame) return;
      frame.status.hidden = !status;
      if (status) {
        frame.status.dataset.tone = status.tone;
        if (frame.status.textContent !== status.text) frame.status.textContent = status.text;
      } else {
        frame.status.textContent = '';
        delete frame.status.dataset.tone;
      }
    }

    function setStatus(next) {
      status = next || null;
      paintStatus();
    }

    function focusRowAction(categoryId) {
      const button = skeleton && skeleton.rows.querySelector('[data-settings-field="data-storage-' + categoryId + '"] .data-storage-action');
      if (button && typeof button.focus === 'function') {
        pendingFocus = '';
        button.focus({ preventScroll: true });
      }
    }

    // ── Measuring ────────────────────────────────────────────────────────────
    async function refresh(ids) {
      if (disposed || !isEnabled()) {
        render();
        return;
      }
      const mine = (generation += 1);
      loadFailed = false;
      const only = Array.isArray(ids) && ids.length && usage ? ids.map(String) : null;
      measuring = new Set(only || [MEASURE_ALL]);
      render();
      let result = null;
      try {
        result = only ? await api().getStorageUsage({ categoryIds: only }) : await api().getStorageUsage();
      } catch (error) {
        log('WARN', 'data_storage.measure_failed', { reason: (error && (error.code || error.name)) || 'error' });
      }
      if (disposed || mine !== generation) return;
      measuring = new Set();
      const next = normalizeUsage(result);
      if (next) usage = only ? mergeUsage(usage, next, only) : next;
      else if (!usage) loadFailed = true;
      render();
    }

    // ── Clear flow ───────────────────────────────────────────────────────────
    function removeModal() {
      if (!modal) return;
      const closing = modal;
      modal = null;
      try { closing.lifecycle?.dispose(); } catch (_error) { /* focus restore only */ }
      if (closing.node.parentNode) closing.node.parentNode.removeChild(closing.node);
    }

    function closeModal() {
      if (!modal || modal.running) return;
      const categoryId = modal.categoryId;
      removeModal();
      focusRowAction(categoryId);
    }

    function itemsHtml(items) {
      return '<ul class="data-clear-list">' + items.map((item) => {
        const label = String(item && item.label || '');
        const files = wholeNumber(item && item.files);
        const size = formatBytes(item && item.bytes) + (files ? ' · ' + fileCount(files) : '');
        return '<li><span>' + escapeHtml(label) + '</span><span>' + escapeHtml(size) + '</span></li>';
      }).join('') + '</ul>';
    }

    function openModal(categoryId, preview) {
      const stepModal = prim.modal();
      if (!stepModal || !doc.body) return false;
      const copy = categoryCopy(categoryId);
      const isChats = categoryId === 'chats';
      const confirmCount = wholeNumber(preview.confirmCount);
      const typed = isChats && confirmCount > 0;
      const bytes = formatBytes(preview.totalBytes);
      const kept = Array.isArray(preview.kept) ? preview.kept.map((label) => String(label || '')).filter(Boolean) : [];
      const keptParts = [];
      if (kept.length) keptParts.push(jt('dataStorage.keptNote', 'Kept: {items}.', { items: kept.join(', ') }));
      if (isChats) keptParts.push(jt('dataStorage.archiveFirst', 'Make an archive first if you might want them back.'));
      if (preview.partial) keptParts.push(jt('dataStorage.previewPartial', 'Some folders are too large to count fully, so the real total can be higher.'));
      const body = itemsHtml(preview.items || [])
        + (keptParts.length ? '<p class="data-clear-keep">' + escapeHtml(keptParts.join(' ')) + '</p>' : '')
        + (typed ? prim.text()({
          id: 'dataStorageConfirmCount',
          label: jt('dataStorage.typeToConfirm', 'Type {count} to confirm', { count: localeCount(confirmCount) }),
          maxLength: 12,
          className: 'data-storage-typed',
          spellcheck: false,
        }) : '');
      const title = isChats
        ? jtn('dataStorage.deleteAllTitle', confirmCount, { count: localeCount(confirmCount) }, 'Delete the chat?', 'Delete all {count} chats?')
        : jt('dataStorage.clearTitle', 'Clear {category}?', { category: copy.noun });
      const summary = isChats
        ? jt('dataStorage.chats.summary', 'Each chat goes with its attachments, artifacts and chat memories, the same as deleting it from the sidebar. The Jenny chat is kept. This cannot be undone.')
          + ' ' + jt('dataStorage.chats.stopsWorking', 'Chats that are working are stopped.')
        : jt('dataStorage.clearSummary', 'These go now. Jenny keeps working.');
      const confirmLabel = isChats
        ? jtn('dataStorage.deleteChats', confirmCount, { count: localeCount(confirmCount) }, 'Delete {count} chat', 'Delete {count} chats')
        : jt('dataStorage.clearSize', 'Clear {size}', { size: bytes });
      doc.body.insertAdjacentHTML('beforeend', stepModal.renderStepModal({
        id: MODAL_ID,
        tone: 'danger',
        title,
        summary,
        bodyHtml: body,
        actions: [
          { id: 'cancel', label: jt('common.cancel', 'Cancel'), variant: 'secondary' },
          { id: 'confirm', label: confirmLabel, variant: 'danger', disabled: typed },
        ],
      }));
      const node = doc.querySelector('[data-step-modal="' + MODAL_ID + '"]');
      if (!node) return false;
      const lifecycle = stepModal.createLifecycle({
        documentRef: doc,
        mountRoot: node,
        getOverlayManager: () => overlayManager || windowRef.rendererOverlayManagerController || null,
        inertTargets: () => { const shell = doc.getElementById('appShell'); return shell ? [shell] : []; },
        appendClientLog: log,
      });
      modal = { node, lifecycle, running: false, categoryId, preview, confirmCount, typed, confirmLabel };
      lifecycle.open({
        id: MODAL_ID,
        onRequestClose: () => closeModal(),
        initialFocusSelector: typed ? '.data-storage-typed .inv-text-field-control' : undefined,
      });
      return true;
    }

    function typedValue() {
      const input = modal && modal.node.querySelector('.data-storage-typed .inv-text-field-control');
      return input ? String(input.value || '').trim() : '';
    }

    function syncConfirmEnabled() {
      if (!modal || !modal.typed || modal.running) return;
      const confirm = modal.node.querySelector('[data-step-modal-action="confirm"]');
      if (confirm) confirm.disabled = typedValue() !== String(modal.confirmCount);
    }

    function describeFailure(result) {
      const failed = Array.isArray(result && result.failed) ? result.failed : [];
      const count = failed.reduce((sum, entry) => sum + Math.max(1, wholeNumber(entry && entry.count)), 0);
      const labels = failed.map((entry) => String(entry && entry.label || '')).filter(Boolean).join(', ');
      return jtn('dataStorage.status.partial', count, { size: formatBytes(result.freedBytes), count: localeCount(count), labels }, 'Freed {size}. {count} item could not be removed: {labels}.', 'Freed {size}. {count} items could not be removed: {labels}.');
    }

    async function confirmClear() {
      if (!modal || modal.running) return;
      const current = modal;
      if (current.typed && typedValue() !== String(current.confirmCount)) return;
      const categoryId = current.categoryId;
      const copy = categoryCopy(categoryId);
      current.running = true;
      busy = true;
      modal.node.querySelectorAll('[data-step-modal-action]').forEach((button) => { button.disabled = true; });
      const confirmButton = modal.node.querySelector('[data-step-modal-action="confirm"]');
      if (confirmButton) confirmButton.textContent = jt('dataStorage.clearing', 'Clearing…');
      const request = { categoryId, previewToken: current.preview.previewToken };
      if (current.typed) request.confirmCount = Number(typedValue());
      let result = null;
      try {
        result = await api().clearCategory(request);
      } catch (error) {
        log('WARN', 'data_storage.clear_failed', { category: categoryId, reason: (error && (error.code || error.name)) || 'error' });
      }
      busy = false;
      if (disposed) return;
      current.running = false;
      pendingFocus = categoryId;
      removeModal();
      const done = result && result.ok === true && (result.status === 'ok' || result.status === 'partial');
      if (done) {
        const partial = result.status === 'partial' || (Array.isArray(result.failed) && result.failed.length > 0);
        if (partial) setStatus({ tone: 'warn', text: describeFailure(result) });
        else if (categoryId === 'chats') {
          setStatus({ tone: 'ok', text: jtn('dataStorage.status.chatsDeleted', current.confirmCount, { count: localeCount(current.confirmCount), size: formatBytes(result.freedBytes) }, 'Deleted the chat, freed {size}.', 'Deleted {count} chats, freed {size}.') });
        } else {
          setStatus({ tone: 'ok', text: jt('dataStorage.status.cleared', 'Cleared {category}, freed {size}.', { category: copy.noun, size: formatBytes(result.freedBytes) }) });
        }
        if (categoryId === 'chats') {
          try { await refreshSessions(); } catch (error) { log('WARN', 'data_storage.sessions_refresh_failed', { reason: (error && (error.code || error.name)) || 'error' }); }
        }
        void refresh(categoryId === 'chats' ? null : [categoryId]);
        return;
      }
      if (result && result.status === 'stale') {
        pendingFocus = '';
        setStatus({ tone: 'warn', text: jt('dataStorage.status.stale', "Jenny's data changed while this was open. Review it again.") });
        void openClear(categoryId, { keepStatus: true });
        return;
      } else if (result && result.status === 'busy') {
        setStatus({ tone: 'warn', text: jt('dataStorage.status.busy', 'Another clear is still running.') });
      } else {
        setStatus({ tone: 'warn', text: jt('dataStorage.status.failed', 'Could not clear {category}. Nothing was removed.', { category: copy.noun }) });
      }
      focusRowAction(categoryId);
    }

    async function openClear(categoryId, options) {
      const copy = categoryCopy(categoryId);
      if (!copy || busy || modal || !api()) return;
      busy = true;
      if (!(options && options.keepStatus)) setStatus(null);
      let preview = null;
      try {
        preview = await api().previewClear({ categoryId });
      } catch (error) {
        log('WARN', 'data_storage.preview_failed', { category: categoryId, reason: (error && (error.code || error.name)) || 'error' });
      }
      busy = false;
      if (disposed) return;
      if (!preview || preview.ok !== true || !preview.previewToken) {
        setStatus({ tone: 'warn', text: jt('dataStorage.status.previewFailed', 'Could not list what would be cleared. Try again.') });
        return;
      }
      const items = Array.isArray(preview.items) ? preview.items : [];
      if (!items.length || (!(Number(preview.totalBytes) > 0) && !wholeNumber(preview.totalFiles))) {
        setStatus({ tone: 'ok', text: jt('dataStorage.status.nothing', 'There is nothing to clear in {category}.', { category: copy.noun }) });
        void refresh([categoryId]);
        return;
      }
      if (!openModal(categoryId, preview)) {
        setStatus({ tone: 'warn', text: jt('dataStorage.status.previewFailed', 'Could not list what would be cleared. Try again.') });
      }
    }

    async function revealCategory(categoryId) {
      let result = null;
      try { result = await api().revealCategory({ categoryId }); } catch (_error) { /* reported below */ }
      if (disposed) return;
      if (!result || result.ok !== true) {
        setStatus({ tone: 'warn', text: jt('dataStorage.status.revealFailed', 'Could not open that folder.') });
      }
    }

    // ── Events ───────────────────────────────────────────────────────────────
    function onMountClick(event) {
      const target = event.target && event.target.closest && event.target.closest('[data-action]');
      if (!target || !mount().contains(target)) return;
      const categoryId = target.getAttribute('data-category') || '';
      if (!categoryCopy(categoryId)) return;
      const action = target.getAttribute('data-action');
      if (action === 'storage-reveal') void revealCategory(categoryId);
      else if (action === 'storage-manage') openSettingsSection('models');
      else if (action === 'storage-clear') void openClear(categoryId);
    }

    function onDocumentClick(event) {
      const target = event.target;
      if (!modal || !target || typeof target.closest !== 'function') return;
      const actionEl = target.closest('[data-step-modal-action]');
      if (actionEl && actionEl.closest('[data-step-modal="' + MODAL_ID + '"]')) {
        const action = actionEl.getAttribute('data-step-modal-action');
        if (action === 'confirm') void confirmClear();
        else if (action === 'cancel') closeModal();
        return;
      }
      if (target.closest('[data-step-modal="' + MODAL_ID + '"]') && !target.closest('.inv-step-modal')) closeModal();
    }

    function onDocumentInput(event) {
      if (modal && event.target && event.target.closest && event.target.closest('.data-storage-typed')) syncConfirmEnabled();
    }

    function isVisible() {
      const view = doc.getElementById('settingsView');
      const section = card();
      return Boolean(view && section && view.classList.contains('active-view') && section.classList.contains('settings-section-active'));
    }

    // One measure per visit: when the page becomes visible again, not on every class change.
    function syncVisibility() {
      const visible = isVisible();
      if (visible && !wasVisible) void refresh();
      wasVisible = visible;
    }

    function bind() {
      const host = mount();
      if (!host || disposed) return;
      host.addEventListener('click', onMountClick);
      doc.addEventListener('click', onDocumentClick);
      doc.addEventListener('input', onDocumentInput);
      cleanups.push(() => {
        host.removeEventListener('click', onMountClick);
        doc.removeEventListener('click', onDocumentClick);
        doc.removeEventListener('input', onDocumentInput);
      });
      const Observer = windowRef && windowRef.MutationObserver;
      if (typeof Observer === 'function') {
        const observer = new Observer(syncVisibility);
        [doc.getElementById('settingsView'), card()].forEach((node) => {
          if (node) observer.observe(node, { attributes: true, attributeFilter: ['class'] });
        });
        cleanups.push(() => observer.disconnect());
      }
      syncVisibility();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      removeModal();
      cleanups.splice(0).forEach((fn) => { try { fn(); } catch (_error) { /* best effort */ } });
    }

    return { bind, dispose, refresh, openClear, isOpen: () => Boolean(modal), getUsage: () => usage };
  }

  return { createDataStorageController, normalizeUsage, categoryCopy, CATEGORY_ORDER };
});
