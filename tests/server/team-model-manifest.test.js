'use strict';

// Slice 6-1: the model offer manifest (server/team/model-manifest.js, MN1 to
// MN5 of TEAM_MODEL_SHARING_SPEC). Every limit at its edge and one past it,
// the model-set rule, exact keys, and no refusal that echoes a value.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MODEL_MANIFEST_REASONS, MODEL_TRANSFER_LIMITS, PROVENANCE_SUFFIX, mainModelName, validateModelManifest,
} = require('../../server/team/model-manifest');

const GIB = 1024 ** 3;
const HASH = 'a'.repeat(64);
const MARKER_HASH = 'f00dfeed'.repeat(8);
const MAIN = 'Qwen3-8B-Q4_K_M.gguf';

const file = (name, size = 100, overrides = {}) => ({
  name, size, sha256: HASH, segments: Array(Math.ceil(size / GIB)).fill(HASH), ...overrides,
});

function offer(overrides = {}) {
  return {
    request_id: 'req_1',
    audience: { kind: 'team' },
    display_name: 'Qwen3 8B',
    files: [file(MAIN)],
    provenance: { licence: 'Apache-2.0', source_url: 'https://example.com/qwen', note: '' },
    ...overrides,
  };
}

const withProvenance = (fields) => offer({ provenance: { ...offer().provenance, ...fields } });
const shards = (count, total = count, size = 100, stem = 'Big-Q8_0') => Array.from({ length: count },
  (_, index) => file(`${stem}-${String(index + 1).padStart(5, '0')}-of-${String(total).padStart(5, '0')}.gguf`, size));

function refused(value, reason) {
  const result = validateModelManifest(value);
  assert.equal(result.ok, false, `expected ${reason}`);
  assert.equal(result.reason, reason);
  assert.ok(MODEL_MANIFEST_REASONS.includes(result.reason));
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'reason']);
  return result;
}

function accepted(value) {
  const result = validateModelManifest(value);
  assert.equal(result.ok, true, `refused: ${result.reason}`);
  return result.manifest;
}

const bodyBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');

test('the red-first five: reserved name, dot name, 65 segments, ninth file, 64 KiB + 1 body', () => {
  refused(offer({ files: [file('CON.gguf')] }), 'name_invalid');
  refused(offer({ files: [file('com0.Q4_K_M.gguf')] }), 'name_invalid');
  refused(offer({ files: [file('.hidden-Q4_K_M.gguf')] }), 'name_invalid');
  refused(offer({ files: [file(MAIN, 100, { segments: Array(65).fill(HASH) })] }), 'segments_invalid');
  refused(offer({ files: [file(MAIN, 65 * GIB)] }), 'size_invalid');
  refused(offer({ files: shards(9) }), 'files_count');
  const big = offer();
  big.provenance.licence = 'x'.repeat(64 * 1024 + 1 - bodyBytes(big) + bodyBytes({ licence: 'Apache-2.0' })
    - bodyBytes({ licence: '' }));
  assert.equal(bodyBytes(big), 64 * 1024 + 1);
  refused(big, 'manifest_too_large');
});

test('a good offer is accepted, frozen, and copied', () => {
  const value = offer({ audience: { kind: 'member', member_id: 'member_abc' } });
  const manifest = accepted(value);
  assert.deepEqual(manifest, value);
  assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.files[0].segments));
  assert.ok(Object.isFrozen(manifest.provenance) && Object.isFrozen(manifest.audience));
  value.files[0].name = 'changed.gguf';
  assert.equal(manifest.files[0].name, MAIN);
  assert.equal(mainModelName(manifest), MAIN);
  assert.equal(PROVENANCE_SUFFIX, '.jenny-source.json');
});

