'use strict';

// Coverage for renderer/chat/renderer-chat-codebase-cite-utils.js
// Pure-ish renderer util: builds a JSDOM per test, no full shell/IDE harness,
// no app.dispose (those are only needed for createHarness()-style tests).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createCodebaseCiteController,
  findCodebaseCitations,
  parseCodebaseCiteHref,
  buildCodebaseCiteHref,
} = require('../renderer/chat/renderer-chat-codebase-cite-utils');
const {
  setOuterHtmlPreservingCodeScroll,
} = require('../renderer/chat/renderer-stream-dom-patch-utils');

// ---------------------------------------------------------------------------
// DOM factory — fresh JSDOM per test
// ---------------------------------------------------------------------------

function buildDom(bodyHtml) {
  const dom = new JSDOM(
    '<!doctype html><html><body>'
      + '<div id="chatView">'
      + '<div id="chatTimeline" role="feed">'
      + (bodyHtml || '')
      + '</div>'
      + '</div>'
      + '</body></html>',
    { url: 'https://jenny.local/chat' }
  );
  return dom;
}

function assistantBubble(innerHtml, status) {
  const st = status || 'complete';
  return '<article class="chat-entry message-shell assistant" data-message-id="m1"'
    + ' data-message-role="assistant" data-message-status="' + st + '">'
    + '<div class="chat-bubble chat-bubble-markdown">' + innerHtml + '</div>'
    + '</article>';
}

function makeController(dom, overrides) {
  const opts = Object.assign({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    getWorkspaceFs() { return null; },
    isEnabled() { return true; },
    appendClientLog() {},
  }, overrides || {});
  return createCodebaseCiteController(opts);
}

// Flush a couple of microtask turns so a settled/rejected openInDefaultApp()
// promise's handler has run.
function flush() {
  return Promise.resolve().then(() => Promise.resolve());
}

// ---------------------------------------------------------------------------
// findCodebaseCitations — pure
// ---------------------------------------------------------------------------

test('findCodebaseCitations matches path:line with POSIX paths', () => {
  const found = findCodebaseCitations('auth is in services/auth/login.js:42 today');
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'services/auth/login.js');
  assert.equal(found[0].line, 42);
  assert.equal(found[0].column, null);
});

test('findCodebaseCitations captures optional :column', () => {
  const found = findCodebaseCitations('see renderer/app.js:120:5');
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'renderer/app.js');
  assert.equal(found[0].line, 120);
  assert.equal(found[0].column, 5);
});

test('findCodebaseCitations finds multiple citations with correct spans', () => {
  const text = 'a.js:1 and dir/b.ts:2';
  const found = findCodebaseCitations(text);
  assert.equal(found.length, 2);
  assert.equal(text.slice(found[0].index, found[0].index + found[0].length), 'a.js:1');
  assert.equal(text.slice(found[1].index, found[1].index + found[1].length), 'dir/b.ts:2');
});

test('findCodebaseCitations ignores bare filenames without a line number', () => {
  assert.deepEqual(findCodebaseCitations('edit your package.json please'), []);
});

test('findCodebaseCitations ignores unknown extensions', () => {
  assert.deepEqual(findCodebaseCitations('grab report.pdf:3'), []);
});

test('findCodebaseCitations rejects parent-escape and absolute paths', () => {
  assert.deepEqual(findCodebaseCitations('../secret.js:1'), []);
  assert.deepEqual(findCodebaseCitations('/etc/app.js:1'), []);
});

test('findCodebaseCitations does not match inside an http(s) URL', () => {
  assert.deepEqual(findCodebaseCitations('open https://cdn.example.com/app.js:80 now'), []);
});

// ---------------------------------------------------------------------------
// parse / build href — pure
// ---------------------------------------------------------------------------

test('buildCodebaseCiteHref + parseCodebaseCiteHref round-trip', () => {
  const href = buildCodebaseCiteHref('services/auth/login.js', 42);
  assert.equal(href, '#codebase:services/auth/login.js:42');
  assert.deepEqual(parseCodebaseCiteHref(href), {
    path: 'services/auth/login.js', line: 42, column: null,
  });
});

