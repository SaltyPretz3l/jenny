const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const modulePath = require.resolve('../renderer/features/renderer-pretext-utils.js');

function loadPretextUtils() {
  delete require.cache[modulePath];
  return require(modulePath);
}

function makeComputedStyle(overrides = {}) {
  return {
    fontStyle: 'normal',
    fontVariant: 'normal',
    fontWeight: '400',
    fontSize: '15px',
    fontFamily: 'sans-serif',
    getPropertyValue() {
      return '';
    },
    ...overrides,
  };
}

test('resolveDefaultFontString does not pin the root fallback once a live bubble exists', (t) => {
  const previousDocument = global.document;
  const previousGetComputedStyle = global.getComputedStyle;
  const previousPretextLayout = global.pretextLayout;
  const rootElement = { nodeName: 'HTML' };
  const bubbleElement = { nodeName: 'DIV' };
  let currentBubble = null;

  t.after(() => {
    delete require.cache[modulePath];
    global.document = previousDocument;
    global.getComputedStyle = previousGetComputedStyle;
    global.pretextLayout = previousPretextLayout;
  });

  global.document = {
    documentElement: rootElement,
    querySelector(selector) {
      return selector === '.chat-bubble' ? currentBubble : null;
    },
  };
  global.getComputedStyle = (element) => {
    if (element === bubbleElement) {
      return makeComputedStyle({
        fontStyle: 'italic',
        fontWeight: '500',
        fontSize: '16px',
        fontFamily: 'Bubble Sans',
      });
    }
    if (element === rootElement) {
      return makeComputedStyle({
        fontSize: '14px',
        fontFamily: 'Root Sans',
      });
    }
    return makeComputedStyle();
  };
  global.pretextLayout = null;

  const pretextUtils = loadPretextUtils();

  currentBubble = null;
  assert.equal(
    pretextUtils.resolveDefaultFontString('.chat-bubble'),
    'normal normal 400 14px Root Sans'
  );

  currentBubble = bubbleElement;
  assert.equal(
    pretextUtils.resolveDefaultFontString('.chat-bubble'),
    'italic normal 500 16px Bubble Sans'
  );
});

test('predictHtmlContentHeight strips tags before delegating to pretext', (t) => {
  const previousDocument = global.document;
  const previousGetComputedStyle = global.getComputedStyle;
  const previousPretextLayout = global.pretextLayout;
  let preparedText = null;

  t.after(() => {
    delete require.cache[modulePath];
    global.document = previousDocument;
    global.getComputedStyle = previousGetComputedStyle;
    global.pretextLayout = previousPretextLayout;
  });

  global.pretextLayout = {
    prepare(text, font) {
      preparedText = text;
      return {
        text,
        font,
      };
    },
    layout(_prepared, _maxWidth, lineHeight) {
      return { height: lineHeight };
    },
    clearCache() {},
  };

  const pretextUtils = loadPretextUtils();
  const prediction = pretextUtils.predictHtmlContentHeight(
    'article:test',
    '<p><strong>Hello</strong> &amp; goodbye</p>',
    'normal normal 400 15px sans-serif',
    320,
    24
  );

  assert.equal(preparedText, 'Hello & goodbye');
  assert.deepEqual(prediction, { height: 24 });
});

