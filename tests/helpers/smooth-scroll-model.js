'use strict';

/* A Chromium-faithful model of a programmatic smooth scroll for jsdom (which
 * has no layout and no scrolling). A smooth scrollIntoView on an element
 * inside `scroller` animates to `destination` over `frames` animation frames
 * (Chromium's programmatic smooth scroll runs for a few hundred ms), firing
 * scroll each frame and scrollend on arrival; any scrollTop write before then
 * aborts it where it stands, as Chromium does. An instant one lands at once.
 * 2026-09-27 gate F5: a reader-anchor restore during the reveal wrote the
 * pre-jump position back, so "Jump to message" never moved.
 */
function installSmoothScrollModel(window, scroller, { scrollHeight = 4000, clientHeight = 400, destination = 1000, frames = 12 } = {}) {
  let top = 0;
  let animation = null;
  const model = { calls: [], abortedBy: [], get top() { return top; } };
  // Resolves once a reveal has started and no smooth animation is in flight,
  // so a loaded machine's slower frame clock cannot cut an assertion short.
  model.waitForIdle = async (timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (model.calls.length === 0 || animation) {
      if (Date.now() >= deadline) throw new Error(`smooth scroll did not settle within ${timeoutMs} ms`);
      await new Promise((resolve) => window.setTimeout(resolve, 16));
    }
  };
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value) => {
      if (animation) model.abortedBy.push(Number(value));
      animation = null;
      top = Math.max(0, Math.min(Number(value) || 0, scrollHeight - clientHeight));
    },
  });
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => clientHeight });
  const previousScrollIntoView = window.HTMLElement.prototype.scrollIntoView;
  window.HTMLElement.prototype.scrollIntoView = function modelScrollIntoView(options = {}) {
    if (!scroller.contains(this)) return previousScrollIntoView.call(this, options);
    model.calls.push({ element: this, options });
    if (options.behavior !== 'smooth') {
      animation = null;
      top = destination;
      scroller.dispatchEvent(new window.Event('scroll'));
      return;
    }
    const run = { from: top, frame: 0 };
    animation = run;
    const tick = () => {
      if (animation !== run) return;
      run.frame += 1;
      top = Math.round(run.from + ((destination - run.from) * run.frame) / frames);
      scroller.dispatchEvent(new window.Event('scroll'));
      if (run.frame < frames) {
        window.requestAnimationFrame(tick);
        return;
      }
      animation = null;
      scroller.dispatchEvent(new window.Event('scrollend'));
    };
    window.requestAnimationFrame(tick);
  };
  return model;
}

function stubRect(element, rect) {
  element.getBoundingClientRect = () => ({ left: 0, right: 800, width: 800, ...rect });
}

module.exports = { installSmoothScrollModel, stubRect };
