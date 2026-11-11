'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { buildReaderCall } = require('../services/browser-use/page-reader-script');

function open(html) {
  const dom = new JSDOM(`<!doctype html><title>T</title><body>${html}</body>`, {
    runScripts: 'outside-only', url: 'https://example.test/',
  });
  return (op, args = {}) => dom.window.eval(buildReaderCall(op, args));
}

function outlineOf(html) {
  return open(html)('read', { scope: 'full' }).text.split('\n').slice(4);
}

test('a table row stays on one line, in column order', () => {
  assert.deepEqual(outlineOf(`<table>
    <tr><th>Name</th><th>Order</th><th>Status</th></tr>
    <tr><td>Hollis Vane</td><td>ORD-2289</td><td>Shipped</td></tr>
  </table>`), ['Name | Order | Status', 'Hollis Vane | ORD-2289 | Shipped']);
});

test('an empty cell keeps its column', () => {
  assert.deepEqual(outlineOf('<table><tr><td>A</td><td></td><td>C</td></tr></table>'), ['A | - | C']);
});

test('a cell hidden by the page holds no column', () => {
  assert.deepEqual(outlineOf('<table><tr><td>A</td><td style="display:none">x</td><td>C</td></tr></table>'), ['A | C']);
});

test('a control inside a cell keeps its ref on the row line', () => {
  const [line] = outlineOf('<table><tr><td>Report</td><td><a href="/r">Open</a></td></tr></table>');
  assert.match(line, /^Report \| \[r\d+\] link "Open" -> https:\/\/example\.test\/r$/);
});

test('an ARIA grid row reads like a table row', () => {
  assert.deepEqual(
    outlineOf('<div role="row"><div role="cell">A</div><div role="cell"></div><div role="cell">C</div></div>'),
    ['A | - | C'],
  );
});

test('a layout table does not fold its nested tables into one line', () => {
  assert.deepEqual(outlineOf(`<table><tr><td>
    <table><tr><td>a1</td><td>a2</td></tr><tr><td>b1</td><td>b2</td></tr></table>
  </td></tr></table>`), ['a1 | a2', 'b1 | b2']);
});

test('find still reaches a control inside a table row', () => {
  const found = open('<table><tr><td>Report</td><td><a href="/r">Open</a></td></tr></table>')('find', { query: 'open' });
  assert.equal(found.matches[0].role, 'link');
});

test('find says how many fields a page has, and finds one with no label by its kind', () => {
  // The owner's case (2026-11-10): asked to use a search box on a page that has none, a model could not tell
  // "no such field" from "a field the outline hides" and went to read the raw HTML with Python.
  const bare = open('<form><p>1000 results</p></form><a href="/x">Next</a><button>Go</button>')('find', { query: 'search' });
  assert.deepEqual([bare.total, bare.fields], [0, 0]);
  const unlabeled = open('<input type="search"><input><select><option>One</option></select>');
  const byKind = unlabeled('find', { query: 'search' });
  assert.deepEqual([byKind.total, byKind.matches[0].role, byKind.fields], [1, 'searchbox', 3]);
  assert.match(byKind.matches[0].ref, /^r\d+$/);
  assert.equal(unlabeled('find', { query: 'textbox' }).matches[0].name, '');
  assert.equal(unlabeled('find', { query: 'box' }).total, 0, 'a short word does not match every kind');
  const framed = open('<p>Pay below</p><iframe src="https://other.example/pay"></iframe>')('find', { query: 'card number' });
  assert.deepEqual([framed.total, framed.fields], [0, null], 'a frame it cannot see into may hold the field');
  assert.ok(outlineOf('<input>').some((line) => /^\[r\d+\] textbox/.test(line)), 'a full read lists a field with no label');
});

test('a label prints once, as the name of its control', () => {
  const lines = outlineOf('<label for="n">Full name</label><input id="n">');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[r\d+\] textbox "Full name"$/);
});

test('a label wrapping its control prints once', () => {
  const lines = outlineOf('<label>Include breakfast <input type="checkbox"></label>');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /checkbox "Include breakfast"$/);
});

