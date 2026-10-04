'use strict';

/* Split view W3-3 (spec docs/plans/split-view/W3_SPEC_2026-09-26.md §5): a
 * composer's settings group and its summary pill
 * (renderer/chat/renderer-pane-composer-rail.js createComposerSettingsFit),
 * driven on a jsdom fragment with an injected measure, a fake ResizeObserver
 * and a manual frame queue. The two-pane composition case lives in
 * tests/renderer-pane-composer-rail.test.js. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createComposerSettingsFit, measureComposerToolbar, resolveSettingsPopoverAnchor, placePopoverOverAnchor, clearPopoverCover,
} = require('../renderer/chat/renderer-pane-composer-rail.js');
const toolbarFit = require('../renderer/chat/renderer-composer-toolbar-fit.js');
const chip = require('../renderer/inventory/chip.js');

const MARKUP = `
  <div class="chat-pane" id="chatPane0">
    <div class="composer">
      <div class="composer-toolbar">
        <div class="composer-toolbar-left"><button type="button" id="attach"></button></div>
        <div class="composer-toolbar-right composer-rail">
          <div class="composer-settings-group" id="composerSettingsGroup">
            <div class="composer-run-mode-slot"><button type="button" class="inv-chip composer-run-mode-chip composer-run-mode-ask" data-inv-chip="composer-run-mode"><span class="inv-chip-label">Ask</span></button></div>
            <div class="composer-model-pill-slot"><button type="button" class="inv-chip composer-model-pill" data-inv-chip="composer-model"><span class="inv-chip-label">qwen3.5 · 9b · High</span></button><div class="inv-popover" hidden></div></div>
            <div class="composer-plan-usage-slot"></div>
          </div>
          <span class="sr-only" id="reason"></span>
          <button type="button" class="composer-send" id="send"></button>
        </div>
      </div>
    </div>
  </div>
  <textarea id="outside"></textarea>
  <div class="composer-popover hidden" id="attachMenu"><button type="button" id="attachAction"></button></div>`;

function mount(t, { html = MARKUP, reading = { available: 900, needed: 600 }, deps = {} } = {}) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { pretendToBeVisual: true });
  const { window } = dom;
  const doc = window.document;
  t.after(() => window.close());
  const frames = [];
  const observers = [];
  const measured = { count: 0, reading };
  class FakeResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
  }
  const mutationObservers = [];
  class TrackedMutationObserver extends window.MutationObserver {
    constructor(callback) { super(callback); this.disconnected = false; mutationObservers.push(this); }
    disconnect() { this.disconnected = true; return super.disconnect(); }
  }
  const settings = createComposerSettingsFit({
    groupEl: doc.getElementById('composerSettingsGroup'),
    paneRoot: doc.getElementById('chatPane0'),
    documentRef: doc,
    deps: {
      toolbarFit,
      chip,
      measure: () => { measured.count += 1; return measured.reading; },
      requestFrame: (callback) => { frames.push(callback); return frames.length; },
      cancelFrame: () => {},
      ResizeObserverCtor: FakeResizeObserver,
      MutationObserverCtor: TrackedMutationObserver,
      ...deps,
    },
  });
  const flush = () => { while (frames.length) frames.shift()(); };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { window, doc, settings, frames, flush, settle, observers, mutationObservers, measured,
    composer: doc.querySelector('.composer'), paneRoot: doc.getElementById('chatPane0'),
    group: doc.getElementById('composerSettingsGroup'), summary: settings && settings.summary };
}

function collapse(ctx) {
  ctx.measured.reading = { available: 300, needed: 600 };
  ctx.settings.recheck();
  ctx.flush();
}

test('the summary pill is an inventory chip placed after the group, before Send, and the slots get row labels', (t) => {
  const { settings, summary, group, doc, flush, composer, paneRoot } = mount(t);
  assert.ok(settings);
  flush();
  assert.equal(group.nextElementSibling, summary, 'right after the group');
  assert.equal(summary.nextElementSibling.id, 'reason');
  assert.equal(doc.getElementById('send').previousElementSibling.id, 'reason');
  assert.equal(summary.tagName, 'BUTTON');
  assert.equal(summary.getAttribute('type'), 'button');
  assert.equal(summary.classList.contains('inv-chip'), true);
  assert.equal(summary.classList.contains('composer-settings-summary'), true);
  assert.equal(summary.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(summary.getAttribute('aria-expanded'), 'false');
  assert.equal(summary.getAttribute('aria-controls'), 'composerSettingsGroup');
  assert.equal(summary.querySelector('.inv-chip-label').textContent, 'qwen3.5 · 9b · High');
  assert.equal(summary.querySelector('.composer-settings-summary-mode'), null, 'Ask carries no tag');
  assert.deepEqual([...group.children].map((slot) => slot.getAttribute('data-settings-label')),
    ['Run mode', 'Model', 'Plan usage']);
  assert.equal(composer.hasAttribute('data-toolbar-compact'), false, 'a toolbar that fits stays expanded');
  assert.equal(paneRoot.hasAttribute('data-composer-compact'), false);
});

test('overflow collapses the composer and its pane; the remembered width expands them again', (t) => {
  const ctx = mount(t);
  ctx.flush();
  collapse(ctx);
  assert.equal(ctx.composer.hasAttribute('data-toolbar-compact'), true);
  assert.equal(ctx.paneRoot.hasAttribute('data-composer-compact'), true);
  assert.equal(ctx.settings.isCompact(), true);
  ctx.measured.reading = { available: 620, needed: 0 };
  ctx.observers[0].callback();
  ctx.flush();
  assert.equal(ctx.composer.hasAttribute('data-toolbar-compact'), false);
  assert.equal(ctx.paneRoot.hasAttribute('data-composer-compact'), false);
  assert.deepEqual(ctx.observers.map((observer) => observer.targets[0].className), ['composer-toolbar'], 'one observer, on the toolbar');
});

test('the summary follows the model pill and the run mode, and rechecks only when its text changed', async (t) => {
  const ctx = mount(t);
  ctx.flush();
  const before = ctx.measured.count;
  const modelLabel = ctx.group.querySelector('[data-inv-chip="composer-model"] .inv-chip-label');
  modelLabel.textContent = 'llava · 7b · Low';
  await ctx.settle();
  assert.equal(ctx.summary.querySelector('.inv-chip-label').textContent, 'llava · 7b · Low');
  ctx.flush();
  assert.equal(ctx.measured.count, before + 1, 'one measure for the label change');

  modelLabel.textContent = 'llava · 7b · Low';
  await ctx.settle();
  ctx.flush();
  assert.equal(ctx.measured.count, before + 1, 'an identical rewrite measures nothing');

  const runModeChip = ctx.group.querySelector('[data-inv-chip="composer-run-mode"]');
  runModeChip.classList.replace('composer-run-mode-ask', 'composer-run-mode-plan');
  await ctx.settle();
  const tag = ctx.summary.querySelector('.composer-settings-summary-mode');
  assert.equal(tag.textContent, 'Plan ·');
  assert.equal(ctx.summary.querySelector('.inv-chip-label').textContent, 'Plan · llava · 7b · Low');
  assert.match(ctx.summary.getAttribute('aria-label'), /Plan · llava/);
  runModeChip.classList.replace('composer-run-mode-plan', 'composer-run-mode-auto');
  await ctx.settle();
  assert.equal(ctx.summary.querySelector('.composer-settings-summary-mode').textContent, 'Auto ·');
});

test('the popover opens from the pill; Escape and an outside click close it and return focus', async (t) => {
  const ctx = mount(t);
  const { summary, composer, group, doc, window } = ctx;
  ctx.flush();
  summary.click();
  assert.equal(composer.hasAttribute('data-settings-open'), false, 'an expanded toolbar has no popover');
  collapse(ctx);

  summary.click();
  assert.equal(composer.hasAttribute('data-settings-open'), true);
  assert.equal(summary.getAttribute('aria-expanded'), 'true');
  assert.equal(group.getAttribute('role'), 'dialog');
  assert.equal(doc.activeElement, group.querySelector('[data-inv-chip="composer-run-mode"]'), 'focus moves to the first control');

  // A popover opened from inside the group takes Escape first.
  const inner = group.querySelector('.inv-popover');
  inner.hidden = false;
  doc.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(composer.hasAttribute('data-settings-open'), true, 'the inner popover closes first');
  inner.hidden = true;
  doc.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(composer.hasAttribute('data-settings-open'), false);
  assert.equal(summary.getAttribute('aria-expanded'), 'false');
  assert.equal(group.hasAttribute('role'), false);
  assert.equal(doc.activeElement, summary, 'Escape returns focus to the pill');

  // The attach body-level menu counts as inside; the textarea is outside.
  summary.click();
  const attachMenu = doc.getElementById('attachMenu');
  attachMenu.classList.remove('hidden');
  doc.getElementById('attachAction').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(composer.hasAttribute('data-settings-open'), true, 'a press in a popover opened from the group keeps it open');
  attachMenu.classList.add('hidden');
  // A press on a field closes it and the field keeps the focus the press gave it.
  const outside = doc.getElementById('outside');
  outside.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  outside.focus(); // the mousedown's default action, after the capture listener
  assert.equal(composer.hasAttribute('data-settings-open'), false, 'an outside press closes it');
  await new Promise((resolve) => window.setTimeout(resolve, 5));
  assert.equal(doc.activeElement, outside, 'a press on a field keeps its focus');

  // Gate D12: a press on nothing focusable leaves <body> focused; focus returns to the pill.
  summary.click();
  doc.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  doc.activeElement.blur(); // the mousedown's default action on a non-focusable target
  assert.equal(composer.hasAttribute('data-settings-open'), false);
  await new Promise((resolve) => window.setTimeout(resolve, 5));
  assert.equal(doc.activeElement, summary, 'focus that was inside returns to the pill');

  // The pill toggles; leaving compact closes it.
  summary.click();
  summary.click();
  assert.equal(composer.hasAttribute('data-settings-open'), false);
  summary.click();
  ctx.measured.reading = { available: 700, needed: 0 };
  ctx.settings.recheck();
  ctx.flush();
  assert.equal(composer.hasAttribute('data-toolbar-compact'), false);
  assert.equal(composer.hasAttribute('data-settings-open'), false, 'expanding closes the popover');
});

test('inside the IDE chat dock the toolbar collapses into its summary pill', (t) => {
  const ctx = mount(t, { html: `<div class="ide-chat-dock-body">${MARKUP}</div>`, reading: { available: 200, needed: 900 } });
  ctx.flush();
  ctx.settings.recheck();
  ctx.flush();
  assert.equal(ctx.composer.hasAttribute('data-toolbar-compact'), true);
  assert.ok(ctx.measured.count > 0, 'the dock is measured');
  assert.ok(ctx.summary.isConnected);
});

test('dispose disconnects both observers, removes the listeners and the pill, and clears the attributes', (t) => {
  const ctx = mount(t);
  const { doc, window } = ctx;
  const added = [];
  const removed = [];
  const originalAdd = doc.addEventListener.bind(doc);
  const originalRemove = doc.removeEventListener.bind(doc);
  doc.addEventListener = (type, handler, options) => { added.push(type); return originalAdd(type, handler, options); };
  doc.removeEventListener = (type, handler, options) => { removed.push(type); return originalRemove(type, handler, options); };
  ctx.flush();
  collapse(ctx);
  ctx.summary.click();
  assert.deepEqual(added.sort(), ['keydown', 'mousedown'], 'document listeners exist only while open');
  ctx.settings.dispose();
  assert.deepEqual(removed.sort(), ['keydown', 'mousedown']);
  assert.equal(ctx.observers[0].disconnected, true);
  assert.equal(ctx.mutationObservers.length, 1);
  assert.equal(ctx.mutationObservers[0].disconnected, true);
  assert.equal(ctx.summary.isConnected, false);
  assert.equal(ctx.composer.hasAttribute('data-toolbar-compact'), false);
  assert.equal(ctx.composer.hasAttribute('data-settings-open'), false);
  assert.equal(ctx.paneRoot.hasAttribute('data-composer-compact'), false);
  assert.equal(ctx.group.querySelector('[data-settings-label]'), null);
  ctx.measured.reading = { available: 100, needed: 900 };
  ctx.observers[0].callback();
  ctx.flush();
  assert.equal(ctx.composer.hasAttribute('data-toolbar-compact'), false, 'a disposed fit decides nothing');
  doc.getElementById('outside').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
});

test('measureComposerToolbar sums the one-line widths through the group and skips hidden or absolute items', (t) => {
  const dom = new JSDOM(`<!doctype html><body>${MARKUP}</body>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const toolbar = doc.querySelector('.composer-toolbar');
  const widths = new Map([
    [doc.getElementById('attach'), 30],
    [doc.querySelector('.composer-run-mode-slot'), 60],
    [doc.querySelector('.composer-model-pill-slot'), 150],
    [doc.getElementById('reason'), 1],
    [doc.getElementById('send'), 36],
  ]);
  for (const [element, width] of widths) Object.defineProperty(element, 'offsetWidth', { value: width });
  Object.defineProperty(toolbar, 'clientWidth', { value: 480 });
  doc.getElementById('reason').style.position = 'absolute';
  assert.deepEqual(measureComposerToolbar(toolbar), { available: 480, needed: 30 + 60 + 150 + 36 });
  assert.deepEqual(measureComposerToolbar(toolbar, { skipNeeded: true }), { available: 480, needed: 0 });
});

test('measureComposerToolbar counts the Chat chip, the break after the group, and no gap for an empty slot', (t) => {
  const dom = new JSDOM(`<!doctype html><body>${MARKUP}</body>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const toolbar = doc.querySelector('.composer-toolbar');
  const left = toolbar.querySelector('.composer-toolbar-left');
  const chat = doc.createElement('div');
  chat.className = 'composer-toggle-slot';
  left.append(chat);
  doc.getElementById('composerSettingsGroup').style.marginInlineEnd = '6px';
  const widths = new Map([
    [doc.getElementById('attach'), 30],
    [chat, 70],
    [doc.querySelector('.composer-run-mode-slot'), 60],
    [doc.querySelector('.composer-model-pill-slot'), 150],
    [doc.getElementById('send'), 36],
  ]);
  for (const [element, width] of widths) Object.defineProperty(element, 'offsetWidth', { value: width });
  Object.defineProperty(toolbar, 'clientWidth', { value: 480 });
  assert.equal(measureComposerToolbar(toolbar).needed, 30 + 70 + 60 + 150 + 6 + 36, 'the empty slot adds nothing; the break after the group counts');
});

test('chat and dock share the one-line fit and natural slot widths', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const fitCss = stripComments(fs.readFileSync(path.join(root, 'styles', 'chat-composer-fit.css'), 'utf8'));
  const dockCss = stripComments(fs.readFileSync(path.join(root, 'styles', 'ide-chat-dock.css'), 'utf8'));
  assert.match(fitCss, /:is\(\.chat-view, \.ide-chat-dock-body\) \.composer \.composer-toolbar\s*\{[^}]*flex-wrap: nowrap;/);
  assert.match(fitCss, /:is\(\.chat-view, \.ide-chat-dock-body\) \.composer:not\(\[data-toolbar-compact\]\)[^{]*\{[^}]*flex-shrink: 0;/);
  assert.doesNotMatch(dockCss, /#composer[^{}]*\{[^}]*order:|\.composer-toolbar-(?:left|right)[^{]*\{[^}]*display: contents;|flex: 1 1 0;/);
  assert.equal(/composer-settings-group|data-toolbar-compact/.test(dockCss), false, 'the dock never styles the group or the compact state');
});

test('the panel owns the project slot while the remaining rail slots stay siblings', async (t) => {
  const { loadRendererApp } = require('./helpers/renderer-shell-harness');
  const app = await loadRendererApp();
  t.after(() => app.dispose());
  const doc = app.window.document;
  const group = doc.getElementById('composerSettingsGroup');
  assert.equal(group.parentElement.classList.contains('composer-toolbar-right'), true);
  assert.deepEqual([...group.children].map((child) => child.id), [
    'composerContextUsageSlot', 'composerPlanUsageSlot', 'composerRunModeSlot', 'composerModelPillSlot',
  ]);
  assert.equal(doc.getElementById('composerChatPanel').contains(doc.getElementById('composerProjectPillSlot')), true);
  for (const id of ['stopStreamButton', 'sendButton', 'composerSendDisabledReason']) {
    assert.equal(doc.getElementById(id).parentElement, group.parentElement);
  }
  const rail = [...group.parentElement.children];
  assert.equal(rail[0], group, 'the settings group leads the right cluster');
  assert.ok(rail.indexOf(doc.getElementById('stopStreamButton')) < rail.indexOf(doc.getElementById('sendButton')), 'Stop comes before Send');
});

const ASK_HINT = 'Jenny asks before running tools that change things.';

test('the Chat chip closes the left cluster, and the run-mode hint lives in the chip title, not a row', async (t) => {
  const { loadRendererApp } = require('./helpers/renderer-shell-harness');
  const app = await loadRendererApp();
  t.after(() => app.dispose());
  const doc = app.window.document;
  const left = doc.querySelector('.composer-toolbar-left');
  assert.deepEqual([...left.children].map((child) => child.id), [
    'composerAttachShortcut', 'composerTerminalShortcut', 'composerToolToggleSlot',
  ]);
  assert.equal(doc.getElementById('composerToolToggleSlot').contains(doc.getElementById('composerChatChipHost')), true);
  assert.equal(doc.getElementById('composerSettingsGroup').contains(doc.getElementById('composerToolToggleSlot')), false);
  assert.equal(doc.getElementById('composerRunModeHint'), null, 'the always-visible hint sentence is gone');
  const chip = doc.getElementById('composerRunModeChip');
  assert.ok(chip.getAttribute('title').includes(ASK_HINT), 'the chip title carries the hint');
  assert.ok(chip.getAttribute('aria-label').includes(ASK_HINT), 'the chip label carries the hint');
});
/* Settings popover polish (owner-approved PO review 2026-09-26, the settings
 * list): row clicks and keys, bounds, and the pill's icon and caret. */