test('predictHtmlContentHeight excludes collapsed tool bodies but retains expanded and always-visible content', (t) => {
  const previousDocument = global.document;
  const previousPretextLayout = global.pretextLayout;
  const dom = new JSDOM('<!doctype html>');
  let preparedText = null;

  t.after(() => {
    delete require.cache[modulePath];
    global.document = previousDocument;
    global.pretextLayout = previousPretextLayout;
    dom.window.close();
  });

  global.document = dom.window.document;
  global.pretextLayout = {
    prepare(text, font) {
      preparedText = text;
      return { text, font };
    },
    layout(_prepared, _maxWidth, lineHeight) {
      return { height: lineHeight };
    },
    clearCache() {},
  };

  const pretextUtils = loadPretextUtils();
  const prediction = pretextUtils.predictHtmlContentHeight(
    'turn:visibility-aware',
    [
      '<p>Always visible &amp; safe</p>',
      '<div class="tool-call-row" data-expanded="false">',
      '<span>Collapsed header</span>',
      '<div class="tool-call-row-body">COLLAPSED_SECRET_PAYLOAD</div>',
      '</div>',
      '<div class="tool-call-row" data-expanded="true">',
      '<span>Expanded header</span>',
      '<div class="tool-call-row-body">EXPANDED_VISIBLE_PAYLOAD</div>',
      '</div>',
    ].join(''),
    'normal normal 400 15px sans-serif',
    320,
    24,
    {
      excludeSelector: '.tool-call-row[data-expanded="false"] .tool-call-row-body, .reasoning-row-panel:not(.expanded) .reasoning-row-panel-body',
    }
  );

  assert.deepEqual(prediction, { height: 24 });
  assert.equal(
    preparedText,
    'Always visible & safe Collapsed header Expanded header EXPANDED_VISIBLE_PAYLOAD'
  );
  assert.doesNotMatch(preparedText, /COLLAPSED_SECRET_PAYLOAD/);
});

test('predictHtmlContentHeight excludes collapsed reasoning bodies but retains expanded reasoning', (t) => {
  const previousDocument = global.document;
  const previousPretextLayout = global.pretextLayout;
  const dom = new JSDOM('<!doctype html>');
  let preparedText = null;

  t.after(() => {
    delete require.cache[modulePath];
    global.document = previousDocument;
    global.pretextLayout = previousPretextLayout;
    dom.window.close();
  });

  global.document = dom.window.document;
  global.pretextLayout = {
    prepare(text, font) {
      preparedText = text;
      return { text, font };
    },
    layout(_prepared, _maxWidth, lineHeight) {
      return { height: lineHeight };
    },
    clearCache() {},
  };

  const pretextUtils = loadPretextUtils();
  const prediction = pretextUtils.predictHtmlContentHeight(
    'turn:reasoning-visibility-aware',
    [
      '<div class="reasoning-row-panel"><span>Collapsed reasoning</span>',
      '<div class="reasoning-row-panel-body chat-bubble-markdown">COLLAPSED_REASONING_PAYLOAD</div></div>',
      '<div class="reasoning-row-panel expanded"><span>Expanded reasoning</span>',
      '<div class="reasoning-row-panel-body chat-bubble-markdown">EXPANDED_REASONING_PAYLOAD</div></div>',
    ].join(''),
    'normal normal 400 15px sans-serif',
    320,
    24,
    {
      excludeSelector: '.tool-call-row[data-expanded="false"] .tool-call-row-body, .reasoning-row-panel:not(.expanded) .reasoning-row-panel-body',
    }
  );

  assert.deepEqual(prediction, { height: 24 });
  assert.equal(
    preparedText,
    'Collapsed reasoning Expanded reasoning EXPANDED_REASONING_PAYLOAD'
  );
  assert.doesNotMatch(preparedText, /COLLAPSED_REASONING_PAYLOAD/);
});

test('predictHtmlContentHeight exclusion fails soft when detached DOM parsing is unavailable', (t) => {
  const previousDocument = global.document;
  const previousPretextLayout = global.pretextLayout;
  let preparedText = null;

  t.after(() => {
    delete require.cache[modulePath];
    global.document = previousDocument;
    global.pretextLayout = previousPretextLayout;
  });

  global.document = undefined;
  global.pretextLayout = {
    prepare(text, font) {
      preparedText = text;
      return { text, font };
    },
    layout(_prepared, _maxWidth, lineHeight) {
      return { height: lineHeight };
    },
    clearCache() {},
  };

  const pretextUtils = loadPretextUtils();
  const prediction = pretextUtils.predictHtmlContentHeight(
    'turn:no-dom-fallback',
    '<div class="tool-call-row" data-expanded="false"><span>Header</span><div class="tool-call-row-body">Fallback payload</div></div>',
    'normal normal 400 15px sans-serif',
    320,
    24,
    { excludeSelector: '.tool-call-row[data-expanded="false"] .tool-call-row-body' }
  );

  assert.deepEqual(prediction, { height: 24 });
  assert.equal(preparedText, 'Header Fallback payload');
});
