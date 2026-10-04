'use strict';

// CSS contract for the timeline activity dot (docs/plans/TIMELINE_ACTIVITY_DOT_SPEC_2026-10-02.md,
// sections 3.1-3.3). The morph engine (renderer-sprite-morph.js) eases into each loop from the
// state's entry pose, so every looping element's static declaration must equal its 0% keyframe.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const rootDir = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(rootDir, relativePath), 'utf8');

const DOT_SHEET = 'styles/chat-sprite-dot.css';
const dotCss = read(DOT_SHEET);

// --- minimal CSS tree: rules, @media/@supports containers, @keyframes ---------
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

function normalizeValue(value) {
  return value.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}

function parseDecls(body) {
  const decls = new Map();
  for (const part of body.split(';')) {
    const index = part.indexOf(':');
    if (index === -1) continue;
    const prop = part.slice(0, index).trim();
    if (prop) decls.set(prop, normalizeValue(part.slice(index + 1)));
  }
  return decls;
}

function parseBlocks(text) {
  const nodes = [];
  let depth = 0;
  let start = 0;
  let preludeStart = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '{') {
      if (depth === 0) {
        start = i + 1;
      }
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const prelude = text.slice(preludeStart, start - 1).trim();
        const body = text.slice(start, i);
        nodes.push({ prelude, body });
        preludeStart = i + 1;
      }
    }
  }
  return nodes;
}

function collect(text, context, out) {
  for (const { prelude, body } of parseBlocks(text)) {
    if (/^@keyframes\s/.test(prelude)) {
      const frames = new Map();
      for (const frame of parseBlocks(body)) {
        for (const stop of frame.prelude.split(',')) {
          const key = stop.trim().replace('from', '0%').replace('to', '100%');
          frames.set(key, { ...(frames.get(key) || {}), ...Object.fromEntries(parseDecls(frame.body)) });
        }
      }
      out.keyframes.set(prelude.replace(/^@keyframes\s+/, '').trim(), frames);
    } else if (prelude.startsWith('@')) {
      collect(body, `${context} ${prelude}`.trim(), out);
    } else {
      const selectors = prelude.split(',').map((s) => normalizeValue(s));
      out.rules.push({ context, selectors, decls: parseDecls(body), prelude });
    }
  }
}

function parseSheet(text) {
  const out = { rules: [], keyframes: new Map() };
  collect(stripComments(text), '', out);
  return out;
}

const dot = parseSheet(dotCss);
const REDUCED = '@media (prefers-reduced-motion: reduce)';
const isReduced = (rule) => rule.context.includes(REDUCED);
const baseRules = dot.rules.filter((rule) => !isReduced(rule));
const reducedRules = dot.rules.filter(isReduced);

function declsFor(rules, selector) {
  const merged = new Map();
  for (const rule of rules) {
    if (rule.selectors.includes(selector)) {
      for (const [prop, value] of rule.decls) merged.set(prop, value);
    }
  }
  return merged;
}

const D = '.chat-sprite-dot';
const state = (name) => `${D}[data-activity="${name}"]`;

// --- 1. wiring ----------------------------------------------------------------
test('styles.css imports the dot sheet and the retired v2 sheet is gone', () => {
  const imports = read('styles.css');
  assert.ok(imports.includes('./styles/chat-sprite-dot.css'), 'styles.css imports chat-sprite-dot.css');
  assert.equal(imports.includes('chat-sprite-v2.css'), false, 'v2 folded into chat-thread.css');
  assert.equal(fs.existsSync(path.join(rootDir, 'styles', 'chat-sprite-v2.css')), false);
  assert.ok(fs.existsSync(path.join(rootDir, 'styles', 'chat-sprite-dot.css')));
});

