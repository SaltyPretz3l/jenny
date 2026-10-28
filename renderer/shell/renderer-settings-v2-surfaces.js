/* renderer/shell/renderer-settings-v2-surfaces.js
 * Builds the wired setup-progress surface, and owns paintSlot: the per-element
 * signature guard the Settings hosts use to skip unchanged innerHTML writes.
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
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const { STEP_ORDER, countCompletedSteps, statusMeta } = sceneUtils;
  const SETUP_STEP_LABELS = Object.freeze({
    workspaceRoot: jt('settings.setup.workspaceRoot', 'Workspace root'),
    localModel: jt('settings.setup.localModel', 'Local model'),
    endpoint: jt('settings.setup.endpoint', 'Endpoint'),
    personality: jt('settings.sections.personality.title', 'Personality'),
    skills: jt('settings.sections.skills.title', 'Skills'),
    capabilities: jt('settings.setup.capabilities', 'Tools and permissions'),
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

  const MODEL_PATH_PARTNER = Object.freeze({ localModel: 'endpoint', endpoint: 'localModel' });

  function dotTone(sceneTone) {
    return SCENE_TONE_TO_DOT[String(sceneTone || '')] || 'muted';
  }

  function buildSetupProgressMarkup(options) {
    const setup = options?.setup || {};
    const steps = setup.steps || {};
    const escapeHtml = options.escapeHtml;
    const total = STEP_ORDER.length;
    const done = countCompletedSteps(steps);
    const items = STEP_ORDER.map((key) => {
      let status = steps[key] || 'pending';
      let meta = statusMeta(status);
      // Setup needs one model path: once the other one is done, an untouched path is not work left.
      const otherModelPath = MODEL_PATH_PARTNER[key];
      if (otherModelPath && status === 'pending' && steps[otherModelPath] === 'done') {
        status = 'not_needed';
        meta = { tone: 'muted', label: jt('settings.setup.notNeeded', 'Not needed') };
      }
      return `<li class="settings-progress-item" data-status="${escapeHtml(status)}">
        <span class="settings-progress-dot status-dot status-dot--${escapeHtml(dotTone(meta.tone))}" aria-hidden="true"></span>
        <span class="settings-progress-label">${escapeHtml(SETUP_STEP_LABELS[key] || key)}</span>
        <span class="settings-progress-status">${escapeHtml(meta.label)}</span>
      </li>`;
    }).join('');
    // The headline follows the same current-health rule as the Setup row in
    // Account (renderer-settings-core-renderers.js), never the persisted
    // setupComplete flag, which stays true after a required step regresses.
    const complete = sceneUtils.computeSetupHealth(setup).state === 'complete';
    // The bar agrees with that headline: a healthy setup is full even with the
    // other model path or optional steps open, and an unhealthy one never is.
    const pct = complete ? 100 : Math.min(99, Math.round((done / total) * 100));
    const summary = complete
      ? jt('settings.setup.completeSummary', 'Setup is complete. Re-run any step to refine your settings.')
      : jt('settings.setup.stepsComplete', '{done} of {total} steps complete.', { done, total });
    return `<div class="settings-progress-card" data-component="settings-setup-progress">
      <div class="settings-progress-header">
        <span class="kicker">${escapeHtml(jt('settings.setup.progress', 'Setup progress'))}</span>
        <span class="settings-progress-percent" aria-label="${escapeHtml(jt('settings.setup.percentCompleteAria', 'Setup percent complete'))}">${pct}%</span>
      </div>
      <div class="settings-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">
        <span class="settings-progress-fill"${pct >= 100 ? ' data-complete="true"' : ''} style="width: ${pct}%"></span>
      </div>
      <p class="settings-progress-summary">${escapeHtml(summary)}</p>
      <ul class="settings-progress-list" role="list">${items}</ul>
    </div>`;
  }

  /*
   * Each host's last-painted signature, keyed by the element in a WeakMap, so:
   *   - re-renders with identical data skip the innerHTML rewrite (keeps focus,
   *     <details> open state and control state a binding patched in place, and
   *     cuts wasted work);
   *   - container removal is GC-safe.
   */
  const lastSignatureByElement = new WeakMap();

  // Writes buildMarkup() into the container only when the signature changed and
  // returns whether it wrote. Without buildMarkup the signature is the markup.
  function paintSlot(container, signature, buildMarkup) {
    if (!container) return false;
    if (lastSignatureByElement.get(container) === signature) return false;
    container.innerHTML = typeof buildMarkup === 'function' ? buildMarkup() : signature;
    lastSignatureByElement.set(container, signature);
    return true;
  }

  // A caller changed the host's DOM by hand: its next paint writes unconditionally.
  function forgetSlot(container) {
    if (container) lastSignatureByElement.delete(container);
  }

  function renderSettingsV2Surfaces(options) {
    const escapeHtml = options?.escapeHtml;
    const slots = options?.slots || {};
    const data = options?.data || {};
    if (slots.setupProgress) {
      const setup = data.setup || {};
      // Resolved at call time; the snapshot-poll module loads with the page shell.
      const { buildSignature } = globalThis.rendererSettingsSnapshotPoll
        || (typeof require === 'function' ? require('./renderer-settings-snapshot-poll') : null);
      const sig = buildSignature(['setup', setup.setupComplete, setup.updatedAt, JSON.stringify(setup.steps || {})]);
      paintSlot(slots.setupProgress, sig, () => buildSetupProgressMarkup({ setup, escapeHtml }));
    }
  }

  return {
    buildSetupProgressMarkup,
    renderSettingsV2Surfaces,
    paintSlot,
    forgetSlot,
  };
});
