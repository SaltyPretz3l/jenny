const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  runReasoningPanelAutoCollapse,
  cancelReasoningPanelAutoCollapse,
  isReasoningPanelCollapsing,
  collectOpenReasoningPhaseKeys,
  replayReasoningHandoff,
  noteReasoningPanelReaderToggle,
  createReasoningHandoffTracker,
} = require('../renderer/chat/renderer-reasoning-autocollapse-utils');

function createPanel(t) {
  const dom = new JSDOM('<div class="reasoning-row-panel expanded" style="max-height: none"></div>');
  t.after(() => dom.window.close());
  const panel = dom.window.document.querySelector('.reasoning-row-panel');
  // Chromium reports 0 for a display:none ([hidden]) element; the collapse
  // must measure only after it re-opens the panel.
  Object.defineProperty(panel, 'scrollHeight', { configurable: true, get: () => (panel.hidden ? 0 : 300) });
  return { dom, panel };
}

function closeAsCaller(panel) {
  panel.hidden = true;
  panel.classList.remove('expanded');
}

function stubTimers(win) {
  const entries = [];
  win.setTimeout = (callback) => {
    entries.push({ callback, cleared: false });
    return entries.length;
  };
  win.clearTimeout = (handle) => {
    if (entries[handle - 1]) entries[handle - 1].cleared = true;
  };
  return entries;
}

function maxHeightTransitionEnd(win) {
  const event = new win.Event('transitionend', { bubbles: true });
  Object.defineProperty(event, 'propertyName', { value: 'max-height' });
  return event;
}

test('animated autocollapse pins, starts next frame, and finishes on transitionend', (t) => {
  const { dom, panel } = createPanel(t);
  const frames = [];
  const timers = stubTimers(dom.window);
  const reads = [];
  Object.defineProperty(panel, 'offsetHeight', {
    configurable: true,
    get() {
      reads.push(`offset:${panel.style.maxHeight}`);
      return 0;
    },
  });
  closeAsCaller(panel);

  const result = runReasoningPanelAutoCollapse(panel, {
    reducedMotion: false,
    transitionMs: 300,
    requestFrame: (callback) => frames.push(callback),
    windowRef: dom.window,
  });

  assert.equal(result, true);
  assert.equal(panel.hidden, false);
  assert.ok(panel.classList.contains('expanded'));
  assert.equal(panel.dataset.collapsing, 'true');
  assert.equal(panel.style.maxHeight, '300px');
  assert.ok(reads.includes('offset:300px'), 'reflow is read after the 300px pin is written');

  frames.splice(0).forEach((callback) => callback());
  assert.ok(panel.classList.contains('expanded'), '.expanded stays for the whole animation (no padding/opacity snap)');
  assert.equal(panel.style.maxHeight, '0px');
  assert.equal(panel.hidden, false);

  panel.dispatchEvent(maxHeightTransitionEnd(dom.window));
  assert.equal(panel.hidden, true);
  assert.equal(panel.style.maxHeight, '');
  assert.equal(panel.hasAttribute('data-collapsing'), false);
  assert.equal(panel.classList.contains('expanded'), false, 'finish removes .expanded once hidden');

  timers[0].callback();
  assert.equal(panel.hidden, true);
  assert.equal(panel.style.maxHeight, '');
});

test('autocollapse uses the timer fallback when transitionend is absent', (t) => {
  const { dom, panel } = createPanel(t);
  const frames = [];
  const timers = stubTimers(dom.window);
  closeAsCaller(panel);

  runReasoningPanelAutoCollapse(panel, {
    reducedMotion: false,
    transitionMs: 300,
    requestFrame: (callback) => frames.push(callback),
    windowRef: dom.window,
  });
  frames.splice(0).forEach((callback) => callback());
  timers[0].callback();

  assert.equal(panel.hidden, true);
  assert.equal(panel.style.maxHeight, '');
  assert.equal(panel.hasAttribute('data-collapsing'), false);
  assert.equal(panel.classList.contains('expanded'), false);
});

test('reduced motion keeps the caller-collapsed state without scheduling a frame', (t) => {
  const { dom, panel } = createPanel(t);
  const frames = [];
  closeAsCaller(panel);

  const result = runReasoningPanelAutoCollapse(panel, {
    reducedMotion: true,
    transitionMs: 300,
    requestFrame: (callback) => frames.push(callback),
    windowRef: dom.window,
  });

  assert.equal(result, true);
  assert.equal(frames.length, 0);
  assert.equal(panel.hidden, true);
  assert.equal(panel.style.maxHeight, '');
  assert.equal(panel.classList.contains('expanded'), false);
});

