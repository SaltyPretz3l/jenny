'use strict';

// Citations Step 1 — bounded normalizer between UNTRUSTED web_search tool
// output (`sources`/`citations`) and the persisted `source_citations` event
// payload. Mirrors tool-result-diff-metadata.js: http(s)-only urls, bounded
// count + per-field length, fixed sourceType vocabulary, dedupe by url.
// The live web_search contract: citation ids are `web:N` and N is 1-BASED.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSourceCitations,
  MAX_CITATIONS,
} = require('../services/backend/tool-result-source-metadata');

function payloadWith(sources, citations) {
  return { sources, citations };
}

describe('normalizeSourceCitations url safety', () => {
  test('accepts http and https urls only', () => {
    const result = normalizeSourceCitations(payloadWith([
      { url: 'https://example.com/a', title: 'A', snippet: 's1' },
      { url: 'http://example.org/b', title: 'B', snippet: 's2' },
    ]));
    assert.equal(result.refs.length, 2);
    assert.equal(result.refs[0].url, 'https://example.com/a');
    assert.equal(result.refs[1].url, 'http://example.org/b');
  });

  test('rejects javascript:, data:, file:, relative, UNC and protocol-relative urls', () => {
    const result = normalizeSourceCitations(payloadWith([
      { url: 'javascript:alert(1)', title: 'x' },
      { url: 'data:text/html,<script>1</script>', title: 'x' },
      { url: 'file:///C:/secrets.txt', title: 'x' },
      { url: '/relative/path', title: 'x' },
      { url: '//example.com/protocol-relative', title: 'x' },
      { url: '\\\\unc\\share', title: 'x' },
      { url: 'HTTPS://ok.example.com/case', title: 'kept' },
    ]));
    assert.equal(result.refs.length, 1, 'only the https url survives');
    assert.equal(result.refs[0].title, 'kept');
  });

  test('a whitespace-padded or credential-bearing url still parses safely or is dropped', () => {
    const result = normalizeSourceCitations(payloadWith([
      { url: '  https://example.com/padded  ', title: 'padded' },
      { url: 'https://user:pass@example.com/', title: 'creds' },
    ]));
    for (const ref of result.refs) {
      assert.match(ref.url, /^https:\/\//);
    }
  });
});

describe('normalizeSourceCitations bounds', () => {
  test('caps the ref count and reports truncation', () => {
    const many = Array.from({ length: MAX_CITATIONS + 5 }, (_ignored, index) => ({
      url: `https://example.com/${index}`,
      title: `t${index}`,
    }));
    const result = normalizeSourceCitations(payloadWith(many));
    assert.equal(result.refs.length, MAX_CITATIONS);
    assert.equal(result.truncated, true);
  });

  test('bounds title and snippet lengths', () => {
    const result = normalizeSourceCitations(payloadWith([
      { url: 'https://example.com/', title: 'T'.repeat(500), snippet: 'S'.repeat(2000) },
    ]));
    assert.equal(result.refs.length, 1);
    assert.ok(result.refs[0].title.length <= 200, 'title bounded');
    assert.ok(result.refs[0].snippet.length <= 280, 'snippet bounded');
  });

  test('sourceType only passes a fixed vocabulary', () => {
    const result = normalizeSourceCitations(payloadWith([
      { url: 'https://a.example.com/', title: 'a', source_type: 'web' },
      { url: 'https://b.example.com/', title: 'b', source_type: '<img onerror=x>' },
    ]));
    assert.equal(result.refs[0].sourceType, 'web');
    assert.equal(result.refs[1].sourceType, '');
  });
});

describe('normalizeSourceCitations shape + fallbacks', () => {
  test('empty / garbage payloads normalize to null', () => {
    assert.equal(normalizeSourceCitations(null), null);
    assert.equal(normalizeSourceCitations('nope'), null);
    assert.equal(normalizeSourceCitations({}), null);
    assert.equal(normalizeSourceCitations(payloadWith([], [])), null);
    assert.equal(normalizeSourceCitations(payloadWith([{ url: 'javascript:x' }])), null);
  });

  test('falls back to citations for url/title when sources are absent (web:N ids are 1-based, informational only)', () => {
    const result = normalizeSourceCitations(payloadWith(undefined, [
      { id: 'web:1', url: 'https://example.com/one', title: 'One' },
      { id: 'web:2', url: 'https://example.com/two', title: 'Two' },
    ]));
    assert.equal(result.refs.length, 2);
    assert.equal(result.refs[0].title, 'One');
    assert.equal(result.refs[0].snippet, '');
  });

  test('dedupes by url, preferring the sources entry (has snippet)', () => {
    const result = normalizeSourceCitations({
      sources: [{ url: 'https://example.com/dup', title: 'From source', snippet: 'snip' }],
      citations: [{ id: 'web:1', url: 'https://example.com/dup', title: 'From citation' }],
    });
    assert.equal(result.refs.length, 1);
    assert.equal(result.refs[0].title, 'From source');
    assert.equal(result.refs[0].snippet, 'snip');
  });

  test('non-object ref entries are skipped without aborting the batch', () => {
    const result = normalizeSourceCitations(payloadWith([
      null,
      'garbage',
      { url: 'https://example.com/ok', title: 'ok' },
      42,
    ]));
    assert.equal(result.refs.length, 1);
  });

  test('does not HTML-escape fields (payload stays clean data; renderer escapes)', () => {
    const result = normalizeSourceCitations(payloadWith([
      { url: 'https://example.com/', title: 'a < b & c' },
    ]));
    assert.equal(result.refs[0].title, 'a < b & c');
  });
});

// The LIVE wire shape (chat-stream-tool-handling.js noteEvent payload) never
// carries structured `sources`/`citations` keys — the web tool json.dumps its
// whole payload into the `output` param, which lands verbatim in
// `payload.output_text`. The normalizer must recover citations from that JSON
// text (the review-P0 fix).
describe('normalizeSourceCitations output_text fallback (live wire shape)', () => {
  function liveWirePayload(webToolPayload) {
    // Mirrors the fixed field whitelist the tool.result handler builds.
    return {
      tool_name: 'web_search',
      output_text: JSON.stringify(webToolPayload),
      summary: 'Web Search',
      is_error: false,
      error_code: '',
      approval_state: 'auto',
      parent_stream_id: 'web',
      generated_artifacts: [],
    };
  }

  test('recovers citations from JSON embedded in output_text', () => {
    const result = normalizeSourceCitations(liveWirePayload({
      query: 'jenny',
      provider: 'ddg',
      results: [{ title: 'One', url: 'https://example.com/one', snippet: 's1' }],
      sources: [{ url: 'https://example.com/one', title: 'One', snippet: 's1', source_type: 'web' }],
      citations: [{ id: 'web:1', url: 'https://example.com/one', title: 'One' }],
    }));
    assert.ok(result, 'refs recovered from output_text JSON');
    assert.equal(result.refs.length, 1);
    assert.equal(result.refs[0].url, 'https://example.com/one');
    assert.equal(result.refs[0].snippet, 's1');
  });

  test('structured keys win over output_text when both are present', () => {
    const result = normalizeSourceCitations({
      sources: [{ url: 'https://structured.example.com/', title: 'Structured' }],
      output_text: JSON.stringify({
        sources: [{ url: 'https://embedded.example.com/', title: 'Embedded' }],
      }),
    });
    assert.equal(result.refs.length, 1);
    assert.equal(result.refs[0].url, 'https://structured.example.com/');
  });

  test('non-citation tool output never reaches JSON.parse territory', () => {
    assert.equal(normalizeSourceCitations({ output_text: 'PASS tests/foo.test.js\n42 passing' }), null);
    assert.equal(normalizeSourceCitations({ output_text: '{"exit_code": 0, "stdout": "built"}' }), null);
    assert.equal(normalizeSourceCitations({ output_text: '[{"citations": []}]' }), null, 'array-prefixed JSON skipped');
  });

  test('malformed or hostile output_text degrades to null, never throws', () => {
    assert.equal(normalizeSourceCitations({ output_text: '{"citations": [broken' }), null);
    assert.equal(normalizeSourceCitations({ output_text: '{"citations": "not-an-array"}' }), null);
    assert.equal(normalizeSourceCitations({ output_text: '{"citations": [{"url": "javascript:x"}]}' }), null);
    assert.equal(normalizeSourceCitations({ output_text: 42 }), null);
  });

  test('oversized output_text is refused without parsing', () => {
    const bigButValid = '{"citations": [{"url": "https://example.com/"}], "pad": "'
      + 'x'.repeat(300000) + '"}';
    assert.equal(normalizeSourceCitations({ output_text: bigButValid }), null);
  });
});
