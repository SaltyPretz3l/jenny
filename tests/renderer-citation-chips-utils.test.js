'use strict';

// Numbered source references (row 154 S2): turn-wide source index, inline
// reference groups and the sources list under the final answer. Every field is
// HTML-escaped at render time; <a>/<span> only (the toggle is the inventory
// plain button); empty refs -> empty string.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const markdownUtils = require('../renderer/shared/markdown-utils');
const {
  buildTurnSourceIndex,
  renderTextWithReferences,
  renderSourceList,
  isSourceListOpen,
  setSourceListOpen,
  stripCitationMarkers,
  stripCitationMarkersForStreaming,
} = require('../renderer/chat/renderer-citation-chips-utils');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function ref(n, extra) {
  return {
    url: `https://example.com/p${n}`,
    title: `Title ${n}`,
    snippet: `Snippet ${n}`,
    sourceType: 'web',
    n,
    ...extra,
  };
}

function notice(rowId, refs) {
  return { row_id: rowId, turn_id: 'turn_1', kind: 'system_notice', payload: { subkind: 'source_citations', refs } };
}

function answer(rowId, text) {
  return { row_id: rowId, turn_id: 'turn_1', kind: 'assistant_text', payload: { text } };
}

function renderRow(index, rowId, text, renderMarkdown) {
  return renderTextWithReferences(text, {
    rowId,
    index,
    escapeHtml,
    renderMarkdown: renderMarkdown || ((value) => `<p>${escapeHtml(value)}</p>`),
  });
}

function numbersOf(html) {
  return [...html.matchAll(/class="source-ref-link"[^>]*data-source-ref="(\d+)"/g)].map((match) => Number(match[1]));
}