const AUTO_ICON = '<svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14"></polygon></svg>';
const PLAN_ICON = '<svg viewBox="0 0 24 24"><path d="M9 6h11"></path></svg>';
const segment = (mode, pressed) => `<button type="button" class="composer-run-mode-segment${pressed ? ' is-active' : ''}" data-run-mode-option="${mode}" aria-pressed="${pressed}">${mode}</button>`;
const RICH_MARKUP = MARKUP
  .replace(/<div class="composer-run-mode-slot">[\s\S]*?<\/button><\/div>/,
    '<div class="composer-run-mode-slot"><button type="button" class="inv-chip composer-run-mode-chip composer-run-mode-auto" data-inv-chip="composer-run-mode" id="runModeChip">'
    + `<span class="inv-chip-icon" aria-hidden="true">${AUTO_ICON}</span><span class="inv-chip-label">Auto</span></button>`
    + `<div class="composer-run-mode-segments" role="group" aria-label="Run mode">${segment('ask', false)}${segment('auto', true)}${segment('plan', false)}</div></div>`)
  .replace('<div class="inv-popover" hidden></div>', '<div class="inv-popover" hidden><button type="button" id="pickerOption"></button></div>');

function openRich(t) {
  const ctx = mount(t, { html: RICH_MARKUP });
  ctx.flush();
  collapse(ctx);
  ctx.key = (name) => {
    const event = new ctx.window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true });
    ctx.doc.activeElement.dispatchEvent(event);
    return event;
  };
  ctx.byId = (id) => ctx.doc.getElementById(id);
  ctx.seg = (mode) => ctx.group.querySelector(`[data-run-mode-option="${mode}"]`);
  return ctx;
}

