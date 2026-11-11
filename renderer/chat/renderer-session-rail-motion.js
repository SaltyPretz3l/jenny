/* renderer/chat/renderer-session-rail-motion.js - how the Session rail moves and resizes (UMD).

   Row 115 slice 3. Two small controllers the rail (renderer-session-rail.js) mounts per pane:

   createRailLayout  the pane's dock measurements and observers, and the glide: the person's Session toggle
                     glides like every other side panel. It drives the shared createSidePanelMotion
                     (renderer-side-panel-motion.js: 220 ms, one reflow of the reading text through
                     --chat-measure-lock, reduced motion = instant) for the rail's own column. The motion's
                     reader anchors are the pane's `session-rail-reflow` notices, so the pane's scroll
                     coordinator is the only anchoring path. The pane carries
                     data-session-rail-glide = opening | closing | leaving, which styles/chat-session-rail.css
                     reads together with #chatView[data-panel-motion]:
                       opening   the docked rail's column grows, the stage / composer / hero give way to it
                       closing   the reverse; the rail stays up (deferEnd) until its column has collapsed
                       leaving   a side panel opening forces the rail out: the rail is gone in the first frame
                                 (no animation of its own) and the room it held rides the panel's glide
                     Only the toggle (and Ctrl+\) glides. The first paint, a session switch, disposal and a
                     width-driven dock change stay instant.

   createRailResizer a separator on the docked rail's start edge: 240 to 420 px, default 280, kept in
                     localStorage `jenny.sessionRail.v1`, applied as --session-rail-width on the pane. It is
                     modelled on #artifactReviewResizer (pointer drag applies on move and saves on release;
                     arrows step 24, Home the default, End the maximum). A pointer drag holds the reading
                     measure with --chat-measure-lock, so the text does not rewrap on every move; it narrows
                     (anchored) only when the rail has used up the stage's slack, and the release is one reflow
                     bracketed by the reader anchor. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../features/renderer-side-panel-motion'));
    return;
  }
  root.rendererSessionRailMotion = factory(root.rendererSidePanelMotion);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (sidePanelMotion) {
  'use strict';

  const GLIDE_ATTRIBUTE = 'data-session-rail-glide';
  const MOTION_ATTRIBUTE = 'data-panel-motion';
  const REFLOW_EVENT = 'session-rail-reflow';
  const MEASURING_EVENT = 'side-panel-measuring'; // dispatched by renderer-side-panel-motion.js open()
  const STORAGE_KEY = 'jenny.sessionRail.v1';
  const WIDTH_PROPERTY = '--session-rail-width';
  const MEASURE_LOCK_PROPERTY = '--chat-measure-lock';
  const MIN_WIDTH = 240;
  const MAX_WIDTH = 420;
  const DEFAULT_WIDTH = 280;
  const KEY_STEP = 24;
  // The least a locked measure keeps beside the rail; a drag grows the rail freely inside the slack above it.
  const LOCKED_GUTTERS_PX = 32;
  const MIN_MEASURE_PX = 320;

  function clampWidth(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_WIDTH;
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(number)));
  }

  /* ── Layout: docking measurements, the glide, the observers ──────────── */

  function createRailLayout({ pane, rail, stage, chatView, win, getPaneWidth, motionOptions }) {
    // The pane's scroll coordinator captures the reader's anchor on 'before' and restores it on 'after'.
    const notify = (phase) => {
      const EventCtor = win.CustomEvent;
      if (typeof EventCtor === 'function') pane.dispatchEvent(new EventCtor(REFLOW_EVENT, { detail: { phase } }));
    };
    const motion = chatView && sidePanelMotion && typeof sidePanelMotion.createSidePanelMotion === 'function'
      ? sidePanelMotion.createSidePanelMotion({
        ...(motionOptions || {}),
        chatView,
        win,
        getCoordinators: () => [{ captureReaderAnchor: () => notify('before'), restoreReaderAnchor: () => notify('after') }],
      })
      : null;
    let heading = '';
    let starting = false; // this rail's own open is running its measuring step
    const mark = (kind) => { if (kind) pane.setAttribute(GLIDE_ATTRIBUTE, kind); else pane.removeAttribute(GLIDE_ATTRIBUTE); };
    // The person's toggle. `run` lands the new mode; hiding keeps the rail up until its column has collapsed.
    function glide(mode, run) {
      const show = mode === 'docked';
      heading = mode;
      motion.cancel(); // first: a running glide's deferred end clears the mark
      mark(show ? 'opening' : 'closing');
      starting = true;
      try {
        const started = show
          ? motion.open({ panel: rail, applyEnd: run })
          : motion.close({ panel: rail, deferEnd: true, applyEnd: () => { mark(''); run(); } });
        if (!started) mark('');
      } finally {
        starting = false;
      }
    }
    function cancel() {
      if (!motion) return;
      motion.cancel();
      mark('');
    }

    return {
      notify,
      panelActive() {
        if (!chatView) return false;
        if (chatView.classList.contains('artifact-review-open') || chatView.hasAttribute(MOTION_ATTRIBUTE)) return true;
        const context = chatView.querySelector('.chat-context-panel');
        return Boolean(context && !context.classList.contains('collapsed'));
      },
      /* The pane's inline size. The stage gives up the rail's room (a margin) while docked, so the
         pane is the stage plus that margin: measuring it this way cannot feed back on its own answer. */
      paneWidth(docked) {
        if (typeof getPaneWidth === 'function') return Number(getPaneWidth());
        if (!stage) return 0;
        const width = stage.getBoundingClientRect().width;
        if (!(width > 0)) return 0;
        const margin = docked && typeof win.getComputedStyle === 'function' ? Number.parseFloat(win.getComputedStyle(stage).marginInlineEnd) || 0 : 0;
        return width + margin;
      },
      /* Lands `run`, the rail's mode change. `changed` is a docked <-> not change: the toggle glides it, a
         side panel's open being measured carries a rail it forces out, anything else is instant and bracketed
         by the reflow notice. The glide's own anchors replace that bracket, never add to it. */
      commit({ how, mode, changed, run }) {
        if (changed && motion && how === 'glide') glide(mode, run);
        else if (changed && motion && how === 'measuring' && mode !== 'docked') {
          mark('leaving');
          run();
        } else if (changed) {
          notify('before');
          run();
          if (stage) void stage.offsetWidth;
          notify('after');
        } else {
          run();
        }
      },
      // The mode a glide is heading to while it runs, else ''. A repeat of that mode is not applied twice.
      target: () => (motion && motion.state() !== 'idle' ? heading : ''),
      cancel,
      // Decide with a side panel's final layout (side-panel-measuring): a rail it forces out leaves inside its motion.
      onMeasuring(handler) {
        if (!chatView || typeof chatView.addEventListener !== 'function') return () => {};
        const listener = () => {
          if (motion && !starting && motion.state() === 'idle') mark(''); // a mark left by an earlier cancelled glide must not animate another panel's open
          handler();
        };
        chatView.addEventListener(MEASURING_EVENT, listener);
        return () => chatView.removeEventListener(MEASURING_EVENT, listener);
      },
      // The stage's size and the things that decide the dock; a glide mark never outlives the motion attribute.
      watch({ onResize, onChange }) {
        const stops = [];
        if (typeof win.ResizeObserver === 'function' && stage) {
          const resizeObserver = new win.ResizeObserver(onResize);
          resizeObserver.observe(stage);
          stops.push(() => resizeObserver.disconnect());
        }
        if (typeof win.MutationObserver === 'function') {
          const observe = (node, attributeFilter, before) => {
            if (!node) return;
            const observer = new win.MutationObserver(() => { if (before) before(); onChange(); });
            observer.observe(node, { attributes: true, attributeFilter });
            stops.push(() => observer.disconnect());
          };
          observe(chatView, ['class', MOTION_ATTRIBUTE], () => { if (!chatView.hasAttribute(MOTION_ATTRIBUTE)) mark(''); });
          observe(chatView && chatView.querySelector('.chat-context-panel'), ['class']);
          observe(pane, ['class', 'data-pane-hosted']);
        }
        return () => stops.forEach((stop) => stop());
      },
      dispose() {
        if (motion) motion.dispose();
        mark('');
      },
    };
  }

  /* ── Resize ──────────────────────────────────────────────────────────── */

  const peersByWindow = new WeakMap(); // window -> Set of appliers: a saved width reaches every pane's rail

  function readStoredWidth(win) {
    try {
      const raw = win.localStorage.getItem(STORAGE_KEY);
      return raw ? clampWidth(JSON.parse(raw).width) : DEFAULT_WIDTH;
    } catch (_error) {
      return DEFAULT_WIDTH;
    }
  }

  function createRailResizer({ pane, rail, stage, chatTimeline, doc, win, jt, notify }) {
    let width = readStoredWidth(win);
    let drag = null; // { pointerId, dir, startX, startWidth, measure, room, lock }
    const element = doc.createElement('div');
    element.className = 'artifact-review-resizer session-rail-resizer';
    element.setAttribute('role', 'separator');
    element.setAttribute('aria-orientation', 'vertical');
    element.setAttribute('aria-label', jt('chat.sessionRail.resize', 'Resize session summary'));
    element.setAttribute('aria-valuemin', String(MIN_WIDTH));
    element.setAttribute('aria-valuemax', String(MAX_WIDTH));
    element.tabIndex = 0;
    element.hidden = true;
    rail.after(element);

    const direction = () => (typeof win.getComputedStyle === 'function' && win.getComputedStyle(pane).direction === 'rtl' ? -1 : 1);
    const timeline = () => chatTimeline || pane.querySelector('[data-chat-node="chatTimeline"]');
    const settleLayout = () => { void pane.offsetWidth; };

    function apply(next) {
      width = clampWidth(next);
      pane.style.setProperty(WIDTH_PROPERTY, `${width}px`);
      element.setAttribute('aria-valuenow', String(width));
    }

    function save() {
      try { win.localStorage.setItem(STORAGE_KEY, JSON.stringify({ width })); } catch (_error) { /* storage blocked */ }
      for (const peer of peersByWindow.get(win) || []) if (peer !== apply) peer(width);
    }

    // One reflow, bracketed by the reader anchor (keys; the end of a drag).
    function reflowAround(change) {
      notify('before');
      change();
      settleLayout();
      notify('after');
    }

    function finishDrag() {
      if (!drag) return;
      const { pointerId } = drag;
      drag = null;
      element.classList.remove('dragging');
      try { element.releasePointerCapture(pointerId); } catch (_error) { /* already released */ }
      reflowAround(() => pane.style.removeProperty(MEASURE_LOCK_PROPERTY));
      save();
    }

    // The reading measure for this drag width: held at its start value while the stage has room for it, narrowed
    // (one anchored reflow per step) only once the rail has used up the slack.
    function holdMeasure(next) {
      const lock = Math.min(drag.measure, Math.max(MIN_MEASURE_PX, drag.measure - Math.max(0, next - drag.startWidth - drag.room)));
      if (lock === drag.lock) return;
      drag.lock = lock;
      reflowAround(() => pane.style.setProperty(MEASURE_LOCK_PROPERTY, `${lock}px`));
    }

    function onPointerDown(event) {
      if (element.hidden || drag || (typeof event.button === 'number' && event.button > 0)) return;
      if (pane.closest && pane.closest('.chat-view')?.hasAttribute(MOTION_ATTRIBUTE)) return;
      event.preventDefault();
      // Hold the reading measure for the drag, so the text does not rewrap on every move.
      const measure = Number(timeline()?.getBoundingClientRect().width) || 0;
      const stageWidth = Number(stage?.getBoundingClientRect().width) || 0;
      if (measure > 0) pane.style.setProperty(MEASURE_LOCK_PROPERTY, `${measure}px`);
      drag = { pointerId: event.pointerId, dir: direction(), startX: event.clientX, startWidth: width, measure, lock: measure, room: Math.max(0, stageWidth - measure - LOCKED_GUTTERS_PX) };
      element.classList.add('dragging');
      try { element.setPointerCapture(event.pointerId); } catch (_error) { /* synthetic pointer */ }
    }

    function onPointerMove(event) {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const next = clampWidth(drag.startWidth + (drag.startX - event.clientX) * drag.dir);
      apply(next);
      if (drag.measure > 0) holdMeasure(next);
    }

    function onPointerEnd(event) {
      if (drag && drag.pointerId === event.pointerId) finishDrag();
    }

    function onKeyDown(event) {
      if (element.hidden) return;
      const step = KEY_STEP * direction();
      const targets = { ArrowLeft: () => width + step, ArrowRight: () => width - step, Home: () => DEFAULT_WIDTH, End: () => MAX_WIDTH };
      if (!Object.prototype.hasOwnProperty.call(targets, event.key)) return;
      event.preventDefault();
      reflowAround(() => apply(targets[event.key]()));
      save();
    }

    const listeners = [
      ['pointerdown', onPointerDown], ['pointermove', onPointerMove], ['pointerup', onPointerEnd],
      ['pointercancel', onPointerEnd], ['lostpointercapture', onPointerEnd], ['keydown', onKeyDown],
    ];
    for (const [type, handler] of listeners) element.addEventListener(type, handler);
    if (!peersByWindow.has(win)) peersByWindow.set(win, new Set());
    peersByWindow.get(win).add(apply);
    apply(width);

    return {
      element,
      setShown(shown) { element.hidden = !shown; },
      getWidth: () => width,
      dispose() {
        peersByWindow.get(win)?.delete(apply);
        for (const [type, handler] of listeners) element.removeEventListener(type, handler);
        if (drag) {
          try { element.releasePointerCapture(drag.pointerId); } catch (_error) { /* already released */ }
          drag = null;
          pane.style.removeProperty(MEASURE_LOCK_PROPERTY);
        }
        pane.style.removeProperty(WIDTH_PROPERTY);
        element.remove();
      },
    };
  }

  return {
    createRailLayout, createRailResizer, clampWidth, REFLOW_EVENT,
  };
});