test('parseCodebaseCiteHref handles a column and rejects non-codebase hrefs', () => {
  assert.deepEqual(parseCodebaseCiteHref('#codebase:a/b.ts:9:3'), {
    path: 'a/b.ts', line: 9, column: 3,
  });
  assert.equal(parseCodebaseCiteHref('#message:m1'), null);
  assert.equal(parseCodebaseCiteHref('#codebase:a/b.ts'), null);
  assert.equal(parseCodebaseCiteHref('#codebase:../b.ts:1'), null);
  assert.equal(parseCodebaseCiteHref(''), null);
});

// ---------------------------------------------------------------------------
// enhanceBubble — DOM linkification
// ---------------------------------------------------------------------------

test('enhanceBubble wraps a citation in a clickable anchor', () => {
  const dom = buildDom(assistantBubble('Auth lives in services/auth/login.js:42 for now.'));
  const controller = makeController(dom);
  const bubble = dom.window.document.querySelector('.chat-bubble-markdown');
  assert.equal(controller.enhanceBubble(bubble), true);

  const anchor = bubble.querySelector('a.codebase-cite-link');
  assert.ok(anchor, 'expected a cite anchor');
  assert.equal(anchor.getAttribute('href'), '#codebase:services/auth/login.js:42');
  assert.equal(anchor.textContent, 'services/auth/login.js:42');
  // Surrounding prose is preserved.
  assert.ok(bubble.textContent.includes('Auth lives in services/auth/login.js:42 for now.'));
  // Bubble is stamped to prevent reprocessing.
  assert.equal(bubble.getAttribute('data-codebase-cite-enhanced'), '1');
});

test('enhanceBubble skips citations inside <pre> code blocks', () => {
  const dom = buildDom(assistantBubble('<pre><code>const p = "a/b.js:1";</code></pre>'));
  const controller = makeController(dom);
  const bubble = dom.window.document.querySelector('.chat-bubble-markdown');
  controller.enhanceBubble(bubble);
  assert.equal(bubble.querySelector('a.codebase-cite-link'), null);
});

test('enhanceBubble is idempotent (skips already-stamped bubbles)', () => {
  const dom = buildDom(assistantBubble('x a/b.js:1 y'));
  const controller = makeController(dom);
  const bubble = dom.window.document.querySelector('.chat-bubble-markdown');
  controller.enhanceBubble(bubble);
  const firstCount = bubble.querySelectorAll('a.codebase-cite-link').length;
  controller.enhanceBubble(bubble);
  assert.equal(bubble.querySelectorAll('a.codebase-cite-link').length, firstCount);
});

test('enhanceAll skips streaming articles and respects the enable gate', () => {
  const streamingDom = buildDom(assistantBubble('a/b.js:1', 'streaming'));
  const streamingController = makeController(streamingDom);
  assert.equal(streamingController.enhanceAll(), 0);
  assert.equal(streamingDom.window.document.querySelector('a.codebase-cite-link'), null);

  const disabledDom = buildDom(assistantBubble('a/b.js:1'));
  const disabledController = makeController(disabledDom, { isEnabled() { return false; } });
  assert.equal(disabledController.enhanceAll(), 0);
  assert.equal(disabledDom.window.document.querySelector('a.codebase-cite-link'), null);
});

test('R2 mutation enhancement scans only the changed article after initial attach', async (t) => {
  const dom = buildDom(assistantBubble('settled without a citation'));
  const controller = makeController(dom);
  t.after(() => controller.dispose());
  controller.attach();
  const timeline = dom.window.document.getElementById('chatTimeline');
  const originalQuerySelectorAll = timeline.querySelectorAll.bind(timeline);
  timeline.querySelectorAll = function rejectWholeTimelineRescan() {
    throw new Error('unexpected whole-timeline scan');
  };

  const host = dom.window.document.createElement('div');
  host.innerHTML = assistantBubble('new citation renderer/chat/app.js:77');
  timeline.appendChild(host.firstElementChild);
  await new Promise((resolve) => dom.window.setTimeout(resolve, 20));

  timeline.querySelectorAll = originalQuerySelectorAll;
  assert.ok(timeline.querySelector('a.codebase-cite-link'));
});

test('an in-place terminal article morph linkifies a citation skipped while streaming', async (t) => {
  const dom = buildDom(assistantBubble('See renderer/app.js:42', 'streaming'));
  const controller = makeController(dom);
  t.after(() => controller.dispose());
  controller.attach();
  const article = dom.window.document.querySelector('.chat-entry');

  const result = setOuterHtmlPreservingCodeScroll(
    article,
    assistantBubble('See renderer/app.js:42', 'complete')
  );
  await new Promise((resolve) => dom.window.setTimeout(resolve, 30));

  assert.equal(result.outcome, 'morph_applied');
  assert.equal(article.dataset.messageStatus, 'complete');
  assert.equal(article.querySelectorAll('a.codebase-cite-link').length, 1);
});