test('the limits object holds the spec numbers and is frozen', () => {
  const limits = MODEL_TRANSFER_LIMITS;
  assert.ok(Object.isFrozen(limits));
  assert.equal(limits.maxFiles, 8);
  assert.equal(limits.maxFileBytes, 64 * GIB);
  assert.equal(limits.maxTotalBytes, 256 * GIB);
  assert.equal(limits.partBytes, 4 * 1024 * 1024);
  assert.equal(limits.segmentBytes, GIB);
  assert.equal(limits.maxSegmentsPerFile, 64);
  assert.equal(limits.maxBodyBytes, 64 * 1024);
  assert.equal(limits.windowParts, 4);
  assert.equal(limits.maxOffersPerMember, 16);
  assert.equal(limits.maxOffersPerHost, 128);
  assert.equal(limits.maxPendingDirectOffers, 8);
  assert.equal(limits.flowingPerHost, 2);
  assert.equal(limits.maxFlowingPerHost, 4);
  assert.equal(limits.senderGraceMs, 120_000);
  assert.equal(limits.directOfferLifeMs, 24 * 3600 * 1000);
  assert.equal(limits.hashCacheEntries, 64);
});

test('files: one to eight, sizes 1 to 64 GiB, total at most 256 GiB', () => {
  refused(offer({ files: [] }), 'files_count');
  refused(offer({ files: 'x' }), 'files_count');
  accepted(offer({ files: shards(8) }));
  refused(offer({ files: [file(MAIN, 0)] }), 'size_invalid');
  refused(offer({ files: [file(MAIN, 1.5)] }), 'size_invalid');
  refused(offer({ files: [file(MAIN, '100')] }), 'size_invalid');
  accepted(offer({ files: [file(MAIN, 1)] }));
  accepted(offer({ files: [file(MAIN, 64 * GIB)] }));
  assert.equal(accepted(offer({ files: [file(MAIN, 64 * GIB)] })).files[0].segments.length, 64);
  refused(offer({ files: [file(MAIN, 64 * GIB + 1)] }), 'size_invalid');
  accepted(offer({ files: shards(4, 4, 64 * GIB) }));
  const five = shards(5, 5, 64 * GIB);
  refused(offer({ files: five }), 'total_too_large');
  const edge = shards(5, 5, 63 * GIB);
  edge[4] = { ...edge[4], size: 4 * GIB, segments: Array(4).fill(HASH) };
  assert.equal(edge.reduce((sum, entry) => sum + entry.size, 0), 256 * GIB);
  accepted(offer({ files: edge }));
  edge[4] = { ...edge[4], size: 4 * GIB + 1, segments: Array(5).fill(HASH) };
  refused(offer({ files: edge }), 'total_too_large');
});

test('hashes and segments: 64 lowercase hex, exactly ceil(size / 1 GiB) segments', () => {
  refused(offer({ files: [file(MAIN, 100, { sha256: 'A'.repeat(64) })] }), 'sha256_invalid');
  refused(offer({ files: [file(MAIN, 100, { sha256: 'a'.repeat(63) })] }), 'sha256_invalid');
  refused(offer({ files: [file(MAIN, 100, { segments: [] })] }), 'segments_invalid');
  refused(offer({ files: [file(MAIN, GIB + 1, { segments: [HASH] })] }), 'segments_invalid');
  accepted(offer({ files: [file(MAIN, GIB)] }));
  accepted(offer({ files: [file(MAIN, GIB + 1)] }));
  refused(offer({ files: [file(MAIN, 100, { segments: ['b'.repeat(65)] })] }), 'segments_invalid');
  refused(offer({ files: [file(MAIN, 100, { segments: 'x' })] }), 'segments_invalid');
});

test('names: segment rules, .gguf, no leading dot, 200 units, room for the provenance file, folding', () => {
  refused(offer({ files: [file('model.bin')] }), 'name_invalid');
  accepted(offer({ files: [file('Qwen3-8B-Q4_K_M.GGUF')] }));
  refused(offer({ files: [file('a/b.gguf')] }), 'name_invalid');
  refused(offer({ files: [file('a?.gguf')] }), 'name_invalid');
  refused(offer({ files: [file('a\u0001.gguf')] }), 'name_invalid');
  refused(offer({ files: [file('')] }), 'name_invalid');
  refused(offer({ files: [file(42)] }), 'name_invalid');
  const at200 = `${'m'.repeat(195)}.gguf`;
  assert.equal(at200.length, 200);
  accepted(offer({ files: [file(at200)] }));
  refused(offer({ files: [file(`m${at200}`)] }), 'name_invalid');
  // 132 UTF-16 units and 252 bytes: the name passes, but its provenance file would be 270 bytes.
  const wide = `${'é'.repeat(120)}-Q4_K_M.gguf`;
  assert.ok(Buffer.byteLength(wide) <= 255 && Buffer.byteLength(wide + PROVENANCE_SUFFIX) > 255);
  refused(offer({ files: [file(wide)] }), 'name_invalid');
  const fits = `${'é'.repeat(106)}-Q4_K_M.gguf`;
  assert.ok(Buffer.byteLength(fits + PROVENANCE_SUFFIX) <= 255);
  accepted(offer({ files: [file(fits)] }));
  refused(offer({ files: [file(MAIN), file(MAIN.toLowerCase())] }), 'name_collision');
  refused(offer({ files: [file('Straße-Q4.gguf'), file('STRASSE-Q4.gguf')] }), 'name_collision');
});