test('index.html carries no sprite holo canvas and keeps the aria-hidden glyph blocks', () => {
  const html = read('index.html');
  assert.equal(/chat-sprite-holo|chatSpriteHolo/.test(html), false, 'holo canvas is retired');
  const blocks = html.match(/<div class="chat-assistant-sprite"[^>]*>[\s\S]*?<\/div>/g) || [];
  assert.equal(blocks.length, 2, 'main block and pane template both stay');
  for (const block of blocks) {
    assert.match(block, /aria-hidden="true"/);
    assert.match(block, /<span class="chat-assistant-sprite-glyph">J<\/span>/);
  }
});

// --- 2. retired disc and holo --------------------------------------------------
test('no sprite holo, streaming promotion, state tint or promotion hint remains', () => {
  const spriteSheets = [
    'styles/chat-thread.css',
    'styles/chat-thread-presets.css',
    DOT_SHEET,
  ];
  for (const sheet of spriteSheets) {
    if (!fs.existsSync(path.join(rootDir, sheet))) continue;
    const css = stripComments(read(sheet));
    assert.equal(/data-sprite-holo/.test(css), false, `${sheet} data-sprite-holo`);
    assert.equal(/chat-sprite-holo/.test(css), false, `${sheet} .chat-sprite-holo`);
    assert.equal(/chat-assistant-sprite\.is-streaming/.test(css), false, `${sheet} .is-streaming`);
    assert.equal(/data-sprite-state/.test(css), false, `${sheet} data-sprite-state tint`);
    assert.equal(/chat-assistant-sprite::(?:before|after)/.test(css), false, `${sheet} holo rings`);
    assert.equal(/--sprite-holo-/.test(css), false, `${sheet} --sprite-holo-* tokens`);
    assert.equal(/sprite-holo-cycle/.test(css), false, `${sheet} holo keyframes`);
    for (const rule of parseSheet(css).rules) {
      if (rule.selectors.some((selector) => /sprite/.test(selector))) {
        assert.equal(rule.decls.has('will-change'), false, `${sheet} ${rule.prelude} will-change`);
      }
    }
  }
  assert.equal(/data-sprite-holo|\.chat-sprite-holo/.test(
    fs.readdirSync(path.join(rootDir, 'styles')).filter((f) => f.endsWith('.css'))
      .map((f) => stripComments(read(`styles/${f}`))).join('\n')
  ), false, 'no stylesheet selects the sprite holo');
  assert.equal(/will-change/.test(stripComments(dotCss)), false, 'no compositor promotion in the dot sheet');
});

test('the sprite layer and its glyph keep their contracts without the disc', () => {
  const thread = parseSheet(read('styles/chat-thread.css'));
  const sprite = declsFor(thread.rules, '.chat-assistant-sprite');
  assert.equal(sprite.get('width'), 'var(--chat-sprite-size)');
  assert.equal(sprite.get('height'), 'var(--chat-sprite-size)');
  assert.equal(sprite.get('inset-inline-start'), '2px');
  for (const prop of ['border', 'background', 'box-shadow', 'border-radius', 'opacity']) {
    assert.equal(sprite.has(prop), false, `.chat-assistant-sprite no longer paints a disc (${prop})`);
  }
  assert.equal(declsFor(thread.rules, '.chat-sprite-layer').has('transition'), false, 'the layer never fades out');
  const glyph = declsFor(thread.rules, '.chat-assistant-sprite-glyph');
  assert.equal(glyph.get('font-family'), 'var(--font-family-brand)');
  assert.equal(glyph.get('text-transform'), 'uppercase');
});

// --- 3. tokens -----------------------------------------------------------------
test('sprite tokens default to the timeline status tokens and motion tokens are defined once', () => {
  const root = declsFor(baseRules, ':root');
  for (const [name, source] of [
    ['active', 'info'], ['warn', 'warn'], ['error', 'error'], ['ok', 'ok'], ['muted', 'muted'],
  ]) {
    const token = name === 'active' ? 'active' : name;
    assert.equal(root.get(`--sprite-dot-${name}`), `var(--tl-status-${token})`, `${name} (${source})`);
  }
  assert.equal(root.get('--sprite-morph-duration'), '280ms');
  assert.equal(root.get('--sprite-morph-urgent'), '140ms');
  assert.equal(root.get('--sprite-morph-ease'), 'cubic-bezier(0.2,0.7,0.2,1)');
  assert.equal(root.get('--sprite-j-duration'), '360ms');
});

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

