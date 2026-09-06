const { API_VERSION } = require('./sidecar-client');

// Generate a Conventional Commit message from a staged diff via a one-shot,
// off-transcript local-model call. Mirrors backend-suggestions' readiness
// guards (managed mode, sidecar ready, a model loaded) but is user-initiated
// and foreground, so it deliberately does NOT skip while a chat stream is
// active. Degrades-never: every guard / failure resolves a structured
// { ok:false, ... } shape so the renderer can show a friendly hint without a
// thrown exception. The diff never enters the chat transcript.
async function generateCommitMessage(service, payload) {
  const diff = String((payload && payload.diff) || '').trim();
  if (!diff) {
    return { ok: false, reason: 'empty_diff' };
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
  const modelLoaded = service.currentStatus?.model_loaded === true
    || Boolean(String(service.currentModel || '').trim());
  if (!modelLoaded) {
    return { ok: false, available: false, reason: 'model_not_loaded' };
  }

  try {
    const result = await service.sidecarClient.request('commit.generate_message', {
      accept_version: API_VERSION,
      diff,
    });
    const message = String((result && result.message) || '').trim();
    if (!message) {
      return { ok: false, reason: 'empty_message' };
    }
    const out = { ok: true, message };
    // The sidecar reports, deterministically (no extra model call), when the
    // staged diff overflowed the model's input cap. Forward it so the renderer
    // can warn the user the message was written from a partial view.
    if (result && result.truncated === true) {
      out.truncated = true;
      out.omittedFiles = Number(result.omitted_files) || 0;
      out.totalFiles = Number(result.total_files) || 0;
    }
    return out;
  } catch (error) {
    if (typeof service._emitServiceLog === 'function') {
      service._emitServiceLog('WARN', 'commit_message.generate_failed', {
        message: error?.message || String(error),
      });
    }
    return { ok: false, reason: 'generate_failed', message: error?.message || String(error) };
  }
}

module.exports = {
  generateCommitMessage,
};
