/* renderer/features/board/board-view-switch.js - the Canvas | Outline switch (UMD).
 *
 * The inventory segmented control with two options, labelled "Board view". The chosen view is remembered per
 * project through the layout store (`viewOf` / `saveView`), so a project comes back in the view it was left in.
 * A click and `set(view)` both save the choice and call `onChange(view)`. `get()` answers for the project
 * `getProjectId()` names now and brings the control into step with it, so a project switch needs no extra call.
 * Nothing runs before createBoardViewSwitch; dispose() removes the listener and the element. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardViewSwitch = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const defaultJt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const VIEWS = Object.freeze(['canvas', 'outline']);

  function primitive(name, path) {
    if (globalThis[name]) return globalThis[name];
    if (typeof require === 'function') {
      try { return require(path); } catch (_error) { /* not loadable here */ }
    }
    return null;
  }

  function createBoardViewSwitch(deps) {
    const jt = deps.jt || defaultJt;
    const doc = deps.document;
    const segmented = deps.segmentedControl || primitive('inventorySegmentedControl', '../../inventory/segmented-control');
    const store = deps.layoutStore || primitive('rendererBoardLayoutStore', './board-layout-store').createLayoutStore({ storage: deps.storage, model: null });
    const projectId = () => String(typeof deps.getProjectId === 'function' ? deps.getProjectId() || '' : '');
    const onChange = typeof deps.onChange === 'function' ? deps.onChange : () => {};

    const element = doc.createElement('div');
    element.className = 'board-view-switch';
    element.setAttribute('data-board-view-switch', '');
    element.insertAdjacentHTML('beforeend', segmented({
      id: 'board-view', className: 'inv-segmented--compact', ariaLabel: jt('board.view.label', 'Board view'), value: store.viewOf(projectId()),
      options: [{ value: 'canvas', label: jt('board.view.canvas', 'Canvas') }, { value: 'outline', label: jt('board.view.outline', 'Outline') }],
    }));
    const group = element.firstElementChild;
    if (typeof segmented.initSegmentedHandlers === 'function') segmented.initSegmentedHandlers(element);

    let silent = false;
    let saved = store.viewOf(projectId());
    let disposed = false;

    function show(view) {
      silent = true;
      try { segmented.select(group, view); } finally { silent = false; }
    }

    function shown() {
      const on = group.querySelector('[aria-checked="true"]');
      return on ? on.getAttribute('data-value') : 'canvas';
    }

    function get() {
      saved = store.viewOf(projectId());
      if (saved !== shown()) show(saved);
      return saved;
    }

    function set(view) {
      if (disposed || !VIEWS.includes(view)) return;
      if (view !== shown()) show(view);
      saved = view;
      store.saveView(projectId(), view);
      onChange(view);
    }

    // The page-wide handler of the inventory and this element's own both answer a key, so a repeat of the
    // view already shown is not a change.
    function onSegmented(event) {
      const value = event.detail && event.detail.value;
      if (silent || disposed || !VIEWS.includes(value) || value === saved) return;
      saved = value;
      store.saveView(projectId(), value);
      onChange(value);
    }
    element.addEventListener('inv-segmented-change', onSegmented);

    return {
      element,
      get,
      set,
      dispose() {
        if (disposed) return;
        disposed = true;
        element.removeEventListener('inv-segmented-change', onSegmented);
        element.remove();
      },
    };
  }

  return { createBoardViewSwitch, VIEWS };
});
