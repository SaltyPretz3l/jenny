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

describe('normalizeSourceCitations keeps each ref\'s web:N number (row 154)', () => {
  test('a sources entry is numbered by its slot in the raw array, invalid slots included', () => {
    const result = normalizeSourceCitations(payloadWith([
      { url: 'https://example.com/one', title: 'One' },
      { url: 'javascript:alert(1)', title: 'Evil' },
      { url: 'https://example.com/three', title: 'Three' },
    ]));
    assert.deepEqual(result.refs.map((ref) => ref.n), [1, 3]);
  });

  test('a citations entry takes N from its web:N id; a malformed id leaves n unset', () => {
    const result = normalizeSourceCitations(payloadWith(undefined, [
      { id: 'web:4', url: 'https://example.com/four', title: 'Four' },
      { id: 'web:x', url: 'https://example.com/bad', title: 'Bad' },
      { id: 'web:1234', url: 'https://example.com/long', title: 'Long' },
      { url: 'https://example.com/none', title: 'None' },
    ]));
    assert.deepEqual(result.refs.map((ref) => ref.n), [4, undefined, undefined, undefined]);
    assert.equal('n' in result.refs[1], false, 'no n key when nothing parsed');
  });

  test('a source and a citation sharing a url keep the source ref and its n', () => {
    const result = normalizeSourceCitations({
      sources: [{ url: 'https://example.com/dup', title: 'From source', snippet: 'snip' }],
      citations: [{ id: 'web:1', url: 'https://example.com/dup', title: 'From citation' }],
    });
    assert.equal(result.refs.length, 1);
    assert.equal(result.refs[0].n, 1);
    assert.equal('alsoN' in result.refs[0], false, 'the same N is not repeated');
  });

  test('a later duplicate url keeps its N on the surviving ref as alsoN', () => {
    const result = normalizeSourceCitations(payloadWith([
      { url: 'https://example.com/a', title: 'A' },
      { url: 'https://example.com/b', title: 'B' },
      { url: 'https://example.com/a', title: 'A again' },
    ]));
    assert.equal(result.refs.length, 2);
    assert.equal(result.refs[0].n, 1);
    assert.deepEqual(result.refs[0].alsoN, [3]);
  });

  test('alsoN is bounded', () => {
    const dupes = Array.from({ length: 40 }, () => ({ url: 'https://example.com/same', title: 'Same' }));
    const result = normalizeSourceCitations(payloadWith(dupes));
    assert.equal(result.refs.length, 1);
    assert.ok(result.refs[0].alsoN.length <= 12, 'alsoN capped');
  });

  test('a fetched page maps to the page source type', () => {
    const result = normalizeSourceCitations(payloadWith([
      { url: 'https://blog.example.com/post', title: 'blog.example.com', snippet: 'Skip to main content', source_type: 'fetched_url' },
    ]));
    assert.equal(result.refs[0].sourceType, 'page');
    assert.equal(result.refs[0].n, 1);
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

  // Gate sitting 2026-11-14 (G4): with the canonical bridge on, the collector sees the sidecar's
  // turn-event payload, which names the tool output `tool_output_summary` (chat_serialization.py),
  // never `output_text`, so no source_citations event was ever derived in the real app.
  test('recovers citations from the canonical tool_output_summary field', () => {
    const result = normalizeSourceCitations({
      tool_name: 'web_search',
      success: true,
      tool_output_summary: JSON.stringify({
        query: 'jenny',
        sources: [{ url: 'https://example.com/one', title: 'One', snippet: 's1', source_type: 'web_result' }],
        citations: [{ id: 'web:1', url: 'https://example.com/one', title: 'One' }],
      }),
      content_type: 'application/json',
    });
    assert.ok(result, 'refs recovered from tool_output_summary JSON');
    assert.equal(result.refs.length, 1);
    assert.equal(result.refs[0].url, 'https://example.com/one');
    assert.equal(result.refs[0].n, 1);
  });

  test('output_text wins over tool_output_summary when both carry JSON', () => {
    const result = normalizeSourceCitations({
      output_text: JSON.stringify({ sources: [{ url: 'https://live.example.com/', title: 'Live' }] }),
      tool_output_summary: JSON.stringify({ sources: [{ url: 'https://saved.example.com/', title: 'Saved' }] }),
    });
    assert.equal(result.refs[0].url, 'https://live.example.com/');
  });

  test('a later call of the turn numbers its sources by slot plus citation_offset', () => {
    const result = normalizeSourceCitations({
      output_text: JSON.stringify({
        citation_offset: 2,
        sources: [
          { url: 'https://example.com/three', title: 'Three' },
          { url: 'https://example.com/four', title: 'Four' },
        ],
        citations: [
          { id: 'web:3', url: 'https://example.com/three', title: 'Three' },
          { id: 'web:4', url: 'https://example.com/four', title: 'Four' },
        ],
      }),
    });
    assert.deepEqual(result.refs.map((entry) => entry.n), [3, 4]);
    assert.equal(result.refs[0].alsoN, undefined, 'sources and citations agree: no alsoN');
  });

  test('citation_offset is read from structured payloads too and defaults to zero', () => {
    const shifted = normalizeSourceCitations({
      citation_offset: 5,
      sources: [{ url: 'https://example.com/a', title: 'A' }],
    });
    assert.equal(shifted.refs[0].n, 6);
    const plain = normalizeSourceCitations({ sources: [{ url: 'https://example.com/a', title: 'A' }] });
    assert.equal(plain.refs[0].n, 1);
  });

  test('a citation_offset that is not a non-negative integer is ignored', () => {
    for (const bad of [-1, 1.5, '2', null, true, [2], Number.NaN]) {
      const result = normalizeSourceCitations({
        citation_offset: bad,
        sources: [{ url: 'https://example.com/a', title: 'A' }],
      });
      assert.equal(result.refs[0].n, 1, `offset ${JSON.stringify(bad)} ignored`);
    }
  });

  test('oversized output_text is refused without parsing', () => {
    const bigButValid = '{"citations": [{"url": "https://example.com/"}], "pad": "'
      + 'x'.repeat(300000) + '"}';
    assert.equal(normalizeSourceCitations({ output_text: bigButValid }), null);
  });
});
