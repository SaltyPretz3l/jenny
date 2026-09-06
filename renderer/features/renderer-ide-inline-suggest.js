/* renderer/features/renderer-ide-inline-suggest.js - inline ghost-text
 * autocomplete (Monaco ghost text + Tab-to-accept) backed by a local
 * fill-in-the-middle coder model. Registers a single Monaco
 * InlineCompletionsProvider that, on a debounced pause, sends the cursor's
 * bounded prefix + suffix to the backend (window.jennyShell.inline.complete →
 * sidecar /api/generate FIM) and renders the returned text as ghost text.
 *
 * Controller-free chrome: all gating, debouncing and IPC live here so the
 * 1015-line IDE controller only has to construct + wire this module (the same
 * handleMonacoReady/dispose seam the theme bridge uses). Degrades to silence:
 * any unmet gate or backend non-ok shape yields no suggestion that round. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'));
    return;
  }
  root.rendererIdeInlineSuggest = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence) {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  // Wait 250 ms after typing pauses before requesting a completion.
  const DEBOUNCE_MS = 250;
  // Bounded context fed to the model (~30% prefix / ~20% suffix of a ~1024-token
  // budget). The sidecar re-bounds as a backstop; small prompts keep FIM fast.
  const PREFIX_MAX_CHARS = 3_000;
  const SUFFIX_MAX_CHARS = 1_500;
  // Short completions: ghost text is a line or a small block, not a function.
  const MAX_TOKENS = 96;

  function createIdeInlineSuggest(deps) {
    const editorHost = deps?.editorHost || null;
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const isFeatureEnabled =
      typeof deps?.isFeatureEnabled === 'function' ? deps.isFeatureEnabled : () => true;
    const windowRef = deps?.windowRef || globalRef.window || globalRef;
    // Agent-mode test seam gate (agent_test_hooks only; never in production):
    // when on, requestCompletion() consults a window-installed canned-completion
    // hook BEFORE the real IPC. The contextBridge inline surface is frozen, so a
    // GUI smoke cannot stub jennyShell.inline.complete directly — it installs the
    // window hook instead. Defaults false, so the hook is inert without it.
    const isTestHookEnabled =
      typeof deps?.isTestHookEnabled === 'function' ? deps.isTestHookEnabled : () => false;
    const log = typeof deps?.log === 'function' ? deps.log : () => {};
    const commitPreference = typeof deps?.commitPreference === 'function'
      ? deps.commitPreference
      : () => Promise.resolve({ updated: false });
    const requestStatusRender =
      typeof deps?.requestStatusRender === 'function' ? deps.requestStatusRender : () => {};
    const fence = asyncFence.createDisposalFence();
    const requestGate = asyncFence.createGenerationGate();

    let monacoApi = null;
    let providerDisposable = null;
    // Degraded state covers real backend failures; an active chat stream instead
    // pauses FIM because the sidecar serializes requests. Paused may linger until
    // the next completion round; that is acceptable for info, never for masking
    // the remembered degraded warning. A genuine ok clears both flags.
    let degraded = false;
    let paused = false;
    let computeTarget = 'automatic';
    let computeReason = 'Selected automatically from live runtime resources.';

    function setComputeState(result) {
      if (fence.isDisposed()) return;
      const nextTarget = String(result?.computeTarget || 'automatic').trim().slice(0, 40) || 'automatic';
      const nextReason = String(result?.computeReason || '').trim().slice(0, 160)
        || 'Selected automatically from live runtime resources.';
      if (nextTarget === computeTarget && nextReason === computeReason) return;
      computeTarget = nextTarget;
      computeReason = nextReason;
      requestStatusRender();
    }

    function setDegraded(next) {
      // Never mutate / repaint after dispose: provideInlineCompletions awaits the
      // backend, so an in-flight request can resolve (or its catch can run) after
      // dispose() nulled monacoApi — and the status bar it would repaint is gone.
      if (fence.isDisposed() || !monacoApi) {
        return;
      }
      const value = next === true;
      if (value === degraded) {
        return;
      }
      degraded = value;
      requestStatusRender();
    }

    function setPaused(next) {
      if (fence.isDisposed() || !monacoApi) return;
      const value = next === true;
      if (value === paused) return;
      paused = value;
      requestStatusRender();
    }

    function isFlagOn() {
      return isFeatureEnabled() === true;
    }

    function modelTagFrom(ide) {
      return String((ide || {}).inlineSuggestModel || '').trim();
    }

    // Every gate that must hold for a suggestion to be requested this round.
    // The feature-on + quick-toggle + model-selected prefix is shared with
    // warm() via shouldSuggestModelConfigured(); this adds the active-file gates.
    // Takes the already-read IDE slice so the hot path reads it once.
    function shouldSuggest(ide) {
      if (!monacoApi || !shouldSuggestModelConfigured(ide)) {
        return false;
      }
      const path = editorHost?.getActivePath?.() || '';
      if (!path) {
        return false;
      }
      // Skip diff / preview / image tabs — ghost text only makes sense in a file.
      if (typeof editorHost?.getDocumentKind === 'function' && editorHost.getDocumentKind(path) !== 'file') {
        return false;
      }
      // Skip large files: the editor runs in a degraded mode and a multi-KB
      // prompt per keystroke would be slow and noisy.
      const reader = windowRef?.rendererIdeActiveEditorReader;
      if (reader && typeof reader.isLargeFile === 'function' && reader.isLargeFile() === true) {
        return false;
      }
      return true;
    }

    async function requestCompletion(payload) {
      // Agent-mode test seam (agent_test_hooks only; never in production): the
      // frozen contextBridge surface can't be stubbed, so a GUI smoke installs
      // a window hook to return a canned completion with no FIM model / sidecar
      // round-trip. Inert unless agent_test_hooks is on AND the hook is set.
      if (isTestHookEnabled()) {
        const hook = windowRef?.__jennyIdeInlineCompleteTestHook;
        if (typeof hook === 'function') {
          return hook(payload);
        }
      }
      const api = windowRef?.jennyShell?.inline;
      if (!api || typeof api.complete !== 'function') {
        return null;
      }
      return api.complete(payload);
    }

    function waitDebounced(token) {
      return new Promise((resolve) => {
        let sub = null;
        const timer = setTimeout(() => {
          sub?.dispose?.();
          resolve(true);
        }, DEBOUNCE_MS);
        if (token && typeof token.onCancellationRequested === 'function') {
          sub = token.onCancellationRequested(() => {
            clearTimeout(timer);
            sub?.dispose?.();
            resolve(false);
          });
        }
      });
    }

    // Read only the bounded window around the cursor (the last PREFIX_MAX_CHARS
    // and first SUFFIX_MAX_CHARS) via getValueInRange, so the per-keystroke hot
    // path never allocates a copy of the whole document. getPositionAt clamps an
    // out-of-range offset to the buffer ends, so no length lookup is needed.
    function boundedPrefixSuffix(model, position) {
      const offset = model.getOffsetAt(position);
      const start = model.getPositionAt(Math.max(0, offset - PREFIX_MAX_CHARS));
      const end = model.getPositionAt(offset + SUFFIX_MAX_CHARS);
      return {
        prefix: model.getValueInRange(
          new monacoApi.Range(start.lineNumber, start.column, position.lineNumber, position.column)
        ),
        suffix: model.getValueInRange(
          new monacoApi.Range(position.lineNumber, position.column, end.lineNumber, end.column)
        ),
      };
    }

    async function provideInlineCompletions(model, position, _context, token) {
      const empty = { items: [] };
      // Read the live IDE slice once and thread it through the gates + payload —
      // it is a stable object reference, so this stays read-fresh, not stale.
      const ide = getIde() || {};
      if (!shouldSuggest(ide) || !model || !position) {
        return empty;
      }
      requestGate.bump();
      const requestToken = requestGate.capture();
      const requestedModel = modelTagFrom(ide);
      const requestedPath = editorHost?.getActivePath?.() || '';
      const proceed = await waitDebounced(token);
      const debounceIde = getIde() || {};
      if (!proceed || fence.isDisposed() || !requestGate.isCurrent(requestToken)
        || !monacoApi || token?.isCancellationRequested
        || !shouldSuggest(debounceIde) || modelTagFrom(debounceIde) !== requestedModel
        || (editorHost?.getActivePath?.() || '') !== requestedPath) {
        return empty;
      }
      const { prefix, suffix } = boundedPrefixSuffix(model, position);
      if (!prefix && !suffix) {
        return empty;
      }
      let result;
      try {
        result = await requestCompletion({
          prefix,
          suffix,
          model: modelTagFrom(ide),
          maxTokens: MAX_TOKENS,
        });
      } catch (error) {
        log('INFO', 'ide.inline_suggest_failed', { message: String((error && error.message) || error || '') });
        setPaused(false);
        setDegraded(true);
        return empty;
      }
      const currentIde = getIde() || {};
      if (fence.isDisposed() || !requestGate.isCurrent(requestToken)
        || !monacoApi || token?.isCancellationRequested
        || !shouldSuggest(currentIde) || modelTagFrom(currentIde) !== requestedModel
        || (editorHost?.getActivePath?.() || '') !== requestedPath) {
        return empty;
      }
      // An active chat stream is a normal pause, while other non-ok shapes are a
      // degraded backend. A genuine ok response clears both health flags even
      // when the completion is empty.
      if (!result || result.ok !== true) {
        const reason = String((result && result.reason) || '');
        if (reason === 'chat_stream_active') {
          setPaused(true);
          return empty;
        }
        log('INFO', 'ide.inline_suggest_degraded', { reason });
        setPaused(false);
        setDegraded(true);
        return empty;
      }
      setPaused(false);
      setDegraded(false);
      setComputeState(result);
      const completion = String(result.completion || '');
      if (!completion) {
        return empty;
      }
      const range = new monacoApi.Range(
        position.lineNumber,
        position.column,
        position.lineNumber,
        position.column
      );
      return { items: [{ insertText: completion, range }], enableForwardStability: true };
    }

    // Pre-load the FIM model at IDE boot (parallel with the rest of init) when a
    // model is already configured, so the first keystroke isn't a cold load.
    function warm() {
      // Never fire after dispose() (monacoApi nulled) — warm() is exported and
      // shouldSuggestModelConfigured() intentionally omits the monacoApi gate.
      if (fence.isDisposed() || !monacoApi) {
        return;
      }
      const ide = getIde() || {};
      if (!shouldSuggestModelConfigured(ide)) {
        return;
      }
      requestCompletion({
        prefix: '\n',
        suffix: '',
        model: modelTagFrom(ide),
        maxTokens: 1,
      }).then(setComputeState).catch(() => {});
    }

    // Like shouldSuggest but without the active-file gates — warming only needs
    // the feature on + a selected model. Takes the already-read slice when the
    // caller has one (the hot path); falls back to reading it otherwise.
    function shouldSuggestModelConfigured(ide) {
      if (!isFlagOn()) {
        return false;
      }
      const slice = ide || getIde() || {};
      return slice.inlineSuggestEnabled !== false && Boolean(modelTagFrom(slice));
    }

    function register() {
      providerDisposable?.dispose?.();
      providerDisposable = monacoApi.languages.registerInlineCompletionsProvider(
        { pattern: '**' },
        {
          provideInlineCompletions,
          freeInlineCompletions() {},
        }
      );
    }

    // Called by the editor host once Monaco actually booted (never on the
    // jsdom / loader-failure fallback path). Registers the provider only when the
    // feature flag is on, so the common (off) case adds zero per-keystroke work.
    function handleMonacoReady(api) {
      if (fence.isDisposed()) return false;
      monacoApi = api || null;
      if (!monacoApi?.languages?.registerInlineCompletionsProvider || !isFlagOn()) {
        return false;
      }
      register();
      warm();
      return true;
    }

    function dispose() {
      requestGate.bump();
      fence.dispose();
      providerDisposable?.dispose?.();
      providerDisposable = null;
      monacoApi = null;
    }

    // The status-bar quick toggle (renderer-ide-statusbar) reads these; owning
    // the visible/enabled/persist logic here keeps it in one place (and the IDE
    // controller under its line ceiling).
    function statusCallbacks() {
      return {
        getInlineSuggestVisible: () => isFlagOn(),
        getInlineSuggestEnabled: () => (getIde() || {}).inlineSuggestEnabled !== false,
        // True when the last completion request genuinely failed; normal chat
        // serialization is exposed separately as paused.
        getInlineSuggestDegraded: () => degraded === true,
        getInlineSuggestPaused: () => paused === true,
        getInlineSuggestComputeStatus: () => ({ target: computeTarget, reason: computeReason }),
        onToggleInlineSuggest: async () => {
          const ide = getIde() || {};
          const next = ide.inlineSuggestEnabled === false;
          const result = await commitPreference('inlineSuggestEnabled', next);
          if (result?.updated !== true) return result;
          // Re-enabling starts from a clean slate: clear any stale degraded warn
          // so it doesn't flash before the next request re-confirms backend health
          // (requestStatusRender below repaints either way).
          if (result.value !== false) {
            degraded = false;
            paused = false;
          }
          requestStatusRender();
          return result;
        },
      };
    }

    return {
      handleMonacoReady,
      dispose,
      warm,
      statusCallbacks,
    };
  }

  return {
    createIdeInlineSuggest,
  };
});
