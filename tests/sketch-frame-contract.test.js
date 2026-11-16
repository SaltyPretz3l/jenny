'use strict';

// new-test-file: the sandboxed sketch frame is a new surface: its scheme handler in the main process,
// the frame page, and the frame's own script (plan section 5.2, slice S3).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const {
  SKETCH_FRAME_CSP,
  SKETCH_FRAME_FILES,
  SKETCH_FRAME_SCHEME,
  SKETCH_FRAME_URL,
  createSketchFrameProtocol,
  registerFramePrivilegedSchemes,
} = require('../services/sketch-frame-protocol');
const { ARTIFACT_FRAME_SCHEME } = require('../services/artifact-frame-protocol');
const { buildSketchBundles, sketchBuildPlan, REPO_ROOT } = require('../scripts/build/build-sketch');

const ROOT = path.resolve(__dirname, '..');
const INIT_SOURCE = fs.readFileSync(path.join(ROOT, 'renderer/frames/sketch-frame-init.js'), 'utf8');
const FRAME_HTML = fs.readFileSync(path.join(ROOT, 'sketch-frame.html'), 'utf8');

/* ── The scheme handler ── */

function makeProtocol(files) {
  const reads = [];
  const logs = [];
  const protocol = createSketchFrameProtocol({
    appRoot: path.join('X:', 'app'),
    log: (level, event, details) => logs.push({ level, event, details }),
    readFile: async (filePath) => {
      reads.push(filePath);
      const name = path.relative(path.join('X:', 'app'), filePath).split(path.sep).join('/');
      if (!files.has(name)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return Buffer.from(files.get(name));
    },
  });
  return { protocol, reads, logs };
}

const THREE_FILES = () => new Map([
  ['sketch-frame.html', '<html></html>'],
  ['sketch-frame.bundle.js', 'var jennySketch = {};'],
  ['renderer/frames/sketch-frame-init.js', '(function () {})();'],
]);

test('the handler serves exactly the three frame files, each with the frame CSP', async () => {
  const { protocol, reads } = makeProtocol(THREE_FILES());
  const expected = [
    ['sketch-frame.html', 'text/html; charset=utf-8', '<html></html>'],
    ['sketch-frame.bundle.js', 'text/javascript; charset=utf-8', 'var jennySketch = {};'],
    ['sketch-frame-init.js', 'text/javascript; charset=utf-8', '(function () {})();'],
  ];
  for (const [name, type, body] of expected) {
    const response = await protocol.handleRequest({ url: `jenny-sketch://frame/${name}`, method: 'GET' });
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get('content-type'), type);
    assert.equal(response.headers.get('content-security-policy'), SKETCH_FRAME_CSP);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await response.text(), body);
  }
  assert.equal(SKETCH_FRAME_FILES.size, 3);
  assert.equal(SKETCH_FRAME_URL, 'jenny-sketch://frame/sketch-frame.html');
  // Each file is read once and kept: a second drawing does not go back to disk.
  await protocol.handleRequest({ url: SKETCH_FRAME_URL, method: 'GET' });
  assert.equal(reads.length, 3);
});

test('the handler refuses every other request and never forms a path from one', async () => {
  const { protocol, reads } = makeProtocol(THREE_FILES());
  const refused = [
    'jenny-sketch://frame/',
    'jenny-sketch://frame/main.js',
    'jenny-sketch://frame/../main.js',
    'jenny-sketch://frame/%2e%2e/main.js',
    'jenny-sketch://frame/..%5cmain.js',
    'jenny-sketch://frame/renderer/frames/sketch-frame-init.js',
    'jenny-sketch://frame/sketch-frame.html/extra',
    'jenny-sketch://frame/SKETCH-FRAME.HTML',
    'jenny-sketch://frame/__proto__',
    'jenny-sketch://frame/constructor',
    'jenny-sketch://frame/sketch-frame.html?file=main.js',
    'jenny-sketch://other/sketch-frame.html',
    'jenny-artifact://frame/sketch-frame.html',
    'file:///sketch-frame.html',
    'not a url',
    '',
  ];
  for (const url of refused) {
    const response = await protocol.handleRequest({ url, method: 'GET' });
    assert.equal(response.status, 404, url);
    assert.equal(await response.text(), '');
  }
  assert.equal((await protocol.handleRequest({ url: SKETCH_FRAME_URL, method: 'POST' })).status, 404);
  assert.equal((await protocol.handleRequest(null)).status, 404);
  assert.deepEqual(reads, [], 'a refused request reads nothing');
});