test('the pill carries a trailing caret and, outside Ask, the run-mode icon right before its label', async (t) => {
  const ctx = mount(t, { html: RICH_MARKUP });
  const { summary, group } = ctx;
  const caret = summary.lastElementChild;
  assert.equal(caret.className, 'composer-settings-summary-caret', 'the caret is the last child');
  assert.equal(caret.getAttribute('aria-hidden'), 'true');
  assert.equal(caret.querySelector('svg path').getAttribute('d'), 'M4 10l4-4 4 4', 'an svg chevron-up, not a text glyph');
  assert.equal(caret.textContent, '');

  const labelEl = summary.querySelector('.inv-chip-label');
  let icon = summary.querySelector('.composer-settings-summary-mode-icon');
  assert.ok(icon, 'Auto shows the mode icon');
  assert.equal(icon.parentElement, summary, 'a direct child of the pill, so it survives a zero-width label');
  assert.equal(icon.nextElementSibling, labelEl, 'right before the label');
  assert.equal(icon.getAttribute('aria-hidden'), 'true');
  assert.equal(icon.innerHTML, AUTO_ICON, 'a clone of the run-mode chip\'s icon');
  assert.equal(summary.querySelector('.composer-settings-summary-mode').textContent, 'Auto ·', 'the tag text is unchanged');
  assert.equal(labelEl.textContent, 'Auto · qwen3.5 · 9b · High', 'the icon adds no text');

  // Plan: the chip re-renders (class + icon); the clone follows, once.
  const chipEl = group.querySelector('[data-inv-chip="composer-run-mode"]');
  ctx.flush();
  const before = ctx.measured.count;
  chipEl.classList.replace('composer-run-mode-auto', 'composer-run-mode-plan');
  chipEl.querySelector('.inv-chip-icon').innerHTML = PLAN_ICON;
  await ctx.settle();
  ctx.flush();
  icon = summary.querySelector('.composer-settings-summary-mode-icon');
  assert.equal(icon.innerHTML, PLAN_ICON);
  assert.equal(summary.querySelector('.composer-settings-summary-mode').textContent, 'Plan ·');
  await ctx.settle();
  ctx.flush();
  assert.equal(ctx.measured.count, before + 1, 'one recheck: writing the pill (outside the observed slots) does not loop');

  // Ask: no tag, no icon; the caret is still last.
  chipEl.classList.replace('composer-run-mode-plan', 'composer-run-mode-ask');
  await ctx.settle();
  assert.equal(summary.querySelector('.composer-settings-summary-mode-icon'), null, 'Ask has no icon');
  assert.equal(summary.querySelector('.composer-settings-summary-mode'), null);
  assert.equal(summary.lastElementChild, caret);
  assert.equal(summary.querySelectorAll('.composer-settings-summary-caret').length, 1);
});

