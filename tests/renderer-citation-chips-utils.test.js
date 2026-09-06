'use strict';

// Citations Step 5 — chip markup builder (C1 title pills per
// CITATION_CHIPS_SPEC.md). Every field HTML-escaped at render time; <a>/<span>
// only (no raw form controls); empty refs -> empty string.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { renderCitationChips, stripCitationMarkers } = require('../renderer/chat/renderer-citation-chips-utils');

function refs(...entries) {
  return entries.map((entry, index) => ({
    url: `https://example.com/${index}`,
    title: `Title ${index}`,
    snippet: `Snippet ${index}`,
    sourceType: 'web',
    ...entry,
  }));
}

describe('renderCitationChips', () => {
  test('N refs render N anchor chips inside the row wrapper', () => {
    const html = renderCitationChips({ refs: refs({}, {}, {}) });
    assert.match(html, /class="citation-chips-row"/);
    assert.equal((html.match(/class="citation-chip"/g) || []).length, 3);
    assert.equal((html.match(/<a /g) || []).length, 3);
  });

  test('chips carry safe anchor plumbing: escaped href, _blank, noopener noreferrer, snippet tooltip', () => {
    const html = renderCitationChips({
      refs: [{ url: 'https://example.com/a?x=1&y=2', title: 'A', snippet: 'The snippet' }],
    });
    assert.match(html, /href="https:\/\/example\.com\/a\?x=1&amp;y=2"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noopener noreferrer"/);
    assert.match(html, /title="The snippet"/);
  });

  test('hostile title/snippet are escaped — no live HTML survives', () => {
    const html = renderCitationChips({
      refs: [{
        url: 'https://example.com/',
        title: '<img src=x onerror=alert(1)>',
        snippet: '"><script>alert(2)</script>',
      }],
    });
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /<script/);
    assert.match(html, /&lt;img/);
  });

  test('missing title falls back to the hostname as the pill text', () => {
    const html = renderCitationChips({
      refs: [{ url: 'https://docs.example.co.uk/deep/path', title: '', snippet: '' }],
    });
    assert.match(html, />docs\.example\.co\.uk</);
    // With no snippet the tooltip carries the full URL.
    assert.match(html, /title="https:\/\/docs\.example\.co\.uk\/deep\/path"/);
  });

  test('the world glyph is aria-hidden SVG and the accessible name is the title span', () => {
    const html = renderCitationChips({ refs: [{ url: 'https://example.com/', title: 'Readable' }] });
    assert.match(html, /<svg[^>]*aria-hidden="true"/);
    const span = html.match(/<span class="citation-chip-title">([^<]*)<\/span>/);
    assert.ok(span, 'title span present');
    assert.equal(span[1], 'Readable');
  });

  test('empty or invalid refs render an empty string (no row)', () => {
    assert.equal(renderCitationChips({ refs: [] }), '');
    assert.equal(renderCitationChips({}), '');
    assert.equal(renderCitationChips(null), '');
  });

  test('non-http(s) refs are dropped defensively even if a caller bypassed the normalizer', () => {
    const html = renderCitationChips({
      refs: [
        { url: 'javascript:alert(1)', title: 'evil' },
        { url: 'https://example.com/fine', title: 'fine' },
      ],
    });
    assert.equal((html.match(/<a /g) || []).length, 1);
    assert.doesNotMatch(html, /javascript:/);
  });
});

// Regression (queue #13 R3 remediation): gpt-oss (at minimum) echoes the
// tool's `web:N` citation ids back into the visible answer as raw bracketed
// markers instead of relying solely on the chip row. Drive evidence showed
// literal CJK corner-bracket markers 【web:1】【web:7】 surviving into the
// rendered text; the chip row makes them redundant, so they should be
// stripped from what the user sees.
describe('stripCitationMarkers', () => {
  test('strips ASCII [web:N] markers', () => {
    assert.equal(stripCitationMarkers('It opened in 1889 [web:1].'), 'It opened in 1889.');
  });

  test('strips fullwidth CJK 【web:N】 markers (the gpt-oss shape from the drive evidence)', () => {
    assert.equal(stripCitationMarkers('It opened in 1889【web:1】.'), 'It opened in 1889.');
  });

  test('strips multiple adjacent markers with no leftover double spaces', () => {
    assert.equal(
      stripCitationMarkers('It opened in 1889【web:1】【web:7】.'),
      'It opened in 1889.'
    );
  });

  test('strips comma-joined multi-id markers', () => {
    assert.equal(stripCitationMarkers('Confirmed by two sources [web:1,7].'), 'Confirmed by two sources.');
    assert.equal(stripCitationMarkers('Confirmed by two sources [web: 1, 7].'), 'Confirmed by two sources.');
  });

  test('leaves unrelated bracketed text untouched', () => {
    assert.equal(stripCitationMarkers('See [the docs](https://example.com) for more.'), 'See [the docs](https://example.com) for more.');
    assert.equal(stripCitationMarkers('Register for the [webinar: 1] slot.'), 'Register for the [webinar: 1] slot.');
  });

  test('degrades safely on nullish/non-string input', () => {
    assert.equal(stripCitationMarkers(null), '');
    assert.equal(stripCitationMarkers(undefined), '');
    assert.equal(stripCitationMarkers(''), '');
  });
});
