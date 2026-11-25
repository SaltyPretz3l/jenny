'use strict';

// new-test-file: new mockup block module (renderer/features/renderer-mockup-block.js): a `mockup` code block shown live in the HTML artifact frame.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const MODULE = '../renderer/features/renderer-mockup-block';
const PAGE = '<!doctype html><title>Panel</title><button>Start</button>';

const escapeText = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// The markup the markdown module makes for a fence: the code block's wrapper, its header, then the pre.
function fence(source, lang = 'mockup') {
  return `<div class="markdown-code-block inv-codeblock-wrap"><div class="markdown-code-header"><span>${lang}</span><button type="button" class="inv-codeblock-copy">Copy</button></div><pre><code class="language-${lang}">${escapeText(source)}</code></pre></div>`;
}

// A reply, a fake frame factory (no staging, no iframe loading) and the module, fresh for each test.
function setup(t, sources = [PAGE], { wrapper = true } = {}) {
  const dom = new JSDOM(`<!doctype html><body><div id="reply">${sources.map((source) => (wrapper ? fence(source) : `<pre><code class="language-mockup">${escapeText(source)}</code></pre>`)).join('<p>between</p>')}</div></body>`, { url: 'https://jenny.invalid/' });
  const prev = { frames: globalThis.rendererHtmlArtifactFrameUtils, io: globalThis.IntersectionObserver };
  const calls = [];
  globalThis.rendererHtmlArtifactFrameUtils = {
    createHtmlArtifactFrame(host, source, options) {
      const iframe = host.ownerDocument.createElement('iframe');
      host.appendChild(iframe);
      const call = { host, source, options, disposed: false };
      call.handle = { dispose() { call.disposed = true; iframe.remove(); }, requestId: `frame-${calls.length}` };
      calls.push(call);
      return call.handle;
    },
  };
  delete globalThis.IntersectionObserver;
  delete require.cache[require.resolve(MODULE)];
  const mockup = require(MODULE);
  t.after(() => {
    mockup._resetForTests();
    if (prev.frames === undefined) delete globalThis.rendererHtmlArtifactFrameUtils; else globalThis.rendererHtmlArtifactFrameUtils = prev.frames;
    if (prev.io === undefined) delete globalThis.IntersectionObserver; else globalThis.IntersectionObserver = prev.io;
    dom.window.close();
  });
  const doc = dom.window.document;
  const reply = doc.getElementById('reply');
  return { mockup, doc, reply, calls, blocks: () => [...doc.querySelectorAll('.markdown-mockup-block')], dom };
}

test('a mockup fence becomes a block with a frame host and the code hidden', (t) => {
  const s = setup(t);
  assert.equal(s.mockup.render(s.reply, { isStreaming: false }), 1);
  const [block] = s.blocks();
  assert.equal(block.querySelector('.markdown-mockup-label').textContent, 'Mockup');
  const host = block.querySelector('.markdown-mockup-frame');
  assert.ok(host, 'a frame host');
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].host, host);
  assert.equal(s.calls[0].source, PAGE, 'the fence body, as written, is the page');
  assert.equal(s.calls[0].options.sizing, 'content');
  const pre = block.querySelector('pre');
  assert.equal(pre.hidden, true);
  assert.equal(block.querySelector('.markdown-code-block').hidden, true, 'the code block wrapper goes with it');
  assert.equal(pre.querySelector('code').textContent, PAGE, 'the code is kept, so copy and search still work');
  assert.equal(s.doc.querySelector('link[data-jenny-mockup-styles]').getAttribute('href'), 'styles/markdown-mockup.css');
});

