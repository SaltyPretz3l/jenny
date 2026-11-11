'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const stylesDir = path.join(__dirname, '..', 'styles');

function readStyle(name) {
  return fs.readFileSync(path.join(stylesDir, name), 'utf8');
}

function blockFor(css, selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `expected a "${selector} {" block`);
  const end = css.indexOf('}', start);
  return css.slice(start, end);
}

test('reduced motion keeps the copy chip visible for its JS lifetime', () => {
  const css = readStyle('chat-hover-actions-v2.css');
  const reducedMotion = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  // Token zeroing cannot replace this rule: the fade ends at opacity 0 with
  // forwards, hiding "Copied!" immediately during its 1200 ms JS lifetime.
  const chip = blockFor(reducedMotion, '.chat-copy-chip');
  assert.match(chip, /animation:\s*none;/);
  assert.match(chip, /opacity:\s*1;/);
  assert.match(chip, /transform:\s*none;/);
});

test('sprite geometry has one transform owner and never chases layout', () => {
  // The sprite paints no disc; the layer fades in only and never transitions on hide.
  const thread = readStyle('chat-thread.css');
  const block = blockFor(thread, '.chat-assistant-sprite');
  assert.doesNotMatch(block, /transition:[^;]*\btransform\b/s, 'chat-thread.css');
  assert.doesNotMatch(blockFor(thread, '.chat-sprite-layer'), /transition\s*:/, 'hiding the layer is instant');
  assert.match(blockFor(thread, '.chat-sprite-layer.visible'), /transition:\s*opacity var\(--transition-regular\)/);
});

test('pending approval liveness belongs to the kicker dot', () => {
  const css = readStyle('chat-tool-markers.css');
  const sectionStart = css.indexOf('Approval-gap row visual distinction');
  const sectionEnd = css.indexOf('Approval batch banner', sectionStart);
  assert.notEqual(sectionStart, -1);
  assert.notEqual(sectionEnd, -1);
  const section = css.slice(sectionStart, sectionEnd);
  const selector = '.approval-gap-row[data-approval-status="pending"] .tool-approval-kicker-dot';

  assert.doesNotMatch(section, /border-(left|inline-start)/);
  assert.doesNotMatch(section, /approval-gap-pulse/);
  assert.match(blockFor(section, selector), /animation:\s*approval-kicker-breathe var\(--motion-duration-pulse\)/);

  const reducedMotion = section.slice(section.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(blockFor(reducedMotion, selector), /animation:\s*none/);
});

test('streaming reasoning has no tail dim mask', () => {
  for (const name of ['chat-machinery.css', 'chat-media-queries.css', 'foundation.css']) {
    const css = readStyle(name);
    assert.doesNotMatch(css, /streaming-tail-fade-mask/, name);
    assert.doesNotMatch(css, /\.reasoning-row-panel-body\s*\{\s*mask-image/, name);
  }
});

test('reasoning panels transition max-height at regular duration without padding', () => {
  const panel = blockFor(readStyle('chat-machinery.css'), '.reasoning-row-panel');
  const transition = panel.match(/transition:\s*([^;]+);/s)?.[1];
  assert.ok(transition, 'reasoning panel declares its transition');
  assert.match(transition, /\bmax-height\s+var\(--motion-duration-regular\)/);
  assert.doesNotMatch(transition, /\bpadding(?:-[a-z-]+)?\b/);
});

test('a collapsing reasoning panel zeroes its block padding so the clip reaches zero', () => {
  const rule = blockFor(readStyle('chat-machinery.css'), '.reasoning-row-panel.expanded[data-collapsing="true"]');
  assert.match(rule, /padding-top:\s*0;/);
  assert.match(rule, /padding-bottom:\s*0;/);
});

test('the live reasoning box is flag-scoped, holds through the collapse and keeps its cap under reduced motion', () => {
  // Row 101 Phase 2: the cap applies only under the root flag attribute, in the Thinking view
  // (Answers view excluded), to a streaming body and to a marked body while its panel is open
  // (the settle collapse, and an earlier phase that settled open mid-turn).
  const css = readStyle('chat-machinery.css');
  const start = css.indexOf(':root[data-reasoning-live-box="on"] .chat-timeline:not([data-transcript-view="answers"])');
  assert.notEqual(start, -1, 'expected the flag-scoped live box rule');
  const rule = css.slice(start, css.indexOf('}', start));
  assert.match(rule, /\.reasoning-row-block\[data-reasoning-status="streaming"\] \.reasoning-row-panel\.expanded > \.reasoning-row-panel-body/);
  assert.match(rule, /:root\[data-reasoning-live-box="on"\] \.reasoning-row-panel\.expanded > \.reasoning-row-panel-body\[data-live-box="true"\]/);
  assert.match(rule, /max-height:\s*max\(\s*calc\(1\.62em \* 10\),\s*calc\(var\(--chat-thread-viewport-h, 70vh\) - var\(--chat-thread-offset, 0px\) - var\(--composer-safe-offset, 0px\) - var\(--tl-row-h, 30px\) - 3em\)\s*\)/);
  assert.match(rule, /overflow-y:\s*auto;/);
  assert.doesNotMatch(rule, /overscroll-behavior/, 'the wheel chains to the timeline at the box edges');
  const fade = blockFor(css, ':root[data-reasoning-live-box="on"] .reasoning-row-panel-body[data-live-box="true"].has-scrolled');
  assert.match(fade, /mask-image:\s*linear-gradient\(to bottom, transparent 0, #000 2\.4em\)/);
  // Reduced motion never lifts the cap: no reduced-motion block mentions the box.
  for (const chunk of css.split('@media (prefers-reduced-motion: reduce)').slice(1)) {
    const body = chunk.slice(0, chunk.indexOf('\n}'));
    assert.doesNotMatch(body, /data-live-box|reasoning-live-box/);
  }
});
