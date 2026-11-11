'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPageActions, createReaderBridge } = require('../services/browser-use/page-actions');
const { MAX_TYPE_TEXT_LENGTH } = require('../services/browser-interaction-utils');
const { createCallLog, createFakeWebContents, logNames } = require('./helpers/fake-web-contents-view');
const { PAGE, READY_PROBE, harness } = require('./helpers/browser-use-page-actions-harness');

const NEVER = () => new Promise(() => {});
const TYPED = 'hunter2-UNIQUE-TYPED-TEXT';
const abortAfterTick = (controller) => setImmediate(() => controller.abort());

const INVALID = [
  ['read', { scope: 'page' }], ['read', { ref: 'x1' }], ['read', { ref: 'r1234567890123' }], ['read', { ref: 12 }],
  ['find', { query: '' }], ['find', { query: 'q'.repeat(201) }], ['find', { query: 5 }], ['find', { query: '   ' }],
  ['navigate', { url: '' }], ['navigate', { url: `https://a.test/${'x'.repeat(4096)}` }],
  ['navigate', { url: 5 }], ['navigate', {}],
  ['click', {}], ['click', { ref: 'r' }], ['click', { ref: 'R1' }], ['click', { ref: 'r1;x' }],
  ['type', { ref: 'bad', text: 'a' }], ['type', { ref: 'r1', text: 5 }], ['type', { ref: 'r1' }],
  ['type', { ref: 'r1', text: 'x'.repeat(MAX_TYPE_TEXT_LENGTH + 1) }], ['type', { ref: 'r1', text: 'a', submit: 'yes' }],
  ['select', { ref: 'bad', value: 'a' }], ['select', { ref: 'r1', value: 7 }],
  ['scroll', { direction: 'left' }], ['scroll', { ref: 'bad' }],
  ['press', { key: 'F5' }], ['press', {}], ['press', { key: 'Enter; rm' }],
];

for (const [method, args] of INVALID) {
  test(`${method} ${JSON.stringify(args).slice(0, 40)} is invalid_arguments and touches nothing`, async () => {
    const h = harness();
    const result = await h.actions[method](args);
    assert.equal(result.ok, false);
    assert.equal(result.status, 'invalid_arguments');
    assert.deepEqual(h.log, []);
  });
}

test('boundary lengths are accepted', async () => {
  const h = harness();
  assert.equal((await h.actions.find({ query: 'q'.repeat(200) })).status, 'ok');
  assert.equal((await h.actions.navigate({ url: `https://a.test/${'x'.repeat(4096 - 16)}` })).status, 'navigated');
  assert.equal((await h.actions.type({ ref: 'r1234567', text: 'x'.repeat(MAX_TYPE_TEXT_LENGTH) })).status, 'typed');
});

test('read returns the page outline and neither gates nor settles', async () => {
  const h = harness();
  const result = await h.actions.read({});
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.page, PAGE);
  assert.deepEqual(h.calls('read')[0].args, { scope: 'viewport' });
  assert.deepEqual(logNames(h.log), ['reader.read']);
  await h.actions.read({ scope: 'full', ref: 'r4' });
  assert.deepEqual(h.calls('read')[1].args, { scope: 'full', ref: 'r4' });
  const stale = await harness({ replies: { read: { status: 'stale', ref: 'r4' } } }).actions.read({ ref: 'r4' });
  assert.deepEqual([stale.ok, stale.status], [false, 'stale_ref']);
  assert.match(stale.message, /read again/i);
});

test('find returns matches and total', async () => {
  const h = harness();
  const result = await h.actions.find({ query: 'pay' });
  assert.deepEqual([result.ok, result.status, result.total, result.matches[0].ref], [true, 'ok', 1, 'r3']);
  assert.deepEqual(h.calls('find')[0].args, { query: 'pay' });
  assert.equal(result.message, 'Found 1 match.');
  const none = async (fields) => (await harness({ replies: { find: { matches: [], total: 0, fields } } }).actions.find({ query: 'search' })).message;
  assert.match(await none(0), /^Found 0 matches\. This page has no text fields or dropdowns at all/);
  assert.match(await none(2), /^Found 0 matches\. This page has 2 fields to type or choose in\./);
  assert.equal(await none(undefined), 'Found 0 matches.');
});

