const { API_VERSION } = require('./sidecar-client');

// Backstop against a misbehaving/compromised renderer so a huge payload never
// crosses IPC+stdio before the sidecar's own clamp. prefix/suffix caps match
// the sidecar's _MAX_PREFIX_CHARS(8000)/_MAX_SUFFIX_CHARS(4000) in
// sidecar/runtime/inline_completion.py, which slices str(prefix)[-8000:] /
// str(suffix)[:4000] in CODE POINTS — so prefix/suffix are compared here in
// code points too (not UTF-16 code units), or an astral-heavy prefix (emoji,
// CJK-Ext-B) the sidecar would happily accept gets spuriously rejected here.
const MAX_PREFIX_CHARS = 8_000;
const MAX_SUFFIX_CHARS = 4_000;
const MAX_MODEL_LEN = 200;
const MAX_MAX_TOKENS = 512;

// Count Unicode code points (not UTF-16 code units) so astral characters
// (emoji, CJK-Ext-B, etc.) count as one each, matching Python's str length.
const codePointLen = (value) => Array.from(String(value)).length;

// Generate a single inline (fill-in-the-middle) code completion for the editor
// cursor via a one-shot, off-transcript local-model call. Mirrors backend-commit's
// readiness guards (managed mode, sidecar ready, a model loaded) and, like
// backend-suggestions, SKIPS while a chat stream is active — the sidecar
// processes requests serially, so a completion would queue behind a long stream
// and time out, and we don't want completions competing with chat. Degrades-never:
// every guard / failure resolves a structured { ok:false, ... } shape so the
// renderer simply shows no ghost text. The edited file content never enters the
// chat transcript.
async function generateInlineCompletion(service, payload) {
  const params = payload && typeof payload === 'object' ? payload : {};
  const prefix = String(params.prefix || '');
  const suffix = String(params.suffix || '');
  const model = String(params.model || '').trim();
  if (!model) {
    return { ok: false, available: false, reason: 'no_model_selected' };
  }
  if (!prefix && !suffix) {
    return { ok: false, reason: 'empty_context' };
  }
  const maxTokens = Number(params.maxTokens);
  if (
    codePointLen(prefix) > MAX_PREFIX_CHARS
    || codePointLen(suffix) > MAX_SUFFIX_CHARS
    || model.length > MAX_MODEL_LEN
    || (Number.isFinite(maxTokens) && maxTokens > MAX_MAX_TOKENS)
  ) {
    if (typeof service?._emitServiceLog === 'function') {
      service._emitServiceLog('INFO', 'inline_complete.payload_too_large', {
        prefixLength: codePointLen(prefix),
        suffixLength: codePointLen(suffix),
        modelLength: model.length,
        maxTokens,
      });
    }
    return { ok: false, reason: 'payload_too_large' };
  }
  if (!service || !service.sidecarClient) {
    return { ok: false, available: false, reason: 'sidecar_unavailable' };
  }
  const phase = typeof service.sidecarManager?.getStatus === 'function'
    ? String(service.sidecarManager.getStatus()?.phase || '').trim().toLowerCase()
    : 'ready';
  if (phase !== 'ready') {
    return { ok: false, available: false, reason: 'sidecar_not_ready' };
  }
  if (service.activeStreams && typeof service.activeStreams.size === 'number' && service.activeStreams.size > 0) {
    return { ok: false, available: false, reason: 'chat_stream_active' };
  }
  // NOTE: intentionally NOT gated on a loaded *chat* model. Inline completion
  // runs on its own FIM model (a separate Ollama pull, independent of whatever
  // serves chat), so it must work while editing in the IDE before any chat model
  // is loaded. The sidecar serves it from a transient Ollama engine when the
  // active chat engine has no FIM path — or when no chat model is loaded at all.

  try {
    const result = await service.sidecarClient.request('inline.complete', {
      accept_version: API_VERSION,
      prefix,
      suffix,
      model,
      max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.trunc(maxTokens) : 96,
    });
    const completion = String((result && result.completion) || '');
    return {
      ok: true,
      completion,
      computeTarget: String(result?.compute_target || 'automatic'),
      computeReason: String(result?.compute_reason || 'runtime_resource_policy'),
    };
  } catch (error) {
    // A timeout here is expected/benign (a slow round is dropped; the renderer
    // simply shows no ghost text), so log at INFO rather than WARN.
    if (typeof service._emitServiceLog === 'function') {
      service._emitServiceLog('INFO', 'inline_complete.generate_failed', {
        message: error?.message || String(error),
      });
    }
    return { ok: false, reason: 'generate_failed' };
  }
}

// Shared readiness gate for the inline model-management calls (loaded-list +
// unload). Mirrors generateInlineCompletion's guards: a ready
// sidecar, and no active chat stream (the sidecar is serial, so a management
// call must not queue behind a long stream). Returns a structured reason on
// failure, or null when it is safe to proceed.
function inlineManagementGuard(service) {
  if (!service || !service.sidecarClient) {
    return { available: false, reason: 'sidecar_unavailable' };
  }
  const phase = typeof service.sidecarManager?.getStatus === 'function'
    ? String(service.sidecarManager.getStatus()?.phase || '').trim().toLowerCase()
    : 'ready';
  if (phase !== 'ready') {
    return { available: false, reason: 'sidecar_not_ready' };
  }
  if (service.activeStreams && typeof service.activeStreams.size === 'number' && service.activeStreams.size > 0) {
    return { available: false, reason: 'chat_stream_active' };
  }
  return null;
}

// List the models currently resident in the Ollama daemon (`/api/ps`), so the
// IDE completion menu can show a live ●loaded / ○not-loaded indicator. Degrades
// to { ok:false, loaded:[] } on any guard/transport failure.
async function listLoadedInlineModels(service) {
  const blocked = inlineManagementGuard(service);
  if (blocked) {
    return { ok: false, loaded: [], ...blocked };
  }
  try {
    const result = await service.sidecarClient.request('inline.loaded_models', {
      accept_version: API_VERSION,
    });
    const loaded = Array.isArray(result && result.loaded) ? result.loaded.map((m) => String(m || '')).filter(Boolean) : [];
    return { ok: true, loaded };
  } catch (error) {
    if (typeof service._emitServiceLog === 'function') {
      service._emitServiceLog('INFO', 'inline_complete.loaded_models_failed', {
        message: error?.message || String(error),
      });
    }
    return { ok: false, loaded: [], reason: 'query_failed' };
  }
}

// Evict a specific FIM model from the Ollama daemon by tag. Degrades to
// { ok:false } on any guard/transport failure.
async function unloadInlineModel(service, payload) {
  const params = payload && typeof payload === 'object' ? payload : {};
  const model = String(params.model || '').trim();
  if (!model) {
    return { ok: false, reason: 'no_model_selected' };
  }
  const blocked = inlineManagementGuard(service);
  if (blocked) {
    return { ok: false, ...blocked };
  }
  try {
    const result = await service.sidecarClient.request('inline.unload', {
      accept_version: API_VERSION,
      model,
    });
    return { ok: result?.ok === true };
  } catch (error) {
    if (typeof service._emitServiceLog === 'function') {
      service._emitServiceLog('INFO', 'inline_complete.unload_failed', {
        message: error?.message || String(error),
      });
    }
    return { ok: false, reason: 'unload_failed' };
  }
}

module.exports = {
  generateInlineCompletion,
  listLoadedInlineModels,
  unloadInlineModel,
};
