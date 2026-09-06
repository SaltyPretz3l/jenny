(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTaskBriefUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_TASK_BRIEF_CHARS = 200 + 2 + 4000;
  const TASK_BRIEF_FOOTER_PREFIX = '---\nJenny task id: ';

  function buildTaskBrief(task, { linkedTaskId } = {}) {
    const title = String(task?.title ?? task?.label ?? '').trim();
    let notes = String(task?.body ?? task?.notes ?? '').trim();
    const id = String(linkedTaskId || '').trim();
    if (!id) return notes ? `${title}\n\n${notes}` : title;

    const footer = `\n\n${TASK_BRIEF_FOOTER_PREFIX}${id}\nWhen this work is done, call task_board { action: "complete", id: "${id}" }.`;
    const notesLimit = MAX_TASK_BRIEF_CHARS - title.length - 2 - footer.length;
    if (notes.length > notesLimit) {
      notes = `${notes.slice(0, Math.max(0, notesLimit - 1))}…`;
    }
    // The chip path has no notes: never emit an empty notes block before the footer.
    return `${title}${notes ? `\n\n${notes}` : ''}${footer}`;
  }

  return {
    buildTaskBrief,
    TASK_BRIEF_FOOTER_PREFIX,
    MAX_TASK_BRIEF_CHARS,
  };
});