test('navigate asks the gate first, loads, settles in navigation mode, then reads', async () => {
  const h = harness();
  const result = await h.actions.navigate({ url: 'https://example.test/a' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'navigated');
  assert.deepEqual(result.page, PAGE);
  assert.deepEqual(logNames(h.log), [
    'gate.beforeNavigate', 'wc.getURL', 'wc.loadURL', 'settler.waitForSettle', 'reader.read',
  ]);
  assert.deepEqual(h.log[0].args, ['https://example.test/a']);
  assert.equal(h.log[3].args[0], 'navigation');
});

test('navigate back, forward and reload skip the gate and guard history', async () => {
  const h = harness({ wc: { canGoBack: true, canGoForward: true } });
  for (const word of ['back', 'forward', 'reload']) {
    const result = await h.actions.navigate({ url: word });
    assert.equal(result.status, 'navigated', word);
  }
  const names = logNames(h.log);
  assert.ok(names.includes('wc.goBack') && names.includes('wc.goForward') && names.includes('wc.reload'));
  assert.ok(!names.some(n => n.startsWith('gate.before')));
  assert.ok(!names.includes('wc.loadURL'));
});

test('navigate back and forward without history is no_history', async () => {
  const h = harness({ wc: { canGoBack: false, canGoForward: false } });
  for (const word of ['back', 'forward']) {
    const result = await h.actions.navigate({ url: word });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'no_history');
  }
  const names = logNames(h.log);
  assert.ok(!names.includes('wc.goBack') && !names.includes('wc.goForward'));
  assert.ok(!names.includes('settler.waitForSettle'));
});

