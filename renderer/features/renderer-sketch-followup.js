/**
 * renderer/features/renderer-sketch-followup.js: a follow-up drawing keeps its nodes where the earlier
 * drawing had them (the project board plan section 5.5, slice S7).
 *
 * Loaded lazily with the sketch frame host (SKETCH_ACTION_MODULES). It does nothing until `attach(host)`.
 * Two jobs: it remembers the positions of each drawing the host draws, in memory only and per source text, and
 * it tells the host which sketch blocks came earlier in the same conversation, nearest first, so the frame can
 * pick the one the new drawing follows (`pickPrevious` in the frame's bundle). A source the module has not seen
 * drawn goes out with `positions: null` and the frame lays it out fresh.
 *
 * Which blocks are "earlier" is read from the page, not from the conversation's messages: the chat list is
 * virtualized, so a block that has scrolled far out of view is not in the DOM and does not count. The message
 * list is not reachable from a lazily loaded module without editing an eager file.
 */
/* global document */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSketchFollowUp = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_EARLIER = 4;
  const MAX_REMEMBERED = 50;
  // The same limits the host puts on a drawing's source; a block over them is never drawn, so never earlier.
  const MAX_CHARS = 16384;
  const MAX_LINES = 400;
  const CODE_SELECTOR = 'pre > code.language-sketch';
  // One message list: the chat timeline of a pane. A block outside any (the full-window viewer) has no earlier ones.
  const CONVERSATION_SELECTOR = '.chat-timeline, [data-chat-node="chatTimeline"]';
  const EXCLUDED_SELECTOR = '.reasoning-row-panel, .markdown-mermaid-block';

  function withinBounds(source) {
    if (!source.trim() || source.length > MAX_CHARS) return false;
    let lines = 1;
    for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) {
      lines += 1;
      if (lines > MAX_LINES) return false;
    }
    return true;
  }

  /** The sketch code blocks of a conversation, in page order, as the host would draw them. */
  function sketchBlocksIn(conversation) {
    const blocks = [];
    for (const code of conversation.querySelectorAll(CODE_SELECTOR)) {
      const block = typeof code.closest === 'function' ? code.closest('.markdown-code-block') : null;
      if (block && !blocks.includes(block) && !block.closest(EXCLUDED_SELECTOR)) blocks.push(block);
    }
    return blocks;
  }

  function attach(host) {
    if (!host || typeof host.onDrawn !== 'function' || typeof host.setEarlierProvider !== 'function') {
      return function detach() {};
    }
    // source text -> positions, oldest first (a Map keeps insertion order; a read or a write moves a key to the end).
    let remembered = new Map();
    let attached = true;

    function remember(source, positions) {
      if (typeof source !== 'string' || !positions || typeof positions !== 'object') return;
      remembered.delete(source);
      remembered.set(source, positions);
      while (remembered.size > MAX_REMEMBERED) remembered.delete(remembered.keys().next().value);
    }

    function recall(source) {
      const positions = remembered.get(source);
      if (!positions) return null;
      remembered.delete(source);
      remembered.set(source, positions);
      return positions;
    }

    function sourceOfBlock(block) {
      const known = typeof host.sourceOf === 'function' ? host.sourceOf(block) : '';
      if (known) return known;
      const code = block.querySelector(CODE_SELECTOR);
      return code ? String(code.textContent || '') : '';
    }

    /** The earlier sketch blocks of the block's conversation, nearest first, at most four. */
    function provider(block) {
      const conversation = block && typeof block.closest === 'function' ? block.closest(CONVERSATION_SELECTOR) : null;
      if (!conversation) return [];
      const blocks = sketchBlocksIn(conversation);
      const index = blocks.indexOf(block);
      const earlier = [];
      for (let at = index - 1; at >= 0 && earlier.length < MAX_EARLIER; at -= 1) {
        const source = sourceOfBlock(blocks[at]);
        if (withinBounds(source)) earlier.push({ source, positions: recall(source) });
      }
      return earlier;
    }

    const stop = host.onDrawn(function (drawn) {
      if (!drawn || !drawn.block || typeof host.getPositions !== 'function') return;
      remember(drawn.source, host.getPositions(drawn.block));
    });
    host.setEarlierProvider(provider);

    return function detach() {
      if (!attached) return;
      attached = false;
      if (typeof stop === 'function') stop();
      host.setEarlierProvider(null);
      remembered = new Map();
    };
  }

  return { attach };
});