test('R14-F05: every name leaves room for the longest name a receive builds from it, at the bound and one past', () => {
  // The receiver's longest: the main model's provenance file moved aside in a rollback, `<name>.jenny-source.json.jenny-moving`.
  const longest = '.jenny-source.json.jenny-moving';
  const atBound = `${'模'.repeat(73)}.gguf`; // 224 bytes: 224 + 31 = 255
  const onePast = `${'模'.repeat(72)}abcd.gguf`; // 225 bytes
  assert.deepEqual([Buffer.byteLength(atBound + longest), Buffer.byteLength(onePast + longest)], [255, 256]);
  accepted(offer({ files: [file(atBound)] }));
  refused(offer({ files: [file(onePast)] }), 'name_invalid');
  refused(offer({ files: [file(`${'模'.repeat(76)}.gguf`)] }), 'name_invalid'); // the reviewer's 233-byte name
  // A companion is checked the same way.
  refused(offer({ files: [file(MAIN), file(`mmproj-${'模'.repeat(72)}.gguf`)] }), 'name_invalid');
});

test('the model set: one main model or one complete shard set, one projector, same-family drafters', () => {
  refused(offer({ files: [file('Alpha-Q4_K_M.gguf'), file('Beta-Q4_K_M.gguf')] }), 'model_set_invalid');
  refused(offer({ files: [file('mmproj-F16.gguf')] }), 'model_set_invalid');
  refused(offer({ files: [file('mtp-Qwen3-8B.gguf')] }), 'model_set_invalid');
  refused(offer({ files: [file(MAIN), file('mtp-Llama-3-8B-Q8_0.gguf')] }), 'model_set_invalid');
  refused(offer({ files: [file(MAIN), file('mmproj-F16.gguf'), file('mmproj-Q8_0.gguf')] }), 'model_set_invalid');
  const full = accepted(offer({
    files: [file(MAIN), file('mmproj-Qwen3-8B-F16.gguf'), file('mtp-Qwen3-8B-Q8_0.gguf'), file('mtp-Qwen3-8B-F16.gguf')],
  }));
  assert.equal(mainModelName(full), MAIN);
  // Shards: every part 1..N present, one stem, one total; an unsplit model beside them is a second main.
  const set = shards(3);
  const reversed = accepted(offer({ files: [...set].reverse() }));
  assert.equal(mainModelName(reversed), set[0].name);
  accepted(offer({ files: shards(1) }));
  refused(offer({ files: [set[0], set[2]] }), 'model_set_invalid');
  const gap = [set[0], set[1], file('Big-Q8_0-00004-of-00003.gguf')];
  refused(offer({ files: gap }), 'model_set_invalid');
  refused(offer({ files: [set[0], set[1], file('Big-Q8_0-00003-of-00004.gguf')] }), 'model_set_invalid');
  refused(offer({ files: [...shards(2, 2), file('Other-Q8_0-00001-of-00001.gguf')] }), 'model_set_invalid');
  refused(offer({ files: [...set, file(MAIN)] }), 'model_set_invalid');
  refused(offer({ files: shards(2, 3) }), 'model_set_invalid');
});