test('a failed load reports only the error code, never a path or stack', async () => {
  const error = Object.assign(new Error('failed loading C:\\Users\\someone\\secret\\file.html'), {
    code: 'ERR_NAME_NOT_RESOLVED',
    stack: 'Error: boom\n    at C:\\Users\\someone\\app\\main.js:10:5',
  });
  const h = harness({ wc: { loadURL: async () => { throw error; } } });
  const result = await h.actions.navigate({ url: 'https://nope.test/' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'load_failed');
  assert.match(result.message, /ERR_NAME_NOT_RESOLVED/);
  const json = JSON.stringify(result);
  assert.doesNotMatch(json, /Users|someone|secret|main\.js|\bat C:|\\\\/);
  const plain = harness({ wc: { loadURL: async () => { throw new Error('/etc/passwd leaked'); } } });
  const second = await plain.actions.navigate({ url: 'https://nope.test/' });
  assert.equal(second.status, 'load_failed');
  assert.doesNotMatch(JSON.stringify(second), /passwd/);
});

test('a declining gate touches nothing on the page and passes status and wait through', async () => {
  const h = harness({
    gateReplies: { beforeNavigate: { proceed: false, status: 'blocked', message: 'Not allowed.', humanWaitMs: 1500 } },
  });
  const result = await h.actions.navigate({ url: 'https://evil.test/' });
  assert.deepEqual(result, { ok: false, status: 'blocked', message: 'Not allowed.', humanWaitMs: 1500 });
  assert.deepEqual(logNames(h.log), ['gate.beforeNavigate']);
  const approving = harness({ gateReplies: { beforeNavigate: { proceed: true, humanWaitMs: 4200 } } });
  const approved = await approving.actions.navigate({ url: 'https://example.test/' });
  assert.deepEqual([approved.status, approved.humanWaitMs], ['navigated', 4200]);
  assert.equal(Object.hasOwn(await harness().actions.read({}), 'humanWaitMs'), false);
});

test('a throwing gate fails closed as declined', async () => {
  const h = harness({ gateReplies: { beforeClick: new Error('consent store offline /secret/path') } });
  const result = await h.actions.click({ ref: 'r12' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'declined');
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.equal(h.webContents.inputEvents.length, 0);
  assert.equal(h.warnings.length, 1);
});

test('click: probe, gate, verify immediately before dispatch, then input and settle', async () => {
  const h = harness();
  const result = await h.actions.click({ ref: 'r12' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'clicked');
  assert.deepEqual(logNames(h.log), [
    'reader.probe', 'gate.beforeClick', 'reader.verify',
    'wc.sendInputEvent', 'wc.sendInputEvent', 'wc.sendInputEvent',
    'settler.waitForSettle', 'reader.pressSeen', 'reader.read',
  ]);
  assert.deepEqual(h.log[1].args[0], READY_PROBE);
  assert.deepEqual(h.calls('verify')[0].args, { ref: 'r12', fingerprint: 'fp-12', watchPress: true });
  assert.deepEqual(h.webContents.inputEvents, [
    { type: 'mouseMove', x: 100, y: 201 },
    { type: 'mouseDown', x: 100, y: 201, button: 'left', clickCount: 1 },
    { type: 'mouseUp', x: 100, y: 201, button: 'left', clickCount: 1 },
  ]);
  assert.equal(h.log[6].args[0], 'action');
});

test('verify runs after a slow gate, not before it', async () => {
  let release;
  const h = harness({ gateReplies: { beforeClick: () => new Promise((r) => { release = () => r({ proceed: true }); }) } });
  const pending = h.actions.click({ ref: 'r12' });
  await new Promise(r => setImmediate(r));
  assert.deepEqual(logNames(h.log), ['reader.probe', 'gate.beforeClick']);
  release();
  await pending;
  const names = logNames(h.log);
  assert.ok(names.indexOf('reader.verify') > names.indexOf('gate.beforeClick'));
  assert.ok(names.indexOf('reader.verify') < names.indexOf('wc.sendInputEvent'));
});

test('click maps a stale or invisible ref without asking the gate', async () => {
  const stale = harness({ replies: { probe: { status: 'stale', ref: 'r12' } } });
  const a = await stale.actions.click({ ref: 'r12' });
  assert.equal(a.status, 'stale_ref');
  assert.match(a.message, /read/i);
  const hidden = harness({ replies: { probe: { status: 'not_visible', ref: 'r12' } } });
  const b = await hidden.actions.click({ ref: 'r12' });
  assert.equal(b.status, 'not_visible');
  for (const h of [stale, hidden]) {
    assert.deepEqual(logNames(h.log), ['reader.probe']);
  }
});

test('a file input is refused even when the gate would allow it', async () => {
  const h = harness({ replies: { probe: { ...READY_PROBE, isFileInput: true } } });
  const result = await h.actions.click({ ref: 'r12' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'refused');
  assert.deepEqual(logNames(h.log), ['reader.probe']);
});

test('element_changed, element_obscured and stale at verify send zero input events', async () => {
  const cases = [
    [{ status: 'changed' }, 'element_changed'],
    [{ status: 'obscured', by: 'div.cookie-banner' }, 'element_obscured'],
    [{ status: 'stale' }, 'stale_ref'],
  ];
  for (const [verify, status] of cases) {
    const h = harness({ replies: { verify } });
    const result = await h.actions.click({ ref: 'r12' });
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.equal(h.webContents.inputEvents.length, 0);
    assert.ok(!logNames(h.log).includes('settler.waitForSettle'));
    if (verify.by) {
      assert.match(result.detail, /cookie-banner/, 'the model is told');
      assert.doesNotMatch(result.message, /cookie-banner/, 'the saved line holds nothing from the page');
    }
  }
});

test('type: probe, gate, focus with clear, insert, settle; the text never appears in the result', async () => {
  const h = harness();
  const result = await h.actions.type({ ref: 'r12', text: TYPED });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'typed');
  assert.deepEqual(logNames(h.log), [
    'reader.probe', 'gate.beforeType', 'reader.focusForTyping', 'wc.insertText',
    'settler.waitForSettle', 'reader.read',
  ]);
  assert.deepEqual(h.calls('focusForTyping')[0].args, { ref: 'r12', fingerprint: 'fp-12', clear: true });
  assert.deepEqual(h.log[1].args[1], { submit: false });
  assert.deepEqual(h.webContents.insertedText, [TYPED]);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TYPED));
  assert.doesNotMatch(JSON.stringify(h.log[1]), new RegExp(TYPED));
  assert.match(result.message, new RegExp(String(TYPED.length)));
});

test('type with submit presses Enter with a char event after inserting', async () => {
  const h = harness();
  const result = await h.actions.type({ ref: 'r12', text: TYPED, submit: true });
  assert.equal(result.status, 'typed');
  assert.deepEqual(h.log.find(e => e.name === 'beforeType').args[1], { submit: true });
  assert.deepEqual(h.webContents.inputEvents, [
    { type: 'keyDown', keyCode: 'Enter' },
    { type: 'char', keyCode: 'Enter' },
    { type: 'keyUp', keyCode: 'Enter' },
  ]);
  const names = logNames(h.log);
  assert.ok(names.indexOf('wc.insertText') < names.indexOf('wc.sendInputEvent'));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TYPED));
});

