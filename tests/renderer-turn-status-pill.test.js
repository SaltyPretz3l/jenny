const test = require('node:test');
const assert = require('node:assert/strict');

const { createTurnStatusPillController, SOURCE_PRIORITY } = require('../renderer/shell/renderer-turn-status-pill.js');

function createPillElement() {
  const classes = new Set(['hidden']);
  const attributes = new Map();
  return {
    innerHTML: '',
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    _attributes: attributes,
    _classes: classes,
  };
}

function createMetricList() {
  const classes = new Set();
  return {
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    _classes: classes,
  };
}

function createTitlebarStatus() {
  const classes = new Set();
  return {
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    _classes: classes,
  };
}

test('priority order has shutdown first and sending last', () => {
  assert.equal(SOURCE_PRIORITY[0], 'lifecycle.shutdown');
  assert.equal(SOURCE_PRIORITY[SOURCE_PRIORITY.length - 1], 'turn.sending');
  assert.ok(SOURCE_PRIORITY.indexOf('lifecycle.modelSwitch') < SOURCE_PRIORITY.indexOf('turn.needs_approval'));
  assert.ok(SOURCE_PRIORITY.indexOf('turn.needs_approval') < SOURCE_PRIORITY.indexOf('turn.running_tool'));
  assert.ok(SOURCE_PRIORITY.indexOf('turn.running_tool') < SOURCE_PRIORITY.indexOf('turn.thinking'));
  assert.ok(SOURCE_PRIORITY.indexOf('turn.thinking') < SOURCE_PRIORITY.indexOf('turn.responding'));
  assert.ok(SOURCE_PRIORITY.indexOf('turn.responding') < SOURCE_PRIORITY.indexOf('turn.sending'));
});

test('starts hidden with no active source', () => {
  const pill = createPillElement();
  const controller = createTurnStatusPillController({ dom: { turnStatusPill: pill } });
  controller.render();
  assert.equal(pill.classList.contains('hidden'), true);
  assert.equal(controller.getActiveSource(), null);
});

test('set renders the message and reveals the pill', () => {
  const pill = createPillElement();
  const controller = createTurnStatusPillController({ dom: { turnStatusPill: pill } });
  controller.set('turn.running_tool', {
    message: 'Running file_read…',
    tone: 'pending',
    spinner: true,
    badgeText: 'Tool',
  });
  assert.equal(pill.classList.contains('hidden'), false);
  assert.equal(pill.getAttribute('data-source'), 'turn.running_tool');
  assert.equal(pill.getAttribute('data-tone'), 'pending');
  assert.match(pill.innerHTML, /Running file_read/);
  assert.match(pill.innerHTML, /turn-status-pill__spinner/);
  assert.match(pill.innerHTML, /Tool</);
});

test('clear removes the source and hides the pill when nothing else is active', () => {
  const pill = createPillElement();
  const controller = createTurnStatusPillController({ dom: { turnStatusPill: pill } });
  controller.set('turn.sending', { message: 'Sending…', tone: 'pending', spinner: true, badgeText: 'Sending' });
  assert.equal(pill.classList.contains('hidden'), false);
  controller.clear('turn.sending');
  assert.equal(pill.classList.contains('hidden'), true);
  assert.equal(controller.getActiveSource(), null);
});

test('higher-priority source supersedes a lower-priority one without erasing the lower-priority payload', () => {
  const pill = createPillElement();
  const controller = createTurnStatusPillController({ dom: { turnStatusPill: pill } });
  controller.set('turn.sending', { message: 'Sending…', tone: 'pending', spinner: true });
  controller.set('turn.running_tool', { message: 'Running git_add…', tone: 'pending', spinner: true, badgeText: 'Tool' });
  assert.equal(controller.getActiveSource(), 'turn.running_tool');
  assert.match(pill.innerHTML, /Running git_add/);

  // Clearing the higher-priority source should fall back to the lower one.
  controller.clear('turn.running_tool');
  assert.equal(controller.getActiveSource(), 'turn.sending');
  assert.match(pill.innerHTML, /Sending/);
});