test('re-entry fences the first frame and finish while the current run completes cleanly', (t) => {
  const { dom, panel } = createPanel(t);
  const frames = [];
  const timers = stubTimers(dom.window);
  const options = {
    reducedMotion: false,
    transitionMs: 300,
    requestFrame: (callback) => frames.push(callback),
    windowRef: dom.window,
  };
  closeAsCaller(panel);

  runReasoningPanelAutoCollapse(panel, options);
  runReasoningPanelAutoCollapse(panel, options);
  frames.splice(0).forEach((callback) => callback());
  timers[0].callback();
  assert.equal(panel.hidden, false, 'the stale first finish cannot hide the current run');
  timers[1].callback();

  assert.equal(panel.hidden, true);
  assert.equal(panel.style.maxHeight, '');
  assert.equal(panel.classList.contains('expanded'), false);
  assert.equal(panel.hasAttribute('data-collapsing'), false);
});

test('isReasoningPanelCollapsing reflects only the active dataset flag', (t) => {
  const { panel } = createPanel(t);

  assert.equal(isReasoningPanelCollapsing(panel), false);
  panel.dataset.collapsing = 'true';
  assert.equal(isReasoningPanelCollapsing(panel), true);
  panel.dataset.collapsing = 'false';
  assert.equal(isReasoningPanelCollapsing(panel), false);
  assert.equal(isReasoningPanelCollapsing(null), false);
});

test('cancelReasoningPanelAutoCollapse hands the panel to the reader before the frame lands', (t) => {
  const { dom, panel } = createPanel(t);
  const frames = [];
  const timers = stubTimers(dom.window);
  closeAsCaller(panel);

  runReasoningPanelAutoCollapse(panel, {
    reducedMotion: false,
    transitionMs: 300,
    requestFrame: (callback) => frames.push(callback),
    windowRef: dom.window,
  });
  // The reader clicks the header in the same frame the auto-collapse armed.
  assert.equal(cancelReasoningPanelAutoCollapse(panel), true);
  assert.equal(panel.hasAttribute('data-collapsing'), false);
  panel.style.maxHeight = '300px';

  frames.splice(0).forEach((callback) => callback());
  assert.equal(panel.style.maxHeight, '300px', 'the stale frame must not write 0px');
  timers[0].callback();
  panel.dispatchEvent(maxHeightTransitionEnd(dom.window));

  assert.equal(panel.hidden, false, 'the stale finish cannot hide the reopened panel');
  assert.ok(panel.classList.contains('expanded'));
  assert.equal(cancelReasoningPanelAutoCollapse(panel), false, 'no-op when nothing is collapsing');
});

test('reduced motion mid-collapse lands the panel closed and clears the flag', (t) => {
  const { dom, panel } = createPanel(t);
  const frames = [];
  const timers = stubTimers(dom.window);
  closeAsCaller(panel);
  runReasoningPanelAutoCollapse(panel, {
    reducedMotion: false,
    transitionMs: 300,
    requestFrame: (callback) => frames.push(callback),
    windowRef: dom.window,
  });
  assert.equal(panel.dataset.collapsing, 'true');

  runReasoningPanelAutoCollapse(panel, { reducedMotion: true, transitionMs: 300, windowRef: dom.window });

  assert.equal(panel.hidden, true);
  assert.equal(panel.classList.contains('expanded'), false);
  assert.equal(panel.style.maxHeight, '');
  assert.equal(panel.hasAttribute('data-collapsing'), false);
  frames.splice(0).forEach((callback) => callback());
  timers[0].callback();
  assert.equal(panel.hidden, true, 'the fenced first run stays a no-op');
  assert.equal(panel.style.maxHeight, '');
});

function createTimeline(t) {
  const panel = (id, thinkingId, key, open, extra = '') => `
    <article data-message-id="${id}">
      <div class="reasoning-row-panel${open ? ' expanded' : ''}" data-thinking-id="${thinkingId}" data-phase-key="${key}"${open ? '' : ' hidden'}${extra}>
        <div class="reasoning-row-panel-body"><p>body</p></div>
      </div>
    </article>`;
  const dom = new JSDOM(`<div id="timeline">
    ${panel('m1', 'think_a', 'phase_1', true)}
    ${panel('m1b', 'think_b', 'phase_2', true, ' data-collapsing="true"')}
    ${panel('m2', 'think_c', 'phase_1', true)}
  </div>`);
  t.after(() => dom.window.close());
  const timeline = dom.window.document.getElementById('timeline');
  timeline.querySelectorAll('.reasoning-row-panel').forEach((node) => {
    Object.defineProperty(node, 'scrollHeight', { configurable: true, get: () => (node.hidden ? 0 : 200) });
  });
  return { dom, timeline };
}

