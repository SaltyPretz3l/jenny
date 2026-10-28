'use strict';

// Sidebar row polish (owner-approved 2026-10-20): every Chats row has one fixed trailing layout. The
// time sits in a slot at the row end and swaps with the chevron and menu on hover; one 6 px status or
// unread dot sits in a fixed column 64 px from the end. These are cascade contracts, so the test
// reads the real stylesheets.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, 'styles', file), 'utf8');

const panelCss = read('chats-panel.css');
const treeCss = read('chats-panel-tree.css');
const trailCss = read('chats-panel-row-trail.css');
const selectionCss = read('chats-panel-selection.css');
const messagesCss = read('chat-messages.css');
const foundationCss = read('foundation.css');

// Flat rule list (selector, body) for plain rules and rules nested inside @media / @container.
function parseRules(css, context = '') {
  const rules = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const head = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth += 1;
      else if (text[j] === '}') depth -= 1;
      j += 1;
    }
    const body = text.slice(open + 1, j - 1);
    if (head.startsWith('@')) {
      if (/^@(media|container|supports)/.test(head)) rules.push(...parseRules(body, head));
    } else {
      rules.push({ selector: head.replace(/\s+/g, ' '), body, context });
    }
    i = j;
  }
  return rules;
}

const trailRules = parseRules(trailCss);
const allCss = [panelCss, treeCss, trailCss, selectionCss, messagesCss].join('\n');
const allRules = parseRules(allCss);

function decls(rules, selector, context = '') {
  return rules
    .filter(rule => rule.context === context && rule.selector.split(/\s*,\s*/).includes(selector))
    .map(rule => rule.body)
    .join('\n');
}

