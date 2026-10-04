'use strict';

// Type-scale gate (2026-09-28): sibling surfaces that play the same role must
// resolve to the same role token, and every role token must ride --font-scale,
// so Text size moves the chats rail, the task rail, the IDE tree and the chat
// timeline together.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STYLES = path.join(__dirname, '..', 'styles');
const read = (file) => fs.readFileSync(path.join(STYLES, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const ROLE_PX = { caption: 12, footnote: 13, code: 13, body: 14, prose: 16, heading: 16, title: 20 };

function customProperties() {
  const map = new Map();
  for (const file of ['foundation.css', 'chat-timeline-tokens.css']) {
    for (const match of read(file).matchAll(/(--(?:font-size|tl-font)-[\w-]+)\s*:\s*([^;]+);/g)) {
      if (!map.has(match[1])) map.set(match[1], match[2].trim());
    }
  }
  return map;
}

function declaredFontSize(file, selector) {
  const css = read(file);
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`(?:^|[}\\s,])${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  assert.ok(rule, `${file}: rule ${selector} exists`);
  const decl = /(?:^|[;{\s])font-size\s*:\s*([^;]+);/.exec(rule[1]);
  assert.ok(decl, `${file}: ${selector} declares font-size`);
  return decl[1].trim();
}

function resolveRole(value, props) {
  let current = value;
  for (let hop = 0; hop < 6; hop += 1) {
    const role = /^var\(--font-size-(caption|footnote|code|body|prose|heading|title)\)$/.exec(current);
    if (role) return role[1];
    const alias = /^var\((--(?:font-size|tl-font)-[\w-]+)\)$/.exec(current);
    if (!alias || !props.has(alias[1])) return null;
    current = props.get(alias[1]);
  }
  return null;
}

test('every role token is Npx times --font-scale at the agreed Default size', () => {
  const props = customProperties();
  for (const [role, px] of Object.entries(ROLE_PX)) {
    assert.equal(props.get(`--font-size-${role}`), `calc(${px}px * var(--font-scale, 1))`, role);
  }
});

test('sibling surfaces with the same role resolve to the same role token', () => {
  const props = customProperties();
  const cases = [
    ['heading', 'chats-panel.css', '.sidebar-title'],
    ['heading', 'artifact-panel.css', '.artifact-panel-title'],
    ['heading', 'chat-subagent-monitor.css', '.subagent-monitor-title'],
    ['body', 'chats-panel.css', '.session-row .session-row__title'],
    ['body', 'task-rail.css', '.artifact-review-panel[data-artifact-review-mode="tasks"] .task-rail-title'],
    ['body', 'ide-view.css', '.ide-tree'],
    ['prose', 'chat-thread.css', '.chat-bubble'],
    ['prose', 'chat-composer.css', '.composer-input'],
    ['caption', 'chats-panel.css', '.session-row__time'],
    ['caption', 'task-rail.css', '.artifact-review-panel[data-artifact-review-mode="tasks"] .task-rail-meta'],
    ['caption', 'chats-panel.css', '.group-label'],
  ];
  for (const [role, file, selector] of cases) {
    assert.equal(resolveRole(declaredFontSize(file, selector), props), role, `${file} ${selector}`);
  }
});

test('the chat timeline aliases ride the same axis as the shell', () => {
  const props = customProperties();
  assert.equal(resolveRole('var(--tl-font-prose)', props), 'prose');
  assert.equal(resolveRole('var(--tl-font-meta)', props), 'caption');
  assert.equal(resolveRole('var(--tl-font-code)', props), 'code');
  assert.equal(resolveRole('var(--tl-font-ui)', props), 'footnote');
});