describe('buildTurnSourceIndex', () => {
  test('a marker resolves against the latest preceding call that holds its n', () => {
    const rows = [
      notice('n1', [ref(1, { url: 'https://a.test/old' })]),
      notice('n2', [ref(1, { url: 'https://b.test/new' })]),
      answer('a1', 'Claim [web:1].'),
    ];
    const index = buildTurnSourceIndex(rows);
    assert.equal(index.resolvedAny, true);
    assert.equal(index.cited.length, 1);
    assert.equal(index.cited[0].ref.url, 'https://b.test/new');
    assert.deepEqual(index.uncited.map((entry) => entry.url), ['https://a.test/old']);
  });

  test('two calls numbered 1-2 and 3-4 resolve each marker to its own call', () => {
    const rows = [
      notice('n1', [
        ref(1, { url: 'https://a.test/one' }),
        ref(2, { url: 'https://a.test/two' }),
      ]),
      notice('n2', [
        ref(3, { url: 'https://b.test/three' }),
        ref(4, { url: 'https://b.test/four' }),
      ]),
      answer('a1', 'First [web:1] and third [web:3].'),
    ];
    const index = buildTurnSourceIndex(rows);
    assert.deepEqual(index.cited.map((entry) => entry.ref.url), [
      'https://a.test/one',
      'https://b.test/three',
    ]);
  });

  test('a marker before any call stays unresolved and its leading space goes with it', () => {
    const rows = [
      answer('a0', 'Early claim [web:1] here.'),
      notice('n1', [ref(1)]),
      answer('a1', 'Later claim [web:1].'),
    ];
    const index = buildTurnSourceIndex(rows);
    assert.equal(index.cited.length, 1);
    assert.equal(renderRow(index, 'a0', 'Early claim [web:1] here.'), '<p>Early claim here.</p>');
    assert.equal(numbersOf(renderRow(index, 'a1', 'Later claim [web:1].')).join(), '1');
  });

  test('numbers follow first-cited order across two text rows', () => {
    const rows = [
      notice('n1', [ref(1), ref(2), ref(3)]),
      answer('a1', 'First [web:3] then [web:1].'),
      answer('a2', 'Next [web:2] and again [web:3].'),
    ];
    const index = buildTurnSourceIndex(rows);
    assert.deepEqual(index.cited.map((entry) => [entry.num, entry.ref.n]), [[1, 3], [2, 1], [3, 2]]);
    assert.equal(numbersOf(renderRow(index, 'a1', 'First [web:3] then [web:1].')).join(), '1,2');
    assert.equal(numbersOf(renderRow(index, 'a2', 'Next [web:2] and again [web:3].')).join(), '3,1');
    assert.equal(index.uncited.length, 0);
    assert.equal(index.finalAnswerRowId, 'a2');
  });

  test('the same url from two calls gets one number', () => {
    const rows = [
      notice('n1', [ref(1, { url: 'https://same.test/x' })]),
      answer('a1', 'One [web:1].'),
      notice('n2', [ref(1, { url: 'https://same.test/x' }), ref(2, { url: 'https://other.test/y' })]),
      answer('a2', 'Two [web:1] and [web:2].'),
    ];
    const index = buildTurnSourceIndex(rows);
    assert.deepEqual(index.cited.map((entry) => entry.ref.url), ['https://same.test/x', 'https://other.test/y']);
    assert.equal(index.all.length, 2);
    assert.equal(numbersOf(renderRow(index, 'a2', 'Two [web:1] and [web:2].')).join(), '1,2');
  });

  test('alsoN resolves to the surviving ref', () => {
    const index = buildTurnSourceIndex([
      notice('n1', [ref(1, { alsoN: [4, 5] })]),
      answer('a1', 'Dup [web:5].'),
    ]);
    assert.equal(index.resolvedAny, true);
    assert.equal(numbersOf(renderRow(index, 'a1', 'Dup [web:5].')).join(), '1');
  });

  test('[web:1,2] and [web:1][web:2] both give one 1,2 group', () => {
    const index = buildTurnSourceIndex([notice('n1', [ref(1), ref(2)]), answer('a1', 'x [web:1] [web:2]')]);
    for (const text of ['Both [web:1,2].', 'Both [web:1][web:2].', 'Both【web:1】【web:2】.', 'Both [web:1] [web:2].']) {
      const html = renderRow(index, 'a1', text);
      assert.equal((html.match(/<sup class="source-ref">/g) || []).length, 1, text);
      assert.equal(numbersOf(html).join(), '1,2', text);
      assert.match(html, /<\/a>,<a class="source-ref-link"/, text);
      assert.doesNotMatch(html, /web:/, text);
    }
  });

  test('a repeated number inside one group is deduped', () => {
    const index = buildTurnSourceIndex([notice('n1', [ref(1, { alsoN: [2] })]), answer('a1', 'x [web:1,2]')]);
    assert.equal(numbersOf(renderRow(index, 'a1', 'Same [web:1,2].')).join(), '1');
  });

  test('refs without n (events saved before numbering) give resolvedAny false and the unnumbered list', () => {
    const rows = [
      notice('n1', [{ url: 'https://old.test/a', title: 'A' }, { url: 'https://old.test/b', title: 'B' }]),
      answer('a1', 'Claim [web:1].'),
    ];
    const index = buildTurnSourceIndex(rows);
    assert.equal(index.resolvedAny, false);
    assert.equal(index.cited.length, 0);
    assert.equal(index.all.length, 2);
    assert.equal(renderRow(index, 'a1', 'Claim [web:1].'), '<p>Claim.</p>');
    const html = renderSourceList(index, { turnId: 'turn_1', escapeHtml });
    assert.match(html, /<ul class="source-list-cited source-list--plain">/);
    assert.doesNotMatch(html, /source-list-num|source-list-toggle|source-list-also|<ol/);
    assert.equal((html.match(/class="source-list-item" data-source-ref=""/g) || []).length, 2);
  });

  test('final answer is the last non-empty assistant_text row; discarded drafts are skipped', () => {
    const rows = [
      answer('a1', 'first'),
      answer('a2', '   '),
      { ...answer('a3', 'discarded'), payload: { text: 'discarded', discard_hidden: true } },
    ];
    assert.equal(buildTurnSourceIndex(rows).finalAnswerRowId, 'a1');
    assert.equal(buildTurnSourceIndex([notice('n1', [ref(1)])]).finalAnswerRowId, '');
    assert.equal(buildTurnSourceIndex([notice('n1', [ref(1)]), notice('n2', [ref(1)])]).lastNoticeRowId, 'n2');
  });

  test('memoised per rows array and tolerant of junk input', () => {
    const rows = [notice('n1', [ref(1)]), answer('a1', 'x [web:1]')];
    assert.equal(buildTurnSourceIndex(rows), buildTurnSourceIndex(rows));
    assert.notEqual(buildTurnSourceIndex(rows), buildTurnSourceIndex([...rows]));
    assert.equal(Object.isFrozen(buildTurnSourceIndex(rows)), true);
    for (const junk of [null, undefined, 'x', [null, 3, {}]]) {
      const index = buildTurnSourceIndex(junk);
      assert.equal(index.resolvedAny, false);
      assert.equal(index.all.length, 0);
    }
  });

  test('non-http refs are dropped even when a caller bypassed the normalizer', () => {
    const index = buildTurnSourceIndex([
      notice('n1', [{ url: 'javascript:alert(1)', title: 'evil', n: 1 }, ref(2)]),
      answer('a1', 'Evil [web:1] fine [web:2].'),
    ]);
    assert.equal(index.all.length, 1);
    const html = renderRow(index, 'a1', 'Evil [web:1] fine [web:2].') + renderSourceList(index, { turnId: 't', escapeHtml });
    assert.doesNotMatch(html, /javascript:/);
  });
});