test('request id, audience and display name', () => {
  accepted(offer({ request_id: 'r'.repeat(64) }));
  refused(offer({ request_id: 'r'.repeat(65) }), 'request_id_invalid');
  refused(offer({ request_id: '' }), 'request_id_invalid');
  refused(offer({ request_id: 'a b' }), 'request_id_invalid');
  refused(offer({ audience: { kind: 'member' } }), 'audience_invalid');
  refused(offer({ audience: { kind: 'member', member_id: 'device_x' } }), 'audience_invalid');
  refused(offer({ audience: { kind: 'team', member_id: 'member_x' } }), 'audience_invalid');
  refused(offer({ audience: { kind: 'everyone' } }), 'audience_invalid');
  refused(offer({ audience: null }), 'audience_invalid');
  accepted(offer({ display_name: 'd'.repeat(128) }));
  accepted(offer({ display_name: 'Été \u{1F600} model' }));
  refused(offer({ display_name: 'd'.repeat(129) }), 'display_name_invalid');
  refused(offer({ display_name: '' }), 'display_name_invalid');
  refused(offer({ display_name: 'a\nb' }), 'display_name_invalid');
  refused(offer({ display_name: 'a‮b' }), 'display_name_invalid');
  refused(offer({ display_name: ' padded' }), 'display_name_invalid');
});

test('licence and note: clean text with line feeds and tabs, at most 4,096 and 1,024', () => {
  accepted(withProvenance({ licence: 'MIT License\n\n\tPermission is hereby granted', note: '' }));
  accepted(withProvenance({ licence: '', note: 'line one\nline two' }));
  refused(withProvenance({ licence: 'MIT\u001b[31m' }), 'licence_invalid');
  refused(withProvenance({ licence: 'MIT\r\nmore' }), 'licence_invalid');
  refused(withProvenance({ licence: 'a‮b' }), 'licence_invalid');
  refused(withProvenance({ licence: 'a​b' }), 'licence_invalid');
  refused(withProvenance({ licence: '\n\t' }), 'licence_invalid');
  refused(withProvenance({ licence: null }), 'licence_invalid');
  accepted(withProvenance({ licence: 'l'.repeat(4096) }));
  refused(withProvenance({ licence: 'l'.repeat(4097) }), 'licence_invalid');
  accepted(withProvenance({ note: 'n'.repeat(1024) }));
  refused(withProvenance({ note: 'n'.repeat(1025) }), 'note_invalid');
  refused(withProvenance({ note: 'a\u0000b' }), 'note_invalid');
});

test('source URL: empty or https, at most 512, no user name or password', () => {
  accepted(withProvenance({ source_url: '' }));
  accepted(withProvenance({ source_url: null }));
  const base = 'https://example.com/';
  accepted(withProvenance({ source_url: base + 'p'.repeat(512 - base.length) }));
  refused(withProvenance({ source_url: base + 'p'.repeat(513 - base.length) }), 'source_url_invalid');
  refused(withProvenance({ source_url: 'http://example.com/model' }), 'source_url_invalid');
  refused(withProvenance({ source_url: 'https://user:secret@example.com/model' }), 'source_url_invalid');
  refused(withProvenance({ source_url: 'https://user@example.com/model' }), 'source_url_invalid');
  refused(withProvenance({ source_url: 'file:///etc/passwd' }), 'source_url_invalid');
  refused(withProvenance({ source_url: 'not a url' }), 'source_url_invalid');
  refused(withProvenance({ source_url: 'https://exa mple.com' }), 'source_url_invalid');
  refused(withProvenance({ source_url: 7 }), 'source_url_invalid');
});

test('exact keys at every level, and a non-object at each one', () => {
  refused(offer({ extra: 1 }), 'manifest_keys');
  const missing = offer();
  delete missing.provenance;
  refused(missing, 'manifest_keys');
  refused(offer({ audience: { kind: 'team', extra: 1 } }), 'audience_invalid');
  refused(offer({ files: [{ ...file(MAIN), extra: 1 }] }), 'file_invalid');
  refused(offer({ files: [null] }), 'file_invalid');
  refused(offer({ files: [[MAIN]] }), 'file_invalid');
  refused(withProvenance({ extra: 1 }), 'provenance_invalid');
  refused(offer({ provenance: 'x' }), 'provenance_invalid');
  for (const value of [null, undefined, 'x', 42, [], [offer()], new Date(), new Map()]) {
    refused(value, 'manifest_not_object');
  }
  const cycle = offer();
  cycle.provenance.self = cycle;
  refused(cycle, 'manifest_too_large');
  const trap = new Proxy(offer(), { getPrototypeOf() { throw new Error('trap'); } });
  refused(trap, 'manifest_not_object');
});

