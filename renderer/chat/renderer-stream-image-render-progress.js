(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamImageRenderProgress = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  /* Live progress of a running image_generate call: its phase, sampling step and
     newest preview frame, painted into the pending figure (data-inv-image-render).
     Progress events are EPHEMERAL, like the live output tail: this module patches
     the DOM directly and never touches the row model or render cache. A timeline
     observer repaints a pending figure that a re-render replaced; the tool_result
     render swaps in the finished figure and settle() forgets the call. */

  // Interrupted turns may never settle a call: keep only the newest few.
  const MAX_TRACKED_RENDERS = 4;
  const KEY_SEPARATOR = '\u001f';
  const PHASES = new Set(['gpu', 'load', 'sample', 'decode']);

  function normalizeId(value) {
    return String(value == null ? '' : value).trim();
  }

  function readIdentity(source) {
    const payload = source || {};
    return {
      sessionId: normalizeId(payload.sessionId || payload.session_id),
      streamId: normalizeId(payload.streamId || payload.stream_id),
      callId: normalizeId(payload.callId || payload.tool_call_id),
    };
  }

  function phaseLabel(phase) {
    if (phase === 'gpu') return jt('chat.artifactFigure.renderFreeingGpu', 'Freeing the GPU');
    if (phase === 'load') return jt('chat.artifactFigure.renderLoading', 'Loading the image model');
    if (phase === 'sample') return jt('chat.artifactFigure.renderDrawing', 'Drawing');
    return jt('chat.artifactFigure.renderFinishing', 'Finishing');
  }

  function createImageRenderProgress(options = {}) {
    const { getChatTimeline = () => null, maxTrackedRenders = MAX_TRACKED_RENDERS } = options;
    // key (session + stream + call id) -> latest progress of that render.
    const renders = new Map();
    let observer = null;
    let observedTimeline = null;
    let disposed = false;
    // One counter for every render, so a figure painted by another render of the same call id repaints.
    let paintVersion = 0;

    function disconnectObserver() {
      if (!observer) return;
      observer.disconnect();
      observer = null;
      observedTimeline = null;
    }

    function paint(figure, render) {
      // Painting mutates the timeline and re-enters the observer: skip a figure that shows this version.
      if (figure.getAttribute('data-inv-render-painted') === String(render.version)) return;
      figure.setAttribute('data-inv-render-painted', String(render.version));
      figure.setAttribute('data-inv-render-phase', render.phase);
      figure.style.setProperty('--inv-render-progress', String(render.fraction));
      const phase = figure.querySelector('.inv-artifact-figure-phase');
      const label = phaseLabel(render.phase);
      if (phase && phase.textContent !== label) phase.textContent = label;
      const step = figure.querySelector('.inv-artifact-figure-step');
      const stepText = render.phase === 'sample' && render.steps
        ? ` · ${jt('chat.artifactFigure.renderStep', '{step} of {steps}', { step: render.step, steps: render.steps })}` : '';
      if (step && step.textContent !== stepText) step.textContent = stepText;
      const preview = figure.querySelector('.inv-artifact-figure-preview');
      if (preview && render.preview && preview.getAttribute('src') !== render.preview) {
        preview.setAttribute('src', render.preview);
        figure.setAttribute('data-inv-render-preview', '');
      }
    }

    // One timeline scan per pass; a call id reused by a later turn shows that turn's render.
    function reconcile() {
      const chatTimeline = getChatTimeline();
      if (!renders.size || !chatTimeline || typeof chatTimeline.querySelectorAll !== 'function') return;
      const byCall = new Map();
      for (const render of renders.values()) byCall.set(render.callId, render);
      for (const figure of chatTimeline.querySelectorAll('[data-inv-image-render]')) {
        const render = byCall.get(figure.getAttribute('data-inv-image-render'));
        if (render) paint(figure, render);
      }
    }

    function ensureObserver() {
      const chatTimeline = getChatTimeline();
      if (observer && observedTimeline === chatTimeline) return;
      disconnectObserver();
      const MutationObserverImpl = chatTimeline?.ownerDocument?.defaultView?.MutationObserver;
      if (!chatTimeline || typeof MutationObserverImpl !== 'function') return;
      // Only added nodes can bring a (re-rendered) pending figure.
      observer = new MutationObserverImpl((records) => {
        if (records.some((record) => record.addedNodes.length)) reconcile();
      });
      observedTimeline = chatTimeline;
      observer.observe(chatTimeline, { childList: true, subtree: true });
    }

    function apply(payload) {
      if (disposed || !payload || !PHASES.has(payload.phase)) return false;
      const identity = readIdentity(payload);
      if (!identity.callId) return false;
      const key = [identity.sessionId, identity.streamId, identity.callId].join(KEY_SEPARATOR);
      const previous = renders.get(key);
      // A newer stream of the same session supersedes an older render with a reused call id.
      for (const [otherKey, other] of [...renders]) {
        if (otherKey !== key && other.sessionId === identity.sessionId && other.callId === identity.callId) renders.delete(otherKey);
      }
      const steps = Number.isSafeInteger(payload.steps) && payload.steps > 0 ? payload.steps : 0;
      const step = steps && Number.isSafeInteger(payload.step) ? Math.min(Math.max(payload.step, 0), steps) : 0;
      const fraction = payload.phase === 'decode' ? 1 : (payload.phase === 'sample' && steps ? step / steps : 0);
      renders.delete(key);
      renders.set(key, {
        ...identity,
        version: paintVersion += 1,
        phase: payload.phase,
        step,
        steps,
        fraction,
        // A step without a new frame keeps the last one.
        preview: typeof payload.preview === 'string' && payload.preview.startsWith('data:image/png;base64,')
          ? payload.preview : (previous?.preview || ''),
      });
      while (renders.size > maxTrackedRenders) renders.delete(renders.keys().next().value);
      ensureObserver();
      reconcile();
      return true;
    }

    function settle(identity) {
      const parsed = readIdentity(identity !== null && typeof identity === 'object' ? identity : { callId: identity });
      for (const [key, render] of [...renders]) {
        if (render.callId === parsed.callId && (!parsed.streamId || render.streamId === parsed.streamId)) renders.delete(key);
      }
      if (!renders.size) disconnectObserver();
    }

    function settleStream(streamId) {
      const normalizedStreamId = normalizeId(streamId);
      for (const [key, render] of [...renders]) {
        if (render.streamId === normalizedStreamId) renders.delete(key);
      }
      if (!renders.size) disconnectObserver();
    }

    function dispose() {
      disposed = true;
      renders.clear();
      disconnectObserver();
    }

    return { apply, settle, settleStream, dispose };
  }

  return { MAX_TRACKED_RENDERS, createImageRenderProgress };
});