// ---------------------------------------------------------------------------
// click handling — dispatch + fallback
// ---------------------------------------------------------------------------

test('clicking a cite link dispatches ide:open-file-at-line and falls back to openInDefaultApp', () => {
  const dom = buildDom(assistantBubble('go to services/auth/login.js:42 here'));
  const opens = [];
  const events = [];
  dom.window.addEventListener('ide:open-file-at-line', (e) => { events.push(e.detail); });
  const controller = makeController(dom, {
    getWorkspaceFs() {
      return { openInDefaultApp(arg) { opens.push(arg); return Promise.resolve({ opened: true }); } };
    },
  });
  controller.attach();

  const anchor = dom.window.document.querySelector('a.codebase-cite-link');
  assert.ok(anchor, 'expected the link to be enhanced on attach()');
  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  anchor.dispatchEvent(event);

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(events, [{ path: 'services/auth/login.js', line: 42, column: null }]);
  // No listener claimed the event (none called preventDefault) -> OS fallback.
  assert.deepEqual(opens, [{ path: 'services/auth/login.js' }]);
});

test('a claiming listener (preventDefault) suppresses the openInDefaultApp fallback', () => {
  const dom = buildDom(assistantBubble('go to a/b.js:7 here'));
  const opens = [];
  dom.window.addEventListener('ide:open-file-at-line', (e) => { e.preventDefault(); });
  const controller = makeController(dom, {
    getWorkspaceFs() {
      return { openInDefaultApp(arg) { opens.push(arg); return Promise.resolve({}); } };
    },
  });
  controller.attach();

  const anchor = dom.window.document.querySelector('a.codebase-cite-link');
  anchor.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(opens, []);
});

test('ordinary external links are not intercepted', () => {
  const dom = buildDom(assistantBubble('<a id="plain" href="https://example.com">external</a>'));
  const controller = makeController(dom);
  controller.attach();
  const anchor = dom.window.document.getElementById('plain');
  const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  anchor.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
});

// --- regressions from the adversarial review -------------------------------

test('hyphenated paths linkify (path alphabet allows - and _)', () => {
  // Regression: an earlier path-safety check wrongly rejected hyphens.
  const text = 'see renderer-chat-codebase-cite-utils.js:5 and a/my_mod-2.ts:9';
  const found = findCodebaseCitations(text);
  assert.equal(found.length, 2);
  assert.equal(found[0].path, 'renderer-chat-codebase-cite-utils.js');
  assert.equal(found[0].line, 5);
  assert.equal(found[1].path, 'a/my_mod-2.ts');
  assert.equal(found[1].line, 9);
  // Spans are internally consistent (slice round-trips to the matched text).
  assert.equal(text.slice(found[0].index, found[0].index + found[0].length), 'renderer-chat-codebase-cite-utils.js:5');
  const dom = buildDom(assistantBubble('edit renderer-chat-codebase-cite-utils.js:5 now'));
  const controller = makeController(dom);
  const bubble = dom.window.document.querySelector('.chat-bubble-markdown');
  controller.enhanceBubble(bubble);
  assert.equal(
    bubble.querySelector('a.codebase-cite-link').getAttribute('href'),
    '#codebase:renderer-chat-codebase-cite-utils.js:5'
  );
});

test('enhanceTextNode splices multiple citations preserving surrounding prose', () => {
  const dom = buildDom(assistantBubble('before a/one.js:1 middle dir/two.ts:2 after'));
  const controller = makeController(dom);
  const bubble = dom.window.document.querySelector('.chat-bubble-markdown');
  controller.enhanceBubble(bubble);
  const anchors = bubble.querySelectorAll('a.codebase-cite-link');
  assert.equal(anchors.length, 2);
  assert.equal(anchors[0].textContent, 'a/one.js:1');
  assert.equal(anchors[1].textContent, 'dir/two.ts:2');
  // Full visible text (prose + links) is intact and in order.
  assert.equal(bubble.textContent, 'before a/one.js:1 middle dir/two.ts:2 after');
});

test('parseCodebaseCiteHref rejects whitespace in the path (find/parse alphabet parity)', () => {
  assert.equal(parseCodebaseCiteHref('#codebase:a b.js:1'), null);
});