test('type refuses secret and file fields regardless of the gate, and non-editable fields', async () => {
  for (const [probe, status] of [
    [{ ...READY_PROBE, isSecret: true }, 'refused'],
    [{ ...READY_PROBE, isFileInput: true }, 'refused'],
    [{ ...READY_PROBE, isEditable: false }, 'not_editable'],
  ]) {
    const h = harness({ replies: { probe } });
    const result = await h.actions.type({ ref: 'r12', text: TYPED });
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.deepEqual(logNames(h.log), ['reader.probe']);
    assert.equal(h.webContents.insertedText.length, 0);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TYPED));
  }
});

test('type maps focusForTyping failures and inserts nothing', async () => {
  for (const [status, expected] of [['stale', 'stale_ref'], ['changed', 'element_changed'], ['not_editable', 'not_editable']]) {
    const h = harness({ replies: { focusForTyping: { status } } });
    const result = await h.actions.type({ ref: 'r12', text: TYPED });
    assert.equal(result.status, expected);
    assert.equal(h.webContents.insertedText.length, 0);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TYPED));
  }
});

test('select: probe, gate, reader select with fingerprint, settle', async () => {
  const h = harness();
  const result = await h.actions.select({ ref: 'r12', value: 'Large' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'selected');
  assert.deepEqual(logNames(h.log), [
    'reader.probe', 'gate.beforeSelect', 'reader.select', 'settler.waitForSettle', 'reader.read',
  ]);
  assert.deepEqual(h.calls('select')[0].args, { ref: 'r12', fingerprint: 'fp-12', value: 'Large' });
});

test('select refuses secret fields and maps reader answers', async () => {
  const secret = harness({ replies: { probe: { ...READY_PROBE, isSecret: true } } });
  assert.equal((await secret.actions.select({ ref: 'r12', value: 'x' })).status, 'refused');
  assert.deepEqual(logNames(secret.log), ['reader.probe']);

  const missing = harness({ replies: { select: { status: 'no_such_option', options: ['Small', 'Medium'] } } });
  const a = await missing.actions.select({ ref: 'r12', value: 'Huge' });
  assert.equal(a.ok, false);
  assert.equal(a.status, 'no_such_option');
  assert.match(a.detail, /Small/);
  assert.match(a.detail, /Medium/);
  assert.doesNotMatch(a.message, /Small|Medium/, 'the saved line holds nothing from the page');
  assert.ok(!logNames(missing.log).includes('settler.waitForSettle'));

  for (const [status, expected] of [
    ['not_selectable', 'not_selectable'], ['stale', 'stale_ref'], ['changed', 'element_changed'],
  ]) {
    const h = harness({ replies: { select: { status } } });
    assert.equal((await h.actions.select({ ref: 'r12', value: 'x' })).status, expected);
  }
});

test('scroll defaults to down, settles, and mentions the end of the page', async () => {
  const h = harness({ replies: { scroll: { status: 'scrolled', moved: 120, atEnd: true } } });
  const result = await h.actions.scroll({});
  assert.equal(result.ok, true);
  assert.equal(result.status, 'scrolled');
  assert.match(result.message, /end|bottom/i);
  assert.deepEqual(h.calls('scroll')[0].args, { direction: 'down' });
  assert.deepEqual(logNames(h.log), ['reader.scroll', 'settler.waitForSettle', 'reader.read']);
  assert.equal(h.log[1].args[0], 'action');

  const more = harness();
  const next = await more.actions.scroll({ direction: 'up', ref: 'r9' });
  assert.deepEqual(more.calls('scroll')[0].args, { direction: 'up', ref: 'r9' });
  assert.doesNotMatch(next.message, /reached/i);
  const stale = harness({ replies: { scroll: { status: 'stale', ref: 'r9' } } });
  assert.equal((await stale.actions.scroll({ ref: 'r9' })).status, 'stale_ref');
  assert.ok(!logNames(stale.log).includes('settler.waitForSettle'));
});

test('press sends keyDown, char and keyUp for Enter and Space, and no char for others', async () => {
  const expectations = [
    ['Enter', 'Enter', true], [' ', 'Space', true], ['Spacebar', 'Space', true],
    ['Tab', 'Tab', false], ['ArrowUp', 'Up', false], ['Escape', 'Escape', false],
  ];
  for (const [key, keyCode, withChar] of expectations) {
    const h = harness();
    const result = await h.actions.press({ key });
    assert.equal(result.status, 'pressed', key);
    const types = h.webContents.inputEvents.map(e => e.type);
    assert.deepEqual(types, withChar ? ['keyDown', 'char', 'keyUp'] : ['keyDown', 'keyUp'], key);
    assert.ok(h.webContents.inputEvents.every(e => e.keyCode === keyCode));
    assert.deepEqual(logNames(h.log).filter(n => !n.startsWith('wc.')), [
      'reader.probeFocused', 'gate.beforePress', 'reader.probeFocused', 'settler.waitForSettle', 'reader.read',
    ]);
  }
});

test('press gives the gate null facts when nothing is focused, and the facts otherwise', async () => {
  const none = harness();
  await none.actions.press({ key: 'Enter' });
  assert.deepEqual(none.log.find(e => e.name === 'beforePress').args, ['Enter', null]);
  const facts = { status: 'ready', ref: 'r5', isSecret: false };
  const some = harness({ replies: { probeFocused: facts } });
  await some.actions.press({ key: 'Enter' });
  assert.deepEqual(some.log.find(e => e.name === 'beforePress').args, ['Enter', facts]);
  const declined = harness({ gateReplies: { beforePress: { proceed: false, message: 'No.' } } });
  assert.equal((await declined.actions.press({ key: 'Enter' })).status, 'declined');
  assert.equal(declined.webContents.inputEvents.length, 0);
});

test('press in a secret field refuses everything except Tab and Escape', async () => {
  const facts = { status: 'ready', ref: 'r5', isSecret: true };
  for (const key of ['Enter', 'Space', 'ArrowLeft']) {
    const h = harness({ replies: { probeFocused: facts } });
    const result = await h.actions.press({ key });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'refused');
    assert.equal(h.webContents.inputEvents.length, 0);
  }
  for (const key of ['Tab', 'Escape']) {
    const h = harness({ replies: { probeFocused: facts } });
    assert.equal((await h.actions.press({ key })).status, 'pressed');
  }
});

