'use strict';

/* renderer/computer-pill/pill.js: draws the computer-use frame or pill from main's state (row 196, C6).
 * Main sends the finished words ({ paused, dot, text, keyHint, resumeLabel, stopLabel }); this page only shows
 * them, reports the pill's size so the window fits it, and sends Resume or Stop. It works in Node tests too. */

(function computerPill(root) {
  function render(doc, view) {
    if (!view || typeof view !== 'object') return;
    const frame = doc.getElementById('cuFrame');
    if (frame) frame.classList.toggle('cu-frame--paused', view.paused === true);
    const dot = doc.getElementById('cuPillDot');
    if (!dot) return;
    dot.className = `status-dot status-dot--${view.dot === 'warn' ? 'warn' : 'active'}`;
    doc.getElementById('cuPillText').textContent = String(view.text || '');
    const resume = doc.getElementById('cuPillResume');
    if (!resume) return;
    resume.textContent = String(view.resumeLabel || '');
    resume.hidden = view.paused !== true;
    resume.disabled = false;
    const stop = doc.getElementById('cuPillStop');
    stop.textContent = String(view.stopLabel || '');
    stop.disabled = false;
    doc.getElementById('cuPillKey').textContent = String(view.keyHint || '');
  }

  // The two buttons come from the inventory primitive, placed before the key hint.
  function addButtons(doc, actionButton) {
    const key = doc.getElementById('cuPillKey');
    if (!key || typeof actionButton !== 'function' || doc.getElementById('cuPillStop')) return;
    key.insertAdjacentHTML('beforebegin', actionButton({ domId: 'cuPillResume', variant: 'primary', size: 'sm' })
      + actionButton({ domId: 'cuPillStop', size: 'sm' }));
    doc.getElementById('cuPillResume').hidden = true;
  }

  function mount(doc, bridge, actionButton) {
    if (!doc || !bridge || typeof bridge.onState !== 'function') return null;
    const pill = doc.getElementById('cuPill');
    if (pill) addButtons(doc, actionButton);
    let lastSize = '';
    const report = () => {
      if (!pill || typeof bridge.size !== 'function') return;
      const box = pill.getBoundingClientRect();
      const width = Math.ceil(box.width) + 2;
      const height = Math.ceil(box.height) + 2;
      if (box.width <= 0 || box.height <= 0 || `${width}x${height}` === lastSize) return;
      lastSize = `${width}x${height}`;
      void Promise.resolve(bridge.size(width, height)).catch(() => {});
    };
    const press = (id, call) => {
      const button = doc.getElementById(id);
      if (!button) return;
      button.addEventListener('click', () => {
        button.disabled = true;
        void Promise.resolve(call()).catch(() => {}).finally(() => { button.disabled = false; });
      });
    };
    press('cuPillResume', () => bridge.resume());
    press('cuPillStop', () => bridge.stop());
    return bridge.onState((view) => { render(doc, view); report(); });
  }

  if (typeof module === 'object' && module.exports) module.exports = { mount, render };
  if (root && root.document && root.jennyComputerPill) mount(root.document, root.jennyComputerPill, root.inventoryActionButton);
}(typeof window !== 'undefined' ? window : null));