test('a file missing on disk is a 404 and is tried again on the next request', async () => {
  const files = THREE_FILES();
  files.delete('sketch-frame.bundle.js');
  const { protocol, logs } = makeProtocol(files);
  const url = 'jenny-sketch://frame/sketch-frame.bundle.js';
  assert.equal((await protocol.handleRequest({ url, method: 'GET' })).status, 404);
  assert.equal(logs.at(-1).event, 'sketch_frame.file_unreadable');
  files.set('sketch-frame.bundle.js', 'built');
  const response = await protocol.handleRequest({ url, method: 'GET' });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'built');
});

test('both frame schemes are registered in one call, standard and secure only', () => {
  const calls = [];
  assert.equal(registerFramePrivilegedSchemes({ registerSchemesAsPrivileged: (list) => calls.push(list) }), true);
  assert.equal(calls.length, 1, 'Electron keeps only the last call');
  assert.deepEqual(calls[0].map((entry) => entry.scheme), [ARTIFACT_FRAME_SCHEME, SKETCH_FRAME_SCHEME]);
  for (const entry of calls[0]) assert.deepEqual(entry.privileges, { standard: true, secure: true });
  assert.equal(registerFramePrivilegedSchemes(null), false);
  const handled = [];
  createSketchFrameProtocol().install({ sessionRef: { protocol: { handle: (scheme, handler) => handled.push([scheme, typeof handler]) } } });
  assert.deepEqual(handled, [['jenny-sketch', 'function']]);
});

/* ── The page and what ships ── */