test('the plain chip without an icon shows the tag and no icon span', async (t) => {
  const ctx = mount(t);
  ctx.group.querySelector('[data-inv-chip="composer-run-mode"]').classList.replace('composer-run-mode-ask', 'composer-run-mode-auto');
  await ctx.settle();
  assert.equal(ctx.summary.querySelector('.composer-settings-summary-mode').textContent, 'Auto ·');
  assert.equal(ctx.summary.querySelector('.composer-settings-summary-mode-icon'), null);
});

// Gate N2 (2026-09-27): a row focused on open showed its tooltip over the list's header.
test('opening clamps the popover to the toolbar width once and suppresses tooltips; closing clears both', (t) => {
  let hides = 0;
  const ctx = mount(t, { html: RICH_MARKUP, deps: { tooltip: { hide: () => { hides += 1; } } } });
  ctx.flush();
  collapse(ctx);
  let reads = 0;
  Object.defineProperty(ctx.doc.querySelector('.composer-toolbar'), 'clientWidth', { configurable: true, get: () => { reads += 1; return 236; } });
  ctx.composer.closest('.chat-pane').getBoundingClientRect = () => ({ top: 30 });
  ctx.doc.querySelector('.composer-toolbar').getBoundingClientRect = () => ({ top: 300 });
  ctx.summary.click();
  assert.equal(ctx.group.style.getPropertyValue('--settings-max-block'), '258px');
  assert.equal(ctx.group.style.getPropertyValue('--settings-max-inline'), '236px');
  assert.equal(reads, 1, 'one width read, at open');
  assert.deepEqual([ctx.group, ctx.summary].map((node) => node.hasAttribute('data-tooltip-suppressed')), [true, true]);
  assert.equal(hides, 1, 'a tooltip already up (the pill hovered before the click) goes');
  ctx.summary.click();
  assert.equal(ctx.group.style.getPropertyValue('--settings-max-inline'), '', 'removed on close');
  assert.equal(ctx.group.style.getPropertyValue('--settings-max-block'), '', 'removed on close');
  assert.deepEqual([ctx.group, ctx.summary].map((node) => node.hasAttribute('data-tooltip-suppressed')), [false, false]);
});

