'use strict';

// Presentation layer for the demo clip recorder: everything that makes a clip
// read as a person using the app rather than a script poking the DOM.
//
//   - OVERLAY_INSTALL_SCRIPT  page-side source (run once per recording) that
//                             installs window.__demoPresentation: an animated
//                             cursor with a click pulse, a caption chip, and
//                             two pins for chrome the scripted engine cannot
//                             drive itself (titlebar telemetry, model label).
//   - DEMO_STYLE_CSS          demo-only stylesheet: the overlay's own styles,
//                             the palette crossfade class, and the engine
//                             lifecycle pill (which only carries meaning with
//                             a live model) hidden.
//   - typingDelays()          human-looking per-character delays from a seed,
//                             so a typed prompt is jittered but reproducible.
//
// Pure module: strings and arithmetic only, no DOM, no I/O. The overlay is
// never part of the app; the recorder injects it after the pre-roll and the
// honesty note in docs/media/README.md discloses it.

const CROSSFADE_CLASS = 'demo-crossfade';
const CROSSFADE_MS = 420;

// Chrome that reads wrong under the scripted replay engine (it never loads a
// real model, so the engine lifecycle pill reports a placeholder state).
// Hidden with visibility so layout is untouched. The composer model pill
// stays visible and is relabelled by pinModelLabel instead.
const HIDDEN_CHROME_SELECTORS = Object.freeze([
  '#workbenchHealthPillSlot',
]);

// Titlebar telemetry as it looks with a local model busy on the GPU. The
// scripted engine never touches the GPU, so the real figures would read idle;
// pinMetrics paints these (jittered each tick) in the app's own markup.
const TELEMETRY_MARKUP_DIVIDER = '<span class="stat-divider" aria-hidden="true"></span>';

const DEMO_STYLE_CSS = [
  `${HIDDEN_CHROME_SELECTORS.map((selector) => `${selector}, ${selector} *`).join(', ')} { visibility: hidden !important; }`,
  // Palette switches crossfade instead of snapping. Gradients cannot
  // transition, so the backdrop still steps; the surfaces and text ease.
  `html.${CROSSFADE_CLASS}, html.${CROSSFADE_CLASS} *:not(canvas) {`
    + ` transition: background-color ${CROSSFADE_MS}ms ease, color ${CROSSFADE_MS}ms ease,`
    + ` border-color ${CROSSFADE_MS}ms ease, fill ${CROSSFADE_MS}ms ease, stroke ${CROSSFADE_MS}ms ease,`
    + ` box-shadow ${CROSSFADE_MS}ms ease !important; }`,
  // A re-themed diagram is a fresh SVG in its final colours; its card must
  // snap with it rather than lag behind for the fade.
  `html.${CROSSFADE_CLASS} .markdown-mermaid-block, html.${CROSSFADE_CLASS} .markdown-mermaid-block * { transition: none !important; }`,
  '#demoCursor { position: fixed; left: 0; top: 0; width: 26px; height: 30px; z-index: 2147483000;'
    + ' pointer-events: none; opacity: 0; transition: opacity 260ms ease;'
    + ' filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.45)); will-change: transform; }',
  '#demoCursor.demo-cursor-visible { opacity: 1; }',
  '#demoCursor.demo-cursor-down { transform-origin: 4px 4px; }',
  '.demo-click-pulse { position: fixed; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;'
    + ' border: 2px solid rgba(255, 255, 255, 0.95); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);'
    + ' z-index: 2147482999; pointer-events: none; animation: demo-click-pulse 420ms ease-out forwards; }',
  '@keyframes demo-click-pulse { from { transform: scale(0.35); opacity: 0.9; } to { transform: scale(1.5); opacity: 0; } }',
  '#demoCaption { position: fixed; left: 50%; top: 64px; transform: translate(-50%, -6px);'
    + ' padding: 7px 14px; border-radius: 999px; font: 500 13px/1.2 "Segoe UI", system-ui, sans-serif;'
    + ' letter-spacing: 0.01em; color: #fff; background: rgba(12, 14, 22, 0.78);'
    + ' box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35), inset 0 0 0 1px rgba(255, 255, 255, 0.12);'
    + ' backdrop-filter: blur(10px); z-index: 2147483001; pointer-events: none; opacity: 0;'
    + ' transition: opacity 240ms ease, transform 240ms ease; white-space: nowrap; }',
  '#demoCaption.demo-caption-visible { opacity: 1; transform: translate(-50%, 0); }',
].join('\n');

