(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererPlanModeShortcut = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function handlePlanModeShortcut(event, documentRef) {
    if (!event || event.defaultPrevented || event.repeat || !event.altKey
      || event.ctrlKey || event.metaKey || String(event.key || '').toLowerCase() !== 'p') return false;
    const togglePlanMode = globalThis.rendererRunModeControl?.togglePlanMode;
    if (typeof togglePlanMode !== 'function') return false;
    event.preventDefault();
    togglePlanMode();
    return true;
  }

  function handleRunModeCycleShortcut(event, documentRef) {
    if (!event || event.defaultPrevented || event.repeat || !event.shiftKey
      || event.ctrlKey || event.altKey || event.metaKey || String(event.key || '') !== 'Tab') return false;
    const cycleRunMode = globalThis.rendererRunModeControl?.cycleRunMode;
    if (typeof cycleRunMode !== 'function') return false;
    event.preventDefault();
    cycleRunMode();
    return true;
  }

  return { handlePlanModeShortcut, handleRunModeCycleShortcut };
});