test('opening focuses the first row\'s target; Up/Down/Home/End walk the rows, Left/Right the run-mode segments', (t) => {
  const ctx = openRich(t);
  const { summary, doc, byId, seg, key } = ctx;
  summary.click();
  assert.equal(doc.activeElement, seg('auto'), 'focus-first: the pressed run-mode segment');
  key('ArrowRight');
  assert.equal(doc.activeElement, seg('plan'));
  key('ArrowRight');
  assert.equal(doc.activeElement, seg('ask'), 'Right wraps');
  key('ArrowLeft');
  assert.equal(doc.activeElement, seg('plan'));
  assert.equal(seg('plan').getAttribute('aria-pressed'), 'false', 'moving focus activates nothing');
  assert.equal(key('ArrowDown').defaultPrevented, true);
  const model = ctx.group.querySelector('[data-inv-chip="composer-model"]');
  assert.equal(doc.activeElement, model);
  key('ArrowDown');
  assert.equal(doc.activeElement, seg('auto'), 'Down skips the empty tools slot and wraps');
  key('ArrowUp');
  assert.equal(doc.activeElement, model, 'Up wraps');
  key('Home');
  assert.equal(doc.activeElement, seg('auto'));
  key('End');
  assert.equal(doc.activeElement, model);
  assert.equal(key('ArrowLeft').defaultPrevented, false, 'Left/Right off a segment are left alone');

  // A popover opened from a row owns the keys.
  const inner = ctx.group.querySelector('.inv-popover');
  inner.hidden = false;
  byId('pickerOption').focus();
  assert.equal(key('ArrowDown').defaultPrevented, false);
  assert.equal(doc.activeElement, byId('pickerOption'));
  inner.hidden = true;

  // Escape still closes; the row keys go with it.
  ctx.group.querySelector('[data-inv-chip="composer-model"]').focus();
  key('Escape');
  assert.equal(ctx.composer.hasAttribute('data-settings-open'), false);
  assert.equal(key('ArrowDown').defaultPrevented, false, 'closed: no row keys');
});

