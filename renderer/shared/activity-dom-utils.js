(function exposeActivityDomUtils(globalScope, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  if (globalScope && typeof globalScope === 'object') {
    globalScope.activityDomUtils = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function activityDomUtilsFactory() {
  function isBusy(snapshot) {
    return Boolean(snapshot && snapshot.state === 'pending');
  }

  function applyActivityAttributes(target, snapshot, options) {
    if (!target || !target.dataset) {
      return;
    }
    var settings = options || {};
    if (!snapshot || !snapshot.state || snapshot.state === 'idle') {
      delete target.dataset.activityState;
      delete target.dataset.activityEmphasis;
      delete target.dataset.activityScope;
      target.removeAttribute('data-busy');
      if (settings.setAriaBusy) {
        target.removeAttribute('aria-busy');
      }
      return;
    }
    target.dataset.activityState = String(snapshot.state || 'idle');
    target.dataset.activityEmphasis = String(snapshot.emphasis || 'subtle');
    target.dataset.activityScope = String(snapshot.scope || '');
    if (isBusy(snapshot)) {
      target.setAttribute('data-busy', 'true');
    } else {
      target.removeAttribute('data-busy');
    }
    if (settings.setAriaBusy) {
      target.setAttribute('aria-busy', isBusy(snapshot) ? 'true' : 'false');
    }
  }

  return {
    applyActivityAttributes: applyActivityAttributes,
    isBusy: isBusy,
  };
});
