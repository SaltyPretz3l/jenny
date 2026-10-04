// Split view W1-2: the pane layout CSS (styles/chat-panes.css) and the one
// retargeted artifact-maximized rule (styles/artifact-panel.css).
//
// jsdom cannot compute grid layout, so this suite pins SOURCE shape: which
// selectors exist, what they declare, and where the file is imported. The
// one-pane visual identity is an owner GUI check.
//
// The design, in three lines:
// - One pane: `.chat-view > .chat-pane { display: contents }`. The wrapper
//   generates no box, so pane 0's four children stay grid children of
//   #chatView exactly as before W1-1 -- same tracks, same containing blocks,
//   same clipping -- whether the IDE dock has restored #chatThreadStage and
//   #composerWrap inside the wrapper or (today) directly into #chatView.
// - Two panes (`[data-pane-count="2"]`): each pane is its own grid (kicker
//   auto, thread 1fr, composer auto); the view is pane | divider | pane |
//   artifact/context columns shifted by +2; the non-focused pane dims only its
//   composer border and Send; below 1180px the split folds to the focused pane.
// - Design law: no side/left border bars, no background on a focused pane, no
//   physical direction property.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const PANES_CSS_PATH = path.join(ROOT, 'styles', 'chat-panes.css');
const PANES_CSS = fs.existsSync(PANES_CSS_PATH) ? fs.readFileSync(PANES_CSS_PATH, 'utf8') : '';
const STYLES_CSS = read('styles.css');
const ARTIFACT_PANEL_CSS = read('styles/artifact-panel.css');

const TWO = '.chat-view[data-pane-count="2"]';

// A small brace-walking parser: every rule as { media, selectors, body } with
// comments stripped. Media is the enclosing @media prelude or ''.
function parseRules(css) {
  const source = css.replace(new RegExp('/\\*[\\s\\S]*?\\*/', 'g'), '');
  const rules = [];
  function walk(text, media) {
    let index = 0;
    while (index < text.length) {
      const open = text.indexOf('{', index);
      if (open === -1) break;
      const prelude = text.slice(index, open).trim();
      let depth = 1;
      let cursor = open + 1;
      while (cursor < text.length && depth > 0) {
        if (text[cursor] === '{') depth += 1;
        if (text[cursor] === '}') depth -= 1;
        cursor += 1;
      }
      const body = text.slice(open + 1, cursor - 1);
      if (prelude.startsWith('@media')) {
        walk(body, prelude);
      } else {
        rules.push({
          media,
          selectors: prelude.split(',').map((selector) => selector.trim().replace(new RegExp('\\s+', 'g'), ' ')),
          body: body.trim(),
        });
      }
      index = cursor;
    }
  }
  walk(source, '');
  return rules;
}

function declarations(body) {
  const map = {};
  for (const part of body.split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    map[part.slice(0, colon).trim()] = part.slice(colon + 1).trim().replace(new RegExp('\\s+', 'g'), ' ');
  }
  return map;
}

// The declarations of the (last) rule whose selector list contains `selector`
// in `media` ('' = top level). Fails loudly when absent.
function rule(css, selector, media = '') {
  const matches = parseRules(css).filter((entry) => entry.media === media && entry.selectors.includes(selector));
  assert.ok(matches.length > 0, `missing rule ${media ? `${media} ` : ''}${selector}`);
  return declarations(matches[matches.length - 1].body);
}

const FOLD = '@media (max-width: 1180px)';

test('two visible panes reserve both composer floors and their divider against the sidebar', () => {
  const guard = rule(PANES_CSS, `${TWO}.artifact-review-open:not(.artifact-review-maximized) > .artifact-review-panel`, '@media (min-width: 1181px)');
  assert.equal(guard['min-width'], '0');
  assert.equal(guard['max-width'], 'max(0px, calc(100vw - var(--sidebar-current-width, 0px) - var(--artifact-review-resizer-width, 10px) - 650px))');
});

