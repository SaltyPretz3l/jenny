'use strict';

/* `preview_test` evidence (services/tools/builtin/preview-test-evidence.js):
 * per-event outcome lines and the honest "applied X of N" count, the optional
 * `observe` read-back (tool-owned script run against a fake DOM exactly as the
 * browser service wraps it, so selector embedding is tested as behavior), and
 * the in-app Preview parity warning for external scripts/stylesheets/media. */

const vm = require('node:vm');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { buildEvalScript } = require('../services/browser-interaction-utils');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');
const {
  callsOf,
  makeContext,
  makeTool,
  makeWorkspace,
  stubService,
} = require('./helpers/preview-test-tool-fixture');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

describe('preview_test / per-event outcomes', () => {
  test('content lists each event outcome and counts only successful events', async () => {
    const root = makeWorkspace();
    const service = stubService({ typeResult: { status: 'selector_miss' } });
    const result = await makeTool().execute(
      {
        path: 'index.html',
        events: [
          { action: 'click', selector: '#start' },
          { action: 'type', selector: '#name', text: 'jenny' },
        ],
      },
      makeContext(root, service)
    );

    assert.equal(result.isError, false);
    assert.match(result.content, /applied 1 of 2 event\(s\)/);
    assert.ok(result.content.includes(
      'Events: 1. click "#start" → clicked; 2. type "#name" → selector_miss (no element matched the selector).'
    ));
    assert.deepEqual(
      result.metadata.events.map(({ action, status, selector }) => ({ action, status, selector })),
      [
        { action: 'click', status: 'clicked', selector: '#start' },
        { action: 'type', status: 'selector_miss', selector: '#name' },
      ]
    );
  });

  test('every non-success status gets a short plain explanation', async () => {
    const root = makeWorkspace();
    const statuses = {
      selector_hidden: /selector_hidden \(.+\)/,
      selector_timeout: /selector_timeout \(.+\)/,
      selector_not_editable: /selector_not_editable \(.+\)/,
      selector_focus_failed: /selector_focus_failed \(.+\)/,
    };
    for (const [status, pattern] of Object.entries(statuses)) {
      const service = stubService({ clickResult: { status } });
      const result = await makeTool().execute(
        { path: 'index.html', events: [{ action: 'click', selector: '#x' }] },
        makeContext(root, service)
      );
      assert.match(result.content, pattern, status);
      assert.match(result.content, /applied 0 of 1 event\(s\)/);
    }
  });

  test('caller selectors are flattened and bounded to 80 chars in the line and metadata', async () => {
    const root = makeWorkspace();
    const selector = `#a${'b'.repeat(200)}`;
    const service = stubService();
    const result = await makeTool().execute(
      { path: 'index.html', events: [{ action: 'click', selector }] },
      makeContext(root, service)
    );

    assert.equal(result.metadata.events[0].selector.length, 80);
    assert.ok(result.content.includes(`click ${JSON.stringify(selector.slice(0, 80))} → clicked`));
    assert.ok(!result.content.includes(selector));
    assert.equal(callsOf(service, 'click')[0][2].selector, selector, 'the service still gets the full selector');
  });

  test('no events means no Events line and a zero count', async () => {
    const root = makeWorkspace();
    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, stubService()));
    assert.match(result.content, /applied 0 event\(s\)/);
    assert.ok(!result.content.includes('Events:'));
  });
});

const VISIBLE_STYLE = Object.freeze({ display: 'block', visibility: 'visible', opacity: '1' });

function fakeElement({
  tag = 'DIV',
  text = '',
  value,
  style = VISIBLE_STYLE,
  width = 40,
  height = 20,
  connected = true,
} = {}) {
  return {
    tagName: tag,
    innerText: text,
    value,
    style,
    isConnected: connected,
    getBoundingClientRect: () => ({ width, height }),
    getClientRects: () => (width > 0 && height > 0 ? [{ width, height }] : []),
  };
}

