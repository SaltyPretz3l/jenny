/* renderer/chat/renderer-hero-model-state.js
 *
 * Row 38 item 5 (variant A): the empty-chat hero follows the model state.
 * This module owns the words and the action markup for the four states the
 * hero can be in besides setup and a running conversation:
 *
 *   noModel      no usable route: pick a model (the recommended fit first)
 *   downloading  a pull is in flight: progress, ETA, Cancel
 *   failed       the classified load failure (item 1) with its matching fix
 *   ready        today's hero, naming the model that loads on first message
 *
 * `heroCopy(view)` is pure: a view object in, `{ title, subtitle, actionsHtml,
 * hint, composerLine }` out. Deriving the view from app state and binding the
 * actions live beside it (added by the S5 behaviour slice). No DOM here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../inventory/action-button'),
      require('../shared/model-load-failure'),
      require('../shell/renderer-model-library-format-utils'),
      require('../shell/renderer-snapshot-refresh')
    );
    return;
  }
  root.rendererHeroModelState = factory(
    root.inventoryActionButton,
    root.jennyModelLoadFailure,
    root.rendererModelLibraryFormatUtils,
    root.rendererSnapshotRefresh
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (actionButton, loadFailure, formatUtils, snapshotRefresh) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t)
    || globalThis.jennyI18nFallback
    || function (key, fallback, params) {
      return params
        ? String(fallback).replace(/\{(\w+)\}/g, (match, name) => (
          Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match))
        : fallback;
    };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn)
    || function (key, count, params, one, other) { return jt.call(null, key, count === 1 ? one : other, params); };

  const STATES = Object.freeze(['noModel', 'downloading', 'failed', 'ready']);

  function formatSize(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value <= 0) return '';
    if (typeof formatUtils?.formatHumanSize === 'function') return formatUtils.formatHumanSize(value);
    return `${Math.round(value / 1e6)} MB`;
  }

  function formatContext(value) {
    return value >= 1024 ? `${Math.round(value / 1024)}K` : String(value);
  }

  // Seconds left from the bytes so far and the time they took; null until a
  // rate exists (first progress) or when the total is unknown.
  function etaSeconds(pull, now) {
    const done = Number(pull?.completedBytes);
    const total = Number(pull?.totalBytes);
    const started = Number(pull?.startedAt);
    const at = Number.isFinite(now) ? now : Date.now();
    if (!(done > 0) || !(total > done) || !(started > 0) || at <= started) return null;
    const rate = done / ((at - started) / 1000);
    return rate > 0 ? Math.round((total - done) / rate) : null;
  }

  function etaText(seconds) {
    if (seconds == null) return '';
    if (seconds < 60) return jt('hero.downloading.etaUnderMinute', 'under a minute');
    const minutes = Math.max(1, Math.round(seconds / 60));
    return jtn('hero.downloading.etaMinutes', minutes, { count: minutes }, 'about {count} minute', 'about {count} minutes');
  }

  function button(variant, label, action, model) {
    if (typeof actionButton !== 'function') return '';
    return actionButton({
      variant, size: 'sm', label, title: label, className: 'hero-action',
      dataset: { 'hero-action': action, 'hero-model': String(model || '') },
    });
  }

  function noModelCopy(view) {
    const recommended = view.recommended && view.recommended.tag ? view.recommended : null;
    const size = recommended ? formatSize(Number(recommended.downloadSizeMb) * 1024 * 1024) : '';
    const subtitle = [jt('hero.noModel.subtitle', 'Jenny needs a model before she can reply.')];
    if (recommended) {
      subtitle.push(size
        ? jt('hero.noModel.fitsWithSize', '{model} fits this computer ({size} download).', { model: recommended.tag, size })
        : jt('hero.noModel.fits', '{model} fits this computer.', { model: recommended.tag }));
    }
    return {
      title: jt('hero.noModel.title', 'Pick a model to start'),
      subtitle: subtitle.join(' '),
      actionsHtml: (recommended
        ? button('primary', jt('hero.noModel.download', 'Download {model}', { model: recommended.tag }), 'download', recommended.tag)
        : '')
        + button(recommended ? 'secondary' : 'primary', jt('hero.noModel.browse', 'Browse models'), 'browse', ''),
      hint: jt('hero.noModel.cloudHint', 'Or sign in with ChatGPT in Settings › Cloud models.'),
      composerLine: jt('hero.noModel.composerLine', 'Send turns on once a model is ready.'),
    };
  }

  function downloadingCopy(view) {
    const pull = view.pull || {};
    const model = String(pull.tag || view.model || '');
    const done = formatSize(pull.completedBytes);
    const total = formatSize(pull.totalBytes);
    const eta = etaText(etaSeconds(pull, view.now));
    let progress = '';
    if (done && total && eta) progress = jt('hero.downloading.progress', '{done} of {total} · {eta} left.', { done, total, eta });
    else if (done && total) progress = jt('hero.downloading.progressNoEta', '{done} of {total}.', { done, total });
    else if (Number.isFinite(Number(pull.percent)) && Number(pull.percent) > 0) {
      progress = jt('hero.downloading.percent', '{percent}% so far.', { percent: Math.round(Number(pull.percent)) });
    }
    const wait = jt('hero.downloading.subtitle', "You can write your first message now; Jenny replies once it's in.");
    return {
      title: jt('hero.downloading.title', 'Getting {model} ready', { model }),
      subtitle: progress ? `${progress} ${wait}` : wait,
      actionsHtml: button('secondary', jt('hero.downloading.cancel', 'Cancel download'), 'cancel-download', model),
      hint: '',
      composerLine: jt('hero.downloading.composerLine', 'Jenny is downloading {model}. Send turns on when it is ready.', { model }),
    };
  }

  // The failed hero reuses item 1's cause-matched recovery, two actions at most.
  function failedCopy(view) {
    const failure = view.failure || {};
    const model = String(failure.model || view.model || '');
    const actions = loadFailure ? loadFailure.recoveryActions(failure).slice(0, 2) : ['retry'];
    const labels = {
      retry: jt('models.library.retry', 'Retry'),
      loadSmaller: jt('models.library.loadAtContext', 'Load at {context} context', {
        context: formatContext(loadFailure ? loadFailure.retryContext(failure) : 8192),
      }),
      showFits: jt('models.library.showModelsThatFit', 'Show models that fit'),
      diagnostics: jt('models.library.openDiagnostics', 'Open Diagnostics'),
      copyDetails: jt('models.library.copyDetails', 'Copy details'),
    };
    return {
      title: jt('hero.failed.title', "{model} didn't load", { model }),
      subtitle: loadFailure ? loadFailure.causeSentence(failure) : String(failure.message || ''),
      actionsHtml: actions.map((action, index) => button(index === 0 ? 'primary' : 'secondary', labels[action], action, model)).join(''),
      hint: '',
      composerLine: jt('hero.failed.composerLine', 'Sending retries the load.'),
    };
  }

  function readyCopy(view) {
    const model = String(view.model || '');
    return {
      title: jt('chat.pipelineChrome.newSession', 'New session'),
      subtitle: jt('chat.pipelineChrome.askToBegin', 'Ask Jenny anything to begin'),
      actionsHtml: '',
      hint: view.loaded === true || !model
        ? ''
        : jt('hero.ready.hint', '{model} loads with your first message', { model }),
      composerLine: '',
    };
  }

  // view: { kind, model, loaded, recommended: {tag, downloadSizeMb}|null,
  //         pull: {tag, percent, completedBytes, totalBytes, startedAt}|null,
  //         failure: <classified failure>|null, now }
  function heroCopy(view) {
    const safe = view && typeof view === 'object' ? view : {};
    switch (safe.kind) {
      case 'noModel': return noModelCopy(safe);
      case 'downloading': return downloadingCopy(safe);
      case 'failed': return failedCopy(safe);
      default: return readyCopy(safe);
    }
  }

  // The setup-incomplete footnote: only when a reply can actually happen.
  function setupFootnote(view) {
    const model = String(view?.model || '');
    if (view?.kind !== 'ready' || !model) return '';
    return jt('hero.setup.footnoteReady', '{model} is ready, so you can start chatting now.', { model });
  }

  function deriveHeroView(state, deps = {}) {
    const s = state || {};
    const failure = loadFailure.readModelLoadFailure(s.backend);
    const running = Object.values(s.modelPulls || {}).find((pull) => pull.status === 'running');
    const acquisition = s.backend?.phase === 'model_acquiring' && s.backend.model_acquisition;
    const pull = running ? {
      tag: running.tag, percent: running.percent, completedBytes: running.completedBytes,
      totalBytes: running.totalBytes, startedAt: running.startedAt,
    } : acquisition ? {
      tag: acquisition.requested_model, percent: acquisition.percent, completedBytes: acquisition.completed_bytes,
      totalBytes: acquisition.total_bytes, startedAt: acquisition.started_at,
    } : null;
    // Only a catalog that was read and lists no usable route is "no model"; an
    // unread or unavailable list is unknown, and the hero stays on today's words.
    const entries = !snapshotRefresh.isModelListUnavailable(s.modelList) && Array.isArray(s.modelList?.data)
      ? s.modelList.data : null;
    const noRoute = s.backend?.phase !== 'model_loading' && Boolean(entries) && !entries.some((entry) => entry && entry.available !== false);
    const kind = failure ? 'failed' : pull ? 'downloading' : noRoute ? 'noModel' : 'ready';
    return {
      kind, model: failure ? failure.model : pull ? pull.tag
        : s.status?.model || s.modelList?.active_model || s.offline?.preferredLocalModel || '',
      loaded: s.status?.model_loaded === true, recommended: s.modelRecommendation || null,
      pull, failure, now: deps.now?.() ?? Date.now(),
    };
  }

  function bindHeroActions(deps) {
    const d = deps || {};
    const reader = d.reader || loadFailure;
    let disposed = false;
    // The load names the engine that failed, so a llama-server GGUF is not retried on the live engine pin.
    const loadPayload = (failure) => (failure.engine ? { model: failure.model, engine_type: failure.engine } : failure.model);
    async function onClick(event) {
      const button = event.target?.closest?.('[data-hero-action]');
      if (!button || disposed) return;
      event.preventDefault();
      const action = button.dataset.heroAction;
      const tag = button.dataset.heroModel;
      try {
        if (action === 'download') return await d.startPull?.(tag);
        if (action === 'cancel-download') return await d.cancelPull?.(tag);
        if (action === 'browse' || action === 'showFits') return d.openSettingsSection?.('models');
        const failure = reader.readModelLoadFailure(d.state?.backend);
        if (!failure) return;
        switch (action) {
          case 'retry': return await d.loadModel?.(loadPayload(failure));
          case 'loadSmaller': {
            if (typeof d.persistContext !== 'function') return;
            const result = await d.persistContext({ modelId: failure.model, contextLength: reader.retryContext(failure) });
            if (disposed || result?.status !== 'applied') return;
            return await d.loadModel?.(loadPayload(failure));
          }
          case 'diagnostics': return d.openLogs?.();
          case 'copyDetails': return await d.windowRef?.navigator?.clipboard?.writeText?.(reader.failureDetails(failure));
          default: return;
        }
      } catch (_error) { /* The model services own the failure shown by the hero. */ }
    }
    d.documentRef.addEventListener('click', onClick);
    d.registerCleanup?.(() => {
      disposed = true;
      d.documentRef.removeEventListener('click', onClick);
    });
  }

  return { STATES, heroCopy, setupFootnote, etaSeconds, etaText, deriveHeroView, bindHeroActions };
});