test('chat-panes.css is imported right after artifact-panel.css, later than the grid and the media ladder', () => {
  const importLine = (name) => STYLES_CSS.indexOf(`@import url("./styles/${name}");`);
  const panes = importLine('chat-panes.css');
  assert.ok(panes > 0, 'styles.css imports styles/chat-panes.css');
  for (const earlier of ['chat-composer.css', 'chat-media-queries.css', 'context-panel.css', 'artifact-panel.css']) {
    assert.ok(importLine(earlier) > 0 && importLine(earlier) < panes, `${earlier} is imported before chat-panes.css`);
  }
  const lines = STYLES_CSS.split('\n');
  const artifactLine = lines.findIndex((line) => line.includes('./styles/artifact-panel.css'));
  assert.ok(lines[artifactLine + 1].includes('./styles/chat-panes.css'), 'immediately after artifact-panel.css');
});

test('one pane: the wrapper generates no box, so pane 0 lays out exactly as before', () => {
  assert.deepEqual(rule(PANES_CSS, '.chat-view > .chat-pane'), { display: 'contents' });
  // Nothing outside the two-pane scope may place or clip pane children.
  for (const entry of parseRules(PANES_CSS)) {
    for (const selector of entry.selectors) {
      if (!selector.includes('.chat-pane >')) continue;
      assert.ok(
        selector.startsWith(TWO) || selector.startsWith('.chat-view.artifact-review-maximized'),
        `${selector} must be scoped to two panes (one pane is display: contents)`
      );
    }
  }
});

test('two panes: each pane is a grid with kicker, thread and composer rows', () => {
  assert.deepEqual(rule(PANES_CSS, `${TWO} > .chat-pane`), {
    display: 'grid',
    'grid-template-columns': 'minmax(0, 1fr)',
    'grid-template-rows': 'auto minmax(0, 1fr) auto',
    'grid-row': '1 / -1',
    position: 'relative',
    'min-inline-size': '0',
    'min-block-size': '0',
    overflow: 'hidden',
  });
  assert.deepEqual(rule(PANES_CSS, `${TWO} > .chat-pane > .chat-pane-kicker`), { 'grid-row': '1' });
  for (const child of ['.hero-stage', '.chat-thread-stage', '.chat-timeline-utility-cluster']) {
    assert.deepEqual(rule(PANES_CSS, `${TWO} > .chat-pane > ${child}`), { 'grid-column': '1', 'grid-row': '2' });
  }
  assert.deepEqual(rule(PANES_CSS, `${TWO} > .chat-pane > .composer-wrap`), {
    'grid-column': '1',
    'grid-row': '3',
    'align-self': 'end',
    // --composer-width follows the viewport; a half-width pane needs its own gutter.
    'max-width': 'min(var(--composer-width), calc(100% - 2 * var(--space-6)))',
    transform: 'none',
  });
});