test('lifecycle.shutdown supersedes every other source', () => {
  const pill = createPillElement();
  const controller = createTurnStatusPillController({ dom: { turnStatusPill: pill } });
  controller.set('lifecycle.modelSwitch', { message: 'Loading model…', tone: 'pending', spinner: true });
  controller.set('turn.needs_approval', { message: 'Approval needed for git_add', tone: 'warning' });
  controller.set('lifecycle.shutdown', { message: 'Shutting down…', tone: 'warning', spinner: true });
  assert.equal(controller.getActiveSource(), 'lifecycle.shutdown');
  assert.match(pill.innerHTML, /Shutting down/);
});

test('shutdown rendering toggles the titlebar-status shutdown class and hides the metric list', () => {
  const pill = createPillElement();
  const metricList = createMetricList();
  const titlebarStatus = createTitlebarStatus();
  const controller = createTurnStatusPillController({
    dom: { turnStatusPill: pill, metricList, titlebarStatus },
  });
  controller.set('lifecycle.shutdown', { message: 'Shutting down…', tone: 'warning', spinner: true });
  assert.equal(pill.getAttribute('data-shutdown'), 'true');
  assert.equal(titlebarStatus.classList.contains('titlebar-status--shutdown'), true);
  assert.equal(metricList.classList.contains('hidden-by-pill'), true);

  controller.clear('lifecycle.shutdown');
  assert.equal(pill.classList.contains('hidden'), true);
  assert.equal(titlebarStatus.classList.contains('titlebar-status--shutdown'), false);
  assert.equal(metricList.classList.contains('hidden-by-pill'), false);
});

test('set with empty message clears that source', () => {
  const pill = createPillElement();
  const controller = createTurnStatusPillController({ dom: { turnStatusPill: pill } });
  controller.set('turn.running_tool', { message: 'Running git_add…', tone: 'pending' });
  controller.set('turn.running_tool', { message: '' });
  assert.equal(controller.getActiveSource(), null);
  assert.equal(pill.classList.contains('hidden'), true);
});

test('indeterminate progress writes the data-indeterminate attribute on the progress underline', () => {
  const pill = createPillElement();
  const controller = createTurnStatusPillController({ dom: { turnStatusPill: pill } });
  controller.set('lifecycle.startup', {
    message: 'Loading model…',
    tone: 'pending',
    spinner: true,
    indeterminate: true,
  });
  assert.match(pill.innerHTML, /data-indeterminate="true"/);
});

test('determinate progress writes a percent into the inline style', () => {
  const pill = createPillElement();
  const controller = createTurnStatusPillController({ dom: { turnStatusPill: pill } });
  controller.set('lifecycle.startup', {
    message: 'Starting…',
    tone: 'pending',
    spinner: true,
    progressPercent: 42,
  });
  assert.match(pill.innerHTML, /--turn-status-pill-progress:42%/);
});

test('html-escapes message and badge content', () => {
  const pill = createPillElement();
  const controller = createTurnStatusPillController({ dom: { turnStatusPill: pill } });
  controller.set('turn.running_tool', {
    message: 'Running <script>alert(1)</script>',
    tone: 'pending',
    spinner: true,
    badgeText: '"&"',
  });
  assert.equal(pill.innerHTML.includes('<script>'), false);
  assert.match(pill.innerHTML, /&lt;script&gt;/);
  assert.match(pill.innerHTML, /&quot;&amp;&quot;/);
});

test('dispose clears all sources and hides the pill', () => {
  const pill = createPillElement();
  const metricList = createMetricList();
  const titlebarStatus = createTitlebarStatus();
  const controller = createTurnStatusPillController({
    dom: { turnStatusPill: pill, metricList, titlebarStatus },
  });
  controller.set('lifecycle.shutdown', { message: 'Shutting down…', tone: 'warning' });
  controller.dispose();
  assert.equal(pill.classList.contains('hidden'), true);
  assert.equal(controller.getActiveSource(), null);
  assert.equal(metricList.classList.contains('hidden-by-pill'), false);
  assert.equal(titlebarStatus.classList.contains('titlebar-status--shutdown'), false);
});

test('no DOM element is a tolerated no-op', () => {
  const controller = createTurnStatusPillController({ dom: {} });
  controller.set('turn.running_tool', { message: 'Running…', tone: 'pending', spinner: true });
  controller.render();
  assert.equal(controller.getActiveSource(), 'turn.running_tool');
  controller.dispose();
});