test('sketch-frame.html carries the handler CSP and loads only its two scripts', () => {
  const dom = new JSDOM(FRAME_HTML);
  const { document } = dom.window;
  assert.equal(document.querySelector('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), SKETCH_FRAME_CSP);
  const scripts = Array.from(document.querySelectorAll('script'));
  assert.deepEqual(scripts.map((script) => script.getAttribute('src')), ['sketch-frame.bundle.js', 'sketch-frame-init.js']);
  assert.ok(scripts.every((script) => !script.textContent.trim()), 'no inline script: the CSP would refuse it');
  assert.ok(document.getElementById('sketch-root'));
  for (const part of ["default-src 'none'", "script-src 'self'", "connect-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) {
    assert.ok(SKETCH_FRAME_CSP.includes(part), part);
  }
  assert.ok(!/unsafe-eval|https?:|\*/.test(SKETCH_FRAME_CSP), 'no eval, no network, no wildcard');
});

test('the app page may embed the sketch scheme, and the packaged app carries the frame files', () => {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(indexHtml, /frame-src 'self' jenny-artifact: jenny-sketch:;/);
  assert.ok(!indexHtml.includes('renderer-sketch-frame-host.js'), 'the frame host loads on the first sketch block, not at startup');
  const builder = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  for (const glob of ['- "*.html"', '- "*.js"', '- renderer/**/*', '- styles/**/*']) {
    assert.ok(builder.includes(glob), `electron-builder.yml files: ${glob}`);
  }
  for (const file of ['sketch-frame.html', 'renderer/frames/sketch-frame-init.js', 'renderer/features/renderer-sketch-frame-host.js', 'styles/markdown-sketch.css']) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  const host = require('../renderer/features/renderer-sketch-frame-host');
  assert.equal(host.FRAME_URL, SKETCH_FRAME_URL);
});

// Gate sitting 2026-11-14 (G8): when an iframe element's color-scheme differs from its document's, Chromium paints an
// opaque Canvas backdrop behind the frame. On a dark palette the element inherited `dark` while the drawing core says
// `light`, so white wedges showed outside the paper's rounded corners. The host gives the element the frame's scheme.
test('the frame element carries the color-scheme the frame document declares (no opaque backdrop)', () => {
  const bundle = fs.readFileSync(path.join(ROOT, 'sketch-frame.bundle.js'), 'utf8');
  const declared = (bundle.match(/color-scheme:\s*([a-z]+)/) || [])[1];
  assert.ok(declared, 'the drawing core declares its color-scheme');
  const css = fs.readFileSync(path.join(ROOT, 'styles/markdown-sketch.css'), 'utf8');
  const rule = (css.match(/\.markdown-sketch-paper > iframe\s*\{([^}]*)\}/) || [])[1] || '';
  assert.match(rule, new RegExp(`color-scheme:\\s*${declared}\\s*;`));
});

/* ── The frame's own script, against a stand-in drawing core ── */

function startFrame(api) {
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="sketch-root"></div></body></html>');
  const posted = [];
  const listeners = {};
  const parent = { postMessage: (payload, target) => posted.push({ payload, target }) };
  const frameWindow = {
    parent,
    jennySketch: api,
    addEventListener: (type, listener) => { listeners[type] = listener; },
  };
  new Function('window', 'document', 'ResizeObserver', INIT_SOURCE)(frameWindow, dom.window.document, undefined);
  const send = (data, source = parent) => listeners.message({ source, data });
  return { dom, posted, send, root: dom.window.document.getElementById('sketch-root'), parent };
}

function drawnApi(extra = {}) {
  const calls = { render: [], palette: [] };
  const api = {
    SKETCH_BOUNDS: { chars: 16384, lines: 400, nodes: 120 },
    render: async (container, source, options) => {
      calls.render.push({ container, source, options });
      return { kind: 'drawn', problems: [], counts: { elements: 2, dropped: 0, flagged: 0, nodes: 2 }, laidOut: { width: 412.4, nodes: [] } };
    },
    previousLayout: () => ({ direction: 'right', positions: { a: { x: 1, y: 2 } } }),
    setPalette: (palette) => calls.palette.push(palette),
    ...extra,
  };
  return { api, calls };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the frame announces itself once and draws a render request from its parent', async () => {
  const { api, calls } = drawnApi();
  const frame = startFrame(api);
  assert.deepEqual(frame.posted, [{ payload: { type: 'sketch-frame-ready' }, target: '*' }]);
  frame.send({ type: 'render', requestId: 'r1', source: 'a Alpha\nb Beta\na -> b', previous: null });
  await settle();
  assert.equal(calls.render.length, 1);
  assert.equal(calls.render[0].container, frame.root);
  assert.equal(calls.render[0].source, 'a Alpha\nb Beta\na -> b');
  const rendered = frame.posted.at(-1).payload;
  assert.equal(rendered.type, 'rendered');
  assert.equal(rendered.requestId, 'r1');
  assert.equal(rendered.ok, true);
  assert.equal(rendered.width, 413);
  assert.deepEqual(rendered.positions, { direction: 'right', positions: { a: { x: 1, y: 2 } } });
  assert.deepEqual(rendered.problems, []);
});

test('the frame ignores a message from the wrong source and a request without an id or a source', async () => {
  const { api, calls } = drawnApi();
  const frame = startFrame(api);
  frame.send({ type: 'render', requestId: 'r1', source: 'a Alpha' }, { postMessage() {} });
  frame.send({ type: 'render', requestId: 'r1', source: 'a Alpha' }, null);
  frame.send({ type: 'render', source: 'a Alpha' });
  frame.send({ type: 'render', requestId: 'x'.repeat(129), source: 'a Alpha' });
  frame.send({ type: 'render', requestId: 'r1', source: { toString: () => 'a Alpha' } });
  frame.send({ type: 'something-else', requestId: 'r1', source: 'a Alpha' });
  frame.send('render');
  frame.send(null);
  await settle();
  assert.equal(calls.render.length, 0);
  assert.equal(frame.posted.length, 1, 'only the ready announcement');
});

test('the frame refuses an oversize or empty source before the drawing core sees it', async () => {
  const { api, calls } = drawnApi();
  const frame = startFrame(api);
  const cases = [
    ['x'.repeat(16385), 'too_long'],
    [Array.from({ length: 401 }, (_, index) => `n${index} Node`).join('\n'), 'too_many_lines'],
    ['   \n  ', 'empty'],
  ];
  for (const [source, reason] of cases) {
    frame.send({ type: 'render', requestId: reason, source });
    await settle();
    assert.deepEqual(frame.posted.at(-1).payload, { type: 'rendered', requestId: reason, ok: false, reason, problems: [] });
  }
  assert.equal(calls.render.length, 0);
  // Exactly at the bounds is drawn.
  frame.send({ type: 'render', requestId: 'edge', source: Array.from({ length: 400 }, (_, index) => `n${index} N`).join('\n') });
  await settle();
  assert.equal(calls.render.length, 1);
});

test('a refused drawing, a Mermaid body and a thrown error each come back as ok:false, never as an exception', async () => {
  const problems = [{ code: 'prose_node', line: 2, text: 'This is a sentence.' }];
  const results = [
    [{ kind: 'refused', reason: 'too_many_problems', problems }, 'too_many_problems', problems],
    [{ kind: 'mermaid', source: 'graph TD' }, 'mermaid', []],
    [{ kind: 'refused', reason: 'too_many_nodes', problems: [] }, 'too_many_nodes', []],
    [null, 'error', []],
    [new Error('layout exploded'), 'error', []],
  ];
  for (const [result, reason, expectedProblems] of results) {
    const { api } = drawnApi({ render: async () => { if (result instanceof Error) throw result; return result; } });
    const frame = startFrame(api);
    frame.root.appendChild(frame.dom.window.document.createElement('svg'));
    frame.send({ type: 'render', requestId: 'r', source: 'a Alpha' });
    await settle();
    assert.deepEqual(frame.posted.at(-1).payload, { type: 'rendered', requestId: 'r', ok: false, reason, problems: expectedProblems });
    assert.equal(frame.root.childNodes.length, 0, 'nothing half-drawn is left');
  }
  const missing = startFrame(undefined);
  missing.send({ type: 'render', requestId: 'r', source: 'a Alpha' });
  await settle();
  assert.equal(missing.posted.at(-1).payload.reason, 'unavailable');
});

test('only the latest of two overlapping requests answers', async () => {
  const pending = [];
  const { api } = drawnApi({ render: () => new Promise((resolve) => pending.push(resolve)) });
  const frame = startFrame(api);
  frame.send({ type: 'render', requestId: 'first', source: 'a Alpha' });
  frame.send({ type: 'render', requestId: 'second', source: 'b Beta' });
  await settle();
  pending[1]({ kind: 'drawn', problems: [], counts: null, laidOut: { width: 10 } });
  pending[0]({ kind: 'drawn', problems: [], counts: null, laidOut: { width: 10 } });
  await settle();
  const answers = frame.posted.filter((entry) => entry.payload.type === 'rendered');
  assert.deepEqual(answers.map((entry) => entry.payload.requestId), ['second']);
});

test('a theme message sets the palette and redraws the current drawing', async () => {
  const { api, calls } = drawnApi();
  const frame = startFrame(api);
  frame.send({ type: 'theme', palette: { paper: '#101418' } });
  assert.deepEqual(calls.palette, [{ paper: '#101418' }]);
  assert.equal(calls.render.length, 0, 'nothing to redraw yet');
  frame.send({ type: 'render', requestId: 'r1', source: 'a Alpha' });
  await settle();
  frame.send({ type: 'theme', palette: 'not an object' });
  await settle();
  assert.deepEqual(calls.palette[1], null);
  assert.equal(calls.render.length, 2);
  assert.equal(frame.posted.at(-1).payload.requestId, 'r1');
});

/* ── The frame's own script with the real drawing core ── */

test('hostile labels are drawn as text by the real bundle: no element is made from them', async () => {
  await buildSketchBundles({ root: REPO_ROOT });
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="sketch-root"></div></body></html>', {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/',
  });
  // jsdom has no font set and no SVG geometry; the viewer waits on the first and measures with the second.
  Object.defineProperty(dom.window.document, 'fonts', { value: { ready: Promise.resolve(), load: async () => [], check: () => true } });
  dom.window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 40, height: 16 });
  dom.window.eval(fs.readFileSync(sketchBuildPlan(REPO_ROOT).frameOutput, 'utf8'));
  const posted = [];
  const listeners = {};
  const parent = { postMessage: (payload) => posted.push(payload) };
  const frameWindow = { parent, jennySketch: dom.window.jennySketch, addEventListener: (type, listener) => { listeners[type] = listener; } };
  new Function('window', 'document', 'ResizeObserver', INIT_SOURCE)(frameWindow, dom.window.document, undefined);
  const source = [
    'title <img src=x onerror=alert(1)>',
    'a <img src=x onerror=alert(2)>',
    'b </script><script>alert(3)</script>',
    'c <svg onload=alert(4)> ~ <iframe src=javascript:alert(5)>',
    'a -> b',
    'b -> c',
  ].join('\n');
  listeners.message({ source: parent, data: { type: 'render', requestId: 'hostile', source, previous: null } });
  for (let turn = 0; turn < 200 && posted.length < 2; turn += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  const rendered = posted.at(-1);
  assert.equal(rendered.type, 'rendered');
  assert.equal(rendered.ok, true, JSON.stringify(rendered).slice(0, 300));
  const root = dom.window.document.getElementById('sketch-root');
  assert.equal(root.querySelectorAll('svg').length >= 1, true);
  assert.equal(root.querySelectorAll('img, script, iframe, [onerror], [onload]').length, 0);
  assert.equal(dom.window.document.querySelectorAll('script').length, 0);
  // A long label wraps over tspans, so each text element is read line by line.
  const drawn = [...root.querySelectorAll('svg text')].map((text) => {
    const lines = [...text.querySelectorAll('tspan')].map((line) => line.textContent);
    return lines.length ? lines.join(' ') : text.textContent;
  });
  for (const label of ['<img src=x onerror=alert(1)>', '<img src=x onerror=alert(2)>', '<svg onload=alert(4)>']) {
    assert.ok(drawn.includes(label), `${label} is there, as text`);
  }
  assert.ok(drawn.some((text) => text.replace(/\s/g, '') === '</script><script>alert(3)</script>'), 'the script label is text too');
  assert.ok(rendered.height >= 0 && Number.isInteger(rendered.width) && rendered.width > 0);
  assert.equal(typeof rendered.positions.positions.a.x, 'number');
});

