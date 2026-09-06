/* renderer/features/renderer-ide-fim-picker.js
 *
 * The completion-model menu behind the statusbar autocomplete caret. Opens a
 * small inventory popover anchored above the caret that lists the installed
 * fill-in-the-middle (FIM) models with their LIVE loaded/unloaded state (from
 * Ollama /api/ps via inline.loadedModels), lets the user pick one (which sets +
 * persists the IDE's inlineSuggestModel and warms it), and exposes explicit
 * Load / Unload controls for the selected model.
 *
 * Controller-free chrome (mirrors renderer-ide-chip-picker.js): the popover is
 * appended to the IDE shell (NOT the cursor-driven statusbar markup, which
 * re-renders on every cursor move and would destroy an open popover). All rows
 * and buttons render through the inventory action-button. Degrades to silence:
 * any missing dep / IPC failure simply yields an empty or stale menu. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeFimPicker = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function noop() {}

  function defaultEscape(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeModelTag(value) {
    const ideState = (typeof globalThis !== 'undefined' && globalThis.rendererIdeState) || null;
    if (ideState && typeof ideState.sanitizeInlineSuggestModel === 'function') {
      return ideState.sanitizeInlineSuggestModel(value);
    }
    return String(value || '').trim();
  }

  function createIdeFimPicker(deps) {
    const options = deps || {};
    const getDom = typeof options.getDom === 'function' ? options.getDom : () => ({});
    const getIde = typeof options.getIde === 'function' ? options.getIde : () => ({});
    const popover = typeof options.popover === 'function' ? options.popover : null;
    const actionButton = typeof options.actionButton === 'function' ? options.actionButton : null;
    const escapeHtml = typeof options.escapeHtml === 'function' ? options.escapeHtml : defaultEscape;
    const commitPreference = typeof options.commitPreference === 'function'
      ? options.commitPreference
      : () => Promise.resolve({ updated: false });
    const requestStatusRender = typeof options.requestStatusRender === 'function' ? options.requestStatusRender : noop;
    const windowRef = options.windowRef || (typeof window !== 'undefined' ? window : null);

    let host = null;
    let bound = false;
    let models = [];        // [{ id }] — FIM-capable only
    let loaded = new Set(); // model names currently resident in the daemon
    let busy = false;       // a Load/Unload IPC round is in flight
    let loading = false;    // the initial model/loaded fetch is in flight
    let statusMsg = '';
    let statusTone = '';    // '' | 'info' | 'ok' | 'warn' — drives the status colour
    // Monotonic op id (mirrors searchSeq in renderer-ide-search-panel.js): each
    // load()/unload() call captures the post-increment value, then re-checks it
    // after every await so a superseded op's continuation can't overwrite a
    // newer op's state — last-click-wins instead of a race on write order.
    let fimOpSeq = 0;

    // Map a backend { ok:false, reason } shape to a one-line, human explanation
    // so a failed Load isn't silent. The reasons come from
    // services/backend/backend-inline-complete.js generateInlineCompletion.
    function describeReason(reason) {
      switch (reason) {
        case 'sidecar_unavailable':
        case 'sidecar_not_ready':
          return 'The local engine is still starting — try again in a moment.';
        case 'chat_stream_active':
          return 'Busy with a chat reply — try again when it finishes.';
        case 'no_model_selected':
          return 'Pick a completion model first.';
        case 'generate_failed':
          return 'Could not reach the model. Is it still installed and is Ollama running?';
        default:
          return 'Could not load the model.';
      }
    }

    function statusLineHtml(text, tone) {
      const toneClass = tone === 'ok'
        ? ' ide-fim-status--ok'
        : (tone === 'warn' ? ' ide-fim-status--warn' : '');
      return `<div class="ide-fim-status${toneClass}" role="status">${escapeHtml(text)}</div>`;
    }

    function modelsApi() {
      return (windowRef && windowRef.jennyShell && windowRef.jennyShell.models) || null;
    }
    function inlineApi() {
      return (windowRef && windowRef.jennyShell && windowRef.jennyShell.inline) || null;
    }
    function currentModel() {
      return String((getIde() || {}).inlineSuggestModel || '').trim();
    }

    function ensureHost() {
      const shell = getDom().ideShell || null;
      if (!shell || !popover || typeof shell.appendChild !== 'function') {
        return null;
      }
      if (host && shell.contains(host)) {
        return host;
      }
      const docRef = shell.ownerDocument || (typeof document !== 'undefined' ? document : null);
      if (!docRef) {
        return null;
      }
      const wrap = docRef.createElement('div');
      wrap.innerHTML = popover({
        id: 'ideFimPicker',
        className: 'ide-chip-popover ide-fim-popover',
        ariaLabel: 'Completion model',
      });
      host = wrap.firstChild;
      shell.appendChild(host);
      if (typeof host.addEventListener === 'function') {
        host.addEventListener('click', handleHostClick);
      }
      return host;
    }

    function position(anchor) {
      const shell = getDom().ideShell || null;
      if (!host || !shell || typeof anchor?.getBoundingClientRect !== 'function') {
        return;
      }
      const a = anchor.getBoundingClientRect();
      const s = shell.getBoundingClientRect();
      host.style.left = `${Math.max(4, a.left - s.left)}px`;
      host.style.bottom = `${Math.max(0, s.bottom - a.top + 4)}px`;
    }

    function loadedDot(isLoaded) {
      return `<span class="ide-fim-dot${isLoaded ? ' ide-fim-dot--on' : ''}"`
        + ` title="${isLoaded ? 'loaded' : 'not loaded'}" aria-hidden="true">`
        + `${isLoaded ? '●' : '○'}</span>`;
    }

    function buildRows() {
      if (loading) {
        return '<div class="ide-fim-empty">Loading models…</div>';
      }
      if (!models.length) {
        return '<div class="ide-fim-empty">No fill-in-the-middle models installed — '
          + 'pull one (e.g. qwen2.5-coder:1.5b-base).</div>';
      }
      const cur = currentModel();
      if (!actionButton) {
        return '';
      }
      return models.map((m) => actionButton({
        plain: true,
        className: `ide-chip-option${m.id === cur ? ' ide-chip-option--active' : ''}`,
        title: 'Choose the inline-completion model',
        trustedHtml: escapeHtml(m.id) + loadedDot(loaded.has(m.id)),
        dataset: { 'ide-fim-model': m.id },
        ariaPressed: m.id === cur,
      })).join('');
    }

    function buildFooter() {
      if (!actionButton) {
        return '';
      }
      const ide = getIde() || {};
      const cur = currentModel();
      const curLoaded = loaded.has(cur);
      const loadBtn = actionButton({
        label: 'Load',
        size: 'sm',
        disabled: busy || !cur || curLoaded,
        dataset: { 'ide-fim-action': 'load' },
      });
      const unloadBtn = actionButton({
        label: 'Unload',
        size: 'sm',
        disabled: busy || !cur || !curLoaded,
        dataset: { 'ide-fim-action': 'unload' },
      });
      let lines = '';
      // Loading the model is distinct from enabling autocomplete: with the quick
      // toggle off there is no ghost text however the model is loaded, so make
      // that the dominant, always-on hint when paused.
      if (ide.inlineSuggestEnabled === false) {
        lines += statusLineHtml('Autocomplete is paused — turn it on with the ✦ button.', 'warn');
      }
      if (statusMsg) {
        lines += statusLineHtml(statusMsg, statusTone);
      }
      return `<div class="ide-fim-popover__actions">${loadBtn}${unloadBtn}</div>${lines}`;
    }

    function renderMenu() {
      if (!host) {
        return;
      }
      host.innerHTML = `<div class="ide-fim-popover__header">Completion model</div>${buildRows()}${buildFooter()}`;
    }

    async function fetchModels() {
      const api = modelsApi();
      if (!api) {
        return [];
      }
      const request = typeof api.listOllamaTags === 'function'
        ? api.listOllamaTags()
        : (typeof api.list === 'function' ? api.list() : null);
      if (!request) {
        return [];
      }
      try {
        const payload = await request;
        const data = Array.isArray(payload && payload.data) ? payload.data : [];
        const seen = new Set();
        const out = [];
        data.forEach((m) => {
          const id = sanitizeModelTag(m && (m.id || m.name || m.model));
          const fim = Boolean(m && m.capabilities && m.capabilities.insert === true);
          if (id && fim && !seen.has(id)) { seen.add(id); out.push({ id }); }
        });
        return out;
      } catch (_error) {
        return [];
      }
    }

    // Returns a Set of resident model names on a SUCCESSFUL /api/ps query, or
    // null when the query itself could not be completed (no api, a degraded
    // { ok:false } shape, or a transport error). Distinguishing "query failed"
    // (null) from "genuinely none loaded" (empty Set) lets load()/unload() avoid
    // a false eviction/unload diagnosis when the daemon simply couldn't be reached.
    async function fetchLoaded() {
      const api = inlineApi();
      if (!api || typeof api.loadedModels !== 'function') {
        return null;
      }
      try {
        const result = await api.loadedModels();
        if (!result || result.ok !== true || !Array.isArray(result.loaded)) {
          return null;
        }
        return new Set(result.loaded.map((m) => String(m || '')).filter(Boolean));
      } catch (_error) {
        return null;
      }
    }

    async function refresh() {
      // Claim an op id like load()/unload(): a reopen's refresh supersedes an
      // in-flight load()/unload() write, and a later load()/unload() supersedes
      // this refresh — so the newest action deterministically owns models/loaded.
      const opId = ++fimOpSeq;
      loading = true;
      renderMenu();
      const [nextModels, nextLoaded] = await Promise.all([fetchModels(), fetchLoaded()]);
      if (opId !== fimOpSeq) {
        return; // superseded by a newer refresh()/load()/unload()
      }
      models = nextModels;
      loaded = nextLoaded || new Set();
      loading = false;
      renderMenu();
    }

    async function load(tag) {
      const model = sanitizeModelTag(tag);
      const api = inlineApi();
      if (!model || !api || typeof api.complete !== 'function') {
        return;
      }
      // Claim this op's id before the first await; a later load()/unload() call
      // bumps fimOpSeq past it, so the two checkpoints below can detect a
      // superseded op and bail before it writes stale state (searchSeq pattern).
      const opId = ++fimOpSeq;
      loading = false;
      busy = true;
      statusMsg = `Loading "${model}"…`;
      statusTone = 'info';
      renderMenu();
      let result;
      try {
        result = await api.complete({
          prefix: '\n',
          suffix: '',
          model,
          maxTokens: 1,
        });
      } catch (_error) {
        result = { ok: false, reason: 'generate_failed' };
      }
      if (opId !== fimOpSeq) {
        return; // a newer load()/unload() superseded this one — don't touch busy/status
      }
      busy = false;
      // Ground truth: re-query the daemon so the dot AND the message reflect what
      // is actually resident, not merely whether the warm call returned ok.
      // fetchLoaded() returns null when the query itself failed (vs. an empty Set
      // for "none loaded"), so a warm success isn't mis-reported as an eviction
      // just because /api/ps was momentarily unreachable.
      const loadedNow = await fetchLoaded();
      if (opId !== fimOpSeq) {
        return; // superseded again during the second await — same reasoning as above
      }
      loaded = loadedNow || new Set();
      const readyMsg = (getIde() || {}).inlineSuggestEnabled === false
        ? 'Loaded.'
        : 'Loaded — ready to autocomplete.';
      if (loadedNow && loadedNow.has(model)) {
        statusMsg = readyMsg;
        statusTone = 'ok';
      } else if (result && result.ok === true) {
        if (loadedNow) {
          // The warm call succeeded but /api/ps DEFINITIVELY does not list the
          // model — the single-model daemon ceiling evicted it. Say how to fix it.
          statusMsg = 'The model loaded but did not stay resident — restart Jenny so the chat and completion models can coexist.';
          statusTone = 'warn';
        } else {
          // Warm succeeded (the model served a token, so it IS resident) but the
          // loaded-state query failed — report ready, not a false eviction.
          statusMsg = readyMsg;
          statusTone = 'ok';
        }
      } else {
        statusMsg = describeReason(result && result.reason);
        statusTone = 'warn';
      }
      renderMenu();
    }

    async function unload(tag) {
      const model = sanitizeModelTag(tag);
      const api = inlineApi();
      if (!model || !api || typeof api.unloadModel !== 'function') {
        return;
      }
      // Shares fimOpSeq with load() so a Load-then-Unload (or the reverse) on
      // the same model resolves in favour of whichever was clicked LAST,
      // regardless of which IPC round trip happens to settle first.
      const opId = ++fimOpSeq;
      loading = false;
      busy = true;
      statusMsg = `Unloading "${model}"…`;
      statusTone = 'info';
      renderMenu();
      try {
        await api.unloadModel({ model });
      } catch (_error) { /* outcome is reported from the ground-truth re-query */ }
      if (opId !== fimOpSeq) {
        return; // a newer load()/unload() superseded this one
      }
      busy = false;
      const loadedNow = await fetchLoaded();
      if (opId !== fimOpSeq) {
        return; // superseded again during the second await
      }
      loaded = loadedNow || new Set();
      if (loadedNow && loadedNow.has(model)) {
        statusMsg = 'Could not unload the model.';
        statusTone = 'warn';
      } else if (loadedNow) {
        statusMsg = 'Unloaded.';
        statusTone = 'ok';
      } else {
        // Could not re-query residency — report the request without asserting state.
        statusMsg = 'Unload requested — could not confirm it.';
        statusTone = 'info';
      }
      renderMenu();
    }

    async function selectModel(tag) {
      const model = sanitizeModelTag(tag);
      if (!model) {
        return;
      }
      const result = await commitPreference('inlineSuggestModel', model);
      if (result?.updated !== true) {
        statusMsg = 'The completion model choice could not be saved.';
        statusTone = 'warn';
        renderMenu();
        return;
      }
      requestStatusRender();
      // Selecting a model loads it so the first keystroke isn't a cold start;
      // load() renders immediately ("Loading…") and owns the visible outcome.
      load(model);
    }

    function handleHostClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      const actionBtn = target.closest('[data-ide-fim-action]');
      if (actionBtn) {
        if (busy) {
          return;
        }
        const action = actionBtn.getAttribute('data-ide-fim-action');
        const cur = currentModel();
        if (!cur) {
          return;
        }
        if (action === 'load') { load(cur); } else if (action === 'unload') { unload(cur); }
        return;
      }
      const row = target.closest('[data-ide-fim-model]');
      if (row) {
        selectModel(row.getAttribute('data-ide-fim-model'));
      }
    }

    function open(anchor) {
      const popEl = ensureHost();
      if (!popEl) {
        return;
      }
      // Re-clicking the caret toggles the popover closed.
      if (popover.isOpen(popEl)) {
        popover.close(popEl);
        return;
      }
      busy = false;
      statusMsg = '';
      statusTone = '';
      renderMenu();
      position(anchor);
      popover.open(popEl, { trigger: anchor });
      // Populate models + live loaded-state after opening (best-effort).
      refresh();
    }

    function initHandlers() {
      if (bound) {
        return;
      }
      const shell = getDom().ideShell || null;
      if (!shell || !popover) {
        return;
      }
      bound = true;
      popover.initPopoverHandlers(shell);
      ensureHost();
    }

    function dispose() {
      // Invalidate any pre-dispose load()/unload() continuation: the picker is
      // a session-long singleton, so a straggling op could otherwise write
      // into a later, re-opened host. Defense-in-depth: a reopen's own
      // refresh() also claims a fresh op id (superseding any straggler) and
      // open() resets busy/status, but bumping here invalidates a straggler
      // that resolves BEFORE any reopen too.
      fimOpSeq += 1;
      if (host && typeof host.removeEventListener === 'function') {
        host.removeEventListener('click', handleHostClick);
      }
      if (host && host.parentNode) {
        host.parentNode.removeChild(host);
      }
      host = null;
      bound = false;
    }

    return {
      initHandlers,
      open,
      dispose,
    };
  }

  return { createIdeFimPicker };
});
