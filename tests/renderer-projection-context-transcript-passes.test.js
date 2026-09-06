// P3-PERF-B. buildProjectionContext used to walk the whole transcript TWICE
// before it ever consulted the whole-projection cache: once to index messages
// by id, and again to index each message's content fingerprint. The second map
// is consumed only by the projection REBUILD, and the whole-projection cache
// misses on every committed streaming delta, so both passes were paid on every
// render regardless of cache state and scaled with session length.
//
// These are counting oracles, not timers: the message objects expose `id` and
// the fingerprint entries expose `content` as getters, so a second pass over
// either array is directly observable and a regression is a hard failure rather
// than a flaky budget. tests/renderer-long-thread-performance.test.js cannot
// cover this — it calls the projector directly and bypasses both caches.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createProjectionContextPipeline,
} = require('../renderer/chat/renderer-render-pipeline-projection-context');

const SESSION_ID = 'session-projection-passes';

// `ids` may repeat: the two indexes are independent first-id-wins maps over the
// same array, which is exactly the property fusing their loops could break.
function buildHarness(ids) {
  const counters = { idReads: 0, fingerprintReads: 0 };
  const messages = ids.map((id, index) => {
    const message = { role: index % 2 === 0 ? 'user' : 'assistant', content: `body ${index}` };
    Object.defineProperty(message, 'id', {
      enumerable: true,
      get() {
        counters.idReads += 1;
        return id;
      },
    });
    return message;
  });
  const cacheBySession = new Map();
  const hydrationCalls = [];
  // One stable array identity: the turn-event contribution to the cache key is
  // an identity-keyed revision, so a fresh array per call would change the
  // signature every render and no cache could ever hit.
  const turnEventState = { turnEventLogVersion: 0, turnEvents: [] };
  const pipeline = createProjectionContextPipeline({
    state: { currentSessionId: SESSION_ID },
    callbacks: {
      // Truthiness gates in this module; the projection itself is the stubbed
      // buildHydratedTurnProjection below.
      projectTurnTree: () => ({ turns: [] }),
      projectTurnRows: () => [],
      computeProjectionSignatureFromFingerprints: (fingerprints) =>
        fingerprints.map((entry) => entry.content).join('|'),
      computeProjectionSignature() {
        throw new Error('a fingerprint list was supplied; the re-fingerprint path must not run');
      },
      getProjectionContextCache(sessionId, options) {
        const key = String(sessionId || '');
        let cache = cacheBySession.get(key) || null;
        if (!cache && options && options.create) {
          cache = {};
          cacheBySession.set(key, cache);
        }
        return cache;
      },
      getPersistedTurnEventState: () => turnEventState,
      buildHydratedTurnProjection(_messages, _threadTree, _turnEventState, options) {
        hydrationCalls.push(options);
        return {
          turnTree: { turns: [] },
          turnById: new Map(),
          turnIdByMessageId: new Map(),
          rowsByTurnId: new Map(),
          rowByPrimaryMessageId: new Map(),
          rowsByRenderMessageId: new Map(),
          viewModelByTurnId: new Map(),
        };
      },
    },
  });

  function render(revision) {
    const messageFingerprints = ids.map((_id, index) => {
      const content = `fp_${index}_${revision}`;
      return {
        get content() {
          counters.fingerprintReads += 1;
          return content;
        },
      };
    });
    return pipeline.buildProjectionContext(messages, null, {}, { messageFingerprints });
  }

  return { counters, messages, render, hydrationCalls };
}

function idsForCount(count) {
  return Array.from({ length: count }, (_value, index) => `msg_${index}`);
}

test('a projection rebuild indexes the transcript in one pass, not two', () => {
  const harness = buildHarness(idsForCount(40));
  harness.counters.idReads = 0;
  harness.counters.fingerprintReads = 0;

  const context = harness.render('r1');

  assert.equal(harness.hydrationCalls.length, 1, 'a cold cache must rebuild the projection');
  assert.equal(context.available, true);
  assert.equal(context.messageById.size, 40);
  const fingerprintById = harness.hydrationCalls[0].messageContentFingerprintById;
  assert.ok(fingerprintById instanceof Map, 'a rebuild must still receive the fingerprint index');
  assert.equal(fingerprintById.size, 40);
  assert.equal(fingerprintById.get('msg_7'), 'fp_7_r1');

  // One `id` read per message: the two indexes are built in a single fused
  // walk. Before this fix it was two reads per message on every render.
  assert.equal(harness.counters.idReads, 40, 'the transcript must be walked exactly once');
  // The fingerprint LIST is legitimately read twice on a rebuild — once for the
  // cache signature, once to build the index the rebuild consumes. That is real
  // work, not waste; the cache-hit case below is where it must disappear.
  assert.equal(harness.counters.fingerprintReads, 80);
});

test('a whole-projection cache hit never builds the fingerprint index', () => {
  const harness = buildHarness(idsForCount(40));
  harness.render('r1');
  assert.equal(harness.hydrationCalls.length, 1);
  harness.counters.idReads = 0;
  harness.counters.fingerprintReads = 0;

  const context = harness.render('r1');

  assert.equal(harness.hydrationCalls.length, 1, 'an unchanged signature must reuse the cached projection');
  assert.equal(context.available, true);
  assert.equal(context.messageById.size, 40, 'messageById is part of the returned context, so it is still built');
  // The fingerprint index is consumed only by the rebuild, so a hit reads the
  // fingerprint list once for the cache signature and never again.
  assert.equal(harness.counters.idReads, 40, 'the transcript must be walked exactly once');
  assert.equal(
    harness.counters.fingerprintReads,
    40,
    'a cache hit reads the fingerprint list only for the signature'
  );
});

test('every rebuild after a delta still receives a populated fingerprint index', () => {
  const harness = buildHarness(idsForCount(12));
  for (let delta = 0; delta < 5; delta += 1) {
    harness.render(`d${delta}`);
  }

  assert.equal(harness.hydrationCalls.length, 5, 'each changed signature must re-hydrate');
  // Guards the one way this refactor can fail silently: if the cache-hit test
  // and the rebuild branch ever stop agreeing, the rebuild gets a null index
  // and the per-turn projection cache degrades to a full re-projection.
  for (let call = 0; call < harness.hydrationCalls.length; call += 1) {
    const fingerprintById = harness.hydrationCalls[call].messageContentFingerprintById;
    assert.ok(fingerprintById instanceof Map, `rebuild ${call} lost its fingerprint index`);
    assert.equal(fingerprintById.size, 12);
    assert.equal(fingerprintById.get('msg_3'), `fp_3_d${call}`);
  }
});

test('the fused index keeps first-id-wins for both maps when ids repeat', () => {
  const harness = buildHarness(['dup', 'dup', 'tail']);

  const context = harness.render('r1');

  assert.equal(context.messageById.size, 2);
  assert.equal(context.messageById.get('dup'), harness.messages[0], 'the FIRST message under an id wins');
  const fingerprintById = harness.hydrationCalls[0].messageContentFingerprintById;
  assert.equal(fingerprintById.size, 2);
  assert.equal(fingerprintById.get('dup'), 'fp_0_r1', 'the FIRST fingerprint under an id wins');
  assert.equal(fingerprintById.get('tail'), 'fp_2_r1');
});