/* ── What the page may ask of a drawing that is up, and what the frame may say back ── */

// A stand-in viewer: render() puts the viewer's own markup in the root and keeps the host it was given.
function viewerApi(extra = {}) {
  const seen = { hosts: [], previous: [], exports: [] };
  const { api, calls } = drawnApi({
    render: async (container, source, options) => {
      calls.render.push({ container, source, options });
      seen.hosts.push(options.host);
      seen.previous.push(options.previous || null);
      container.innerHTML = '<div class="frame"><div class="canvas"><svg></svg></div><div class="tooltip"></div>'
        + '<form class="drawbar-ask"><input><button type="submit">Send</button></form></div>';
      return { kind: 'drawn', problems: [], counts: null, laidOut: { width: 100, title: { lines: ['Sign', 'in'] } } };
    },
    slug: (title) => String(title || 'sketch').toLowerCase().replace(/\s+/g, '-'),
    toSvgString: (svg) => { seen.exports.push(['svg', svg.tagName]); return '<svg>drawn</svg>'; },
    toPngBase64: async (svg) => { seen.exports.push(['png', svg.tagName]); return 'iVBORw0KGgo='; },
    toExcalidraw: (laidOut) => { seen.exports.push(['excalidraw', laidOut.width]); return '{"type":"excalidraw"}'; },
    ...extra,
  });
  return { api, calls, seen };
}