describe('renderTextWithReferences', () => {
  const index = buildTurnSourceIndex([
    notice('n1', [ref(1, { title: '"><img src=x onerror=1>', snippet: '"><script>alert(2)</script>', url: 'https://ex.test/a?x=1&y=2' }), ref(2)]),
    answer('a1', 'x [web:1] [web:2]'),
  ]);

  test('anchor carries safe plumbing and escaped data attributes', () => {
    const html = renderRow(index, 'a1', 'Claim [web:1].');
    assert.match(html, /<sup class="source-ref"><a class="source-ref-link" href="https:\/\/ex\.test\/a\?x=1&amp;y=2" target="_blank" rel="noopener noreferrer"/);
    assert.match(html, /data-source-url="https:\/\/ex\.test\/a\?x=1&amp;y=2"/);
    assert.match(html, /data-source-site="ex\.test"/);
    assert.doesNotMatch(html, /data-source-kind/);
    assert.match(html, /aria-label="Source 1: &quot;&gt;&lt;img src=x onerror=1&gt;"/);
    assert.doesNotMatch(html, /<img|<script/);
  });

  test('no private-use sentinel survives with the real markdown renderer', () => {
    const text = [
      'Plain claim [web:1].',
      '',
      '**Bold claim**【web:2】 and *italic* [web:1].',
      '',
      '[a link [web:1]](https://example.com/link) outside [web:2].',
      '',
      '- list item [web:1]',
      '- second [web:2]',
      '',
      'Inline `code [web:1]` here.',
      '',
      '```js',
      'const x = "[web:2]"; // [web:1]',
      '```',
      '',
      'Spoof 7 attempt.',
    ].join('\n');
    const html = renderRow(index, 'a1', text, (value) => markdownUtils.renderMarkdown(value));
    assert.doesNotMatch(html, /[]/);
    assert.doesNotMatch(html, /web:/);
    // Plain, bold, list items and the link's neighbour render references; code and link text strip them.
    assert.ok((html.match(/<sup class="source-ref">/g) || []).length >= 5, html);
    assert.doesNotMatch(html, /<code[^>]*>[^<]*<sup/);
    assert.doesNotMatch(html, /<a [^>]*href="https:\/\/example\.com\/link"[^>]*>[^<]*<sup/);
    assert.match(html, /<strong>Bold claim<\/strong><sup class="source-ref">/);
  });

  test('a bare url right before a marker keeps its href and the number (review 2026-11-14)', () => {
    const rows = [notice('n1', [ref(1)]), answer('a1', 'Visit https://example.com/foo [web:1] for more. See www.example.org [web:1].')];
    const html = renderRow(buildTurnSourceIndex(rows), 'a1', rows[1].payload.text, (value) => markdownUtils.renderMarkdown(value));
    assert.match(html, /href="https:\/\/example\.com\/foo"/);
    assert.doesNotMatch(html, /%EE%80|[\uE000\uE001]/);
    assert.match(html, /https:\/\/example\.com\/foo<\/a><sup class="source-ref">/);
    assert.equal((html.match(/<sup class="source-ref">/g) || []).length, 2);
  });

  test('[web:0] never resolves to a ref saved without a number', () => {
    const rows = [notice('n1', [{ url: 'https://old.test/a', title: 'A' }]), answer('a1', 'Claim [web:0].')];
    const index = buildTurnSourceIndex(rows);
    assert.equal(index.resolvedAny, false);
    assert.equal(renderRow(index, 'a1', 'Claim [web:0].'), '<p>Claim.</p>');
  });

  test('unresolved or absent index strips markers like the settled strip', () => {
    assert.equal(renderTextWithReferences('A [web:9] b【web:3】.', { rowId: 'a1', index, escapeHtml, renderMarkdown: (v) => v }), 'A b.');
    assert.equal(renderTextWithReferences('A [web:1] b.', { rowId: 'a1', index: null, escapeHtml, renderMarkdown: (v) => v }), 'A b.');
    assert.equal(renderTextWithReferences('', { rowId: 'a1', index, escapeHtml, renderMarkdown: (v) => v }), '');
    assert.equal(stripCitationMarkers('A [web:9] b.'), 'A b.');
  });
});