test('the body limit: exactly 64 KiB is not refused for size, one byte more is', () => {
  const edge = offer();
  edge.provenance.note = 'x'.repeat(64 * 1024 - bodyBytes(edge));
  assert.equal(bodyBytes(edge), 64 * 1024);
  refused(edge, 'note_invalid');
  edge.provenance.note += 'x';
  refused(edge, 'manifest_too_large');
});

test('no refusal echoes a marker name, hash or URL', () => {
  const markers = ['MARKERNAME', MARKER_HASH, 'markerhost.example'];
  const cases = [
    offer({ files: [file('MARKERNAME?.gguf')] }),
    offer({ files: [file('MARKERNAME-Q4.gguf', 100, { sha256: `${MARKER_HASH}0` })] }),
    offer({ files: [file('MARKERNAME-Q4.gguf', 100, { segments: [MARKER_HASH, MARKER_HASH] })] }),
    offer({ files: [file('MARKERNAME-Q4.gguf'), file('markername-q4.gguf')] }),
    withProvenance({ source_url: 'http://markerhost.example/MARKERNAME' }),
    withProvenance({ source_url: 'https://u:p@markerhost.example/' }),
    offer({ display_name: 'MARKERNAME\n' }),
  ];
  for (const value of cases) {
    const result = validateModelManifest(value);
    assert.equal(result.ok, false);
    const text = JSON.stringify(result);
    for (const marker of markers) assert.ok(!text.includes(marker), `${result.reason} echoes a value`);
  }
});

test('shard numbers in any case form a set; a broken set of them is refused and nothing throws', () => {
  const upper = [file('Big-Q8_0-00001-OF-00002.gguf'), file('Big-Q8_0-00002-OF-00002.gguf')];
  assert.equal(mainModelName(accepted(offer({ files: upper }))), upper[0].name);
  const mixed = [file('big-q8_0-00002-Of-00002.GGUF'), file('Big-Q8_0-00001-oF-00002.gguf')];
  assert.equal(mainModelName(accepted(offer({ files: mixed }))), mixed[1].name);
  refused(offer({ files: [upper[0], file('Big-Q8_0-00003-OF-00003.gguf')] }), 'model_set_invalid');
  refused(offer({ files: [upper[0]] }), 'model_set_invalid');
  assert.doesNotThrow(() => mainModelName({ files: [upper[0]] }));
});

test('a sparse segment list of the right length is refused', () => {
  const sparse = new Array(3);
  sparse[0] = HASH;
  sparse[2] = HASH;
  refused(offer({ files: [file(MAIN, 2 * GIB + 1, { segments: sparse })] }), 'segments_invalid');
  refused(offer({ files: [file(MAIN, 100, { segments: new Array(1) })] }), 'segments_invalid');
});

test('the source URL text itself must start with https:// and hold no backslash', () => {
  refused(withProvenance({ source_url: 'https:example.com/model' }), 'source_url_invalid');
  refused(withProvenance({ source_url: 'https:\\\\example.com\\model' }), 'source_url_invalid');
  refused(withProvenance({ source_url: 'https://example.com\\model' }), 'source_url_invalid');
  refused(withProvenance({ source_url: 'https:/example.com/model' }), 'source_url_invalid');
  accepted(withProvenance({ source_url: 'https://example.com/a/b?c=1#d' }));
});

test('a lone surrogate is refused in the display name, licence and note', () => {
  refused(offer({ display_name: 'name \ud800' }), 'display_name_invalid');
  refused(withProvenance({ licence: 'MIT \udc00' }), 'licence_invalid');
  refused(withProvenance({ note: '\ud83d note' }), 'note_invalid');
  accepted(offer({ display_name: 'name \ud83d\ude00' }));
});

test('keys and the file count are checked before the body is measured', (t) => {
  const stringify = t.mock.method(JSON, 'stringify');
  refused(offer({ extra: 'x'.repeat(70 * 1024) }), 'manifest_keys');
  refused(offer({ files: [...shards(9), { pad: 'x'.repeat(70 * 1024) }] }), 'files_count');
  assert.equal(stringify.mock.callCount(), 0);
  t.mock.restoreAll();
});
