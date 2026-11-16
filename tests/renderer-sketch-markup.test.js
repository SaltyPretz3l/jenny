'use strict';

// new-test-file: "Mark up" is a new surface: a lazily loaded action module of the sketch frame host
// (plan section 5.6, slice S8), tested against the real host the way the host's own test draws a block.

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const HOST_PATH = require.resolve('../renderer/features/renderer-sketch-frame-host');
const MODULE_PATH = require.resolve('../renderer/features/renderer-sketch-markup');
const markdownUtils = require('../renderer/shared/markdown-utils');

const SOURCE = 'title Sign in\nuser User @user\napp App\nuser -> app';
const PNG_BASE64 = 'iVBORw0KGgo=';
const PNG_BYTES = [137, 80, 78, 71, 13, 10, 26, 10];
const TAKES = { supported: true, modelLabel: 'Vision Model' };
const UNKNOWN = { supported: null, modelLabel: 'The active model' };
const BLIND = { supported: false, modelLabel: 'Text Model' };

function frameOf(block) {
  const iframe = block.querySelector('.markdown-sketch-paper > iframe');
  assert.ok(iframe, 'the block has a frame');
  if (!iframe.sketchTestWindow) {
    const posted = [];
    const stub = { posted, postMessage: (payload, target) => posted.push({ payload, target }) };
    Object.defineProperty(iframe, 'contentWindow', { configurable: true, value: stub });
    iframe.sketchTestWindow = stub;
  }
  return { iframe, frameWindow: iframe.sketchTestWindow, posted: iframe.sketchTestWindow.posted };
}

function say(dom, source, data) {
  const event = new dom.window.Event('message');
  Object.defineProperty(event, 'source', { value: source });
  Object.defineProperty(event, 'data', { value: data });
  dom.window.dispatchEvent(event);
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A drawn sketch block with the Mark up module attached to the real host. */
function drawn(t, options = {}) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="host"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.setTimeout = () => ({});
  dom.window.clearTimeout = () => {};
  delete require.cache[HOST_PATH];
  delete require.cache[MODULE_PATH];
  const host = require(HOST_PATH);
  const markup = require(MODULE_PATH);
  const container = dom.window.document.getElementById('host');
  container.innerHTML = markdownUtils.renderMarkdown('```sketch\n' + SOURCE + '\n```');
  const run = { vision: options.vision || TAKES, inserted: [], pictures: [], toasts: [], failPosts: false, insertResult: true, pictureResult: { ok: true } };
  const deps = {
    insertIntoComposer: (payload) => { run.inserted.push(payload); return run.insertResult; },
    attachPicture: async (picture) => {
      run.pictures.push(picture);
      if (run.pictureResult instanceof Error) throw run.pictureResult;
      return run.pictureResult;
    },
    resolveVision: () => run.vision,
    showToast: (message, toastOptions) => run.toasts.push({ message, options: toastOptions }),
  };
  const view = Object.assign({}, host, { post: (block, message) => (run.failPosts ? false : host.post(block, message)) });
  const detach = markup.attach(view, deps);
  t.after(() => { detach(); host.dispose(); dom.window.close(); });
  host.renderInline(container);
  const block = container.querySelector('.markdown-sketch-block');
  const ctx = { dom, host, markup, container, block, run, detach, document: dom.window.document };
  draw(ctx);
  return ctx;
}

function draw(ctx) {
  const frame = frameOf(ctx.block);
  say(ctx.dom, frame.frameWindow, { type: 'sketch-frame-ready' });
  const request = frame.posted.find((entry) => entry.payload.type === 'render').payload;
  say(ctx.dom, frame.frameWindow, { type: 'rendered', requestId: request.requestId, ok: true, height: 200, width: 400, problems: [], counts: { nodes: 2 } });
  Object.assign(ctx, frame, { request });
}

const markupButton = (ctx) => ctx.block.querySelector('[data-sketch-action="markup"]');
const pictureBox = (ctx) => ctx.block.querySelector('.markdown-sketch-picture input[type="checkbox"]');
const markupPosts = (ctx) => ctx.posted.filter((entry) => entry.payload.type === 'markup').map((entry) => entry.payload);
const answers = (ctx) => ctx.posted.filter((entry) => entry.payload.type === 'ask-result').map((entry) => entry.payload);
const frameAsk = (ctx, extra = {}) => say(ctx.dom, ctx.frameWindow, { type: 'ask', requestId: ctx.request.requestId, askId: 'ask-1', text: 'I marked up the Sketchy drawing "Sign in".\nI circled App.\nwhy here?', pngBase64: PNG_BASE64, ...extra });

