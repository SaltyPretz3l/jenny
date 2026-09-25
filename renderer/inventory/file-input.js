/* Hidden file chooser primitive for toolbar-driven file selection. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryFileInput = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  return function inventoryFileInput(documentRef, options = {}) {
    const input = documentRef.createElement('input');
    input.type = 'file';
    input.className = String(options.className || '');
    input.accept = String(options.accept || '');
    input.hidden = options.hidden !== false;
    return input;
  };
});