test('a disabled pressed segment falls back to the first enabled one', (t) => {
  const ctx = openRich(t);
  ctx.seg('auto').disabled = true;
  ctx.summary.click();
  assert.equal(ctx.doc.activeElement, ctx.seg('ask'), 'run mode focuses its first enabled segment');
});

test('a press on a row\'s label or padding clicks its primary control; run mode is not forwarded', (t) => {
  const ctx = openRich(t);
  const { group, byId, window } = ctx;
  const clicks = [];
  const count = (id, node) => node.addEventListener('click', () => clicks.push(id));
  count('runMode', byId('runModeChip'));
  ['ask', 'auto', 'plan'].forEach((mode) => count(mode, ctx.seg(mode)));
  const modelPill = group.querySelector('[data-inv-chip="composer-model"]');
  count('model', modelPill);
  count('pickerOption', byId('pickerOption'));
  const press = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

  press(group.querySelector('.composer-model-pill-slot'));
  assert.deepEqual(clicks, [], 'closed: nothing is forwarded');
  ctx.summary.click();

  press(group.querySelector('.composer-model-pill-slot'));
  assert.deepEqual(clicks.splice(0), ['model']);
  press(group.querySelector('.composer-run-mode-slot'));
  assert.deepEqual(clicks.splice(0), [], 'the run-mode row has no single control');
  press(modelPill);
  assert.deepEqual(clicks.splice(0), ['model'], 'a press on the control itself is not forwarded again');
  modelPill.disabled = true;
  press(group.querySelector('.composer-model-pill-slot'));
  assert.deepEqual(clicks.splice(0), [], 'no enabled control outside a popover: nothing');
  press(group.querySelector('.composer-plan-usage-slot'));
  assert.deepEqual(clicks.splice(0), [], 'an empty slot has no control');

  modelPill.disabled = false;
  ctx.settings.setOpen(false);
  press(group.querySelector('.composer-model-pill-slot'));
  assert.deepEqual(clicks, [], 'closing removes the listener');
});

