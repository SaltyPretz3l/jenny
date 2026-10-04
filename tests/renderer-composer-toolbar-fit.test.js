'use strict';

/* Split view W3-3 -- the composer toolbar fit (owner decision 2026-09-26
 * "B"): collapse the settings into one summary pill when the one-line
 * toolbar would overflow, expand when the width it last needed fits again. */

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');

const { createToolbarFit } = require('../renderer/chat/renderer-composer-toolbar-fit');

function createRig({ available = 800, needed = 600, host = 'chat' } = {}) {
  const frames = [];
  const applied = [];
  const observers = [];
  const env = { available, needed, host, measures: 0 };
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
    fire() { this.callback([]); }
  }
  const target = { id: 'toolbar', closest: () => env.host === 'dock' ? {} : null };
  const fit = createToolbarFit({
    target,
    measure: () => { env.measures += 1; return { available: env.available, needed: env.needed }; },
    apply: (compact) => applied.push(compact),
    requestFrame: (callback) => { frames.push(callback); return frames.length; },
    cancelFrame: () => { frames.length = 0; },
    getHost: () => env.host,
    ResizeObserverCtor: FakeResizeObserver,
  });
  function flush() {
    while (frames.length) frames.shift()();
  }
  return { fit, env, frames, applied, observers, flush, target };
}

test('a toolbar that fits stays expanded and applies nothing', () => {
  const { fit, applied, flush, observers, target } = createRig({ available: 800, needed: 600 });
  flush();
  assert.equal(fit.isCompact(), false);
  assert.deepEqual(applied, []);
  assert.deepEqual(observers[0].targets, [target]);
});

test('overflow collapses once; widening past the remembered width expands', () => {
  const { fit, env, applied, flush, observers } = createRig({ available: 500, needed: 640 });
  flush();
  assert.equal(fit.isCompact(), true);
  assert.deepEqual(applied, [true]);

  // While collapsed the content is narrow; `needed` is ignored.
  env.needed = 200;
  env.available = 600;
  observers[0].fire();
  flush();
  assert.equal(fit.isCompact(), true, 'still narrower than the remembered 640');

  env.available = 640;
  env.needed = 640;
  observers[0].fire();
  flush();
  assert.equal(fit.isCompact(), false);
  assert.deepEqual(applied, [true, false]);
});

test('the boundary does not flip-flop: the verify frame re-collapses when a label grew', () => {
  const { fit, env, applied, flush, observers } = createRig({ available: 500, needed: 640 });
  flush();
  env.available = 660;
  env.needed = 700; // the model name got longer while collapsed
  observers[0].fire();
  flush();
  assert.equal(fit.isCompact(), true);
  assert.deepEqual(applied, [true, false, true]);

  // Now 700 is remembered: 680 stays collapsed, no further writes.
  env.available = 680;
  observers[0].fire();
  flush();
  assert.deepEqual(applied, [true, false, true]);
});

test('a burst of resizes and rechecks measures once per frame', () => {
  const { fit, env, flush, observers } = createRig({ available: 800, needed: 600 });
  flush();
  const before = env.measures;
  observers[0].fire();
  observers[0].fire();
  fit.recheck();
  fit.recheck();
  flush();
  assert.equal(env.measures, before + 1);
});

test('a hidden toolbar (zero width) decides nothing', () => {
  const { fit, env, applied, flush, observers } = createRig({ available: 500, needed: 640 });
  flush();
  env.available = 0;
  observers[0].fire();
  flush();
  assert.equal(fit.isCompact(), true);
  assert.deepEqual(applied, [true]);
});

test('a toolbar in the dock collapses like the chat view', () => {
  const { fit, env, applied, flush } = createRig({ available: 300, needed: 640, host: 'dock' });
  flush();
  assert.equal(fit.isCompact(), true);
  assert.deepEqual(applied, [true]);
  assert.equal(env.measures, 1);
});

test('a host change forgets the remembered width', () => {
  const { fit, env, frames, applied, flush } = createRig({ available: 500, needed: 640 });
  flush();
  env.host = 'dock';
  env.needed = 550;
  fit.recheck(); // Equal host widths do not trigger a ResizeObserver.
  frames.shift()();
  assert.equal(fit.isCompact(), false, 'forget 640 and expand before measuring the new host');
  assert.deepEqual(applied, [true, false]);
  frames.shift()();
  assert.equal(fit.isCompact(), true, 'the verify frame decides using the new host');
  env.available = env.needed = 550;
  fit.recheck();
  flush();
  assert.equal(fit.isCompact(), false, 'the new remembered width is 550, not 640');
});

test('recheck after a label change collapses an expanded toolbar that now overflows', () => {
  const { fit, env, flush } = createRig({ available: 600, needed: 580 });
  flush();
  env.needed = 620;
  fit.recheck();
  flush();
  assert.equal(fit.isCompact(), true);
});