test('Mark up sits at order 50 on a drawn block and again after the block is drawn anew', (t) => {
  const ctx = drawn(t);
  const button = markupButton(ctx);
  assert.ok(button, 'the button is there');
  assert.equal(button.getAttribute('data-sketch-order'), '50');
  assert.equal(button.getAttribute('aria-pressed'), 'false');
  assert.match(button.textContent, /Mark up/);
  assert.ok(button.querySelector('svg'), 'with the mark-up icon');
  ctx.host.addAction(ctx.block, ctx.document.createElement('span'), 60);
  ctx.host.addAction(ctx.block, ctx.document.createElement('span'), 10);
  const orders = Array.from(ctx.block.querySelectorAll('.markdown-sketch-actions > [data-sketch-order]')).map((el) => el.getAttribute('data-sketch-order'));
  assert.deepEqual(orders, ['10', '50', '60']);
  ctx.host.resetBlock(ctx.block);
  assert.equal(markupButton(ctx), null, 'nothing is left on a block that was reset');
  ctx.host.renderBlock(ctx.block);
  draw(ctx);
  assert.equal(ctx.block.querySelectorAll('[data-sketch-action="markup"]').length, 1);
  assert.equal(markupButton(ctx).getAttribute('data-sketch-order'), '50');
  assert.equal(markupButton(ctx).getAttribute('aria-pressed'), 'false');
});

test('pressing Mark up posts markup on with the picture flag, pressing it again posts off', (t) => {
  const ctx = drawn(t);
  markupButton(ctx).click();
  assert.deepEqual(markupPosts(ctx), [{ type: 'markup', on: true, picture: true, requestId: ctx.request.requestId }]);
  assert.equal(markupButton(ctx).getAttribute('aria-pressed'), 'true');
  markupButton(ctx).click();
  assert.equal(markupPosts(ctx).at(-1).on, false);
  assert.equal(markupPosts(ctx).at(-1).picture, false);
  assert.equal(markupButton(ctx).getAttribute('aria-pressed'), 'false');
});

test('when the post is refused the button does not change', (t) => {
  const ctx = drawn(t);
  ctx.run.failPosts = true;
  markupButton(ctx).click();
  assert.equal(markupButton(ctx).getAttribute('aria-pressed'), 'false');
  assert.equal(pictureBox(ctx), null);
  ctx.run.failPosts = false;
  markupButton(ctx).click();
  assert.equal(markupButton(ctx).getAttribute('aria-pressed'), 'true');
  ctx.run.failPosts = true;
  markupButton(ctx).click();
  assert.equal(markupButton(ctx).getAttribute('aria-pressed'), 'true', 'still on when turning it off was refused');
  assert.ok(pictureBox(ctx), 'and its picture option stays');
});

test('the frame turning drawing mode off or on itself is followed without a post', (t) => {
  const ctx = drawn(t);
  markupButton(ctx).click();
  const before = markupPosts(ctx).length;
  say(ctx.dom, ctx.frameWindow, { type: 'markup', requestId: ctx.request.requestId, on: false });
  assert.equal(markupButton(ctx).getAttribute('aria-pressed'), 'false');
  assert.equal(pictureBox(ctx), null);
  assert.equal(markupPosts(ctx).length, before, 'turning off inside the frame is never answered with a post');
  say(ctx.dom, ctx.frameWindow, { type: 'markup', requestId: ctx.request.requestId, on: true });
  assert.equal(markupButton(ctx).getAttribute('aria-pressed'), 'true');
  assert.ok(pictureBox(ctx));
  assert.deepEqual(markupPosts(ctx).slice(before), [{ type: 'markup', on: true, picture: true, requestId: ctx.request.requestId }],
    'turning on inside the frame (the viewer own Draw button) only sends the picture flag, so it matches the option');
});

test('the picture option appears only while Mark up is on', (t) => {
  const ctx = drawn(t);
  assert.equal(pictureBox(ctx), null);
  markupButton(ctx).click();
  assert.ok(pictureBox(ctx));
  assert.match(ctx.block.querySelector('.markdown-sketch-picture').textContent, /Attach the picture/);
  markupButton(ctx).click();
  assert.equal(pictureBox(ctx), null);
});

