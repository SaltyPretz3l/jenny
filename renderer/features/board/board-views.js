/* renderer/features/board/board-views.js - the board's two views and what they share (UMD, global rendererBoardViews).
 *
 * The centre column of the Board page holds one element from here. Inside it: the canvas (board-canvas-view.js), the
 * outline (board-outline-view.js) over it, and the find box over both. This module owns only how they go together:
 *  - which view shows. The choice is the view switch's (board-view-switch.js, remembered per project). The view
 *    that is not shown is hidden from the pointer, the keyboard and assistive technology, never only covered;
 *  - where the switch sits: in the canvas toolbar's slot while the canvas shows, at the end of the outline's bar
 *    while the outline shows, so it is always one click away;
 *  - the canvas's keyboard map (board-keyboard.js), attached to the canvas only, so the outline keeps its own keys;
 *  - find: one box for both views. Ctrl+F (Cmd+F on macOS) opens it from the outline too; its matches light up in
 *    both views, and the match it walks to is brought into sight on the canvas.
 *
 * The views need the board editor, which the page can build only once it knows its source, so the element exists
 * from the start and `setEditor(editor)` fills it in, once. Nothing here reads or writes a board. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardViews = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* deps: document, canvas (the canvas view), layoutStore, getProjectId(), jt, model, actionButton, boardCard, onViewChange(view),
   *   modules: { find, outline, keyboard, viewSwitch } (the four modules' exports).
   * Returns { element, setEditor(editor), sync(), getView(), focus(), openFind(), dispose() }. */
  function createBoardViews(deps) {
    const doc = deps.document;
    const canvas = deps.canvas;
    const modules = deps.modules || {};
    const onViewChange = typeof deps.onViewChange === 'function' ? deps.onViewChange : () => {};

    const element = doc.createElement('div');
    element.className = 'board-views';
    element.setAttribute('data-board-views', '');
    element.appendChild(canvas.element);

    let editor = null;
    let outline = null;
    let find = null;
    let keyboard = null;
    let viewSwitch = null;
    let current = 'canvas';
    let disposed = false;

    function placeSwitch() {
      if (!viewSwitch) return;
      const home = current === 'outline'
        ? outline.element.querySelector('.board-outline__bar')
        : canvas.element.querySelector('[data-board-toolbar-slot]');
      if (home && viewSwitch.element.parentNode !== home) home.appendChild(viewSwitch.element);
    }

    // `byPerson`: the switch was used, so focus follows into the view that opened.
    function apply(view, byPerson) {
      if (disposed || !outline) return;
      const next = view === 'outline' ? 'outline' : 'canvas';
      const changed = next !== current;
      current = next;
      element.setAttribute('data-board-view', current);
      canvas.element.hidden = current === 'outline';
      outline.element.hidden = current !== 'outline';
      placeSwitch();
      if (current === 'outline' && (changed || byPerson)) outline.show(editor.getBoard());
      if (changed) onViewChange(current);
      if (byPerson && current === 'outline') outline.focusFirst();
    }

    function onMatches(ids, currentId) {
      canvas.setMatches(ids);
      outline.setMatches(ids);
      if (currentId && current === 'canvas') canvas.reveal(currentId);
    }

    // The canvas has its own key map; from the outline, find is the one key this module adds.
    function onKeyDown(event) {
      if (!find || event.defaultPrevented || event.altKey || event.shiftKey) return;
      if ((event.key !== 'f' && event.key !== 'F') || !(event.ctrlKey || event.metaKey)) return;
      if (!outline.element.contains(event.target)) return;
      event.preventDefault();
      find.open();
    }

    // The outline redraws its whole tree on every board change. While it is hidden nobody sees that, and on a 500-card board
    // it is most of the cost of every drag, so it hears the editor only while it shows; apply() draws it afresh when it comes back.
    function whileShown(source) {
      return Object.assign({}, source, {
        onChange: (listener) => source.onChange((change) => { if (current === 'outline') listener(change); }),
      });
    }

    function setEditor(next) {
      if (disposed || editor || !next) return;
      editor = next;
      outline = modules.outline.createBoardOutlineView({ document: doc, editor: whileShown(editor), model: deps.model, jt: deps.jt, find: modules.find, actionButton: deps.actionButton, boardCard: deps.boardCard, activate: (id) => canvas.activate(id, 'outline') });
      outline.element.hidden = true;
      element.appendChild(outline.element);
      find = modules.find.createBoardFind({ document: doc, jt: deps.jt, actionButton: deps.actionButton, getBoard: () => editor.getBoard(), onMatches });
      element.appendChild(find.element);
      keyboard = modules.keyboard.createBoardKeyboard({ editor, view: canvas, openFind: () => find.open(), jt: deps.jt });
      keyboard.attach(canvas.element);
      viewSwitch = modules.viewSwitch.createBoardViewSwitch({
        document: doc, layoutStore: deps.layoutStore, getProjectId: deps.getProjectId, jt: deps.jt,
        onChange: (view) => apply(view, true),
      });
      element.addEventListener('keydown', onKeyDown);
      apply(viewSwitch.get(), false);
    }

    return {
      element,
      setEditor,
      // After the project changed or a board was read: the view this project was left in.
      sync() { if (viewSwitch && !disposed) apply(viewSwitch.get(), false); },
      getView: () => current,
      // Focus into the view on screen; false when that is the canvas (the workbench focuses it).
      focus() { if (current !== 'outline' || !outline) return false; outline.focusFirst(); return true; },
      openFind() { if (find) find.open(); },
      dispose() {
        if (disposed) return;
        disposed = true;
        element.removeEventListener('keydown', onKeyDown);
        [keyboard, find, viewSwitch, outline].forEach((part) => { if (part) part.dispose(); });
        element.remove();
      },
    };
  }

  return { createBoardViews };
});
