(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsOverlays = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function positionPopover(button, popover, windowRef) {
    if (!button || !popover || !windowRef || typeof button.getBoundingClientRect !== 'function') {
      return;
    }
    const buttonRect = button.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const viewportWidth = Number(windowRef.innerWidth || 0) || 0;
    const top = Math.max(buttonRect.top - popoverRect.height - 10, 16);
    const left = Math.min(
      Math.max(buttonRect.left, 16),
      Math.max(viewportWidth - popoverRect.width - 16, 16)
    );
    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
  }

  function createSettingsOverlayRenderer(deps) {
    const state = deps?.state || {};
    const windowRef = deps?.windowRef || (typeof globalThis !== 'undefined' ? globalThis : {});
    const {
      composerAttachMenu,
      composerAttachShortcut,
    } = deps?.dom || {};

    function renderComposerPopover() {
      const open = Boolean(state.ui.composerPopoverOpen);
      if (!composerAttachMenu || !composerAttachShortcut) return;
      composerAttachMenu.classList.toggle('hidden', !open);
      composerAttachShortcut.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (!open) {
        return;
      }
      positionPopover(composerAttachShortcut, composerAttachMenu, windowRef);
    }

    // Nothing to release: kept so the shell's dispose chain stays uniform.
    function dispose() {}

    return {
      renderComposerPopover,
      dispose,
    };
  }

  return { createSettingsOverlayRenderer };
});