test('a link inside a label keeps its own line', () => {
  const lines = outlineOf('<label><input type="checkbox"> I agree to the <a href="/terms">terms</a></label>');
  assert.equal(lines.length, 2);
  assert.match(lines[1], /link "terms"/);
});

test('a label with no control is ordinary text', () => {
  assert.deepEqual(outlineOf('<label>Just words</label>'), ['Just words']);
});

test('a styled toggle is reached through its label and reports its state', () => {
  const lines = outlineOf('<input id="b" type="checkbox" checked style="display:none"><label for="b">Breakfast</label>');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[r\d+\] checkbox "Breakfast" checked$/);
});

test('the label of a hidden file input is reported as a file input, so a click is refused', () => {
  const read = open('<input id="f" type="file" style="display:none"><label for="f">Choose a file</label>');
  const ref = /\[(r\d+)\] file/.exec(read('read', { scope: 'full' }).text)[1];
  assert.equal(read('probe', { ref }).isFileInput, true);
});

test('the label of an ordinary checkbox is not a file input', () => {
  const read = open('<input id="b" type="checkbox" style="display:none"><label for="b">Breakfast</label>');
  const ref = /\[(r\d+)\] checkbox/.exec(read('read', { scope: 'full' }).text)[1];
  assert.equal(read('probe', { ref }).isFileInput, false);
});

for (const [markup, expected] of [
  ['<button>Go</button>', 'submit'],
  ['<button type="submit">Go</button>', 'submit'],
  ['<button type="button">Go</button>', 'button'],
  ['<button type="reset">Go</button>', 'reset'],
  ['<button type="nonsense">Go</button>', 'submit'],
]) {
  test(`${markup} reports its real type to the consent gate`, () => {
    const read = open(`<form method="post" action="/x">${markup}</form>`);
    const ref = /\[(r\d+)\] button/.exec(read('read', { scope: 'full' }).text)[1];
    assert.equal(read('probe', { ref }).inputType, expected);
  });
}

// jsdom has no media engine, so each element's playback properties are stubbed.
const PLAYING = { paused: false, ended: false, currentTime: 42, duration: 226, readyState: 4, muted: false, volume: 1 };
function openMedia(html, stubs = []) {
  const dom = new JSDOM(`<!doctype html><title>T</title><body>${html}</body>`, {
    runScripts: 'outside-only', url: 'https://example.test/',
  });
  stubs.forEach((props, index) => {
    const el = dom.window.document.querySelectorAll('video, audio')[index];
    for (const [key, value] of Object.entries({ ...PLAYING, ...props })) {
      Object.defineProperty(el, key, { value, configurable: true });
    }
  });
  return (args = {}) => {
    const out = JSON.parse(JSON.stringify(dom.window.eval(buildReaderCall('read', { scope: 'full', ...args }))));
    return { ...out, mediaLine: out.text.split('\n').find((line) => line.startsWith('Media:')) };
  };
}

test('a page with no media and no sound has no media line', () => {
  const out = openMedia('<p>Hello</p>')();
  assert.equal(out.mediaLine, undefined);
  assert.equal(out.media, null);
});

test('no media element but sound playing says the page is playing sound', () => {
  const out = openMedia('<p>Hello</p>')({ sound: 'playing' });
  assert.equal(out.mediaLine, 'Media: this page is playing sound.');
  assert.equal(out.media, null);
});

test('no media element and muted sound adds no line', () => {
  assert.equal(openMedia('<p>Hello</p>')({ sound: 'muted' }).mediaLine, undefined);
});

test('a playing video reports its position and sound', () => {
  const out = openMedia('<video></video>', [{}])({ sound: 'playing' });
  assert.equal(out.mediaLine, 'Media: video playing, 0:42 of 3:46, sound on.');
  assert.deepEqual(out.media, { kind: 'video', state: 'playing', position: '0:42 of 3:46', duration: 226, ad: false });
});

test('the media tags stay out of the outline', () => {
  const out = openMedia('<video></video><audio></audio><p>Words</p>', [{}, {}])();
  assert.deepEqual(out.text.split('\n').slice(4).filter((line) => line && !line.startsWith('Media:')), ['Words']);
});