function parseColor(value) {
  const v = value.trim();
  if (v.startsWith('#')) return { rgb: hexToRgb(v), alpha: 1 };
  const m = v.match(/rgba?\(([^)]+)\)/);
  assert.ok(m, `unparseable color ${value}`);
  const parts = m[1].split(',').map(Number);
  return { rgb: parts.slice(0, 3), alpha: parts[3] === undefined ? 1 : parts[3] };
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bgHex) {
  const bg = hexToRgb(bgHex);
  const { rgb, alpha } = parseColor(fg);
  const blended = rgb.map((v, i) => v * alpha + bg[i] * (1 - alpha));
  const a = luminance(blended);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const SPRITE_TONES = ['active', 'warn', 'error', 'ok', 'muted'];

function lightPalettes() {
  return fs.readdirSync(path.join(rootDir, 'styles'))
    .filter((name) => /^palette-.+\.css$/.test(name))
    .filter((name) => /color-scheme:\s*light/.test(read(`styles/${name}`)))
    .map((name) => name.replace(/^palette-/, '').replace(/\.css$/, ''))
    .sort();
}

function paletteBackgrounds(name) {
  const css = stripComments(read(`styles/palette-${name}.css`));
  const colors = [];
  const baseMatch = css.match(/--bg-base:\s*(#[0-9a-fA-F]{6})/);
  assert.ok(baseMatch, `${name} --bg-base`);
  colors.push(baseMatch[1]);
  for (const token of ['--surface-body-background', '--mat-work-bg']) {
    const m = css.match(new RegExp(`${token}:[^;]*?(#[0-9a-fA-F]{6})\\s*;`));
    if (m) colors.push(m[1]);
  }
  return colors;
}

test('every light palette overrides the sprite tones and meets 3:1 on its chat backgrounds', () => {
  const light = lightPalettes();
  assert.deepEqual(light, ['jenny-day', 'paper', 'woolly'], 'the light palette set changed: review the overrides');
  for (const name of light) {
    const decls = declsFor(baseRules, `:root[data-palette="${name}"]`);
    const backgrounds = paletteBackgrounds(name);
    for (const tone of SPRITE_TONES) {
      const value = decls.get(`--sprite-dot-${tone}`);
      assert.ok(value, `${name} overrides --sprite-dot-${tone}`);
      for (const bg of backgrounds) {
        assert.ok(contrast(value, bg) >= 3, `${name} ${tone} vs ${bg}: ${contrast(value, bg).toFixed(2)}`);
      }
    }
  }
  for (const name of fs.readdirSync(path.join(rootDir, 'styles'))
    .filter((f) => /^palette-.+\.css$/.test(f)).map((f) => f.replace(/^palette-|\.css$/g, ''))) {
    if (!light.includes(name)) {
      assert.equal(declsFor(baseRules, `:root[data-palette="${name}"]`).size, 0, `${name} (dark) keeps the defaults`);
    }
  }
});

// --- 4. root, scaling, urgent, suspended ---------------------------------------
test('the dot root is a fixed 30px centered coordinate space that alone takes the breakpoint scale', () => {
  const root = declsFor(baseRules, D);
  assert.equal(root.get('width'), '30px');
  assert.equal(root.get('height'), '30px');
  assert.equal(root.get('margin'), '-15px');
  assert.equal(root.get('inset-block-start'), '50%');
  assert.equal(root.get('inset-inline-start'), '50%');
  assert.equal(root.get('transform'), 'scale(var(--sprite-dot-scale))');
  assert.equal(declsFor(baseRules, ':root').get('--sprite-dot-scale'), '1');
  const media = baseRules.filter((rule) => rule.context === '@media (max-width: 700px)');
  assert.equal(declsFor(media, '.chat-view').get('--sprite-dot-scale'), '0.8');
  // The ratio mirrors chat-media-queries.css: --chat-sprite-size clamp(22px, 5vw, 24px) is 24px
  // at every width where the rail still shows (phones hide it at <= 480px), and 24 / 30 = 0.8.
  assert.match(read('styles/chat-media-queries.css'),
    /@media \(max-width:\s*700px\)\s*\{[^@]*?--chat-sprite-size:\s*clamp\(22px,\s*5vw,\s*24px\);/);
  for (const rule of baseRules) {
    if (rule.selectors.some((s) => s.startsWith(D) && s !== D)) {
      assert.equal(rule.decls.get('transform')?.includes('var(--sprite-dot-scale)') || false, false,
        `${rule.prelude} must not carry the scale`);
    }
  }
});

test('data-morph-urgent switches every dot transition to the urgent duration', () => {
  assert.equal(declsFor(baseRules, D).get('--sprite-dot-morph'), 'var(--sprite-morph-duration)');
  assert.equal(declsFor(baseRules, `${D}[data-morph-urgent]`).get('--sprite-dot-morph'), 'var(--sprite-morph-urgent)');
  for (const rule of baseRules) {
    if (!rule.selectors.some((s) => s.includes(D))) continue;
    const transition = rule.decls.get('transition');
    if (transition) {
      assert.match(transition, /var\(--sprite-dot-morph\)/, rule.prelude);
      assert.equal(transition.includes('--sprite-morph-duration'), false, rule.prelude);
    }
  }
});

test('data-suspended pauses every loop under the root', () => {
  const rule = baseRules.find((r) => r.selectors.includes(`${D}[data-suspended]`)
    && r.selectors.includes(`${D}[data-suspended] *`));
  assert.ok(rule, 'one rule covers the root and its descendants');
  // Each form's animation shorthand resets the play state at higher specificity.
  assert.equal(rule.decls.get('animation-play-state'), 'paused !important');
});

// --- 5. forms, tones, entry poses ----------------------------------------------
test('each activity form, tone and settled shape is declared', () => {
  const tone = (name) => declsFor(baseRules, state(name)).get('color');
  assert.equal(tone('wait'), 'var(--sprite-dot-muted)');
  for (const name of ['stuck', 'approve', 'stopped']) assert.equal(tone(name), 'var(--sprite-dot-warn)', name);
  assert.equal(tone('error'), 'var(--sprite-dot-error)');
  assert.equal(tone('done'), 'var(--sprite-dot-ok)');
  assert.equal(tone('rest'), 'var(--widget-sprite-color)');
  for (const name of ['think', 'write', 'compose', 'check', 'search', 'tool', 'compact']) {
    assert.equal(tone(name), undefined, `${name} keeps the default active tone`);
  }
  const p1 = (name) => declsFor(baseRules, `${state(name)} .p1`);
  assert.equal(declsFor(baseRules, `${D} .p`).get('width'), '7px', 'p1 is the 7px dot unless a state resizes it');
  assert.equal(p1('stopped').get('width'), '9px');
  assert.equal(p1('stopped').get('border-radius'), '2px');
  assert.equal(p1('error').get('width'), '3px');
  assert.equal(p1('error').get('height'), '9px');
  assert.equal(p1('error').get('transform'), 'translate(0px,-2.5px)');
  assert.equal(declsFor(baseRules, `${state('error')} .p2`).get('transform'), 'translate(0px,5.5px)');
  assert.equal(p1('approve').get('width'), '8px');
  assert.equal(declsFor(baseRules, `${state('stuck')} .r`).get('width'), '12px');
  assert.equal(declsFor(baseRules, `${state('search')} .r`).get('width'), '9px');
  assert.equal(p1('done').get('width'), '2.6px');
  assert.equal(p1('done').get('transform'), 'translate(-5.5px,0.5px)');
  const check = declsFor(baseRules, '.chat-sprite-check .ck');
  assert.equal(check.get('stroke-width'), '2.6');
  assert.equal(check.get('stroke-linecap'), 'round');
  assert.equal(check.get('stroke-linejoin'), 'round');
  assert.equal(check.get('stroke'), 'currentColor');
  assert.equal(declsFor(baseRules, `${state('done')} .ck`).get('opacity'), '1');
  for (const part of ['.p', '.r']) {
    assert.equal(declsFor(baseRules, `${state('rest')} ${part}`).get('opacity') ?? '0', '0', `rest collapses ${part}`);
  }
  assert.equal(declsFor(baseRules, `${state('rest')} .p`).get('width'), '0');
});

const LOOPS = [
  ['think', '.p1 .q', 'sprite-gaze'], ['think', '.p2', 'sprite-moon-z'], ['think', '.p2 .q', 'sprite-moon'],
  ['write', '.p1 .q', 'sprite-type-caret'], ['write', '.p2 .q', 'sprite-type-line'],
  ['compose', '.p1 .q', 'sprite-hop'], ['compose', '.p2 .q', 'sprite-hop'], ['compose', '.p3 .q', 'sprite-hop'],
  ['check', '.q', 'sprite-draw'],
  ['search', '.w', 'sprite-scan'],
  ['tool', '.w', 'sprite-orbit'],
  ['compact', '.p2 .q', 'sprite-fold-l'], ['compact', '.p3 .q', 'sprite-fold-r'],
  ['wait', '.p1 .q', 'sprite-hg-a'], ['wait', '.p2 .q', 'sprite-hg-b'], ['wait', '.p3 .q', 'sprite-hg-grain'],
  ['wait', '.w', 'sprite-hourglass'],
  ['stuck', '.w', 'sprite-strain'],
  ['approve', '.r', 'sprite-ping'],
];
const LOOP_PROPS = ['transform', 'opacity', 'z-index'];

function animationName(value) {
  return (value.split(' ').find((token) => dot.keyframes.has(token))) || null;
}

test('the loop inventory is exactly the shipped vocabulary', () => {
  const found = [];
  for (const rule of baseRules) {
    const animation = rule.decls.get('animation');
    if (!animation || animation === 'none') continue;
    for (const selector of rule.selectors) {
      const match = selector.match(/^\.chat-sprite-dot\[data-activity="(\w+)"\]\s+(.+)$/);
      if (match && !selector.startsWith('[dir')) found.push([match[1], match[2], animationName(animation)]);
    }
  }
  const key = (entry) => entry.join('|');
  assert.deepEqual(found.map(key).sort(), LOOPS.map(key).sort());
  for (const name of dot.keyframes.keys()) {
    if (name === 'sprite-type-caret-rtl') continue;
    assert.ok(name.startsWith('sprite-'), `${name} is namespaced`);
  }
});

test('parity: every looping element static pose equals its loop 0% keyframe', () => {
  let checked = 0;
  for (const rule of baseRules) {
    const animation = rule.decls.get('animation');
    if (!animation || animation === 'none') continue;
    const name = animationName(animation);
    assert.ok(name, `${rule.prelude} references a defined @keyframes`);
    const frames = dot.keyframes.get(name);
    const first = frames.get('0%');
    assert.ok(first, `${name} has a 0% frame`);
    for (const selector of rule.selectors) {
      const statics = declsFor(baseRules, selector);
      for (const prop of LOOP_PROPS) {
        if (!(prop in first)) continue;
        assert.equal(statics.get(prop), first[prop], `${selector} static ${prop} vs ${name} 0%`);
        checked += 1;
      }
    }
  }
  assert.ok(checked >= LOOPS.length, `checked ${checked} static/0% pairs`);
});

test('parity holds for the RTL caret and the moon keyframes are exact', () => {
  const rtlCaret = baseRules.find((r) => r.selectors.includes(`[dir="rtl"] ${state('write')} .p1 .q`) && r.decls.has('animation'));
  assert.ok(rtlCaret, 'RTL caret loop');
  const name = animationName(rtlCaret.decls.get('animation'));
  assert.equal(declsFor(baseRules, `[dir="rtl"] ${state('write')} .p1 .q`).get('transform'),
    dot.keyframes.get(name).get('0%').transform);
  assert.equal(dot.keyframes.get(name).get('0%').transform, 'translate(7px,0px) rotate(-30deg)');
  assert.equal(dot.keyframes.get('sprite-type-caret').get('0%').transform, 'translate(-7px,0px) rotate(30deg)');
  // Handwriting: the pen leans forward in every frame (mirrored in RTL) and its
  // tip rises through letter humps while it crosses at the line's linear pace,
  // so the line's edge stays under the tip.
  const line = dot.keyframes.get('sprite-type-line');
  assert.equal(line.get('0%').transform, 'scaleX(0)');
  assert.equal(line.get('70%').transform, 'scaleX(1)');
  for (const [loop, sign] of [['sprite-type-caret', 1], [name, -1]]) {
    let raised = 0;
    for (const [stop, frame] of dot.keyframes.get(loop)) {
      const [, x, y, deg] = frame.transform.match(/^translate\((-?[\d.]+)px,(-?[\d.]+)px\) rotate\((-?[\d.]+)deg\)$/).map(Number);
      assert.ok(sign * deg >= 20 && sign * deg <= 36, `${loop} ${stop} tilt`);
      if (parseFloat(stop) > 70) continue;
      if (y < -0.3) raised += 1;
      assert.ok(Math.abs(x - sign * (-7 + (14 * parseFloat(stop)) / 70)) < 0.006, `${loop} ${stop} tip on the line`);
    }
    assert.ok(raised >= 10, `${loop} rises through letter strokes`);
  }
  for (const selector of [`${state('write')} .p1 .q`, `[dir="rtl"] ${state('write')} .p1 .q`, `${state('write')} .p2 .q`]) {
    assert.match(declsFor(baseRules, selector).get('animation'), / linear infinite$/, `${selector} crosses at a steady pace, no steps`);
  }
  assert.equal(/steps\(/.test(dotCss.slice(dotCss.indexOf('@keyframes sprite-type-caret'), dotCss.indexOf('@keyframes sprite-hop'))), false);
  assert.equal(declsFor(baseRules, `${state('write')} .p3`).size, 0, 'write draws a single line');
  assert.equal(declsFor(baseRules, `${state('write')} .p2`).get('transform'), 'translate(-2px,3.5px)');
  assert.equal(declsFor(baseRules, `[dir="rtl"] ${state('write')} .p2`).get('transform'), 'translate(2px,3.5px)');
  const R = 9.5;
  const tilt = 0.42;
  const g = 1.9;
  const steps = 32;
  const f = (n, digits) => String(Number(n.toFixed(digits)));
  const moon = dot.keyframes.get('sprite-moon');
  // moon-z runs step-end, so each sample holds the last keyframe at or before it.
  const moonZ = dot.keyframes.get('sprite-moon-z');
  const stepValue = (frames, at, prop) => [...frames]
    .filter(([offset, decls]) => parseFloat(offset) <= at + 1e-9 && decls[prop] !== undefined)
    .sort(([a], [b]) => parseFloat(a) - parseFloat(b))
    .pop()[1][prop];
  const gaze = dot.keyframes.get('sprite-gaze');
  assert.equal(moon.size, steps + 1);
  for (let i = 0; i <= steps; i += 1) {
    const key = `${f((i / steps) * 100, 3)}%`;
    const t = -Math.PI / 2 + (2 * Math.PI * i) / steps;
    const s = Math.sin(t);
    const x = R * Math.cos(t);
    const y = R * tilt * Math.sin(t);
    assert.equal(moon.get(key).transform, `translate(${f(x, 2)}px,${f(y, 2)}px) scale(${f(0.78 + 0.22 * s, 3)})`, key);
    assert.equal(moon.get(key).opacity, f(0.55 + (0.45 * (s + 1)) / 2, 3), key);
    assert.equal(stepValue(moonZ, (i / steps) * 100, 'z-index'), s >= 0 ? '2' : '0', key);
    assert.equal(gaze.get(key).transform, `translate(${f(g * Math.cos(t), 2)}px,${f(g * tilt * Math.sin(t), 2)}px)`, key);
  }
  assert.equal(moon.get('0%').transform, 'translate(0px,-3.99px) scale(0.56)');
  assert.equal(gaze.get('0%').transform, 'translate(0px,-0.8px)');
});

test('RTL flips the inline-start origins and the caret direction', () => {
  const rtl = (selector) => declsFor(baseRules, `[dir="rtl"] ${selector}`);
  assert.equal(declsFor(baseRules, `${state('write')} .p2 .q`).get('transform-origin'), 'left center');
  assert.equal(rtl(`${state('write')} .p2 .q`).get('transform-origin'), 'right center');
  assert.equal(declsFor(baseRules, `${state('check')} .q`).get('transform-origin'), 'left center');
  assert.equal(rtl(`${state('check')} .q`).get('transform-origin'), 'right center');
  assert.match(dotCss, /transform-origin:\s*left center;\s*\/\*\s*rtl:physical\s*\*\//);
  assert.match(dotCss, /transform-origin:\s*right center;\s*\/\*\s*rtl:physical\s*\*\//);
});

// --- 6. reduced motion -----------------------------------------------------------
test('reduced motion removes every loop and parks a distinct pose per state', () => {
  const none = reducedRules.find((rule) => rule.selectors.includes(D) && rule.selectors.includes(`${D} *`));
  assert.ok(none, 'one rule drops every animation under the root');
  assert.equal(none.decls.get('animation'), 'none !important');
  for (const rule of reducedRules) {
    if (rule !== none) assert.equal(rule.decls.has('animation'), false, `${rule.prelude} re-introduces a loop`);
  }

  const signature = (name) => reducedRules
    .filter((rule) => rule.selectors.some((s) => s.includes(`data-activity="${name}"`)))
    .map((rule) => `${rule.selectors.join(',')}{${[...rule.decls].map(([k, v]) => `${k}:${v}`).sort().join(';')}}`)
    .join('\n');
  const poses = ['think', 'approve', 'compose', 'compact'].map((name) => [name, signature(name)]);
  for (const [name, pose] of poses) assert.ok(pose.length > 0, `${name} has a reduced pose`);
  assert.equal(new Set(poses.map(([, pose]) => pose)).size, poses.length, 'reduced poses are distinct');

  const reduced = (selector) => declsFor(reducedRules, selector);
  assert.equal(reduced(`${state('think')} .p2 .q`).get('transform'), 'translate(6.7px,2.8px) scale(1)');
  assert.equal(reduced(`${state('think')} .p2 .q`).get('opacity'), '1');
  assert.equal(reduced(`${state('think')} .p2`).get('z-index'), '2');
  assert.equal(reduced(`${state('think')} .p1 .q`).get('transform'), 'translate(1.3px,0.55px)');
  assert.equal(reduced(`${state('write')} .p2 .q`).get('transform'), 'scaleX(0.6)');
  assert.equal(reduced(`${state('write')} .p1 .q`).get('transform'), 'translate(1.4px,0px) rotate(30deg)');
  assert.equal(reduced(`[dir="rtl"] ${state('write')} .p1 .q`).get('transform'), 'translate(-1.4px,0px) rotate(-30deg)');
  assert.equal(reduced(`${state('compose')} .p1 .q`).get('transform'), 'translateY(-2.5px)');
  assert.equal(reduced(`${state('compose')} .p1 .q`).get('opacity'), '1');
  assert.equal(reduced(`${state('check')} .p1 .q`).get('transform'), 'scaleX(1)');
  assert.equal(reduced(`${state('check')} .p2 .q`).get('transform'), 'scaleX(0.7)');
  assert.equal(reduced(`${state('check')} .p3 .q`).get('transform'), 'scaleX(0.4)');
  assert.equal(reduced(`${state('search')} .w`).get('transform'), 'translateX(0px) rotate(0deg)');
  assert.equal(reduced(`${state('compact')} .p2 .q`).get('transform'), 'translateX(3px)');
  assert.equal(reduced(`${state('compact')} .p3 .q`).get('transform'), 'translateX(-3px)');
  assert.equal(reduced(`${state('compact')} .p2 .q`).get('opacity'), '0.45');
  assert.equal(reduced(`${state('approve')} .r`).get('transform'), 'scale(1.8)');
  assert.equal(reduced(`${state('approve')} .r`).get('opacity'), '0.4');
  assert.equal(reduced(D).get('--sprite-morph-duration'), 'var(--sprite-morph-urgent)');
});

// --- 7. the J ----------------------------------------------------------------------
test('the brand J shows with no dot root and only at rest once the dot exists', () => {
  const glyph = '.chat-assistant-sprite-glyph';
  const base = declsFor(baseRules, glyph);
  assert.equal(base.get('opacity'), '0.84', 'shown as today before the engine runs');
  assert.equal(base.get('transform'), 'scale(1)');
  assert.match(base.get('transition'), /opacity var\(--sprite-j-duration\) var\(--sprite-morph-ease\)/);
  const hidden = declsFor(baseRules, `${D}:not([data-activity="rest"]) ~ ${glyph}`);
  assert.equal(hidden.get('opacity'), '0');
  assert.equal(hidden.get('transform'), 'scale(0.55)');
  // At rest no rule matches over the base, so the J shows. The rest J must
  // never be hidden by a rule that does not require a non-rest dot.
  for (const rule of baseRules) {
    for (const selector of rule.selectors) {
      if (selector.includes(glyph) && rule.decls.get('opacity') === '0') {
        assert.ok(selector.includes(':not([data-activity="rest"]) ~'), selector);
      }
    }
  }
});

// --- 8. the inline activity row ----------------------------------------------------
test('where the rail dot shows, the activity row keeps its words and hides only its throbber', () => {
  const scope = '.chat-sprite-layer.visible ~ .chat-timeline .turn-activity-row';
  const hiders = baseRules.filter((rule) => rule.selectors.some((s) => s.includes('.turn-activity-row')));
  assert.equal(hiders.length, 1, 'one rule in the dot sheet touches the activity row');
  assert.deepEqual(hiders[0].selectors, [`${scope} > .status-dot`, `${scope} > .turn-activity-glyph`]);
  assert.deepEqual([...hiders[0].decls], [['visibility', 'hidden']], 'visibility keeps the row aligned');
  // The sibling combinator needs the layer before the timeline in the same column.
  const { document } = new JSDOM(read('index.html')).window;
  const template = document.getElementById('chatPaneTemplate');
  const layers = [document, template.content].flatMap((root) => [...root.querySelectorAll('.chat-sprite-layer')]);
  assert.equal(layers.length, 2, 'main column and pane template');
  for (const layer of layers) {
    assert.ok(layer.parentElement.querySelector('.chat-sprite-layer ~ .chat-timeline'), 'timeline follows the layer');
  }
});