async function drawnFrame(extra) {
  const viewer = viewerApi(extra);
  const frame = startFrame(viewer.api);
  frame.send({ type: 'render', requestId: 'r1', source: 'a Alpha\nb Beta\na -> b' });
  await settle();
  return { ...viewer, frame, last: () => frame.posted.at(-1).payload };
}

test('an export request answers with the drawing as SVG, PNG or Excalidraw, named by its title', async () => {
  const { frame, seen, last } = await drawnFrame();
  const cases = [
    ['svg', { text: '<svg>drawn</svg>' }],
    ['png', { base64: 'iVBORw0KGgo=' }],
    ['excalidraw', { text: '{"type":"excalidraw"}' }],
  ];
  for (const [kind, body] of cases) {
    frame.send({ type: 'export', requestId: 'r1', kind });
    await settle();
    assert.deepEqual(last(), { type: 'export', requestId: 'r1', kind, ok: true, name: 'sign-in', ...body });
  }
  assert.deepEqual(seen.exports, [['svg', 'svg'], ['png', 'svg'], ['excalidraw', 100]]);
  const before = frame.posted.length;
  frame.send({ type: 'export', requestId: 'forged', kind: 'svg' });
  frame.send({ type: 'export', requestId: 'r1', kind: 'pdf' });
  frame.send({ type: 'export', requestId: 'r1', kind: 'constructor' });
  frame.send({ type: 'export', requestId: 'r1', kind: 'svg' }, { postMessage() {} });
  await settle();
  assert.equal(frame.posted.length, before, 'a forged id, an unknown kind and a stranger get no answer');
});