test('dispose cancels the pending frame and disconnects the observer', () => {
  const { fit, frames, observers, applied, env } = createRig({ available: 500, needed: 640 });
  assert.equal(frames.length, 1, 'the initial evaluation is scheduled, not synchronous');
  fit.dispose();
  assert.equal(frames.length, 0);
  assert.equal(observers[0].disconnected, true);
  fit.recheck();
  assert.equal(frames.length, 0);
  assert.equal(env.measures, 0);
  assert.deepEqual(applied, []);
});

test('CSS: expanded, the settings group is one rail item carrying the break and the summary pill is absent', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-composer-fit.css'), 'utf8');
  const body = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `missing ${selector}`);
    return css.slice(at, css.indexOf('}', at));
  };
  assert.match(body('.composer-settings-group'), /display: flex;[\s\S]*margin-inline-end: var\(--space-3\);/);
  assert.match(body('.composer-settings-summary'), /display: none;/);
  assert.match(body('.composer[data-toolbar-compact] .composer-settings-group'), /display: none;/);
  assert.match(body('.composer[data-toolbar-compact][data-settings-open] .composer-settings-group'), /position: absolute;/);
  assert.match(body('.composer[data-toolbar-compact][data-settings-open] :is(#composerSettingsGroup, .composer-settings-group) > [data-settings-label]:empty'), /display: none;/);
  assert.equal(css.includes('▾'), false, 'the caret is an SVG span, not a text glyph');
  assert.match(body('.composer-settings-summary[aria-expanded="true"] .composer-settings-summary-caret'), /transform: rotate\(180deg\);/);
  const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8').split(/\r?\n/);
  const shell = styles.findIndex((line) => line.includes('./styles/chat-composer-shell-v2.css'));
  assert.ok(styles[shell + 1].includes('./styles/chat-composer-fit.css'), 'imported right after chat-composer-shell-v2.css');
});

test('CSS: a chat-view button row stays on one line; the summary label gives way first', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-composer-fit.css'), 'utf8');
  const body = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `missing ${selector}`);
    return css.slice(at, css.indexOf('}', at));
  };
  // (0,3,0) out-specifies the narrow-window `.chat-view .composer-toolbar { flex-wrap: wrap }`.
  assert.match(body(':is(.chat-view, .ide-chat-dock-body) .composer .composer-toolbar'), /flex-wrap: nowrap;/);
  assert.match(body(':is(.chat-view, .ide-chat-dock-body) .composer .composer-toolbar-left'), /flex: none;/);
  assert.match(body(':is(.chat-view, .ide-chat-dock-body) .composer .composer-toolbar-right'), /min-width: 0;/);
  assert.match(body(':is(.chat-view, .ide-chat-dock-body) .composer .composer-rail'), /flex-wrap: nowrap;/);
  // Review P1: expanded items must not shrink, or the summed offsetWidths hide the overflow and the fit never collapses.
  assert.match(body(':is(.chat-view, .ide-chat-dock-body) .composer:not([data-toolbar-compact]) :is(.composer-rail, .composer-settings-group) > *'), /flex-shrink: 0;/);
  assert.match(body('.composer[data-toolbar-compact] .composer-rail > :is(.composer-send, .composer-stop-button, .composer-pause-button)'), /flex: none;/);
  // Gate F3 (2026-09-27): an overflowing rail spills past its end edge, never back over Attach and Commands.
  assert.match(body(':is(.chat-view, .ide-chat-dock-body) .composer .composer-toolbar-right'), /justify-content: safe flex-end;/);
  // Collapsed while streaming, the queue button is the send arrow alone, Stop's size.
  assert.match(body('.composer[data-toolbar-compact] .composer-rail > .composer-send.composer-send-queue'), /aspect-ratio: 1;[\s\S]*font-size: 0;/);
  assert.match(body('.composer[data-toolbar-compact] .composer-rail > .composer-send.composer-send-queue::before'), /content: "\\2191" \/ "";/);
  assert.match(body('.composer[data-toolbar-compact] .composer-settings-summary'), /min-width: 0;/);
  assert.match(body('.composer[data-toolbar-compact] .composer-settings-summary .inv-chip-label'), /min-width: 0;[\s\S]*text-overflow: ellipsis;/);
  assert.match(body('.composer-settings-summary-mode-icon,\n.composer-settings-summary-caret'), /flex: none;/);
  const media = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-media-queries.css'), 'utf8');
  assert.match(media, /\.chat-view \.composer-toolbar \{[^}]*flex-wrap: wrap;/, 'the rule this out-specifies still exists (update this pin if it goes)');
});

