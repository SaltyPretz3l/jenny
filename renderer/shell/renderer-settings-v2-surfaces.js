/* renderer/shell/renderer-settings-v2-surfaces.js
 * Builds the wired setup-progress surface. A per-element signature guard skips
 * unchanged innerHTML writes.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../features/setup-scenes/scene-utils')
    );
    return;
  }
  root.rendererSettingsV2Surfaces = factory(
    root.rendererSetupSceneUtils
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (sceneUtils) {
  const STEP_ORDER = (sceneUtils && sceneUtils.STEP_ORDER)
    || ['workspaceRoot', 'localModel', 'endpoint', 'personality', 'skills'];
  const SETUP_STEP_LABELS = Object.freeze({
    workspaceRoot: 'Workspace root',
    localModel: 'Local model',
    endpoint: 'Endpoint',
    personality: 'Personality',
    skills: 'Skills',
  });
  // Map scene-utils tones (success/danger/pending/muted) to status-dot CSS
  // classes (--ok/--error/--warn/--muted). Keep the mapping at the boundary
  // so we don't fork the design-token vocabulary.
  const SCENE_TONE_TO_DOT = Object.freeze({
    success: 'ok',
    danger: 'error',
    pending: 'warn',
    muted: 'muted',
  });

  const fallbackCountCompletedSteps = (steps) => {
    let done = 0;
    for (const key of STEP_ORDER) {
      const status = steps && steps[key];
      if (status === 'done' || status === 'skipped') done += 1;
    }
    return done;
  };
  const countCompletedSteps = (sceneUtils && sceneUtils.countCompletedSteps) || fallbackCountCompletedSteps;
  const statusMeta = (sceneUtils && sceneUtils.statusMeta)
    || ((status) => ({ tone: 'pending', label: status === 'done' ? 'Done' : 'Pending' }));
  function dotTone(sceneTone) {
    return SCENE_TONE_TO_DOT[String(sceneTone || '')] || 'muted';
  }

  function buildSetupProgressMarkup(options) {
    const setup = options?.setup || {};
    const steps = setup.steps || {};
    const escapeHtml = options.escapeHtml;
    const total = STEP_ORDER.length;
    const done = countCompletedSteps(steps);
    const pct = Math.round((done / total) * 100);
    const items = STEP_ORDER.map((key) => {
      const status = steps[key] || 'pending';
      const meta = statusMeta(status);
      return `<li class="settings-progress-item" data-status="${escapeHtml(status)}">
        <span class="settings-progress-dot status-dot status-dot--${escapeHtml(dotTone(meta.tone))}" aria-hidden="true"></span>
        <span class="settings-progress-label">${escapeHtml(SETUP_STEP_LABELS[key] || key)}</span>
        <span class="settings-progress-status">${escapeHtml(meta.label)}</span>
      </li>`;
    }).join('');
    const summary = setup.setupComplete
      ? 'Setup is complete. Re-run any step to refine your settings.'
      : `${done} of ${total} steps complete.`;
    return `<div class="settings-progress-card" data-component="settings-setup-progress">
      <div class="settings-progress-header">
        <span class="kicker">Setup progress</span>
        <span class="settings-progress-percent" aria-label="Setup percent complete">${pct}%</span>
      </div>
      <div class="settings-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
        <span class="settings-progress-fill" style="width: ${pct}%"></span>
      </div>
      <p class="settings-progress-summary">${escapeHtml(summary)}</p>
      <ul class="settings-progress-list" role="list">${items}</ul>
    </div>`;
  }

  /*
   * Per-orchestrator-instance signature cache. Each container's last-painted
   * data signature lives on the container element itself via a WeakMap, so:
   *   - re-renders with identical data skip the innerHTML rewrite (preserves
   *     <details> open state in the rendered settings cards + cuts wasted work);
   *   - container removal is GC-safe.
   */
  const lastSignatureByElement = new WeakMap();

  function buildSignature(parts) {
    return parts.map((part) => {
      if (part === null || part === undefined) return '';
      if (typeof part === 'object') return JSON.stringify(part);
      return String(part);
    }).join('|');
  }

  function paintSlot(container, signature, buildMarkup) {
    if (!container) return;
    if (lastSignatureByElement.get(container) === signature) return;
    container.innerHTML = buildMarkup();
    lastSignatureByElement.set(container, signature);
  }

  function renderSettingsV2Surfaces(options) {
    const escapeHtml = options?.escapeHtml;
    const slots = options?.slots || {};
    const data = options?.data || {};
    if (slots.setupProgress) {
      const setup = data.setup || {};
      const sig = buildSignature(['setup', setup.setupComplete, setup.updatedAt, JSON.stringify(setup.steps || {})]);
      paintSlot(slots.setupProgress, sig, () => buildSetupProgressMarkup({ setup, escapeHtml }));
    }
  }

  return {
    buildSetupProgressMarkup,
    renderSettingsV2Surfaces,
  };
});