// Runs a tool-owned script exactly the way the browser service wraps it, but
// against a fake document, so selector embedding is tested as behavior.
function runPageScript(script, elementsBySelector, sandboxExtras = {}) {
  const sandbox = {
    ...sandboxExtras,
    document: {
      querySelectorAll(selector) {
        if (Object.prototype.hasOwnProperty.call(elementsBySelector, selector)) {
          return elementsBySelector[selector];
        }
        if (/["();\\]|^\s*\[|\[\s*$/.test(selector)) {
          throw new SyntaxError(`'${selector}' is not a valid selector`);
        }
        return [];
      },
    },
    window: { getComputedStyle: (element) => element.style || VISIBLE_STYLE },
  };
  vm.createContext(sandbox);
  return vm.runInContext(buildEvalScript(script), sandbox);
}

function observingHandler(elementsBySelector, sandboxExtras) {
  return async (options, evalCount) => {
    if (evalCount === 1) {
      return { status: 'evaluated', result: { scripts: [], stylesheets: [], media: [] } };
    }
    const value = await runPageScript(options.script, elementsBySelector, sandboxExtras);
    return { status: 'evaluated', result: JSON.parse(JSON.stringify(value)) };
  };
}

describe('preview_test / observe', () => {
  test('reports match count, visibility and bounded text per selector', async () => {
    const root = makeWorkspace();
    const longText = `  line one\n\n   ${'z'.repeat(400)}  `;
    const elements = {
      '#score': [fakeElement({ text: '1' })],
      '#overlay': [fakeElement({ text: 'Game over', style: { display: 'none', visibility: 'visible', opacity: '1' } })],
      '#name': [fakeElement({ tag: 'INPUT', text: 'ignored', value: 'jenny' })],
      '#long': [fakeElement({ text: longText }), fakeElement({ text: 'second' })],
      '#faded': [fakeElement({ text: 'faded', style: { display: 'block', visibility: 'visible', opacity: '0' } })],
      '#zero': [fakeElement({ text: 'zero', width: 0 })],
      '.missing': [],
    };
    const service = stubService({ evalHandler: observingHandler(elements) });
    const result = await makeTool().execute(
      { path: 'index.html', observe: ['#score', '#overlay', '.missing', '#name', '#long', '#faded', '#zero'] },
      makeContext(root, service)
    );

    assert.equal(result.isError, false);
    const lines = result.content.split('\n');
    assert.ok(lines.includes('Observed after events (untrusted page text):'));
    assert.ok(lines.includes('- "#score": 1 match, visible, text "1"'));
    assert.ok(lines.includes('- "#overlay": 1 match, hidden'));
    assert.ok(lines.includes('- ".missing": no match'));
    assert.ok(lines.includes('- "#name": 1 match, visible, text "jenny"'));
    assert.ok(lines.includes('- "#faded": 1 match, hidden'));
    assert.ok(lines.includes('- "#zero": 1 match, hidden'));
    const longLine = lines.find((line) => line.startsWith('- "#long"'));
    assert.match(longLine, /^- "#long": 2 matches, visible, text "line one z+"$/);
    const byName = Object.fromEntries(result.metadata.observations.map((entry) => [entry.selector, entry]));
    assert.deepEqual(
      { ...byName['#score'] },
      { selector: '#score', count: 1, visible: true, text: '1' }
    );
    assert.equal(byName['#overlay'].visible, false);
    assert.equal(byName['.missing'].count, 0);
    assert.equal(byName['#long'].text.length, 160);
    assert.equal(byName['#long'].count, 2);
  });

  test('observation runs after events and the post-event settle, in one eval', async () => {
    const root = makeWorkspace();
    const service = stubService({ evalHandler: observingHandler({ '#score': [fakeElement({ text: '2' })] }) });
    await makeTool().execute(
      {
        path: 'index.html',
        events: [{ action: 'click', selector: '#start' }],
        observe: ['#score', '#timer'],
      },
      makeContext(root, service)
    );

    const order = service.calls.map(([name]) => name);
    const evals = callsOf(service, 'eval');
    assert.equal(evals.length, 2, 'one parity read plus one observe read');
    assert.ok(order.lastIndexOf('eval') > order.indexOf('click'), 'observe reads after the click');
    assert.ok(order.lastIndexOf('eval') < order.indexOf('close'));
  });

  test('selectors reach the page only as JSON data and cannot break out of the script', async () => {
    const root = makeWorkspace();
    const hostile = '"]); alert(1); //';
    const backtick = '`${alert(2)}`';
    const sandboxExtras = { __alerts: 0 };
    sandboxExtras.alert = () => { sandboxExtras.__alerts += 1; };
    const service = stubService({
      evalHandler: observingHandler({ '#ok': [fakeElement({ text: 'fine' })] }, sandboxExtras),
    });
    const result = await makeTool().execute(
      { path: 'index.html', observe: [hostile, backtick, '#ok'] },
      makeContext(root, service)
    );

    const observeScript = callsOf(service, 'eval')[1][2].script;
    assert.ok(observeScript.includes(JSON.stringify([hostile, backtick, '#ok'])), 'selectors are a JSON literal');
    assert.ok(
      !observeScript.split(JSON.stringify([hostile, backtick, '#ok'])).join('').includes('alert('),
      'the selector text appears nowhere outside the JSON literal'
    );
    assert.equal(sandboxExtras.__alerts, 0, 'no selector text was executed');
    assert.equal(result.isError, false);
    const lines = result.content.split('\n');
    assert.ok(lines.includes(`- ${JSON.stringify(hostile)}: invalid selector`));
    assert.ok(lines.includes(`- ${JSON.stringify(backtick)}: invalid selector`));
    assert.ok(lines.includes('- "#ok": 1 match, visible, text "fine"'));
    assert.equal(result.metadata.observations[0].invalid, true);
  });

  test('eval_error and a thrown eval both report the observation as unavailable', async () => {
    const root = makeWorkspace();
    const handlers = [
      async (_options, evalCount) => (evalCount === 1
        ? { status: 'evaluated', result: { scripts: [], stylesheets: [], media: [] } }
        : { status: 'eval_error', reason: `boom at ${root}/index.html` }),
      async (_options, evalCount) => {
        if (evalCount === 1) return { status: 'evaluated', result: { scripts: [], stylesheets: [], media: [] } };
        throw new Error('Browser eval script exceeds 10000 characters.');
      },
    ];
    for (const evalHandler of handlers) {
      const service = stubService({ evalHandler });
      const result = await makeTool().execute(
        { path: 'index.html', observe: ['#score'] },
        makeContext(root, service)
      );
      assert.equal(result.isError, false, 'the test still ran');
      assert.match(result.content, /Observation unavailable: \S/);
      assert.ok(!result.content.includes('Observed after events'));
      assert.ok(result.metadata.observation_error);
      assert.equal(result.metadata.observations, undefined);
      assert.ok(!JSON.stringify(result).includes(root));
      assert.equal(callsOf(service, 'close').length, 1);
    }
  });

  test('no observe input means no observation lines and no second eval', async () => {
    const root = makeWorkspace();
    const service = stubService();
    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));
    assert.ok(!result.content.includes('Observed after events'));
    assert.equal(result.metadata.observations, undefined);
    assert.equal(callsOf(service, 'eval').length, 1);
  });

  test('invalid observe input fails closed before any window opens', async () => {
    const root = makeWorkspace();
    const tooMany = Array.from({ length: 9 }, (_, index) => `#n${index}`);
    // Eight 200-character control-character selectors JSON-escape past the
    // encoded ceiling (and would overflow the service's eval script limit).
    const escapesTooLong = Array.from({ length: 8 }, () => ''.repeat(200));
    for (const bad of ['#score', {}, [], tooMany, [''], ['   '], ['x'.repeat(201)], [42], [null], ['#ok', ''], escapesTooLong]) {
      const service = stubService();
      const result = await makeTool().execute(
        { path: 'index.html', observe: bad },
        makeContext(root, service)
      );
      assert.equal(result.isError, true, `${JSON.stringify(bad)} must be rejected`);
      assert.equal(result.metadata.reason, 'invalid_observe');
      assert.equal(callsOf(service, 'open').length, 0);
    }
    const accepted = await makeTool().execute(
      { path: 'index.html', observe: ['x'.repeat(200), ...tooMany.slice(0, 7)] },
      makeContext(root, stubService({ evalHandler: observingHandler({}) }))
    );
    assert.equal(accepted.isError, false, '8 entries of 200 chars are within bounds');
  });
});