test('two panes: pane | divider | pane, both ratios named, artifact and context columns shifted +2', () => {
  const view = rule(PANES_CSS, TWO);
  assert.equal(view['--chat-pane-resizer-width'], '10px');
  assert.equal(
    view['grid-template-columns'],
    'minmax(0, var(--chat-pane-a, 1fr)) var(--chat-pane-resizer-width) minmax(0, var(--chat-pane-b, 1fr)) auto'
  );
  assert.equal(
    rule(PANES_CSS, `${TWO}.artifact-review-open`)['grid-template-columns'],
    'minmax(0, var(--chat-pane-a, 1fr)) var(--chat-pane-resizer-width) minmax(0, var(--chat-pane-b, 1fr)) '
      + 'var(--artifact-review-resizer-width, 10px) auto'
  );
  assert.deepEqual(rule(PANES_CSS, `${TWO} > .chat-pane[data-pane-id="0"]`), { 'grid-column': '1' });
  assert.deepEqual(rule(PANES_CSS, `${TWO} > .chat-pane-resizer`), { 'grid-column': '2', 'grid-row': '1 / -1' });
  assert.deepEqual(rule(PANES_CSS, `${TWO} > .chat-pane[data-pane-id="1"]`), { 'grid-column': '3' });
  // One-pane columns today: context panel 2, artifact resizer 2, artifact panel 3.
  assert.match(read('styles/context-panel.css'), new RegExp('\\.chat-context-panel \\{\\s*grid-column: 2;'));
  assert.match(read('styles/context-panel.css'), new RegExp('\\.artifact-review-resizer \\{\\s*grid-column: 2;'));
  assert.match(read('styles/context-panel.css'), new RegExp('\\.artifact-review-panel \\{\\s*grid-column: 3;'));
  assert.deepEqual(rule(PANES_CSS, `${TWO} > .artifact-review-resizer:not(.chat-pane-resizer)`), { 'grid-column': '4' });
  assert.deepEqual(rule(PANES_CSS, `${TWO} > .artifact-review-panel`), { 'grid-column': '5' });
  assert.deepEqual(rule(PANES_CSS, `${TWO} > .chat-context-panel`), { 'grid-column': '4' });
  // The divider's look comes from the shared artifact-review-resizer class: no
  // hairline copy here.
  assert.equal(PANES_CSS.includes('::before'), false, 'the divider hairline is not copied');
});

test('the kicker: one quiet line, muted, primary in the focused pane, a muted project suffix', () => {
  assert.deepEqual(rule(PANES_CSS, '.chat-pane-kicker'), {
    display: 'flex',
    'align-items': 'center',
    gap: 'var(--space-2)',
    'min-inline-size': '0',
    'padding-block': 'var(--space-2)',
    'padding-inline': 'var(--space-4)',
    color: 'var(--text-muted)',
    'font-size': 'var(--font-size-sm)',
  });
  assert.deepEqual(rule(PANES_CSS, '.chat-pane[data-pane-focused="true"] > .chat-pane-kicker'), {
    color: 'var(--text-primary)',
  });
  assert.deepEqual(rule(PANES_CSS, '.chat-pane-kicker[hidden]'), { display: 'none' });
  // Gate N3 (2026-09-27): one line that ellipsizes, never one word per line.
  assert.deepEqual(rule(PANES_CSS, '.chat-pane-kicker-project'), {
    'min-inline-size': '0',
    overflow: 'hidden',
    color: 'var(--text-muted)',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  });
});

test('the non-focused pane dims only its composer border and Send', () => {
  const unfocused = `${TWO} > .chat-pane[data-pane-focused="false"]`;
  assert.deepEqual(rule(PANES_CSS, `${unfocused} .composer`), { 'border-color': 'var(--border-subtle)' });
  assert.deepEqual(rule(PANES_CSS, `${unfocused} .composer-send`), { opacity: '0.55' });
  // The composer's border is a `border` shorthand, so border-color is the
  // property that changes it.
  assert.match(read('styles/chat-composer.css'), new RegExp('border: 1px solid transparent;'));
  const dimmingRules = parseRules(PANES_CSS).filter((entry) => entry.selectors.some((s) => s.includes('[data-pane-focused="false"]')));
  for (const entry of dimmingRules) {
    if (entry.media === FOLD) continue;
    assert.ok(
      entry.selectors.every((s) => s.endsWith(' .composer') || s.endsWith(' .composer-send')),
      `nothing else dims: ${entry.selectors.join(', ')}`
    );
  }
});