test('a withheld page returns no page text and is checked before the page is read', async () => {
  const h = harness({ gateExtras: { takeWithheld: () => ({ reason: 'sensitive form' }), takeBlockedNavigation: () => null } });
  const result = await h.actions.click({ ref: 'r12' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'withheld');
  assert.equal(Object.hasOwn(result, 'page'), false);
  assert.doesNotMatch(JSON.stringify(result), /Home|outline/);
  assert.equal(h.calls('read').length, 0);
});

test('takeWithheld is called before reader.read and takeBlockedNavigation after', async () => {
  const h = harness({ gateExtras: { takeWithheld: () => null, takeBlockedNavigation: () => null } });
  await h.actions.scroll({});
  const names = logNames(h.log);
  assert.ok(names.indexOf('gate.takeWithheld') > names.indexOf('settler.waitForSettle'));
  assert.ok(names.indexOf('gate.takeWithheld') < names.indexOf('reader.read'));
  assert.ok(names.indexOf('gate.takeBlockedNavigation') > names.indexOf('reader.read'));
});

test('a blocked popup navigation is attached and explained', async () => {
  const blocked = { host: 'ads.example.test', reason: 'new_site' };
  const h = harness({ gateExtras: { takeWithheld: () => null, takeBlockedNavigation: () => blocked } });
  const result = await h.actions.click({ ref: 'r12' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'clicked');
  assert.deepEqual(result.blockedNavigation, blocked);
  assert.match(result.message, /ads\.example\.test/);
  assert.match(result.message, /navigate/);
});

test('a reader failure after the action keeps the action status', async () => {
  const h = harness({ replies: { read: new Error('document replaced') } });
  const result = await h.actions.click({ ref: 'r12' });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'clicked');
  assert.equal(Object.hasOwn(result, 'page'), false);
  assert.match(result.message, /could not be read/i);
  assert.equal(h.webContents.inputEvents.length, 3);
  const before = harness({ replies: { probe: new Error('document replaced') } });
  const early = await before.actions.click({ ref: 'r12' });
  assert.deepEqual([early.ok, early.status, before.webContents.inputEvents.length], [false, 'page_unavailable', 0]);
});

test('screenshot masks secrets, holds frames, captures, and always restores', async () => {
  const h = harness();
  const result = await h.actions.screenshot();
  assert.equal(result.ok, true);
  assert.equal(result.status, 'screenshot');
  assert.ok(Buffer.isBuffer(result.image.buffer));
  assert.deepEqual([result.image.width, result.image.height, result.image.mime_type], [8, 6, 'image/png']);
  const names = logNames(h.log);
  assert.deepEqual(names.filter(n => n !== 'wc.executeJavaScript'), [
    'reader.secretMask', 'wc.beginFrameSubscription', 'wc.invalidate', 'wc.capturePage',
    'wc.endFrameSubscription', 'reader.secretMask',
  ]);
  assert.deepEqual(h.calls('secretMask').map(c => c.args), [{ on: true }, { on: false }]);
  assert.deepEqual(h.log.find(e => e.name === 'capturePage').args, [undefined, { stayHidden: true }]);
  assert.ok(!names.includes('settler.waitForSettle'));
});

test('screenshot restores the page when capture fails', async () => {
  const h = harness({ wc: { capturePage: async () => { throw new Error('gpu lost at C:\\x'); } } });
  const result = await h.actions.screenshot();
  assert.equal(result.ok, false);
  assert.equal(result.status, 'screenshot_failed');
  assert.doesNotMatch(JSON.stringify(result), /gpu|C:/);
  assert.deepEqual(h.calls('secretMask').map(c => c.args), [{ on: true }, { on: false }]);
  assert.ok(logNames(h.log).includes('wc.endFrameSubscription'));
});

test('screenshot restores the page when aborted mid-capture', async () => {
  const controller = new AbortController();
  const h = harness({ wc: { capturePage: NEVER } });
  const pending = h.actions.screenshot({}, { signal: controller.signal });
  abortAfterTick(controller);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(h.calls('secretMask').map(c => c.args), [{ on: true }, { on: false }]);
  assert.ok(logNames(h.log).includes('wc.endFrameSubscription'));
});

test('screenshot never captures when the mask could not be applied', async () => {
  let n = 0;
  const h = harness({ replies: { secretMask: () => { n += 1; if (n === 1) throw new Error('gone'); return { status: 'ok' }; } } });
  const result = await h.actions.screenshot();
  assert.equal(result.status, 'screenshot_failed');
  assert.ok(!logNames(h.log).includes('wc.capturePage'));
  assert.equal(h.calls('secretMask').length, 2);
});

test('an already aborted signal cancels before touching anything', async () => {
  const controller = new AbortController();
  controller.abort();
  for (const [method, args] of [
    ['read', {}], ['click', { ref: 'r1' }], ['navigate', { url: 'https://a.test/' }], ['press', { key: 'Tab' }],
  ]) {
    const h = harness();
    const result = await h.actions[method](args, { signal: controller.signal });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'cancelled', method);
    assert.deepEqual(h.log, []);
  }
});