describe('preview_test / in-app preview parity', () => {
  function parityHandler(result, observeResult) {
    return async (_options, evalCount) => (evalCount === 1
      ? result
      : (observeResult || { status: 'evaluated', result: [] }));
  }

  test('warns when the page references external scripts and stylesheets', async () => {
    const root = makeWorkspace();
    const service = stubService({
      evalHandler: parityHandler({
        status: 'evaluated',
        result: { scripts: ['game.js'], stylesheets: ['style.css'], media: [] },
      }),
    });
    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.equal(result.isError, false);
    assert.ok(result.content.includes(
      'In-app preview parity: this page references 1 external script and 1 stylesheet (names are untrusted page text: game.js, style.css).'
    ));
    assert.match(result.content, /preview_test loads contained workspace files \(never the network\), but Jenny's in-app Preview is self-contained and loads no external files at all, so scripts there never run and styles are missing\. Inline them into the HTML if the user will view it in the in-app Preview\./);
    assert.deepEqual(
      { ...result.metadata.external_resources },
      { scripts: ['game.js'], stylesheets: ['style.css'], media: [] }
    );
  });

  test('pluralizes and mentions only the categories present', async () => {
    const root = makeWorkspace();
    const service = stubService({
      evalHandler: parityHandler({
        status: 'evaluated',
        result: { scripts: [], stylesheets: [], media: ['a.png', 'b.mp3'] },
      }),
    });
    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.match(result.content, /In-app preview parity: this page references 2 external media files \(names are untrusted page text: a\.png, b\.mp3\)\./);
    assert.ok(!result.content.includes('scripts there never run'));
    assert.ok(!result.content.includes('styles are missing'));
  });

  test('references are reported as written, redacted, bounded and capped at 10', async () => {
    const root = makeWorkspace();
    const many = Array.from({ length: 14 }, (_, index) => `lib${index}.js`);
    const service = stubService({
      evalHandler: parityHandler({
        status: 'evaluated',
        result: {
          scripts: [`${root}/secret/game.js`, `${'a'.repeat(300)}.js`, ...many],
          stylesheets: [],
          media: [],
        },
      }),
    });
    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.ok(!JSON.stringify(result).includes(root), 'absolute workspace path is redacted');
    assert.match(result.content, /\[(?:workspace path|redacted:path)\]\/game\.js/);
    const scripts = result.metadata.external_resources.scripts;
    assert.equal(scripts.length, 10);
    for (const entry of scripts) assert.ok(entry.length <= 120);
    assert.ok(!result.content.includes('lib13.js'));
  });

  test('a failed collection omits the line and the metadata silently', async () => {
    const root = makeWorkspace();
    for (const evalHandler of [
      async () => ({ status: 'eval_error', reason: 'nope' }),
      async () => { throw new Error('nope'); },
      async () => ({ status: 'evaluated', result: 'garbage' }),
    ]) {
      const service = stubService({ evalHandler });
      const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));
      assert.equal(result.isError, false);
      assert.ok(!result.content.includes('In-app preview parity'));
      assert.equal(result.metadata.external_resources, undefined);
    }
  });

  test('the collection script reads attribute values as written and skips data: and blob: refs', async () => {
    const root = makeWorkspace();
    const attr = (value) => ({ getAttribute: (name) => (name === 'src' || name === 'href' ? value : null) });
    const page = {
      'script[src]': [attr('game.js'), attr('data:text/javascript,1'), attr('https://cdn.test/x.js')],
      'link[rel~="stylesheet" i][href]': [attr('style.css')],
      'img[src], iframe[src], audio[src], video[src], source[src]': [
        attr('blob:abc'), attr('data:image/png;base64,AAAA'), attr('hero.png'),
      ],
    };
    const service = stubService({
      evalHandler: async (options) => {
        const value = await runPageScript(options.script, page);
        return { status: 'evaluated', result: JSON.parse(JSON.stringify(value)) };
      },
    });
    const result = await makeTool().execute({ path: 'index.html' }, makeContext(root, service));

    assert.deepEqual(
      { ...result.metadata.external_resources },
      { scripts: ['game.js', 'https://cdn.test/x.js'], stylesheets: ['style.css'], media: ['hero.png'] }
    );
    assert.match(result.content, /references 2 external scripts, 1 stylesheet and 1 media file \(/);
  });
});