// A classic arrow pointer; the hotspot is the top-left tip.
const CURSOR_SVG = '<svg viewBox="0 0 26 30" width="26" height="30" xmlns="http://www.w3.org/2000/svg">'
  + '<path d="M3 2 L3 24 L8.6 18.8 L12.4 27.5 L16.4 25.8 L12.7 17.3 L20.5 17.3 Z"'
  + ' fill="#ffffff" stroke="#111318" stroke-width="1.6" stroke-linejoin="round"/></svg>';

const OVERLAY_INSTALL_SCRIPT = `(() => {
  if (window.__demoPresentation) return true;
  const doc = document;
  const cursor = doc.createElement('div');
  cursor.id = 'demoCursor';
  cursor.innerHTML = ${JSON.stringify(CURSOR_SVG)};
  const caption = doc.createElement('div');
  caption.id = 'demoCaption';
  doc.body.appendChild(cursor);
  doc.body.appendChild(caption);
  const state = { x: 0, y: 0, raf: 0 };
  function place(x, y) {
    state.x = x; state.y = y;
    cursor.style.transform = 'translate3d(' + x + 'px, ' + y + 'px, 0)';
  }
  function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
  function moveTo(x, y, ms) {
    if (state.raf) cancelAnimationFrame(state.raf);
    const fromX = state.x; const fromY = state.y;
    const dx = x - fromX; const dy = y - fromY;
    const dist = Math.hypot(dx, dy);
    // Slight arc: bow the path perpendicular to the travel direction.
    const bow = Math.min(28, dist * 0.08);
    const cx = fromX + dx / 2 - (dy / (dist || 1)) * bow;
    const cy = fromY + dy / 2 + (dx / (dist || 1)) * bow;
    const duration = Math.max(1, ms || 0);
    return new Promise((resolve) => {
      const start = performance.now();
      const frame = (now) => {
        const t = Math.min(1, (now - start) / duration);
        const e = easeInOutCubic(t);
        const px = (1 - e) * (1 - e) * fromX + 2 * (1 - e) * e * cx + e * e * x;
        const py = (1 - e) * (1 - e) * fromY + 2 * (1 - e) * e * cy + e * e * y;
        place(px, py);
        if (t < 1) { state.raf = requestAnimationFrame(frame); } else { state.raf = 0; resolve(); }
      };
      state.raf = requestAnimationFrame(frame);
    });
  }
  function show(x, y) {
    place(x, y);
    requestAnimationFrame(() => cursor.classList.add('demo-cursor-visible'));
  }
  function press() {
    const pulse = doc.createElement('div');
    pulse.className = 'demo-click-pulse';
    pulse.style.left = state.x + 'px';
    pulse.style.top = state.y + 'px';
    doc.body.appendChild(pulse);
    cursor.style.transform = 'translate3d(' + state.x + 'px, ' + state.y + 'px, 0) scale(0.92)';
    setTimeout(() => { place(state.x, state.y); }, 110);
    setTimeout(() => { pulse.remove(); }, 500);
  }
  function setCaption(text) {
    const value = String(text || '');
    if (!value) { caption.classList.remove('demo-caption-visible'); return; }
    caption.textContent = value;
    caption.classList.add('demo-caption-visible');
  }
  function setCrossfade(enabled) {
    doc.documentElement.classList.toggle(${JSON.stringify(CROSSFADE_CLASS)}, enabled === true);
  }
  ${seededRandom.toString()}
  // Paint CPU / GPU / VRAM into #metricList and keep them there: the app
  // rewrites the list on its own refresh timer, so a childList observer puts
  // the pinned markup straight back (before the next paint).
  function pinMetrics(spec) {
    const list = doc.getElementById('metricList');
    if (!list || !spec) return false;
    const random = seededRandom(spec.seed || 1);
    const jitter = (base, span) => Math.round(Number(base) + (random() * 2 - 1) * span);
    const paint = () => {
      const used = (Number(spec.vramUsedGb) + (random() * 2 - 1) * 0.15).toFixed(1);
      const total = Number(spec.vramTotalGb).toFixed(1);
      const items = [['CPU', jitter(spec.cpu, 5) + '%'], ['GPU', jitter(spec.gpu, 4) + '%'], ['VRAM', used + '/' + total + ' GB']];
      state.metricsMarkup = items
        .map(([label, value]) => '<span class="metric-item">' + label + ': ' + value + '</span>')
        .join(${JSON.stringify(TELEMETRY_MARKUP_DIVIDER)});
      if (list.innerHTML !== state.metricsMarkup) list.innerHTML = state.metricsMarkup;
    };
    paint();
    new MutationObserver(() => {
      if (state.metricsMarkup && list.innerHTML !== state.metricsMarkup) list.innerHTML = state.metricsMarkup;
    }).observe(list, { childList: true });
    setInterval(paint, Math.max(250, Number(spec.intervalMs) || 1500));
    return true;
  }
  // Relabel the composer model pill (and show its loaded dot). The app
  // re-syncs the label whenever its inputs change, so a subtree observer
  // reapplies the pinned text the moment it is overwritten.
  function pinModelLabel(text) {
    const slot = doc.getElementById('composerModelPillSlot');
    const value = String(text || '');
    if (!slot || !value) return false;
    const apply = () => {
      const pill = doc.getElementById('composerModelPill');
      const label = pill && pill.querySelector('.inv-chip-label');
      if (!label) return;
      if (label.textContent !== value) label.textContent = value;
      if (!pill.querySelector('.composer-model-pill-dot')) {
        const dot = doc.createElement('span');
        dot.className = 'composer-model-pill-dot status-dot status-dot--ok';
        dot.setAttribute('aria-hidden', 'true');
        pill.insertBefore(dot, pill.firstChild);
      }
    };
    apply();
    new MutationObserver(apply).observe(slot, { childList: true, characterData: true, subtree: true });
    return true;
  }
  window.__demoPresentation = {
    show, moveTo, press, setCaption, setCrossfade, pinMetrics, pinModelLabel,
    position: () => ({ x: state.x, y: state.y }),
  };
  return true;
})()`;

// Deterministic mulberry32 PRNG so a scene types the same way on every run.
function seededRandom(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Per-character delays (ms, applied AFTER each character) around baseMs:
// jittered 0.55x-1.45x, a beat after spaces, a longer one after punctuation.
function typingDelays(text, baseMs, seed) {
  const base = Math.max(0, Number(baseMs) || 0);
  const random = seededRandom(seed);
  const chars = Array.from(String(text || ''));
  return chars.map((char) => {
    let delay = base * (0.55 + random() * 0.9);
    if (char === ' ') delay += base * 0.5;
    if (/[,.?!;:]/.test(char)) delay += base * 2.2;
    return Math.round(delay);
  });
}

module.exports = {
  CROSSFADE_CLASS,
  CROSSFADE_MS,
  HIDDEN_CHROME_SELECTORS,
  TELEMETRY_MARKUP_DIVIDER,
  DEMO_STYLE_CSS,
  OVERLAY_INSTALL_SCRIPT,
  typingDelays,
  seededRandom,
};