test('resolveSettingsPopoverAnchor names the open compact settings group around a trigger, else null', (t) => {
  const dom = new JSDOM(`<!doctype html><body><div class="composer" data-toolbar-compact data-settings-open>
    <div class="composer-settings-group" id="group"><div class="composer-context-usage-slot"><button id="ring"></button></div></div></div>
    <button id="stray"></button></body>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const ring = doc.getElementById('ring');
  assert.equal(resolveSettingsPopoverAnchor(ring), doc.getElementById('group'));
  assert.equal(resolveSettingsPopoverAnchor(doc.getElementById('stray')), null);
  assert.equal(resolveSettingsPopoverAnchor(null), null);
  assert.equal(resolveSettingsPopoverAnchor({}), null, 'a non-element is null-safe');
  doc.querySelector('.composer').removeAttribute('data-settings-open');
  assert.equal(resolveSettingsPopoverAnchor(ring), null, 'a closed popover anchors nothing');
  doc.querySelector('.composer').setAttribute('data-settings-open', '');
  doc.querySelector('.composer').removeAttribute('data-toolbar-compact');
  assert.equal(resolveSettingsPopoverAnchor(ring), null, 'an expanded toolbar anchors nothing');
});

test('placePopoverOverAnchor covers the anchor from its bottom-end corner, clamps to the viewport; clearPopoverCover undoes it', (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="group"></div><div id="popover" style="position: fixed"></div></body>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  const doc = window.document;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
  const group = doc.getElementById('group');
  const popover = doc.getElementById('popover');
  let anchorRect = { left: 500, right: 780, top: 300, bottom: 560, width: 280, height: 260 };
  let popoverRect = { width: 320, height: 200 };
  group.getBoundingClientRect = () => anchorRect;
  popover.getBoundingClientRect = () => popoverRect;

  const layout = placePopoverOverAnchor(popover, group);
  assert.equal(popover.style.minWidth, '280px');
  assert.equal(popover.style.minHeight, '260px');
  assert.equal(popover.dataset.settingsCover, '1');
  assert.equal(popover.style.left, '460px', 'right edges meet: 780 - 320');
  assert.equal(popover.style.top, '300px', 'bottom edges meet at the anchor\'s height (the min-height floor)');
  assert.equal(layout.maxHeight, 568);

  // Clamped: a wide popover near the right and bottom edges.
  anchorRect = { left: 510, right: 790, top: 330, bottom: 590, width: 280, height: 260 };
  popoverRect = { width: 400, height: 260 };
  placePopoverOverAnchor(popover, group, { margin: 12 });
  assert.equal(popover.style.left, '388px', '800 - 12 - 400');
  assert.equal(popover.style.top, '328px', '600 - 12 - 260');

  // An offsetParent-relative popover gets the same corner in its parent's coordinates.
  anchorRect = { left: 500, right: 780, top: 300, bottom: 560, width: 280, height: 260 };
  popoverRect = { width: 320, height: 200 };
  Object.defineProperty(popover, 'offsetParent', { configurable: true, value: { getBoundingClientRect: () => ({ left: 100, top: 50 }) } });
  placePopoverOverAnchor(popover, group);
  assert.equal(popover.style.left, '360px');
  assert.equal(popover.style.top, '250px');

  clearPopoverCover(popover);
  assert.equal(popover.style.minWidth, '');
  assert.equal(popover.style.minHeight, '');
  assert.equal(popover.dataset.settingsCover, undefined);
  popover.style.minWidth = '99px';
  clearPopoverCover(popover);
  assert.equal(popover.style.minWidth, '99px', 'an unflagged popover keeps its own sizes');
  assert.equal(placePopoverOverAnchor(null, group), null);
  clearPopoverCover(null);

  // A stylesheet floor above the anchor's size stays the floor.
  const style = doc.createElement('style');
  style.textContent = '#popover { min-width: 292px; }';
  doc.head.append(style);
  popover.style.minWidth = '';
  placePopoverOverAnchor(popover, group);
  assert.equal(popover.style.minWidth, '292px');
  assert.equal(popover.style.minHeight, '260px');
});

test('a row-label press opens the row menu and keeps it open (the popover module\'s click-away does not see it)', (t) => {
  const popover = require('../renderer/inventory/popover.js');
  const html = `<div class="chat-pane" id="p"><div class="composer" id="wrap"><div class="composer-toolbar"><div class="composer-toolbar-left"></div>
    <div class="composer-toolbar-right composer-rail"><div class="composer-settings-group" id="composerSettingsGroup">
    <div class="composer-run-mode-slot"><button type="button" class="inv-chip composer-run-mode-chip composer-run-mode-ask" data-inv-chip="composer-run-mode"><span class="inv-chip-label">Ask</span></button></div>
    <div class="composer-model-pill-slot"><button type="button" class="inv-chip" data-inv-chip="composer-model" aria-haspopup="dialog" aria-controls="mp"><span class="inv-chip-label">m</span></button><div class="inv-popover" id="mp" hidden><button type="button" id="opt"></button></div></div>
    </div><button type="button" class="composer-send"></button></div></div></div></div>`;
  const ctx = mount(t, { html, reading: { available: 100, needed: 600 } });
  ctx.flush();
  collapse(ctx);
  // The app's wiring: the document click-away and the composer's chip delegate.
  popover.initPopoverHandlers(ctx.doc);
  ctx.doc.getElementById('wrap').addEventListener('click', (event) => {
    const chipEl = event.target.closest('[data-inv-chip="composer-model"]');
    if (chipEl) popover.toggle(ctx.doc.getElementById(chipEl.getAttribute('aria-controls')), { trigger: chipEl });
  });
  ctx.settings.setOpen(true);
  const menu = ctx.doc.getElementById('mp');
  ctx.doc.querySelector('.composer-model-pill-slot').dispatchEvent(new ctx.window.MouseEvent('click', { bubbles: true }));
  assert.equal(menu.hidden, false, 'the forwarded click opened the picker and the row press did not close it again');
});

test('expanding while a run-mode segment has focus hands it to the toolbar\'s cycling chip (Astra review P2)', (t) => {
  const ctx = openRich(t);
  ctx.summary.click();
  ctx.seg('plan').focus();
  assert.equal(ctx.doc.activeElement, ctx.seg('plan'));
  ctx.measured.reading = { available: 900, needed: 0 };
  ctx.settings.recheck();
  ctx.flush();
  assert.equal(ctx.composer.hasAttribute('data-toolbar-compact'), false);
  assert.equal(ctx.doc.activeElement, ctx.byId('runModeChip'), 'the segments leave with the list; the chip they mirror takes the focus');
});

test('compact settings contains Tab at both ends and closes when focus leaves the list and pill', (t) => {
  const ctx = openRich(t);
  ctx.summary.click();
  ctx.byId('runModeChip').style.display = 'none';
  const first = ctx.seg('ask');
  const last = ctx.group.querySelector('[data-inv-chip="composer-model"]');
  last.focus();
  assert.equal(ctx.key('Tab').defaultPrevented, true);
  assert.equal(ctx.doc.activeElement, first);
  const back = new ctx.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
  first.dispatchEvent(back);
  assert.equal(back.defaultPrevented, true);
  assert.equal(ctx.doc.activeElement, last);
  ctx.summary.focus();
  assert.equal(ctx.settings.isOpen(), true, 'focus on the summary stays inside');
  ctx.byId('outside').focus();
  assert.equal(ctx.settings.isOpen(), false);
});

test('a press on a row label (focus leaves to nothing) keeps the compact list open for the row click', (t) => {
  const ctx = openRich(t);
  ctx.summary.click();
  const last = ctx.group.querySelector('[data-inv-chip="composer-model"]');
  last.focus();
  last.dispatchEvent(new ctx.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  assert.equal(ctx.settings.isOpen(), true);
  ctx.byId('outside').focus();
  assert.equal(ctx.settings.isOpen(), false);
});
