/* renderer/features/renderer-suggestion-utils.js – rotating fallback suggestions and prompt chip rendering (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSuggestionUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function createSuggestionController(deps) {
    const { state, staticModel } = deps;
    const { promptGrid } = deps.dom;
    const { escapeHtml = (v) => String(v ?? '') } = deps.callbacks || {};

    var _fallbackPool = [
      'What should I focus on today?',
      'Help me think through a decision I need to make',
      'What is one thing I could do right now to feel more on track?',
      'Help me organize my thoughts about something important',
      'What questions should I be asking myself right now?',
      'Help me brainstorm ideas for a project',
      'Walk me through the pros and cons of something',
      'Help me write something I have been putting off',
      'What is the simplest next step I can take?',
      'Help me reflect on how this week went',
      'Summarize what I should know before a big meeting',
      'Help me turn a vague idea into a concrete plan',
    ];
    var _currentFallbackSet = [];
    var _fallbackRotationTimer = 0;
    var FALLBACK_ROTATION_INTERVAL_MS = 45000;

    function _pickRandomFallbacks(count) {
      var pool = _fallbackPool.slice();
      if (state.companion?.loaded && state.companion.modeMeta) {
        var meta = state.companion.modeMeta;
        var modePrompts = [meta.homePrompt].concat(
          Array.isArray(meta.secondaryPrompts) ? meta.secondaryPrompts : []
        ).filter(Boolean);
        for (var i = 0; i < modePrompts.length; i++) {
          if (pool.indexOf(modePrompts[i]) === -1) pool.push(modePrompts[i]);
        }
      }
      var picked = [];
      while (picked.length < count && pool.length > 0) {
        var idx = Math.floor(Math.random() * pool.length);
        picked.push(pool[idx]);
        pool.splice(idx, 1);
      }
      return picked;
    }

    function _getRotatingFallbacks() {
      if (!_currentFallbackSet.length) {
        _currentFallbackSet = _pickRandomFallbacks(3);
      }
      return _currentFallbackSet;
    }

    function _startFallbackRotation() {
      if (_fallbackRotationTimer) return;
      _fallbackRotationTimer = setInterval(function () {
        if (state.suggestions?.status === 'ready' && state.suggestions.items?.length > 0) return;
        _currentFallbackSet = _pickRandomFallbacks(3);
        renderPrompts();
      }, FALLBACK_ROTATION_INTERVAL_MS);
    }

    function _stopFallbackRotation() {
      if (_fallbackRotationTimer) {
        clearInterval(_fallbackRotationTimer);
        _fallbackRotationTimer = 0;
      }
    }

    function renderPrompts() {
      var prompts;
      var chipClass = 'prompt-chip';
      var status = state.suggestions ? state.suggestions.status : 'idle';
      var tipMarkup = '';
      var activeTip = state.tips && state.tips.featureEnabled && state.tips.settings && state.tips.settings.enabled !== false
        ? state.tips.activeTip
        : null;

      if (status === 'ready' && state.suggestions.items && state.suggestions.items.length > 0) {
        prompts = state.suggestions.items;
        chipClass = 'prompt-chip suggestion-reveal';
        _stopFallbackRotation();
      } else {
        prompts = _getRotatingFallbacks();
        _startFallbackRotation();
      }

      if (!prompts || prompts.length === 0) {
        prompts = staticModel.suggestions;
      }

      if (activeTip && activeTip.title) {
        tipMarkup = `
          <button
            class="prompt-chip"
            type="button"
            data-tip-settings="${escapeHtml(activeTip.settingsSection || 'home')}"
            title="${escapeHtml(activeTip.body || activeTip.title)}"
          >
            Tip: ${escapeHtml(activeTip.title)}
          </button>
        `;
      }

      promptGrid.innerHTML = tipMarkup + prompts
        .map(
          (prompt, index) => `
          <button class="${chipClass}" type="button" data-prompt="${escapeHtml(prompt)}" title="${escapeHtml(prompt)}" aria-label="${escapeHtml(prompt)}" style="--suggestion-reveal-index:${Math.max(index, 0)}">
            ${escapeHtml(prompt)}
          </button>
        `
        )
        .join('');
    }

    return { renderPrompts, stopFallbackRotation: _stopFallbackRotation };
  }

  return { createSuggestionController };
});