test('the picture option is on for a model that takes pictures and for one not known yet', (t) => {
  for (const vision of [TAKES, UNKNOWN]) {
    const ctx = drawn(t, { vision });
    markupButton(ctx).click();
    assert.equal(pictureBox(ctx).checked, true, `supported ${vision.supported}`);
    assert.equal(pictureBox(ctx).disabled, false);
    assert.equal(markupPosts(ctx).at(-1).picture, true);
    assert.equal(pictureBox(ctx).hasAttribute('aria-describedby'), false);
  }
});

test('the picture option is off and disabled with its reason, naming the model, for a model without pictures', (t) => {
  const ctx = drawn(t, { vision: BLIND });
  markupButton(ctx).click();
  const box = pictureBox(ctx);
  assert.ok(box, 'never hidden');
  assert.equal(box.checked, false);
  assert.equal(box.disabled, true);
  const reason = 'Text Model does not take pictures, so only the words are sent.';
  assert.equal(box.closest('.markdown-sketch-picture').getAttribute('title'), reason);
  assert.equal(box.getAttribute('title'), reason);
  const described = ctx.document.getElementById(box.getAttribute('aria-describedby'));
  assert.equal(described.textContent, reason);
  assert.equal(markupPosts(ctx).at(-1).picture, false);
});

test('changing the picture option posts markup again with the new flag', (t) => {
  const ctx = drawn(t);
  markupButton(ctx).click();
  pictureBox(ctx).click();
  assert.equal(pictureBox(ctx).checked, false);
  assert.deepEqual(markupPosts(ctx).at(-1), { type: 'markup', on: true, picture: false, requestId: ctx.request.requestId });
  pictureBox(ctx).click();
  assert.equal(markupPosts(ctx).at(-1).picture, true);
  ctx.run.failPosts = true;
  pictureBox(ctx).click();
  assert.equal(pictureBox(ctx).checked, true, 'a refused post leaves the option as it was');
});

test('a question with a picture, for a model that takes pictures: the words go in, the picture is attached, the frame is answered', async (t) => {
  const ctx = drawn(t);
  markupButton(ctx).click();
  frameAsk(ctx);
  assert.deepEqual(ctx.run.inserted, [{ text: 'I marked up the drawing "Sign in".\nI circled App.\nwhy here?' }]);
  assert.deepEqual(answers(ctx), [{ type: 'ask-result', askId: 'ask-1', ok: true, requestId: ctx.request.requestId }], 'answered in the same turn');
  await settle();
  assert.equal(ctx.run.pictures.length, 1);
  assert.equal(ctx.run.pictures[0].displayName, 'marked-up-drawing.png');
  assert.equal(ctx.run.pictures[0].mimeType, 'image/png');
  assert.deepEqual(Array.from(ctx.run.pictures[0].bytes), PNG_BYTES);
  assert.deepEqual(ctx.run.toasts, []);
  say(ctx.dom, ctx.frameWindow, { type: 'markup', requestId: ctx.request.requestId, on: false });
  assert.equal(markupButton(ctx).getAttribute('aria-pressed'), 'false', 'the button follows the frame leaving drawing mode');
});

test('only the leading phrase of the viewer\'s first line is reworded', (t) => {
  const ctx = drawn(t);
  frameAsk(ctx, { text: 'I marked up the Sketchy drawing.\nSketchy drawing again: I marked up the Sketchy drawing', pngBase64: '' });
  assert.equal(ctx.run.inserted[0].text, 'I marked up the drawing.\nSketchy drawing again: I marked up the Sketchy drawing');
  frameAsk(ctx, { askId: 'ask-2', text: 'Look at what I marked and explain it.', pngBase64: '' });
  assert.equal(ctx.run.inserted[1].text, 'Look at what I marked and explain it.');
});

test('a question for a model without pictures: the words go in and no picture is attached', async (t) => {
  const ctx = drawn(t, { vision: BLIND });
  markupButton(ctx).click();
  frameAsk(ctx);
  await settle();
  assert.equal(ctx.run.inserted.length, 1);
  assert.equal(ctx.run.pictures.length, 0);
  assert.equal(answers(ctx)[0].ok, true);
  assert.deepEqual(ctx.run.toasts, [], 'dropping a picture the person was told would not be sent is not worth a toast');
});