test('a paused video says paused', () => {
  const out = openMedia('<video></video>', [{ paused: true }])({ sound: 'muted' });
  assert.match(out.mediaLine, /^Media: video paused, 0:42 of 3:46/);
  assert.equal(out.media.state, 'paused');
});

test('an ended video says ended', () => {
  const out = openMedia('<video></video>', [{ ended: true, paused: true, currentTime: 226 }])();
  assert.match(out.mediaLine, /^Media: video ended, 3:46 of 3:46/);
});

test('a video that wants to play but has not buffered says loading', () => {
  const out = openMedia('<video></video>', [{ readyState: 1 }])();
  assert.match(out.mediaLine, /^Media: video loading, 0:42 of 3:46/);
  assert.equal(out.media.state, 'loading');
});

test('an audio element reads as audio', () => {
  const out = openMedia('<audio></audio>', [{ currentTime: 5, duration: 60 }])({ sound: 'playing' });
  assert.equal(out.mediaLine, 'Media: audio playing, 0:05 of 1:00, sound on.');
});

test('an infinite duration reads as live', () => {
  const out = openMedia('<video></video>', [{ duration: Infinity }])({ sound: 'playing' });
  assert.equal(out.mediaLine, 'Media: video playing, live, sound on.');
  assert.equal(out.media.position, 'live');
  assert.equal(out.media.duration, null);
});

test('a position past an hour uses h:mm:ss', () => {
  const out = openMedia('<video></video>', [{ currentTime: 3725, duration: 7200 }])({ sound: 'playing' });
  assert.equal(out.mediaLine, 'Media: video playing, 1:02:05 of 2:00:00, sound on.');
});

test('an element inside an ad player reads as an ad', () => {
  const out = openMedia('<div id="movie_player" class="ad-showing"><video></video></div>', [{ currentTime: 3, duration: 15 }])({ sound: 'playing' });
  assert.equal(out.mediaLine, 'Media: an ad playing, 0:03 of 0:15, sound on.');
  assert.equal(out.media.ad, true);
});

test('an element muted by the page says so, with or without a sound argument', () => {
  assert.match(openMedia('<video></video>', [{ muted: true }])().mediaLine, /, muted by the page\.$/);
  assert.match(openMedia('<video></video>', [{ volume: 0 }])({ sound: 'playing' }).mediaLine, /, muted by the page\.$/);
});

test('sound muted in Jenny is reported', () => {
  const out = openMedia('<video></video>', [{}])({ sound: 'muted' });
  assert.equal(out.mediaLine, 'Media: video playing, 0:42 of 3:46, muted in Jenny.');
});

test('a playing element with no sound argument says no sound yet', () => {
  const out = openMedia('<video></video>', [{}])();
  assert.equal(out.mediaLine, 'Media: video playing, 0:42 of 3:46, no sound yet.');
});

test('a paused element with no sound argument adds no sound part', () => {
  const out = openMedia('<video></video>', [{ paused: true }])();
  assert.equal(out.mediaLine, 'Media: video paused, 0:42 of 3:46.');
});

test('the playing element wins over a larger paused one', () => {
  const dom = openMedia('<video id="big"></video><audio></audio>', [{ paused: true, currentTime: 1, duration: 100 }, { currentTime: 9, duration: 30 }]);
  assert.equal(dom({ sound: 'playing' }).mediaLine, 'Media: audio playing, 0:09 of 0:30, sound on.');
});

test('with nothing playing the largest element with a duration is picked', () => {
  const out = openMedia('<video></video><video></video>', [
    { paused: true, currentTime: 1, duration: 10 },
    { paused: true, currentTime: 2, duration: 20 },
  ])();
  assert.match(out.mediaLine, /^Media: video paused/);
  assert.ok(out.media.duration === 10 || out.media.duration === 20);
});

test('an element with no known duration and nothing playing gives no line', () => {
  const out = openMedia('<video></video>', [{ paused: true, duration: NaN }])();
  assert.equal(out.mediaLine, undefined);
  assert.equal(out.media, null);
});