test('an export that fails says so, and nothing is exported before a drawing is up', async () => {
  const { frame, last } = await drawnFrame({ toPngBase64: async () => { throw new Error('tainted canvas'); } });
  frame.send({ type: 'export', requestId: 'r1', kind: 'png' });
  await settle();
  assert.deepEqual(last(), { type: 'export', requestId: 'r1', kind: 'png', ok: false });
  const idle = startFrame(viewerApi().api);
  idle.send({ type: 'export', requestId: 'r1', kind: 'svg' });
  await settle();
  assert.equal(idle.posted.length, 1, 'only the ready announcement');
});

test('clicking a node with a file posts open-file with a bounded path; web links are never opened', async () => {
  const { frame, seen, last } = await drawnFrame();
  const host = seen.hosts[0];
  assert.equal(host.openLink('https://example.com/'), undefined);
  const before = frame.posted.length;
  host.openFile({ path: 'src/app.js', line: 12, link: 'vscode://file/src/app.js' });
  assert.deepEqual(last(), { type: 'open-file', requestId: 'r1', path: 'src/app.js', line: 12 });
  host.openFile({ path: 'src/app.js', line: -3 });
  assert.equal(last().line, null);
  host.openFile({ path: 'x'.repeat(1025) });
  host.openFile({ path: 42 });
  host.openFile(null);
  assert.equal(frame.posted.length, before + 2);
  assert.equal(host.download, undefined, 'the viewer hides its export buttons: the page asks instead');
  assert.equal(host.toggleFullscreen, undefined);
});

test('a question waits for the page; the picture goes only when the page allowed it', async () => {
  const { frame, seen, last } = await drawnFrame();
  const host = seen.hosts[0];
  const first = host.ask({ text: 'What is this?', image: 'AAAA' });
  const sent = last();
  assert.deepEqual(sent, { type: 'ask', requestId: 'r1', askId: sent.askId, text: 'What is this?' });
  frame.send({ type: 'ask-result', requestId: 'forged', askId: sent.askId, ok: true });
  frame.send({ type: 'ask-result', requestId: 'r1', askId: 'constructor', ok: true });
  frame.send({ type: 'ask-result', requestId: 'r1', askId: sent.askId, ok: true });
  assert.equal(await first, true);
  frame.send({ type: 'markup', requestId: 'r1', on: true, picture: true });
  const second = host.ask({ text: 'q'.repeat(9000), image: 'AAAA' });
  assert.equal(last().pngBase64, 'AAAA');
  assert.equal(last().text.length, 8000);
  assert.notEqual(last().askId, sent.askId);
  frame.send({ type: 'ask-result', requestId: 'r1', askId: last().askId, ok: false });
  assert.equal(await second, false);
  assert.equal(await host.ask({ text: '   ' }), false, 'nothing to ask');
  // A new drawing starts without the picture again.
  frame.send({ type: 'render', requestId: 'r2', source: 'a Alpha' });
  await settle();
  const third = seen.hosts[1].ask({ text: 'again', image: 'AAAA' });
  assert.equal('pngBase64' in last(), false);
  frame.send({ type: 'ask-result', requestId: 'r2', askId: last().askId, ok: true });
  assert.equal(await third, true);
});