test('click cancels during probe, gate, verify and settle', async () => {
  const stages = [
    ['probe', { replies: { probe: NEVER } }, 0],
    ['gate', { gateReplies: { beforeClick: NEVER } }, 0],
    ['verify', { replies: { verify: NEVER } }, 0],
    ['settle', { settle: NEVER }, 3],
  ];
  for (const [stage, options, events] of stages) {
    const controller = new AbortController();
    const h = harness(options);
    const pending = h.actions.click({ ref: 'r12' }, { signal: controller.signal });
    abortAfterTick(controller);
    const result = await pending;
    assert.equal(result.status, 'cancelled', stage);
    assert.equal(result.ok, false);
    assert.equal(h.webContents.inputEvents.length, events, stage);
  }
});

test('type, navigate and press cancel while waiting on the page', async () => {
  const cases = [
    ['type', { ref: 'r12', text: TYPED }, { replies: { focusForTyping: NEVER } }],
    ['navigate', { url: 'https://example.test/' }, { wc: { loadURL: NEVER }, settle: NEVER }],
    ['press', { key: 'Enter' }, { gateReplies: { beforePress: NEVER } }],
    ['select', { ref: 'r12', value: 'x' }, { replies: { select: NEVER } }],
    ['scroll', {}, { replies: { scroll: NEVER } }],
  ];
  for (const [method, args, options] of cases) {
    const controller = new AbortController();
    const h = harness(options);
    const pending = h.actions[method](args, { signal: controller.signal });
    abortAfterTick(controller);
    const result = await pending;
    assert.equal(result.status, 'cancelled', method);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TYPED));
  }
});

