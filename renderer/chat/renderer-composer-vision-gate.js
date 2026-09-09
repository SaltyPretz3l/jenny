(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererComposerVisionGate = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  // Must equal sidecar/ai/engines/vision_input.py MAX_VISION_ATTACHMENTS (tests/attachment-image-cap-parity.test.js pins it).
  const MAX_IMAGE_ATTACHMENTS = 4;
  const HEURISTIC_VISION_SOURCES = new Set(['model_name', 'name_heuristic', 'heuristic', 'catalog_absent']);
  function unknownVision(modelLabel = jt('composer.visionGate.activeModel', 'The active model')) {
    return { supported: null, source: 'unknown', modelLabel };
  }

  function resolveActiveModelVision(state, runtimePreferences) {
    try {
      const preferred = String(runtimePreferences?.preferredModel || '').trim();
      const backendModel = String(state?.status?.model || '').trim();
      const modelLabel = preferred || backendModel || jt('composer.visionGate.activeModel', 'The active model');
      if (preferred === '' || preferred === backendModel) {
        // No model resolved or loaded yet: the send itself triggers the lazy
        // load, so there is nothing to judge — fail open (sidecar stays the authority).
        if (!backendModel || state?.status?.local_runtime?.model?.loaded === false) {
          return unknownVision(modelLabel);
        }
        const statusVision = state?.status?.local_runtime?.capabilities?.vision;
        if (statusVision && typeof statusVision === 'object' && typeof statusVision.available === 'boolean') {
          return {
            supported: statusVision.available,
            source: String(statusVision.source || '').trim().toLowerCase() || 'status',
            modelLabel,
          };
        }
        const legacyVision = state?.status?.active_model_capabilities?.vision;
        if (typeof legacyVision === 'boolean') {
          return { supported: legacyVision, source: 'status', modelLabel };
        }
        return unknownVision(modelLabel);
      }

      const entries = Array.isArray(state?.modelList?.data) ? state.modelList.data : [];
      const entryId = (entry) => String(entry?.id || entry?.name || entry?.model || '');
      const catalogEntry = entries.find((entry) => entryId(entry) === preferred)
        || entries.find((entry) => entryId(entry).toLowerCase() === preferred.toLowerCase());
      if (typeof catalogEntry?.capabilities?.vision === 'boolean') {
        return { supported: catalogEntry.capabilities.vision, source: 'catalog', modelLabel };
      }
      // Catalog rows only stamp vision when a probe/family/name matched (see
      // sidecar catalog.py _entry_supports_vision); a row with capabilities but
      // no vision flag is a soft "probably not" — warn, never block.
      if (catalogEntry?.capabilities && typeof catalogEntry.capabilities === 'object') {
        return { supported: false, source: 'catalog_absent', modelLabel };
      }
      return unknownVision(modelLabel);
    } catch (_error) {
      return unknownVision();
    }
  }

  function noGate(vision = unknownVision(), imageCount = 0) {
    return { blocked: false, notice: '', tone: '', sendReason: '', imageCount, vision };
  }

  function evaluateComposerVisionGate({
    state,
    runtimePreferences,
    maxImages = MAX_IMAGE_ATTACHMENTS,
  } = {}) {
    try {
      const vision = resolveActiveModelVision(state, runtimePreferences);
      const imageCount = (Array.isArray(state?.attachments?.queued) ? state.attachments.queued : [])
        .filter((entry) => String(entry?.kind || '').trim() === 'image').length;
      if (imageCount === 0) return noGate(vision);
      if (imageCount > maxImages) {
        const excess = imageCount - maxImages;
        return {
          blocked: true,
          notice: jt('composer.visionGate.tooManyImages', 'Up to {max} images per message. Remove {excess} to send.', { max: maxImages, excess }),
          tone: 'warning',
          sendReason: jtn('composer.visionGate.removeImagesToSend', excess, { count: excess }, 'Remove {count} image to send.', 'Remove {count} images to send.'),
          imageCount,
          vision,
        };
      }
      if (vision.supported === false) {
        if (HEURISTIC_VISION_SOURCES.has(vision.source)) {
          return {
            blocked: false,
            notice: jt('composer.visionGate.mayNotSupportImages', '{model} may not support images. If the reply fails, switch to a vision model.', { model: vision.modelLabel }),
            tone: 'warning',
            sendReason: '',
            imageCount,
            vision,
          };
        }
        return {
          blocked: true,
          notice: jt('composer.visionGate.cannotSeeImages', "{model} can't see images. Switch to a vision model or remove the image.", { model: vision.modelLabel }),
          tone: 'warning',
          sendReason: jt('composer.visionGate.removeOrChooseVisionModel', 'Remove the image or choose a vision model to send.'),
          imageCount,
          vision,
        };
      }
      return noGate(vision, imageCount);
    } catch (_error) {
      return noGate();
    }
  }

  function syncComposerVisionGate({
    state,
    runtimePreferences,
    sendButton,
    reasonNode,
    syncDisabledReason,
    setComposerStatusNotice,
    clearComposerStatusNotice,
  } = {}) {
    const gate = evaluateComposerVisionGate({ state, runtimePreferences });
    if (gate.blocked && sendButton) sendButton.disabled = true;
    if (gate.blocked && sendButton) sendButton.title = gate.sendReason;
    if (!gate.blocked && sendButton) sendButton.removeAttribute?.('title');
    if (typeof syncDisabledReason === 'function') {
      syncDisabledReason(sendButton, reasonNode, gate.sendReason);
    }
    const noticeOwner = String(state?.ui?.composerStatusNoticeOwner || '').trim();
    if (gate.notice && (!noticeOwner || noticeOwner === 'attachments.vision')) {
      if (typeof setComposerStatusNotice === 'function') {
        setComposerStatusNotice(gate.notice, { owner: 'attachments.vision', tone: gate.tone, at: 0 });
      }
    } else if (!gate.notice && typeof clearComposerStatusNotice === 'function') {
      clearComposerStatusNotice({ owner: 'attachments.vision' });
    }
    return gate;
  }

  return {
    MAX_IMAGE_ATTACHMENTS,
    HEURISTIC_VISION_SOURCES,
    resolveActiveModelVision,
    evaluateComposerVisionGate,
    syncComposerVisionGate,
  };
});