describe('renderSourceList', () => {
  const rows = [
    notice('n1', [
      ref(1, { url: 'https://www.example.com/one', title: 'First page' }),
      ref(2, { url: 'https://www.site.test/two', title: 'site.test' }),
      ref(3, { url: 'https://blog.test/post/deep?q=1#frag', title: 'blog.test', snippet: 'Navigation junk', sourceType: 'page' }),
      ref(4, { url: 'https://unused.test/', title: '' }),
    ]),
    answer('a1', 'A [web:3] B [web:1] C [web:2].'),
  ];

  test('numbered list of cited sources, toggle and hidden also list for the rest', () => {
    const index = buildTurnSourceIndex(rows);
    const text = renderRow(index, 'a1', 'A [web:3] B [web:1] C [web:2].');
    assert.equal(numbersOf(text).join(), '1,2,3');
    const html = renderSourceList(index, { turnId: 'turn:1', escapeHtml });
    assert.match(html, /^<section class="source-list" aria-label="Sources" data-source-list-turn="turn:1">/);
    assert.match(html, /<ol class="source-list-cited">/);
    assert.equal((html.match(/<li class="source-list-item" data-source-ref="\d">/g) || []).length, 3);
    assert.match(html, /<span class="source-list-num" aria-hidden="true">1<\/span>/);
    // Title slot: a real title keeps its site span; a host-equal title shows the site alone.
    assert.match(html, /data-source-ref="3"[^>]*>site\.test<\/a><\/span><\/li>/);
    assert.match(html, />First page<\/a><span class="source-list-site">example\.com<\/span>/);
    assert.doesNotMatch(html, /data-source-site="www\.|source-list-site">www\./);
    // Page ref: site + path (no query, no hash), no site span, empty snippet attribute.
    assert.match(html, /data-source-snippet=""[^>]*>blog\.test\/post\/deep<\/a><\/span>/);
    assert.doesNotMatch(html, /Navigation junk/);
    // Toggle + unnumbered also list.
    assert.match(html, /<button type="button" class="source-list-toggle" aria-expanded="false" aria-controls="source-also-turn-1" data-source-list-toggle="turn:1">Also searched 1 more<\/button>/);
    assert.match(html, /<ul class="source-list-also" id="source-also-turn-1" hidden>/);
    assert.match(html.split('<ul class="source-list-also"')[1], /data-source-ref="" /);
  });

  test('a fully cited turn has no toggle or also list', () => {
    const index = buildTurnSourceIndex([notice('n1', [ref(1)]), answer('a1', 'x [web:1]')]);
    const html = renderSourceList(index, { turnId: 'turn_1', escapeHtml });
    assert.doesNotMatch(html, /source-list-toggle|source-list-also/);
  });

  test('empty refs render an empty string', () => {
    assert.equal(renderSourceList(buildTurnSourceIndex([answer('a1', 'x')]), { turnId: 't', escapeHtml }), '');
    assert.equal(renderSourceList(null, { turnId: 't', escapeHtml }), '');
  });

  test('hostile title, snippet and url never become live markup', () => {
    const index = buildTurnSourceIndex([
      notice('n1', [
        ref(1, { title: '"><img src=x onerror=1>', snippet: '"><svg onload=1>' }),
        { url: 'javascript:alert(1)', title: 'bad', n: 2 },
        ref(3, { url: 'https://ok.test/"onmouseover="x', title: '<b>t</b>' }),
      ]),
      answer('a1', 'a [web:1][web:3]'),
    ]);
    const html = renderSourceList(index, { turnId: '"><x>', escapeHtml });
    assert.doesNotMatch(html, /<img|<svg|<b>|<x>|javascript:/);
    assert.doesNotMatch(html, /"onmouseover=/);
  });

  test('toggle open state survives a re-render and defaults to closed', () => {
    const index = buildTurnSourceIndex(rows);
    assert.equal(isSourceListOpen('turn_open'), false);
    const closed = renderSourceList(index, { turnId: 'turn_open', escapeHtml });
    assert.match(closed, /aria-expanded="false"/);
    assert.match(closed, /<ul class="source-list-also" id="[^"]+" hidden>/);
    setSourceListOpen('turn_open', true);
    assert.equal(isSourceListOpen('turn_open'), true);
    const open = renderSourceList(index, { turnId: 'turn_open', escapeHtml });
    assert.match(open, /aria-expanded="true"/);
    assert.match(open, /<ul class="source-list-also" id="[^"]+">/);
    setSourceListOpen('turn_open', false);
    assert.equal(isSourceListOpen('turn_open'), false);
  });

  test('open state is bounded to the newest 200 turns', () => {
    for (let i = 0; i < 205; i += 1) setSourceListOpen(`bound_${i}`, true);
    assert.equal(isSourceListOpen('bound_0'), false);
    assert.equal(isSourceListOpen('bound_4'), false);
    assert.equal(isSourceListOpen('bound_204'), true);
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

// Streaming variant: the live bubble must never show a marker the settled
// bubble strips, and each frame must extend the previous one so the
// incremental stream renderer keeps its stable prefix.
describe('stripCitationMarkersForStreaming', () => {
  test('strips complete markers and holds back one still arriving', () => {
    assert.equal(stripCitationMarkersForStreaming('Built in 1889 [web:1]. Then'), 'Built in 1889. Then');
    assert.equal(stripCitationMarkersForStreaming('Built in 1889 [web:1'), 'Built in 1889');
    assert.equal(stripCitationMarkersForStreaming('Built in 1889【web: 1, '), 'Built in 1889');
    assert.equal(stripCitationMarkersForStreaming('Built in 1889 [w'), 'Built in 1889');
  });

  test('leaves non-marker brackets alone', () => {
    assert.equal(stripCitationMarkersForStreaming('See [the docs'), 'See [the docs');
    assert.equal(stripCitationMarkersForStreaming('Register for the [webinar'), 'Register for the [webinar');
  });

  test('every streamed frame is a prefix of the settled text', () => {
    const full = 'The tower opened in 1889 [web:1]. It is 330 m tall【web:2,7】 and [the docs](https://example.com) agree [web: 3].\n\nNext paragraph.';
    const settled = stripCitationMarkers(full);
    let previous = '';
    for (let end = 0; end <= full.length; end += 1) {
      const frame = stripCitationMarkersForStreaming(full.slice(0, end));
      assert.ok(settled.startsWith(frame), `frame ${end} is not a prefix of the settled text: ${JSON.stringify(frame)}`);
      assert.ok(frame.startsWith(previous), `frame ${end} rewrote earlier text`);
      assert.doesNotMatch(frame, /web/);
      previous = frame;
    }
  });

  test('a marker that opens a paragraph keeps the blank line and every frame stays a prefix', () => {
    const full = 'Intro\n\n[web:1] Starts a paragraph.\n\nEnd';
    const settled = stripCitationMarkers(full);
    assert.equal(settled, 'Intro\n\n Starts a paragraph.\n\nEnd');
    let previous = '';
    for (let end = 0; end <= full.length; end += 1) {
      const frame = stripCitationMarkersForStreaming(full.slice(0, end));
      assert.ok(frame.startsWith(previous), `frame ${end} rewrote earlier text: ${JSON.stringify(frame)}`);
      previous = frame;
    }
  });
});