test('markup turns the viewer\'s drawing mode on and off, and the question box works without a form submit', async () => {
  const { frame } = await drawnFrame();
  const viewer = frame.root.querySelector('.frame');
  frame.send({ type: 'markup', requestId: 'forged', on: true });
  assert.equal(viewer.classList.contains('drawing'), false);
  frame.send({ type: 'markup', requestId: 'r1', on: true });
  assert.equal(viewer.classList.contains('drawing'), true);
  assert.equal(viewer.querySelector('.tooltip').hasAttribute('hidden'), true);
  frame.send({ type: 'markup', requestId: 'r1', on: 'yes' });
  assert.equal(viewer.classList.contains('drawing'), false);
  const form = viewer.querySelector('form.drawbar-ask');
  const submits = [];
  form.addEventListener('submit', (event) => { submits.push(event.defaultPrevented); event.preventDefault(); });
  const { Event, KeyboardEvent } = frame.dom.window;
  const click = new Event('click', { bubbles: true, cancelable: true });
  form.querySelector('button').dispatchEvent(click);
  assert.equal(click.defaultPrevented, true, 'the browser never submits the form');
  form.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }));
  form.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(submits.length, 2, 'the button and Enter each raise one submit event');
  form.querySelector('button').disabled = true;
  form.querySelector('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(submits.length, 2, 'nothing to send: no event');
});

test('the frame tells the page when drawing mode changes inside it', async () => {
  const viewer = viewerApi();
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="sketch-root"></div></body></html>');
  const posted = [];
  const listeners = {};
  const parent = { postMessage: (payload) => posted.push(payload) };
  const frameWindow = { parent, jennySketch: viewer.api, MutationObserver: dom.window.MutationObserver, addEventListener: (type, listener) => { listeners[type] = listener; } };
  new Function('window', 'document', 'ResizeObserver', INIT_SOURCE)(frameWindow, dom.window.document, undefined);
  listeners.message({ source: parent, data: { type: 'render', requestId: 'r1', source: 'a Alpha' } });
  await settle();
  const frameEl = dom.window.document.querySelector('.frame');
  frameEl.classList.add('drawing');
  frameEl.classList.add('something-else');
  await settle();
  frameEl.classList.remove('drawing');
  await settle();
  assert.deepEqual(posted.filter((payload) => payload.type === 'markup'), [
    { type: 'markup', requestId: 'r1', on: true },
    { type: 'markup', requestId: 'r1', on: false },
  ]);
  // A theme change redraws into a fresh viewer, which is out of drawing mode: the page is told.
  dom.window.document.querySelector('.frame').classList.add('drawing');
  await settle();
  listeners.message({ source: parent, data: { type: 'theme', palette: { paper: '#101418' } } });
  await settle();
  assert.deepEqual(posted.filter((payload) => payload.type === 'markup').slice(2), [
    { type: 'markup', requestId: 'r1', on: true },
    { type: 'markup', requestId: 'r1', on: false },
  ]);
  assert.equal(dom.window.document.querySelector('.frame').classList.contains('drawing'), false);
});