test('split composers dock level: no empty-hero lift in either pane', () => {
  // chat-composer.css lifts every .composer-wrap under an idle .chat-view.chat-empty
  // (pane 0 drives the view classes). The pane composer rule cancels it at equal
  // specificity, so chat-panes.css must load after chat-composer.css.
  assert.match(read('styles/chat-composer.css'), /\.chat-view\.chat-empty\[data-send-lifecycle="idle"\] \.composer-wrap \{\s*transform: translateY\(calc\(-1 \* var\(--empty-composer-lift\)\)\);/);
  assert.ok(STYLES_CSS.indexOf('chat-composer.css') < STYLES_CSS.indexOf('chat-panes.css'), 'chat-panes.css loads last');
  assert.equal(rule(PANES_CSS, `${TWO} > .chat-pane > .composer-wrap`).transform, 'none');
  assert.equal(PANES_CSS.includes('--empty-composer-lift'), false, 'no pane re-applies the lift');
});

test('while the divider drags, the view stops text selection and the panes stop pointer work', () => {
  assert.deepEqual(rule(PANES_CSS, '.chat-view[data-pane-resizing]'), {
    'user-select': 'none',
    cursor: 'col-resize',
  });
  assert.deepEqual(rule(PANES_CSS, '.chat-view[data-pane-resizing] > .chat-pane'), { 'pointer-events': 'none' });
});

test('below 1180px the split folds to the focused pane and restores the one-pane columns', () => {
  assert.equal(rule(PANES_CSS, TWO, FOLD)['grid-template-columns'], 'minmax(0, 1fr) auto');
  assert.equal(
    rule(PANES_CSS, `${TWO}.artifact-review-open`, FOLD)['grid-template-columns'],
    'minmax(0, 1fr) var(--artifact-review-resizer-width, 10px) auto'
  );
  assert.deepEqual(rule(PANES_CSS, `${TWO} > .chat-pane[data-pane-focused="false"]`, FOLD), { display: 'none' });
  assert.deepEqual(rule(PANES_CSS, `${TWO} > .chat-pane-resizer`, FOLD), { display: 'none' });
  assert.deepEqual(rule(PANES_CSS, `${TWO} > .chat-pane[data-pane-focused="true"]`, FOLD), { 'grid-column': '1' });
  assert.deepEqual(rule(PANES_CSS, `${TWO} > .artifact-review-resizer:not(.chat-pane-resizer)`, FOLD), { 'grid-column': '2' });
  assert.deepEqual(rule(PANES_CSS, `${TWO} > .artifact-review-panel`, FOLD), { 'grid-column': '3' });
  assert.deepEqual(rule(PANES_CSS, `${TWO} > .chat-context-panel`, FOLD), { 'grid-column': '2' });
  // The fold lives here; the pinned media-query ladder gains nothing.
  assert.equal(read('styles/chat-media-queries.css').includes('data-pane-count'), false);
  assert.equal(read('styles/chat-media-queries.css').includes('chat-pane'), false);
});

test('artifact maximized: the pane children are hidden through the pane, never as view children by class alone', () => {
  const maximizedHidden = rule(ARTIFACT_PANEL_CSS, '.chat-view.artifact-review-maximized > .chat-pane > .hero-stage');
  assert.deepEqual(maximizedHidden, { display: 'none' });
  const entry = parseRules(ARTIFACT_PANEL_CSS)
    .find((candidate) => candidate.selectors.includes('.chat-view.artifact-review-maximized > .chat-pane > .hero-stage'));
  assert.deepEqual(entry.selectors, [
    '.chat-view.artifact-review-maximized > .chat-pane > .hero-stage',
    '.chat-view.artifact-review-maximized > .chat-pane > .chat-thread-stage',
    '.chat-view.artifact-review-maximized > .chat-pane > .composer-wrap',
    // W1-4 debt: the IDE dock restores these two into #chatView itself until
    // its restore target becomes the pane root; drop both then.
    '.chat-view.artifact-review-maximized > .chat-thread-stage',
    '.chat-view.artifact-review-maximized > .composer-wrap',
    '.chat-view.artifact-review-maximized > .artifact-review-resizer',
    '.chat-view.artifact-review-maximized > .chat-pane-resizer',
  ]);
  assert.equal(
    ARTIFACT_PANEL_CSS.includes('.chat-view.artifact-review-maximized > .hero-stage'),
    false,
    'the hero is always inside the pane now'
  );
  // Two panes: the panes are grid boxes, so they go wholesale, and the view
  // keeps the single maximized column (these must come after the fold).
  assert.deepEqual(rule(PANES_CSS, `${TWO}.artifact-review-maximized`), { 'grid-template-columns': 'minmax(0, 1fr)' });
  assert.deepEqual(rule(PANES_CSS, `${TWO}.artifact-review-maximized > .chat-pane`), { display: 'none' });
  assert.deepEqual(rule(PANES_CSS, `${TWO}.artifact-review-maximized > .artifact-review-panel`), { 'grid-column': '1 / -1' });
  const rules = parseRules(PANES_CSS);
  const lastFold = rules.map((candidate) => candidate.media).lastIndexOf(FOLD);
  const maximizedIndex = rules.findIndex((candidate) => candidate.selectors.includes(`${TWO}.artifact-review-maximized`));
  assert.ok(maximizedIndex > lastFold, 'the maximized two-pane rules come after the fold block so they win its ties');
});

test('design law: no side bars, no focused background, no physical direction, only defined tokens', () => {
  const rules = parseRules(PANES_CSS);
  assert.ok(rules.length > 0, 'chat-panes.css has rules');
  const bars = ['border-left', 'border-right', 'border-inline-start', 'border-inline-end', 'border-inline'];
  for (const entry of rules) {
    const decls = declarations(entry.body);
    if (entry.selectors.some((s) => s.endsWith('.chat-pane') || s.includes('.chat-pane-kicker') || s.includes('.chat-pane['))) {
      for (const property of Object.keys(decls)) {
        assert.equal(bars.some((bar) => property.startsWith(bar)), false, `${property} on ${entry.selectors.join(', ')}`);
      }
    }
    if (entry.selectors.some((s) => s.includes('[data-pane-focused'))) {
      for (const property of Object.keys(decls)) {
        assert.equal(property.startsWith('background'), false, `${property} on a focus rule`);
        assert.equal(property === 'box-shadow', false, `${property} on a focus rule`);
      }
    }
  }
  const physical = new RegExp('(^|[\\s;{])(margin|padding|border)-(left|right)\\b|(^|[\\s;{])(left|right|float|clear|text-align)\\s*:', 'm');
  assert.equal(physical.test(PANES_CSS.replace(new RegExp('/\\*[\\s\\S]*?\\*/', 'g'), '')), false, 'logical properties only');

  const stylesDir = path.join(ROOT, 'styles');
  const defined = new Set();
  for (const name of fs.readdirSync(stylesDir)) {
    if (!name.endsWith('.css')) continue;
    const text = fs.readFileSync(path.join(stylesDir, name), 'utf8');
    const definition = new RegExp('(--[A-Za-z0-9-]+)\\s*:', 'g');
    let match = definition.exec(text);
    while (match) {
      defined.add(match[1]);
      match = definition.exec(text);
    }
  }
  const reference = new RegExp('var\\((--[A-Za-z0-9-]+)\\s*\\)', 'g');
  let match = reference.exec(PANES_CSS);
  while (match) {
    assert.equal(defined.has(match[1]), true, `${match[1]} is a real token (referenced without a fallback)`);
    match = reference.exec(PANES_CSS);
  }
});

// Split view W2-1 (drag-to-split): the composition writes
// #chatView[data-pane-drop="left"|"right"] during a drag, naming the pane side
// ('left' = pane 0 = inline-start). One pane: a ::after outlines that half of
// the view. Two panes: the same outline on that side's pane root. Outline
// only: no fill, no tint, no shadow, no transition.
const DROP_OUTLINE = { outline: '1px solid var(--border-subtle)', 'outline-offset': '-1px' };

test('drop zones: one pane outlines the hovered half through a ::after, inline-start 0 or 50%', () => {
  assert.deepEqual(rule(PANES_CSS, '.chat-view[data-pane-drop]:not([data-pane-count="2"])::after'), {
    content: '""',
    position: 'absolute',
    'inset-block': '0',
    'inset-inline-start': '0',
    'inline-size': '50%',
    ...DROP_OUTLINE,
    'pointer-events': 'none',
    'z-index': 'var(--z-chrome)',
  });
  assert.deepEqual(rule(PANES_CSS, '.chat-view[data-pane-drop="right"]:not([data-pane-count="2"])::after'), {
    'inset-inline-start': '50%',
  });
  // The ::after is absolutely positioned against #chatView, which already is a
  // positioned box (chat-composer.css); W2-1 adds no positioning of its own.
  assert.equal(rule(read('styles/chat-composer.css'), '.chat-view').position, 'relative');
  for (const entry of parseRules(PANES_CSS)) {
    if (entry.selectors.some((s) => s === '.chat-view' || s.startsWith('.chat-view[data-pane-drop'))) {
      if (entry.selectors.some((s) => s.endsWith('::after'))) continue;
      assert.equal('position' in declarations(entry.body), false, `${entry.selectors.join(', ')} positions the view`);
    }
  }
});

test('drop zones: two panes outline the pane root of the hovered side', () => {
  assert.deepEqual(rule(PANES_CSS, `${TWO}[data-pane-drop="left"] > .chat-pane[data-pane-id="0"]`), DROP_OUTLINE);
  assert.deepEqual(rule(PANES_CSS, `${TWO}[data-pane-drop="right"] > .chat-pane[data-pane-id="1"]`), DROP_OUTLINE);
});

test('drop zones: outline only -- no background, shadow, filter, opacity or transition on any drop rule', () => {
  const dropRules = parseRules(PANES_CSS).filter((entry) => entry.selectors.some((s) => s.includes('data-pane-drop')));
  assert.equal(dropRules.length, 3, 'the one-pane half, its right-half inset, and the two-pane root');
  for (const entry of dropRules) {
    for (const property of Object.keys(declarations(entry.body))) {
      assert.equal(
        ['background', 'box-shadow', 'filter', 'opacity', 'transition', 'animation', 'border'].some((banned) => property.startsWith(banned)),
        false,
        `${property} on ${entry.selectors.join(', ')}`
      );
    }
  }
});

test('W3: the sprite gives its gutter back with two panes and in a collapsed-composer pane', () => {
  for (const selector of [`${TWO} .chat-sprite-layer`, '.chat-pane[data-composer-compact] .chat-sprite-layer']) {
    assert.deepEqual(rule(PANES_CSS, selector), { display: 'none' });
  }
  for (const selector of [`${TWO} .chat-pane`, '.chat-pane[data-composer-compact]']) {
    assert.deepEqual(rule(PANES_CSS, selector), { '--chat-sprite-size': '0px', '--chat-sprite-rail-offset': '0px' });
  }
});

test('W3: the side panel owner line is one muted, ellipsized line with no box', () => {
  const line = rule(PANES_CSS, '.side-panel-owner-line');
  assert.equal(line.color, 'var(--text-muted)');
  assert.equal(line['white-space'], 'nowrap');
  for (const key of ['border', 'background', 'border-inline-start', 'box-shadow']) assert.equal(line[key], undefined, key);
  assert.equal(rule(PANES_CSS, '.side-panel-owner-title')['text-overflow'], 'ellipsis');
});

test('gate §C: with two panes the toast stack starts below the pane kicker row, on the chat view only', () => {
  const toastCss = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'styles', 'toast.css'), 'utf8');
  assert.deepEqual(rule(toastCss, ':root[data-active-view="chat"]:has(#chatView[data-pane-count="2"]) .toast-viewport'), {
    top: 'var(--toast-split-top, calc(var(--titlebar-height) + var(--space-8) + 32px))',
  });
});