test('collectOpenReasoningPhaseKeys lists visible open panels by identity and skips collapsing or hidden ones', (t) => {
  const { timeline } = createTimeline(t);
  assert.deepEqual(
    collectOpenReasoningPhaseKeys(timeline.querySelector('[data-message-id="m1"]')),
    [{ thinkingId: 'think_a', phaseKey: 'phase_1' }]
  );
  assert.deepEqual(collectOpenReasoningPhaseKeys(timeline.querySelector('[data-message-id="m1b"]')), []);
  const closed = timeline.querySelector('[data-message-id="m2"] .reasoning-row-panel');
  closed.hidden = true;
  assert.deepEqual(collectOpenReasoningPhaseKeys(timeline.querySelector('[data-message-id="m2"]')), []);
  assert.deepEqual(collectOpenReasoningPhaseKeys(null), []);
});

test('replayReasoningHandoff collapses only remembered panels that a rebuild closed, measured after re-opening', (t) => {
  const { dom, timeline } = createTimeline(t);
  const frames = [];
  stubTimers(dom.window);
  const options = { reducedMotion: false, transitionMs: 300, requestFrame: (cb) => frames.push(cb), windowRef: dom.window };
  const article = timeline.querySelector('[data-message-id="m1"]');
  const panel = article.querySelector('.reasoning-row-panel');
  const mine = { thinkingId: 'think_a', phaseKey: 'phase_1' };

  // Still open: nothing to replay.
  assert.equal(replayReasoningHandoff(article, [mine], options), 0);
  assert.equal(panel.hasAttribute('data-collapsing'), false);

  // The rebuild swapped in a settled, hidden panel.
  closeAsCaller(panel);
  const entries = [mine, { thinkingId: 'think_a', phaseKey: 'phase_9' }, { thinkingId: 'other', phaseKey: 'phase_1' }, { phaseKey: '' }];
  assert.equal(replayReasoningHandoff(article, entries, options), 1);
  assert.equal(panel.hidden, false);
  assert.equal(panel.dataset.collapsing, 'true');
  assert.equal(panel.style.maxHeight, '200px', 'the start height is measured with the panel visible, never the hidden 0');
  // Idempotent while collapsing.
  assert.equal(replayReasoningHandoff(article, [mine], options), 0);
});

test('replayReasoningHandoff escapes selector values through the supplied escaper', (t) => {
  const dom = new JSDOM('<article data-message-id="m"><div class="reasoning-row-panel" data-thinking-id="t 1" data-phase-key="p/1" hidden><p>x</p></div></article>');
  t.after(() => dom.window.close());
  stubTimers(dom.window);
  const article = dom.window.document.querySelector('article');
  const panel = article.querySelector('.reasoning-row-panel');
  Object.defineProperty(panel, 'scrollHeight', { configurable: true, get: () => (panel.hidden ? 0 : 50) });
  const seen = [];
  const replayed = replayReasoningHandoff(article, [{ thinkingId: 't 1', phaseKey: 'p/1' }], {
    reducedMotion: false, transitionMs: 300, requestFrame: () => {}, windowRef: dom.window,
    escapeSelectorValue: (value) => { seen.push(value); return String(value).replace(/[^\w-]/g, (ch) => '\\' + ch); },
  });
  assert.equal(replayed, 1);
  assert.deepEqual(seen, ['t 1', 'p/1']);
});

test('the hand-off tracker scopes entries to the remembered article, forgets after a replay, and honours the reader toggle', (t) => {
  const { dom, timeline } = createTimeline(t);
  const frames = [];
  stubTimers(dom.window);
  const tracker = createReasoningHandoffTracker({
    chatTimeline: timeline,
    escapeSelectorValue: (value) => String(value || ''),
    buildOptions: () => ({ reducedMotion: false, transitionMs: 300, requestFrame: (cb) => frames.push(cb), windowRef: dom.window }),
  });
  tracker.rememberById('m1');
  const other = timeline.querySelector('[data-message-id="m2"] .reasoning-row-panel');
  closeAsCaller(other);
  assert.equal(tracker.replay(), 0, 'the same phase key on another message is not touched');
  assert.equal(other.hasAttribute('data-collapsing'), false);

  const mine = timeline.querySelector('[data-message-id="m1"] .reasoning-row-panel');
  closeAsCaller(mine);
  assert.equal(tracker.replay(), 1);
  assert.equal(mine.dataset.collapsing, 'true');
  delete mine.dataset.collapsing;
  mine.hidden = true;
  mine.classList.remove('expanded');
  assert.equal(tracker.replay(), 0, 'entries are forgotten once a replay collapsed the panel');

  // Reader closes the panel on purpose: a later rebuild must not replay it.
  mine.hidden = false;
  mine.classList.add('expanded');
  tracker.remember(timeline.querySelector('[data-message-id="m1"]'));
  noteReasoningPanelReaderToggle(mine);
  closeAsCaller(mine);
  assert.equal(tracker.replay(), 0, 'a reader-closed panel is not re-animated by a rebuild');

  tracker.remember(timeline.querySelector('[data-message-id="m1"]'));
  tracker.clear();
  assert.equal(tracker.replay(), 0);
  tracker.remember(null);
  assert.equal(tracker.replay(), 0);
});
