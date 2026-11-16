/* renderer/features/renderer-board-block-row.js - a `board` code block in a chat reply, as one compact row (UMD, global
 * rendererBoardBlockRow).
 *
 * Jenny answers a turn sent from the Board with a fenced `board` block (note ..., n3 -> f2 blocks, edit n3 ..., tidy g1). The
 * main process turns it into a proposal; in the chat the block is only a list of lines, so it becomes one row: a dot, "Proposed N
 * board changes" and a Show button that opens the original code block under the row. On the Board page, with this chat docked
 * beside it, the row also has Review, which shows the Changes view (the stylesheet shows that button only inside
 * [data-board-chat-host]). The code block itself stays in the page as it was, hidden until Show, so Copy still works.
 *
 * Loaded lazily by renderer-mermaid-runtime-loader.js the first time a `board` block is found with `project_boards` on; nothing of it
 * is in index.html. A block is replaced only when the reply answers a turn sent from a board: the nearest earlier user message
 * of the chat carries the board mark, [data-message-mark="board"] (renderer-transcript-attachments.js). A block still streaming is left alone.
 * The block's lines are only counted here; nothing is read from them. Row 150, slice C3. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardBlockRow = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const STYLESHEET_HREF = 'styles/markdown-sketch.css';
  let sequence = 0;

  /** The lines of a block that are changes: not blank and not starting with a pipe once trimmed. */
  function countLines(body) {
    return String(body || '').split(/\r\n|\r|\n/).filter((line) => { const text = line.trim(); return text !== '' && text[0] !== '|'; }).length;
  }

  function labelFor(count) {
    return count === 1 ? jt('chat.boardBlock.one', 'Proposed 1 board change') : jt('chat.boardBlock.many', 'Proposed {count} board changes', { count });
  }

  /** True when the nearest earlier user message of this chat was sent from a board. */
  function answersBoardTurn(wrapper) {
    const entry = typeof wrapper.closest === 'function' ? wrapper.closest('.chat-entry') : null;
    if (!entry) return false;
    const entries = Array.from(wrapper.ownerDocument.querySelectorAll('.chat-entry[data-message-role]'));
    for (let i = entries.indexOf(entry) - 1; i >= 0; i -= 1) {
      if (entries[i].getAttribute('data-message-role') === 'user') return entries[i].querySelector('[data-message-mark="board"]') !== null;
    }
    return false;
  }

  function ensureStylesheet(doc) {
    const head = doc.head || doc.documentElement;
    if (!head || doc.querySelector('link[data-jenny-sketch-styles]')) return; // the sketch host's sheet, shared
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = STYLESHEET_HREF;
    link.setAttribute('data-jenny-sketch-styles', 'true');
    head.appendChild(link);
  }

  // The inventory's button (escaped label and title); null only when the inventory is not in the page.
  function button(doc, label, title, act) {
    const make = globalThis.inventoryActionButton || (typeof require === 'function' ? require('../inventory/action-button') : null);
    if (typeof make !== 'function') return null;
    const holder = doc.createElement('template');
    holder.innerHTML = make({ variant: 'ghost', size: 'sm', className: 'board-block-row__btn', label, title, dataset: { 'board-row-act': act } });
    return holder.content.firstElementChild;
  }

  function buildRow(doc, wrapper, count) {
    if (!wrapper.id) { sequence += 1; wrapper.id = `board-block-${sequence}`; }
    const bar = doc.createElement('div');
    bar.className = 'board-block-row';
    bar.setAttribute('data-board-block-row', '');
    const dot = doc.createElement('span');
    dot.className = 'board-block-row__dot status-dot status-dot--pending';
    dot.setAttribute('aria-hidden', 'true');
    const label = doc.createElement('span');
    label.className = 'board-block-row__label';
    label.textContent = labelFor(count);
    const show = button(doc, jt('chat.boardBlock.show', 'Show'), jt('chat.boardBlock.showTitle', 'Show the lines Jenny wrote'), 'show');
    if (!show) return null;
    show.setAttribute('aria-expanded', 'false');
    show.setAttribute('aria-controls', wrapper.id);
    show.addEventListener('click', () => {
      const open = wrapper.hidden;
      wrapper.hidden = !open;
      show.setAttribute('aria-expanded', open ? 'true' : 'false');
      show.textContent = open ? jt('chat.boardBlock.hide', 'Hide') : jt('chat.boardBlock.show', 'Show');
    });
    bar.append(dot, label, show);
    const page = globalThis.rendererBoardPage;
    if (page && typeof page.revealChanges === 'function') {
      const review = button(doc, jt('chat.boardBlock.review', 'Review'), jt('chat.boardBlock.reviewTitle', 'Show the proposed changes beside the board'), 'review');
      if (review) review.addEventListener('click', () => { try { page.revealChanges(); } catch (_error) { /* the page may be gone */ } });
      if (review) bar.appendChild(review);
    }
    return bar;
  }

  /** Replaces each finished `board` block under `container` with its row. Returns how many rows were made. */
  function render(container, options) {
    if (!container || typeof container.querySelectorAll !== 'function') return 0;
    const streaming = Boolean(options && options.isStreaming);
    const all = Array.from(container.querySelectorAll('pre > code'));
    let made = 0;
    all.forEach((code, index) => {
      if (!code.classList.contains('language-board') || (streaming && index === all.length - 1)) return;
      const wrapper = typeof code.closest === 'function' ? code.closest('.markdown-code-block') : null;
      if (!wrapper || wrapper.closest('.reasoning-row-panel')) return;
      // Done already only while its row still stands above it: a repaint of the reply keeps the code block it knows
      // (hidden, as left) and drops the row, which would leave nothing in the chat to show for the block.
      const above = wrapper.previousElementSibling;
      if (wrapper.classList.contains('markdown-board-block') && above && above.hasAttribute('data-board-block-row')) return;
      const count = countLines(code.textContent);
      if (!count || !answersBoardTurn(wrapper)) return;
      const doc = wrapper.ownerDocument;
      const row = buildRow(doc, wrapper, count);
      if (!row) return;
      ensureStylesheet(doc);
      wrapper.classList.add('markdown-board-block');
      wrapper.parentNode.insertBefore(row, wrapper);
      wrapper.hidden = true;
      made += 1;
    });
    return made;
  }

  return { render, countLines, labelFor };
});
