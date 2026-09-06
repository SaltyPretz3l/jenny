/* renderer/features/renderer-ide-map-event-ownership.js - shared Workspace
 * File Map event ownership. Classification precedence is node, named surface,
 * contenteditable/control, district, then canvas. Canvas, node, and district
 * are the three canvas-owned categories. A gesture accepts only the pointerId
 * captured when it began.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeMapEventOwnership = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Panel/surface containers that own their own pointer + keyboard events in
  // full (a whole subtree, not just a specific leaf control). Order matters
  // only insofar as these are all checked before the generic control sniff;
  // among themselves they are mutually exclusive DOM subtrees.
  const SURFACE_SELECTORS = [
    ['overview', '.ide-map-overview'],
    ['findings', '.ide-map-findings'],
    ['control', '.ide-map-controls'],
    ['rail', '.ide-map-activity-rail'],
  ];

  // Generic interactive-control / ARIA-widget sniff, for elements that are
  // NOT inside one of the named surfaces above but are still an interactive
  // control in their own right (e.g. a future control rendered directly onto
  // the viewport). Kept broad but inert: matching an element here never
  // removes canvas ownership from a `[data-map-node]` ancestor, since that is
  // checked first in classifyMapEventTarget.
  const INTERACTIVE_CONTROL_SELECTOR = [
    'input', 'textarea', 'select', 'button', 'a[href]', 'label',
    '[role="button"]', '[role="link"]', '[role="checkbox"]',
    '[role="switch"]', '[role="slider"]', '[role="textbox"]',
    '[role="combobox"]', '[role="listbox"]', '[role="option"]',
    '[role="menu"]', '[role="menuitem"]', '[role="tab"]',
    '[role="tabpanel"]', '[role="dialog"]', '[role="spinbutton"]',
    '[contenteditable="true"]', '[contenteditable=""]',
  ].join(',');

  function closestSafe(target, selector) {
    if (!target || typeof target.closest !== 'function') {
      return null;
    }
    try {
      return target.closest(selector);
    } catch (_error) {
      // An invalid/unsupported selector should never throw through a hot
      // event-handling path; treat it as "no match".
      return null;
    }
  }

  function isContentEditableTarget(target) {
    if (!target) return false;
    // isContentEditable is the live DOM property (walks ancestors itself in a
    // real browser); closest() is the jsdom-safe fallback for elements whose
    // isContentEditable getter is absent from a test double.
    if (target.isContentEditable === true) return true;
    return !!closestSafe(target, '[contenteditable="true"],[contenteditable=""]');
  }

  function isMapNodeTarget(target) {
    return !!closestSafe(target, '[data-map-node]');
  }

  function isMapDistrictTarget(target) {
    return !!closestSafe(target, '[data-map-district]');
  }

  function isInteractiveControlTarget(target) {
    return !!closestSafe(target, INTERACTIVE_CONTROL_SELECTOR);
  }

  // Classifies by walking closest() chains, most-specific first: a map node
  // wins over everything; the named panel surfaces (including the rail) and
  // the generic interactive-control sniff all outrank 'district' since a
  // control can be painted inside a district's DOM subtree in principle;
  // 'district' outranks the 'canvas' fallback. Falls back to 'canvas' — the
  // bare viewport/content background, or any purely decorative descendant
  // (the shared dots/rays <svg>) that isn't one of the categories above.
  function classifyMapEventTarget(target) {
    if (isMapNodeTarget(target)) return 'node';
    for (const [name, selector] of SURFACE_SELECTORS) {
      if (closestSafe(target, selector)) return name;
    }
    if (isContentEditableTarget(target)) return 'contenteditable';
    if (isInteractiveControlTarget(target)) return 'control';
    if (isMapDistrictTarget(target)) return 'district';
    return 'canvas';
  }

  const CANVAS_POINTER_CATEGORIES = new Set(['canvas', 'node', 'district']);
  const CANVAS_KEYBOARD_CATEGORIES = new Set(['canvas', 'node', 'district']);
  const CANVAS_WHEEL_CATEGORIES = new Set(['canvas', 'node', 'district']);

  function ownsCanvasPointerEvent(target) {
    return CANVAS_POINTER_CATEGORIES.has(classifyMapEventTarget(target));
  }

  function ownsMapKeyboardEvent(target) {
    return CANVAS_KEYBOARD_CATEGORIES.has(classifyMapEventTarget(target));
  }

  function ownsMapWheelZoom(target) {
    return CANVAS_WHEEL_CATEGORIES.has(classifyMapEventTarget(target));
  }

  // event.pointerId is absent on plain mouse events and on many synthetic
  // test events; normalize those to the literal 'mouse' so a captured id can
  // always be compared with ===.
  function normalizePointerId(event) {
    return event && event.pointerId != null ? event.pointerId : 'mouse';
  }

  // A tiny id-tracking seam: capture() records the gesture's pointer id at
  // pointerdown; matches(event) tells the caller whether a later
  // move/up/cancel event belongs to that SAME gesture. release() clears it
  // (call at gesture end, cancel, or dispose).
  function createPointerIdGate() {
    let activeId = null;
    return {
      capture(id) {
        activeId = id;
      },
      matches(event) {
        return activeId != null && normalizePointerId(event) === activeId;
      },
      isActive() {
        return activeId != null;
      },
      release() {
        activeId = null;
      },
      get activeId() {
        return activeId;
      },
    };
  }

  return {
    classifyMapEventTarget,
    ownsCanvasPointerEvent,
    ownsMapKeyboardEvent,
    ownsMapWheelZoom,
    normalizePointerId,
    createPointerIdGate,
    isContentEditableTarget,
    isMapNodeTarget,
    isMapDistrictTarget,
    isInteractiveControlTarget,
  };
});