test('a model switched after Mark up was turned on is respected when the question arrives', async (t) => {
  const ctx = drawn(t, { vision: TAKES });
  markupButton(ctx).click();
  assert.equal(pictureBox(ctx).checked, true);
  ctx.run.vision = BLIND;
  frameAsk(ctx);
  await settle();
  assert.equal(ctx.run.inserted.length, 1, 'the question still goes in');
  assert.equal(ctx.run.pictures.length, 0, 'the picture is dropped');
  assert.equal(answers(ctx)[0].ok, true);
  assert.equal(pictureBox(ctx).disabled, true, 'and the option shows why');
  assert.equal(pictureBox(ctx).checked, false);
});

test('Mark up turned on again reads the model again', (t) => {
  const ctx = drawn(t, { vision: BLIND });
  markupButton(ctx).click();
  assert.equal(markupPosts(ctx).at(-1).picture, false);
  markupButton(ctx).click();
  ctx.run.vision = TAKES;
  markupButton(ctx).click();
  assert.equal(markupPosts(ctx).at(-1).picture, true);
  assert.equal(pictureBox(ctx).disabled, false);
});

test('when the composer refuses the picture the words still go in and a toast says why', async (t) => {
  for (const [result, expected] of [
    [{ ok: false, reason: 'too_many' }, /left out.*most pictures/],
    [{ ok: false, reason: 'too_large' }, /left out.*too large/],
    [{ ok: false, reason: 'failed' }, /left out.*could not be attached/],
    [new Error('disk full'), /left out.*could not be attached/],
  ]) {
    const ctx = drawn(t);
    ctx.run.pictureResult = result;
    markupButton(ctx).click();
    frameAsk(ctx);
    await settle();
    assert.equal(ctx.run.inserted.length, 1);
    assert.equal(answers(ctx)[0].ok, true);
    assert.equal(ctx.run.toasts.length, 1);
    assert.match(ctx.run.toasts[0].message, expected);
    assert.equal(ctx.run.toasts[0].options.tone, 'warning');
  }
});

test('with no message box the frame is told no, a toast says to open a chat and nothing is attached', async (t) => {
  const ctx = drawn(t);
  ctx.run.insertResult = false;
  markupButton(ctx).click();
  frameAsk(ctx);
  await settle();
  assert.deepEqual(answers(ctx).map((entry) => entry.ok), [false]);
  assert.deepEqual(ctx.run.toasts.map((entry) => entry.message), ['Open a chat to ask about this drawing.']);
  assert.equal(ctx.run.pictures.length, 0);
});

test('a question for a block that never had Mark up on is still answered', async (t) => {
  const ctx = drawn(t);
  frameAsk(ctx, { askId: 'ask-9' });
  await settle();
  assert.deepEqual(answers(ctx).map((entry) => [entry.askId, entry.ok]), [['ask-9', true]]);
  assert.equal(ctx.run.inserted.length, 1);
  assert.equal(ctx.run.pictures.length, 1);
});

test('hostile text reaches the message box as the same characters and never becomes markup', async (t) => {
  const ctx = drawn(t);
  const hostile = '<img src=x onerror="window.pwned=1"></script><script>window.pwned=1</script>';
  frameAsk(ctx, { text: 'I marked up the Sketchy drawing "' + hostile + '".', pngBase64: '' });
  await settle();
  assert.equal(ctx.run.inserted[0].text, 'I marked up the drawing "' + hostile + '".');
  assert.equal(ctx.document.querySelector('img'), null);
  assert.equal(ctx.dom.window.pwned, undefined);
  assert.equal(ctx.block.querySelector('script'), null);
});

test('the module adds no markup from its own picture: the picture goes to the composer path only', async (t) => {
  const ctx = drawn(t);
  frameAsk(ctx);
  await settle();
  assert.equal(ctx.document.querySelectorAll('img, canvas').length, 0);
  assert.equal(ctx.block.innerHTML.includes(PNG_BASE64), false);
});

test('detach removes the controls and handlers and turns drawing mode off where it was on', async (t) => {
  const ctx = drawn(t);
  markupButton(ctx).click();
  assert.ok(pictureBox(ctx));
  ctx.detach();
  assert.equal(markupButton(ctx), null);
  assert.equal(pictureBox(ctx), null);
  assert.deepEqual(markupPosts(ctx).at(-1), { type: 'markup', on: false, picture: false, requestId: ctx.request.requestId });
  const before = ctx.posted.length;
  frameAsk(ctx);
  say(ctx.dom, ctx.frameWindow, { type: 'markup', requestId: ctx.request.requestId, on: true });
  await settle();
  assert.equal(ctx.run.inserted.length, 0, 'a module that left hears no question');
  assert.equal(ctx.posted.length, before);
  assert.doesNotThrow(() => ctx.detach());
});