test('double-open guard: a listener that omits preventDefault still hits the OS fallback', () => {
  // Locks the contract that the in-editor listener MUST preventDefault to claim
  // the navigation; otherwise the OS fallback fires (the documented hazard).
  const dom = buildDom(assistantBubble('go to a/b.js:7 here'));
  const opens = [];
  dom.window.addEventListener('ide:open-file-at-line', () => { /* no preventDefault */ });
  const controller = makeController(dom, {
    getWorkspaceFs() {
      return { openInDefaultApp(arg) { opens.push(arg); return Promise.resolve({}); } };
    },
  });
  controller.attach();
  dom.window.document
    .querySelector('a.codebase-cite-link')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(opens, [{ path: 'a/b.js' }]);
});

test('a structured NOT_FOUND open error marks the link with a specific cue', async () => {
  const dom = buildDom(assistantBubble('see ghost/missing.js:9 here'));
  const notices = [];
  const controller = makeController(dom, {
    notifyError(message) { notices.push(message); },
    getWorkspaceFs() {
      return {
        openInDefaultApp() {
          // Mirrors a WorkspaceFsError: human-prose message + structured code.
          return Promise.reject(Object.assign(
            new Error('File or folder not found in the workspace.'),
            { error_code: 'CMP-WORKSPACEFS-0004' }
          ));
        },
      };
    },
  });
  controller.attach();
  const anchor = dom.window.document.querySelector('a.codebase-cite-link');
  anchor.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();
  assert.equal(anchor.getAttribute('data-codebase-cite-error'), '1');
  assert.match(anchor.getAttribute('title'), /not found/i);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /missing\.js/);
});

test('a code-less open error still marks the link with a generic cue', async () => {
  // The realistic case if the structured code does not survive the IPC
  // boundary: the cue degrades to the generic line but is still shown.
  const dom = buildDom(assistantBubble('see ghost/missing.js:9 here'));
  const controller = makeController(dom, {
    getWorkspaceFs() {
      return { openInDefaultApp() { return Promise.reject(new Error('Error invoking remote method')); } };
    },
  });
  controller.attach();
  const anchor = dom.window.document.querySelector('a.codebase-cite-link');
  anchor.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();
  assert.equal(anchor.getAttribute('data-codebase-cite-error'), '1');
  assert.equal(anchor.getAttribute('title'), 'Couldn’t open ghost/missing.js.');
});

test('no workspace bridge marks the link unavailable synchronously', () => {
  const dom = buildDom(assistantBubble('see a/b.js:3 here'));
  const notices = [];
  const controller = makeController(dom, {
    notifyError(message) { notices.push(message); },
    getWorkspaceFs() { return null; },
  });
  controller.attach();
  const anchor = dom.window.document.querySelector('a.codebase-cite-link');
  anchor.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(anchor.getAttribute('data-codebase-cite-error'), '1');
  assert.equal(notices.length, 1);
});

test('a successful retry clears a prior error stamp', async () => {
  const dom = buildDom(assistantBubble('see a/b.js:3 here'));
  let failNext = true;
  const controller = makeController(dom, {
    getWorkspaceFs() {
      return {
        openInDefaultApp() {
          if (failNext) { failNext = false; return Promise.reject(new Error('NOT_FOUND')); }
          return Promise.resolve({ opened: true });
        },
      };
    },
  });
  controller.attach();
  const anchor = dom.window.document.querySelector('a.codebase-cite-link');
  anchor.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await flush();
  assert.equal(anchor.getAttribute('data-codebase-cite-error'), '1');
  // Second click: the stamp is cleared synchronously at the top of the handler,
  // and the now-successful open does not re-mark it.
  anchor.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(anchor.getAttribute('data-codebase-cite-error'), null);
});

test('dispose() removes the click listener and stops enhancing', () => {
  const dom = buildDom(assistantBubble('a/b.js:1'));
  const opens = [];
  const controller = makeController(dom, {
    getWorkspaceFs() {
      return { openInDefaultApp(arg) { opens.push(arg); return Promise.resolve({}); } };
    },
  });
  const detach = controller.attach();
  const anchor = dom.window.document.querySelector('a.codebase-cite-link');
  assert.ok(anchor, 'enhanced on attach');
  detach();
  // After dispose the delegated click handler no longer routes citations.
  anchor.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.deepEqual(opens, []);
});