function declared(rules, selector, property, context = '') {
  const match = decls(rules, selector, context).match(new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`));
  return match ? match[1].trim() : null;
}

test('the row-trail stylesheet is imported after the tree and before the selection styles', () => {
  const imports = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.ok(imports.includes('@import url("./styles/chats-panel-row-trail.css");'));
  assert.ok(imports.indexOf('chats-panel-row-trail.css') > imports.indexOf('chats-panel-tree.css'));
  assert.ok(imports.indexOf('chats-panel-row-trail.css') < imports.indexOf('chats-panel-selection.css'));
});

test('every row is one grid column: the parent override is gone', () => {
  assert.equal(declared(parseRules(panelCss), '.session-row', 'grid-template-columns'), 'minmax(0, 1fr)');
  assert.doesNotMatch(treeCss, /data-tree-has-children="true"\]\s*\{[^}]*grid-template-columns/);
  assert.doesNotMatch(allCss, /grid-template-columns:\s*minmax\(0, 1fr\) (?:auto )?32px/);
  assert.doesNotMatch(allCss, /grid-template-columns:\s*minmax\(0, 1fr\) auto/);
});

test('time, dot, unread dot, chevron, count chip and menu are absolutely placed from the row end', () => {
  const placed = ['.session-row__time', '.session-row__dot', '.session-row__unread-dot', '.session-row__chevron', '.session-row__children-chip', '.session-row__menu'];
  const insets = {
    '.session-row__time': 'var(--space-5)',
    '.session-row__menu': 'var(--space-2)',
    '.session-row__chevron': 'calc(var(--space-2) + 32px)',
    '.session-row__dot': 'var(--session-row-dot-col-end)',
    '.session-row__unread-dot': 'var(--session-row-dot-col-end)',
    '.session-row__children-chip': 'calc(var(--session-row-dot-col-end) + var(--session-row-dot-size) + var(--space-4))',
  };
  for (const selector of placed) {
    assert.equal(declared(trailRules, selector, 'position'), 'absolute', `${selector} is absolute`);
    assert.equal(declared(trailRules, selector, 'inset-block-start'), '50%', `${selector} centres vertically`);
    assert.match(declared(trailRules, selector, 'transform') || '', /translateY\(-50%\)/, selector);
    assert.equal(declared(trailRules, selector, 'inset-inline-end'), insets[selector], `${selector} inset`);
  }
  assert.equal(declared(trailRules, '.session-row__branch', 'display'), 'contents');
  // The dot column sits just past a time slot sized in caption widths, so it scales with the text size,
  // and the time is clipped to that slot: a long localized date never runs under the dot.
  assert.equal(declared(trailRules, '.session-row', '--session-row-time-slot'), 'calc(var(--font-size-caption) * 4.6)');
  assert.equal(declared(trailRules, '.session-row', '--session-row-dot-col-end'), 'calc(var(--space-5) + var(--session-row-time-slot) + var(--space-3))');
  assert.equal(declared(trailRules, '.session-row__time', 'max-inline-size'), 'var(--session-row-time-slot)');
  assert.equal(declared(trailRules, '.session-row__time', 'text-overflow'), 'ellipsis');
});

test('the dot column is the same on parent, collapsed parent, child, unread and active rows', () => {
  // The dot's inset is declared once, with no per-row-type override anywhere.
  const rowType = /data-tree-(?:has-children|expanded|depth|last)|\.active|--unread|--primary/;
  for (const rule of allRules) {
    if (/session-row__(?:dot|unread-dot)/.test(rule.selector) && rowType.test(rule.selector)) {
      assert.doesNotMatch(rule.body, /inset|transform|position/, `no positional override for ${rule.selector}`);
    }
  }
  assert.equal(declared(trailRules, '.session-row__dot', 'inset-inline-end'), declared(trailRules, '.session-row__unread-dot', 'inset-inline-end'));
});

test('the open and completed dot looks are gone; needs-you, working and failed remain', () => {
  assert.doesNotMatch(allCss, /data-session-dominant-state="open"\]\s*\.session-row__dot\s*\{[^}]*box-shadow/);
  assert.doesNotMatch(allCss, /\[data-session-last-outcome="completed"\]/);
  assert.doesNotMatch(allCss, /\.session-row\.active \.session-row__menu\s*\{[^}]*opacity:\s*0\.62/);
  assert.match(panelCss, /\[data-session-dominant-state="streaming"\] \.session-row__dot\s*\{[\s\S]*?var\(--sidebar-state-streaming-color\)/);
  assert.match(panelCss, /data-session-dominant-state="input_needed"\]\) \.session-row__dot\s*\{[\s\S]*?var\(--sidebar-state-approval-color\)/);
  assert.match(panelCss, /\[data-session-last-outcome="failed"\] \.session-row__dot\s*\{\s*background:\s*var\(--text-danger-emphasis\)/);
  assert.match(panelCss, /@keyframes sidebar-state-pulse\s*\{\s*from\s*\{\s*opacity:\s*0\.3;\s*\}/);
  assert.match(panelCss, /\.session-row \.session-row__title\s*\{[^}]*font-weight:\s*400/);
  assert.match(messagesCss, /\.session-row__title--unread\s*\{[^}]*font-weight:\s*600/);
});

test('the working dot is the muted text colour', () => {
  assert.match(foundationCss, /--sidebar-state-streaming-color:\s*var\(--text-muted\);/);
  const palettes = fs.readdirSync(path.join(root, 'styles')).filter(name => /^palette-.*\.css$/.test(name));
  for (const name of palettes) assert.doesNotMatch(read(name), /--sidebar-state-streaming-color/, name);
});

test('the unread dot yields whenever a status dot shows', () => {
  const rule = allRules.find(entry => /session-row__unread-dot$/.test(entry.selector) && /display:\s*none/.test(entry.body));
  assert.ok(rule, 'a hiding rule exists');
  for (const state of ['streaming', 'approval', 'plan_review', 'input_needed']) {
    assert.ok(rule.selector.includes(`[data-session-dominant-state="${state}"]`), state);
  }
  assert.ok(rule.selector.includes('[data-session-last-outcome="failed"]'));
});

test('the open button reserves the dot column, and collapsed parents reserve the chip as well', () => {
  assert.equal(
    declared(trailRules, '.project-header', '--session-row-end-reserve'),
    'calc(var(--session-row-dot-col-end) + var(--session-row-dot-size) + var(--space-5))'
  );
  assert.equal(declared(trailRules, '.session-row__open', 'padding-inline-end'), 'var(--session-row-end-reserve)');
  assert.equal(
    declared(trailRules, '.session-row[data-tree-expanded="false"] .session-row__open', 'padding-inline-end'),
    'calc(var(--session-row-end-reserve) + 44px)'
  );
});

test('narrow panels move the dot column to the row end margin', () => {
  const narrow = '@container viewpanel (max-width: 279px)';
  assert.equal(declared(trailRules, '.session-row', '--session-row-dot-col-end', narrow), 'var(--space-5)');
  // The end padding still clears the hover controls there: menu (32 px), plus the chevron (20 px) on parents.
  assert.equal(declared(trailRules, '.session-row__open', 'padding-inline-end', narrow), 'calc(var(--space-2) + 32px + var(--space-2))');
  assert.equal(declared(trailRules, '.session-row[data-tree-has-children="true"] .session-row__open', 'padding-inline-end', narrow), 'calc(var(--space-2) + 52px + var(--space-2))');
  assert.match(declared(trailRules, '.session-row[data-tree-expanded="false"] .session-row__open', 'padding-inline-end', narrow), /52px[\s\S]*var\(--space-4\)/);
  assert.match(panelCss, /@container viewpanel \(max-width: 279px\)[\s\S]*?\.session-row__time,/);
  // On hover the chevron and menu take that margin: the dots and chip step aside with visibility,
  // because the working dot's pulse animates opacity and an opacity rule would lose to it.
  const narrowHover = trailRules.find(rule => rule.context === '@container viewpanel (max-width: 279px)'
    && /:hover/.test(rule.selector) && /session-row__dot/.test(rule.selector));
  assert.ok(narrowHover, 'a narrow hover rule hides the dot column');
  for (const part of ['.session-row__dot', '.session-row__unread-dot', '.session-row__children-chip']) assert.ok(narrowHover.selector.includes(part), part);
  assert.match(narrowHover.body, /visibility:\s*hidden/);
  assert.doesNotMatch(narrowHover.body, /opacity/);
});

test('hover and focus swap the time for the controls with opacity only; bulk selection keeps the time', t => {
  assert.equal(declared(trailRules, '.session-row__chevron', 'opacity'), '0');
  assert.equal(declared(trailRules, '.session-row__menu', 'opacity'), '0');
  assert.doesNotMatch(treeCss, /aria-expanded="false"\]\s*\{\s*opacity:\s*1/);
  assert.match(trailCss, /transition:\s*opacity var\(--motion-duration-fast\) var\(--motion-ease-standard\)/);
  assert.match(trailCss, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?transition:\s*none/);

  const dom = new JSDOM('<!doctype html><head></head><body></body>');
  t.after(() => dom.window.close());
  const style = dom.window.document.createElement('style');
  style.textContent = [panelCss, treeCss, trailCss, selectionCss]
    .map(css => css.replace(/@container[\s\S]*?\n\}\n/, ''))
    .join('\n');
  dom.window.document.head.append(style);
  const rowHtml = (cls, attrs) => `<li class="session-row ${cls}" ${attrs}><button class="session-row__open"><span class="session-row__dot"></span><time class="session-row__time">3m</time></button><span class="session-row__branch"><button class="session-row__chevron"></button></span><button class="session-row__menu"></button></li>`;
  dom.window.document.body.insertAdjacentHTML('beforeend',
    rowHtml('', 'data-tree-has-children="true" data-tree-expanded="true"')
    + rowHtml('', 'data-tree-depth="1" data-tree-last="true"')
    + rowHtml('', 'data-tree-has-children="true" data-tree-expanded="false"')
    + rowHtml('active', ''));
  for (const row of dom.window.document.querySelectorAll('.session-row')) {
    const computed = node => dom.window.getComputedStyle(node);
    assert.equal(computed(row).gridTemplateColumns, 'minmax(0, 1fr)');
    for (const selector of ['.session-row__time', '.session-row__dot', '.session-row__menu', '.session-row__chevron']) {
      assert.equal(computed(row.querySelector(selector)).position, 'absolute', selector);
    }
    assert.equal(computed(row.querySelector('.session-row__menu')).opacity, '0');
    assert.equal(computed(row.querySelector('.session-row__chevron')).opacity, '0');
  }

  // The swap rules, checked as text because jsdom does not evaluate :hover.
  const swap = allRules.filter(rule => /:is\(:hover, :focus-within\)/.test(rule.selector) && /session-row__(?:time|menu|chevron)/.test(rule.selector));
  const timeHide = swap.find(rule => /session-row__time/.test(rule.selector));
  const controlsShow = swap.find(rule => /session-row__menu/.test(rule.selector));
  assert.ok(timeHide && /opacity:\s*0/.test(timeHide.body), 'hover hides the time');
  assert.match(timeHide.selector, /:not\(\.sidebar-bulk-selecting\)/, 'the time stays in bulk selection');
  assert.ok(controlsShow && /opacity:\s*1/.test(controlsShow.body) && /session-row__chevron/.test(controlsShow.selector), 'hover shows the chevron and menu');
});

test('forced colours: status dots use CanvasText and the unread dot uses Highlight', () => {
  const forced = trailRules.filter(rule => rule.context === '@media (forced-colors: active)');
  assert.ok(forced.some(rule => /session-row__dot/.test(rule.selector) && /background:\s*CanvasText/.test(rule.body)));
  assert.ok(forced.some(rule => /session-row__unread-dot/.test(rule.selector) && /background:\s*Highlight/.test(rule.body)));
});

test('tree guide line: 24 px indent, 4 px inside the title start, one straight segment, no tee', () => {
  const rule = declared(parseRules(treeCss), '.session-row', '--cw-indent');
  assert.equal(rule, '24px');
  assert.equal(declared(parseRules(treeCss), '.session-row', '--cw-thread-x'), 'calc(var(--cw-base, 0px) + var(--space-4) + 4px)');
  assert.equal(declared(parseRules(treeCss), '.session-row', '--cw-thread'), 'color-mix(in srgb, var(--text-muted) 55%, transparent)');
  assert.doesNotMatch(treeCss, /\[data-tree-last="false"\]::after/);
  assert.doesNotMatch(treeCss, /border-end-start-radius/);
  const last = parseRules(treeCss).find(entry => entry.selector.includes('[data-tree-last="true"]') && entry.selector.endsWith('::after'));
  assert.ok(last, 'the last-child segment exists');
  assert.match(last.body, /block-size:\s*calc\(var\(--session-row-height\) \+ var\(--space-1\) - var\(--space-4\)\)/);
  assert.doesNotMatch(last.body, /border-block-end|border-radius/);
  const origin = decls(parseRules(treeCss), '.session-row__origin');
  assert.doesNotMatch(origin, /padding-inline-start/);
});

test('the Select control is quiet until hovered; Done keeps the accent', () => {
  const rules = parseRules(selectionCss);
  assert.equal(declared(rules, '.sidebar-bulk-control--select', 'color'), 'var(--text-secondary)');
  assert.match(selectionCss, /\.sidebar-bulk-control--select:(?:hover|is\(:hover, :focus-visible\))[^{]*\{[^}]*color:\s*var\(--text-primary\)/);
  assert.equal(declared(rules, '.sidebar-bulk-control--done', 'color'), 'var(--accent)');
});

test('chats-panel.css stays under the 600-line ratchet', () => {
  assert.ok(panelCss.trimEnd().split('\n').length <= 599);
});