test('createReaderBridge injects the generation and runs in the isolated world', async () => {
  const log = createCallLog();
  const webContents = createFakeWebContents({
    log, executeJavaScriptInIsolatedWorld: async () => ({ status: 'ok', value: 7 }),
  });
  let generation = 3;
  const built = [];
  const bridge = createReaderBridge({
    webContents,
    worldId: 1234,
    getGeneration: () => generation,
    buildReaderCall: (op, args) => { built.push([op, args]); return `reader(${op})`; },
  });
  assert.deepEqual(await bridge.call('probe', { ref: 'r1' }), { status: 'ok', value: 7 });
  generation = 4;
  await bridge.call('status');
  assert.deepEqual(built, [['probe', { ref: 'r1', generation: 3 }], ['status', { generation: 4 }]]);
  assert.deepEqual(log[0].args, [1234, [{ code: 'reader(probe)' }]]);
});

test('createReaderBridge times out a page that never answers', async () => {
  const webContents = createFakeWebContents({ executeJavaScriptInIsolatedWorld: NEVER });
  const bridge = createReaderBridge({
    webContents, worldId: 1, getGeneration: () => 1, buildReaderCall: () => 'x', timeoutMs: 20,
  });
  await assert.rejects(bridge.call('read', {}), /timed out/i);
});

test('Enter is not pressed when the focus left the typed field', async () => {
  const h = harness({ replies: { focusIs: { status: 'changed' } } });
  const result = await h.actions.type({ ref: 'r12', text: TYPED, submit: true });
  assert.equal(result.status, 'element_changed');
  assert.match(result.message, /Enter was not pressed/);
  assert.equal(h.webContents.inputEvents.length, 0);
  assert.deepEqual(h.calls('focusIs')[0].args.ref, 'r12');
  assert.ok(!logNames(h.log).includes('settler.waitForSettle'));
});

test('typing without Enter has no second focus check', async () => {
  const h = harness();
  assert.equal((await h.actions.type({ ref: 'r12', text: TYPED })).status, 'typed');
  assert.equal(h.calls('focusIs').length, 0);
});

test('a key is not pressed when the focus moved while the user was being asked', async () => {
  let reads = 0;
  const field = (fingerprint, isSecret) => ({ ...READY_PROBE, isEditable: true, isSecret, fingerprint });
  const h = harness({ replies: { probeFocused: () => (reads++ === 0 ? field('search', false) : field('card-number', true)) } });
  const result = await h.actions.press({ key: 'Enter' });
  assert.equal(result.status, 'element_changed');
  assert.equal(h.webContents.inputEvents.length, 0);
  const gained = harness({ replies: { probeFocused: () => (reads++ === 2 ? { status: 'none' } : field('late', false)) } });
  assert.equal((await gained.actions.press({ key: 'Enter' })).status, 'element_changed', 'focus appearing counts as moving');
});

test('a native call that never answers ends the step instead of hanging it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let typing = false;
  const h = harness({ wc: { insertText: () => { typing = true; return new Promise(() => {}); } } });
  const running = h.actions.type({ ref: 'r12', text: TYPED }).then(value => value, error => error);
  for (let turn = 0; turn < 200 && !typing; turn += 1) await Promise.resolve();
  assert.equal(typing, true);
  t.mock.timers.tick(5000);
  const outcome = await running;
  assert.equal(outcome.message, 'Typing timed out.');
  assert.doesNotMatch(JSON.stringify(outcome), new RegExp(TYPED));
});
