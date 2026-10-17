/* Shared next-send projection and refresh subscriptions. No prompt contents leave the service. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-context-usage-model'));
    return;
  }
  root.rendererContextPreview = factory(root.rendererContextUsageModel);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (usage) {
  'use strict';

  function markStale(summary, sectionKeys) {
    if (!summary || typeof summary !== 'object') return summary;
    const next = { ...summary };
    sectionKeys.forEach((key) => {
      if (next[key]?.state === 'available') next[key] = { ...next[key], state: 'stale' };
    });
    return next;
  }

  function withDraft(preview, text, attachments) {
    if (!preview?.breakdown || !Number.isSafeInteger(preview.used_tokens)) return preview;
    const draftTokens = usage.estimateTextTokens(text) + usage.estimateAttachmentTokens(attachments);
    const used = preview.used_tokens + draftTokens;
    return { ...preview, used_tokens: used,
      available_tokens: preview.capacity_tokens == null ? null : Math.max(0, preview.capacity_tokens - used),
      breakdown: { ...preview.breakdown, messages: preview.breakdown.messages + draftTokens } };
  }

  function bindRefresh({ pane, win, listen, syncSession, scheduleFetch, paint, visible, options }) {
    const draftSelector = '[data-chat-node="chatInput"], #chatInput';
    let inputsKey = options.getSummaryKey?.() ?? null; // mount already fetched for these inputs
    let paintedDraft;
    const paintDraft = () => { paintedDraft = pane.querySelector?.(draftSelector)?.value; paint(); };
    listen(pane, 'composer-state-rendered', () => {
      const changed = syncSession();
      const next = options.getSummaryKey?.() ?? null;
      if (!changed && next !== inputsKey) scheduleFetch();
      inputsKey = next;
      paintDraft();
    });
    listen(win, 'focus', scheduleFetch);
    // A keystroke already painted by composer-state-rendered is not painted twice.
    listen(pane, 'input', (event) => {
      if (event.target.matches?.(draftSelector) && event.target.value !== paintedDraft) paintDraft();
    });
    // External prompt/instruction edits have no renderer event.
    const timer = options.refreshIntervalMs > 0 ? win.setInterval(() => {
      if (visible() && pane.ownerDocument.visibilityState !== 'hidden') scheduleFetch();
    }, options.refreshIntervalMs) : null;
    return () => { if (timer) win.clearInterval(timer); };
  }

  return { withDraft, bindRefresh, markStale };
});