test('CSS: the open group is a settings list with in-place sub-menus', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-composer-fit.css'), 'utf8');
  const G = '.composer[data-toolbar-compact][data-settings-open] :is(#composerSettingsGroup, .composer-settings-group)';
  const body = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, `missing ${selector}`);
    return css.slice(at, css.indexOf('}', at));
  };
  assert.match(body('.composer[data-toolbar-compact][data-settings-open] .composer-settings-group'), /width: min\(280px, var\(--settings-max-inline, 280px\)\);[\s\S]*max-block-size: var\(--settings-max-block, none\);[\s\S]*overflow-y: auto;/);
  assert.match(body(`${G} > [data-settings-label]`), /min-height: 36px;[\s\S]*position: static;|position: static;[\s\S]*min-height: 36px;/);
  assert.match(body(`${G} .inv-popover`), /bottom: 0;[\s\S]*min-width: 100%;[\s\S]*min-height: 100%;/);
  assert.match(body('.composer-run-mode-segments'), /display: none;/, 'segments exist only inside the open list');
  assert.match(body(`${G} .composer-run-mode-chip`), /display: none;/);
  // Astra review P2: translated segments wrap under the label and may shrink; their labels break, never clip.
  assert.match(body(`${G} > .composer-run-mode-slot`), /flex-wrap: wrap;/);
  assert.match(body(`${G} .composer-run-mode-segments`), /min-width: 0;[\s\S]*max-width: 100%;/);
  assert.doesNotMatch(body('.composer-run-mode-segment-label'), /white-space: nowrap|text-overflow/);
  // Gate F4 (2026-09-27): a label wraps only between words (no break-word, no zero floor);
  // segments that still do not fit stack whole.
  assert.doesNotMatch(body('.composer-run-mode-segment-label'), /overflow-wrap|word-break|min-width: 0/);
  assert.doesNotMatch(body('.composer-run-mode-segments .composer-run-mode-segment'), /min-width: 0/);
  assert.match(body('.composer-run-mode-segments .composer-run-mode-segment'), /flex: 1 1 0;/, 'even shares, floored at the longest word');
  assert.match(body(`${G} .composer-run-mode-segments`), /flex-wrap: wrap;/);
  assert.match(body('.inv-usage-bar,\n.inv-context-ring-percent'), /display: none;/, 'bar and percent stay off the toolbar');
  // Review P3s: a General project stays muted (out-specifies the chip stripping); bar, then percent, then chevron.
  assert.match(body(`${G} > [data-settings-label] .inv-chip.composer-project-pill--general:not(.inv-popover *)`), /color: var\(--text-muted\);/);
  assert.match(body(`${G} .inv-context-ring .inv-chip-label`), /order: 1;/);
  assert.match(body(`${G} > [data-settings-label] .inv-chip[aria-haspopup]:not(.inv-popover *)::after`), /order: 2;/);
});


/* Gate F3 (2026-09-27): Stop, Pause and the queue label appear with a reply
 * without resizing the toolbar, so the ResizeObserver never saw them; an
 * expanded row overflowed while streaming. Their changes recheck the fit;
 * a change elsewhere in the group (the context ring re-rendering) does not. */
test('a change on the rail\'s own buttons rechecks the fit; a context slot change does not', async (t) => {
  const { JSDOM } = require('jsdom');
  const { createComposerSettingsFit } = require('../renderer/chat/renderer-pane-composer-rail');
  const dom = new JSDOM('<div class="chat-pane"><div class="composer"><div class="composer-toolbar"><div class="composer-toolbar-left"></div>'
    + '<div class="composer-toolbar-right composer-rail"><div class="composer-settings-group" id="group">'
    + '<div class="composer-model-pill-slot"><button type="button" class="inv-chip" data-inv-chip="composer-model"><span class="inv-chip-label">m</span></button></div>'
    + '<div class="composer-context-usage-slot" id="context"></div></div>'
    + '<button type="button" class="composer-stop-button hidden" id="stop"></button><button type="button" class="composer-send" id="send">↑</button>'
    + '</div></div></div></div>');
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const frames = [];
  let measures = 0;
  const settings = createComposerSettingsFit({
    groupEl: doc.getElementById('group'),
    documentRef: doc,
    deps: {
      toolbarFit: require('../renderer/chat/renderer-composer-toolbar-fit'),
      chip: require('../renderer/inventory/chip'),
      measure: () => { measures += 1; return { available: 900, needed: 600 }; },
      requestFrame: (callback) => { frames.push(callback); return frames.length; },
      cancelFrame() {},
      ResizeObserverCtor: null,
    },
  });
  t.after(() => settings.dispose());
  const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); while (frames.length) frames.shift()(); };
  await settle();
  const base = measures;
  doc.getElementById('context').innerHTML = '<button type="button" class="inv-chip">64%</button>';
  await settle();
  assert.equal(measures, base, 'the context ring re-rendering measures nothing');
  doc.getElementById('stop').classList.remove('hidden');
  await settle();
  assert.equal(measures, base + 1, 'Stop appearing rechecks');
  doc.getElementById('send').textContent = 'Queue — runs in Auto';
  await settle();
  assert.equal(measures, base + 2, 'the queue label rechecks');
  doc.getElementById('stop').insertAdjacentHTML('beforebegin', '<button type="button" class="composer-pause-button"></button>');
  await settle();
  assert.equal(measures, base + 3, 'Pause mounting rechecks');
});