test('the toggle shows and hides the code and says so with aria-expanded', (t) => {
  const s = setup(t, [PAGE], { wrapper: false });
  s.mockup.render(s.reply, {});
  const [block] = s.blocks();
  const toggle = block.querySelector('.markdown-mockup-toggle');
  const pre = block.querySelector('pre');
  assert.equal(toggle.textContent, 'Show code');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(pre.id);
  assert.equal(toggle.getAttribute('aria-controls'), pre.id);
  toggle.click();
  assert.equal(pre.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(toggle.textContent, 'Hide code');
  toggle.click();
  assert.equal(pre.hidden, true);
  assert.equal(toggle.textContent, 'Show code');
  assert.equal(s.calls.length, 1, 'toggling the code never touches the frame');
});

test('a streaming message and a reasoning panel are skipped; the finished message is picked up later', (t) => {
  const s = setup(t);
  assert.equal(s.mockup.render(s.reply, { isStreaming: true }), 0);
  assert.equal(s.blocks().length, 0);
  assert.equal(s.calls.length, 0);
  const panel = s.doc.createElement('div');
  panel.className = 'reasoning-row-panel';
  panel.innerHTML = fence(PAGE);
  s.reply.appendChild(panel);
  assert.equal(s.mockup.render(s.reply, { isStreaming: false }), 1, 'only the one outside the panel');
  assert.equal(s.blocks().length, 1);
  assert.equal(panel.querySelector('.markdown-mockup-block'), null);
  const live = s.doc.createElement('div');
  live.className = 'chat-bubble-streaming';
  live.innerHTML = fence('<!doctype html><div>half a pa');
  s.reply.appendChild(live);
  assert.equal(s.mockup.render(s.reply, { isStreaming: false }), 0, 'a bubble still streaming is left alone by a timeline-wide pass');
  live.className = '';
  assert.equal(s.mockup.render(s.reply, { isStreaming: false }), 1, 'and picked up once it settles');
});

test('a second render call does not wrap the block twice', (t) => {
  const s = setup(t);
  s.mockup.render(s.reply, {});
  assert.equal(s.mockup.render(s.reply, {}), 0);
  assert.equal(s.blocks().length, 1);
  assert.equal(s.calls.length, 1);
  assert.equal(s.doc.querySelectorAll('link[data-jenny-mockup-styles]').length, 1);
});

test('a plain html fence and an empty mockup fence are left alone', (t) => {
  const s = setup(t, ['']);
  s.reply.insertAdjacentHTML('beforeend', fence('<p>hi</p>', 'html'));
  assert.equal(s.mockup.render(s.reply, {}), 0);
  assert.equal(s.blocks().length, 0);
  assert.equal(s.calls.length, 0);
});

test('a source over 131072 bytes stays a code block with a note, and no frame is made', (t) => {
  const big = `<p>${'é'.repeat(70000)}</p>`; // over the bound in bytes, under it in characters
  assert.ok(big.length < 131072 && Buffer.byteLength(big) > 131072);
  const s = setup(t, [big]);
  assert.equal(s.mockup.render(s.reply, {}), 0);
  assert.equal(s.blocks().length, 0);
  assert.equal(s.calls.length, 0);
  const code = s.reply.querySelector('.markdown-code-block');
  assert.equal(code.hidden, false);
  assert.equal(code.nextElementSibling.textContent, 'This mockup is too large to show.');
  s.mockup.render(s.reply, {});
  assert.equal(s.reply.querySelectorAll('.markdown-mockup-note').length, 1, 'the note is not added twice');
  const exact = setup(t, ['x'.repeat(131072)]);
  assert.equal(exact.mockup.render(exact.reply, {}), 1, 'exactly the bound is still shown');
});

test('a frame failure disposes it, shows the code and one note, and hides the toggle', (t) => {
  const s = setup(t);
  s.mockup.render(s.reply, {});
  const [block] = s.blocks();
  s.calls[0].options.onFailure({ ok: false, error: 'timed out' });
  assert.equal(s.calls[0].disposed, true);
  assert.equal(block.querySelector('pre').hidden, false);
  assert.equal(block.querySelector('.markdown-code-block').hidden, false);
  assert.equal(block.querySelector('.markdown-mockup-toggle').hidden, true);
  assert.equal(block.querySelector('.markdown-mockup-frame').hidden, true);
  assert.equal(block.querySelector('.markdown-mockup-note').textContent, 'This mockup could not be shown.');
  s.calls[0].options.onFailure({ ok: false });
  assert.equal(block.querySelectorAll('.markdown-mockup-note').length, 1, 'a second report changes nothing');
});

test('a failure reported before the frame call returns still ends in the code and the note', (t) => {
  const s = setup(t);
  globalThis.rendererHtmlArtifactFrameUtils.createHtmlArtifactFrame = (host, source, options) => {
    options.onFailure({ ok: false, error: 'no staging bridge' });
    return { dispose() {}, requestId: '' };
  };
  s.mockup.render(s.reply, {});
  const [block] = s.blocks();
  assert.equal(block.querySelector('pre').hidden, false);
  assert.equal(block.querySelector('.markdown-mockup-note').textContent, 'This mockup could not be shown.');
});

test('the fifth live frame parks the oldest, and its button shows it again', (t) => {
  const s = setup(t, [1, 2, 3, 4, 5].map((n) => `<p>page ${n}</p>`));
  s.mockup.render(s.reply, {});
  const blocks = s.blocks();
  assert.equal(s.calls.length, 5);
  assert.equal(s.calls.filter((call) => !call.disposed).length, 4, 'four stay up');
  assert.equal(s.calls[0].disposed, true, 'positions tell nothing here, so the oldest goes');
  assert.equal(blocks[0].getAttribute('data-mockup-state'), 'parked');
  const again = blocks[0].querySelector('.markdown-mockup-frame button');
  assert.equal(again.textContent, 'Show the mockup');
  again.click();
  assert.equal(s.calls.length, 6, 'a new frame for the same source');
  assert.equal(s.calls[5].source, '<p>page 1</p>');
  assert.equal(blocks[0].getAttribute('data-mockup-state'), 'live');
  assert.equal(blocks[0].querySelector('.markdown-mockup-frame button'), null);
  assert.equal(s.calls.filter((call) => !call.disposed).length, 4, 'still four: another one was parked');
  assert.equal(blocks[1].getAttribute('data-mockup-state'), 'parked');
});

test('the block furthest from the view is the one parked', (t) => {
  const s = setup(t, [1, 2, 3, 4, 5].map((n) => `<p>page ${n}</p>`));
  // Block n sits at tops[n]; the viewport is 800 high, so block 1 (at 4000) is by far the furthest.
  const tops = new Map();
  s.dom.window.HTMLElement.prototype.getBoundingClientRect = function rect() {
    const top = tops.get(this) || 0;
    return { top, bottom: top + 100, height: 100, left: 0, right: 0, width: 0 };
  };
  Object.defineProperty(s.dom.window, 'innerHeight', { value: 800 });
  const heights = [0, 4000, 200, 300, 100];
  // Give each block its position as soon as it is made, before the fifth one is shown.
  const frames = globalThis.rendererHtmlArtifactFrameUtils;
  const create = frames.createHtmlArtifactFrame;
  frames.createHtmlArtifactFrame = (host, source, options) => {
    const block = host.closest('.markdown-mockup-block');
    const all = [...s.doc.querySelectorAll('.markdown-mockup-block')];
    all.forEach((each, index) => tops.set(each, heights[index]));
    assert.ok(block);
    return create(host, source, options);
  };
  s.mockup.render(s.reply, {});
  const parked = s.blocks().filter((block) => block.getAttribute('data-mockup-state') === 'parked');
  assert.equal(parked.length, 1);
  assert.equal(parked[0], s.blocks()[1]);
});

test('a block that left the document gives its frame up, and its place in the count', (t) => {
  const s = setup(t, [1, 2, 3, 4].map((n) => `<p>page ${n}</p>`));
  s.mockup.render(s.reply, {});
  assert.equal(s.calls.filter((call) => !call.disposed).length, 4);
  s.blocks()[1].remove();
  s.reply.insertAdjacentHTML('beforeend', fence('<p>page 5</p>'));
  s.mockup.render(s.reply, {});
  assert.equal(s.calls.length, 5);
  assert.equal(s.calls.filter((call) => call.disposed).length, 1, 'only the removed block frame was let go');
  assert.equal(s.calls[1].disposed, true);
  assert.equal(s.blocks().filter((block) => block.getAttribute('data-mockup-state') === 'parked').length, 0, 'nothing else was parked');
});

test('with an IntersectionObserver a block is shown when it comes near the viewport, not before', (t) => {
  const s = setup(t);
  const observers = [];
  globalThis.IntersectionObserver = class {
    constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  };
  s.mockup.render(s.reply, {});
  assert.equal(observers.length, 1);
  assert.equal(observers[0].options.rootMargin, '200px 0px');
  assert.equal(s.calls.length, 0, 'not near yet');
  const [block] = s.blocks();
  assert.ok(observers[0].targets.has(block));
  observers[0].callback([{ target: block, isIntersecting: false }]);
  assert.equal(s.calls.length, 0);
  observers[0].callback([{ target: block, isIntersecting: true }]);
  assert.equal(s.calls.length, 1);
  assert.equal(observers[0].targets.has(block), false, 'watched no more');
});

test('model text never becomes elements of the host page', (t) => {
  const evil = '<img src=x onerror=alert(1)><script>window.top.x=1</script><p>mockup</p>';
  const s = setup(t, [evil]);
  s.mockup.render(s.reply, {});
  assert.equal(s.doc.querySelectorAll('img, script').length, 0);
  assert.equal(s.calls[0].source, evil, 'it goes to the frame factory, whole and as text');
  assert.equal(s.doc.querySelector('pre code').textContent, evil);
  s.calls[0].options.onFailure({ ok: false });
  assert.equal(s.doc.querySelectorAll('img, script').length, 0);
});

test('a block rebuilt from a string by a repaint is taken up again, not stacked in the old chrome', (t) => {
  const s = setup(t);
  s.mockup.render(s.reply, {});
  const markup = s.reply.innerHTML;
  s.reply.innerHTML = markup; // the markup comes back as new elements with the old block around the pre
  assert.equal(s.mockup.render(s.reply, {}), 1);
  assert.equal(s.blocks().length, 1);
  assert.equal(s.reply.querySelectorAll('.markdown-mockup-toggle').length, 1);
  assert.equal(s.calls.length, 2);
});