test('a follow-up starts from the earlier drawing the core picks; the page\'s own positions win', async () => {
  const picks = [];
  const picked = { direction: 'right', positions: { a: { x: 5, y: 6 } } };
  const { frame, seen } = await drawnFrame({ pickPrevious: async (source, earlier) => { picks.push([source, earlier]); return picked; } });
  assert.equal(picks.length, 0, 'no earlier drawing, nothing to pick');
  const earlier = [
    { source: 'a Alpha', positions: { direction: 'right', positions: { a: { x: 1, y: 2 } } } },
    { source: 'x'.repeat(16385) },
    { source: '   ' },
    { source: 7 },
    { source: 'b Beta', positions: 'nope' },
    { source: 'c C' }, { source: 'd D' }, { source: 'e E' },
  ];
  frame.send({ type: 'render', requestId: 'r2', source: 'a Alpha\nz Zed', earlier });
  await settle();
  assert.equal(picks.length, 1);
  assert.equal(picks[0][0], 'a Alpha\nz Zed');
  assert.deepEqual(picks[0][1], [
    { source: 'a Alpha', positions: { direction: 'right', positions: { a: { x: 1, y: 2 } } } },
    { source: 'b Beta', positions: null },
    { source: 'c C', positions: null },
    { source: 'd D', positions: null },
  ]);
  assert.deepEqual(seen.previous.at(-1), picked);
  const own = { direction: 'down', positions: {} };
  frame.send({ type: 'render', requestId: 'r3', source: 'a Alpha', previous: own, earlier });
  await settle();
  assert.equal(picks.length, 1, 'positions the page sent are used as they are');
  assert.deepEqual(seen.previous.at(-1), own);
  // A core that throws, or picks nothing, still draws.
  const broken = await drawnFrame({ pickPrevious: () => { throw new Error('layout exploded'); } });
  broken.frame.send({ type: 'render', requestId: 'r4', source: 'a Alpha', earlier: [{ source: 'a Alpha' }] });
  await settle();
  assert.equal(broken.last().ok, true);
  assert.equal(broken.seen.previous.at(-1), null);
});

test('the real bundle exports a drawing as SVG and Excalidraw, and hides the viewer toolbar', async () => {
  await buildSketchBundles({ root: REPO_ROOT });
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body><div id="sketch-root"></div></body></html>', {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/',
  });
  Object.defineProperty(dom.window.document, 'fonts', { value: { ready: Promise.resolve(), load: async () => [], check: () => true } });
  dom.window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 40, height: 16 });
  dom.window.eval(fs.readFileSync(sketchBuildPlan(REPO_ROOT).frameOutput, 'utf8'));
  const posted = [];
  const listeners = {};
  const parent = { postMessage: (payload) => posted.push(payload) };
  const frameWindow = { parent, jennySketch: dom.window.jennySketch, addEventListener: (type, listener) => { listeners[type] = listener; } };
  new Function('window', 'document', 'ResizeObserver', INIT_SOURCE)(frameWindow, dom.window.document, undefined);
  const wait = async (count) => { for (let turn = 0; turn < 200 && posted.length < count; turn += 1) await new Promise((resolve) => setTimeout(resolve, 25)); };
  listeners.message({ source: parent, data: { type: 'render', requestId: 'real', source: 'title Sign in\nuser User\napp App file=src/app.js\nuser -> app' } });
  await wait(2);
  assert.equal(posted.at(-1).ok, true, JSON.stringify(posted.at(-1)).slice(0, 300));
  const root = dom.window.document.getElementById('sketch-root');
  assert.ok(root.querySelector('.frame > .toolbar'), 'the viewer still builds its toolbar');
  assert.match(dom.window.document.getElementById('sketch-styles').textContent, /\.toolbar\s*\{\s*display:\s*none;?\s*\}/);
  assert.equal(root.querySelectorAll('.toolbar button').length, 1, 'no export or fullscreen button: only Draw, which is hidden with the bar');
  assert.ok(root.querySelector('form.drawbar-ask'), 'the question box is there for drawing mode');
  listeners.message({ source: parent, data: { type: 'export', requestId: 'real', kind: 'svg' } });
  await wait(3);
  const svg = posted.at(-1);
  assert.equal(svg.ok, true);
  assert.equal(svg.name, 'sign-in');
  assert.match(svg.text, /^<\?xml[^>]*>\s*<svg[\s>]/);
  listeners.message({ source: parent, data: { type: 'export', requestId: 'real', kind: 'excalidraw' } });
  await wait(4);
  const excalidraw = JSON.parse(posted.at(-1).text);
  assert.equal(excalidraw.type, 'excalidraw');
  assert.ok(excalidraw.elements.length >= 3);
});
