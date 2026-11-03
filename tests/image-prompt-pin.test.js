'use strict';

// Row 91: the /image pin's shape, how a pinned message reads to the model, the
// turn lookup the image tool trusts, and the one-render ledger.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeImagePromptPin, withImagePromptPin, projectUserImagePromptPin,
  resolveTurnImagePrompt, storedImagePromptPin, hasPinnedRender, claimPinnedRender, releasePinnedRender,
} = require('../services/backend/image-prompt-pin');
const { normalizeMessageFields } = require('../services/backend/message-normalization');

test('a pin keeps only well-formed options; an empty pin still marks the message', () => {
  assert.deepEqual(normalizeImagePromptPin({}), {});
  assert.deepEqual(normalizeImagePromptPin({ width: 1472, height: 1120, seed: 7, extra: 'dropped' }),
    { width: 1472, height: 1120, seed: 7 });
  assert.deepEqual(normalizeImagePromptPin({ source_artifact_id: 'art_1', region: { kind: 'box', points: [[1, 2], [30, 40]] } }),
    { source_artifact_id: 'art_1', region: { kind: 'box', points: [[1, 2], [30, 40]] } });
  for (const bad of [null, [], 'x', { width: 1024 }, { width: 10, height: 10 }, { seed: -1 }, { seed: 1.5 },
    { source_artifact_id: '../etc' }, { region: { kind: 'box', points: [[1, 2], [3, 4]] } },
    { source_artifact_id: 'a', region: { kind: 'star', points: [[1, 2], [3, 4]] } },
    { source_artifact_id: 'a', region: { kind: 'freehand', points: [[1, 2], [3, 4]] } }]) {
    assert.equal(normalizeImagePromptPin(bad), null, JSON.stringify(bad));
  }
});

test('a pinned user row reads the same live and on replay; other rows are untouched', () => {
  const live = withImagePromptPin('A red kite', {});
  assert.match(live, /^A red kite\n\n\[Image request: .*image_generate once.*exactly as written/s);
  assert.equal(projectUserImagePromptPin({ role: 'user', image_prompt_pin: {} }, 'A red kite'), live);
  assert.equal(projectUserImagePromptPin({ role: 'user' }, 'A red kite'), 'A red kite');
  assert.equal(projectUserImagePromptPin({ role: 'assistant', image_prompt_pin: {} }, 'ok'), 'ok');
  assert.equal(withImagePromptPin('A red kite', null), 'A red kite');
});

test('message normalization stores the pin on user rows only and omits it otherwise', () => {
  const base = { id: 'm1', content: 'A red kite', timestamp: '2026-10-31T00:00:00.000Z' };
  assert.deepEqual(normalizeMessageFields({ ...base, role: 'user', image_prompt_pin: { seed: 3, junk: 1 } }).image_prompt_pin, { seed: 3 });
  assert.equal('image_prompt_pin' in normalizeMessageFields({ ...base, role: 'user' }), false);
  assert.equal('image_prompt_pin' in normalizeMessageFields({ ...base, role: 'assistant', image_prompt_pin: {} }), false);
  assert.equal('image_prompt_pin' in normalizeMessageFields({ ...base, role: 'user', image_prompt_pin: { seed: 'x' } }), false);
});

test('the turn lookup returns the stored text as the prompt, or null', () => {
  const rows = [
    { id: 'u1', role: 'user', turn_id: 't1', content: 'Exact words, verbatim', image_prompt_pin: { width: 1024, height: 1024 } },
    { id: 'a1', role: 'assistant', turn_id: 't1', content: 'Which style?' },
    { id: 'u1b', role: 'user', turn_id: 't1', content: 'Watercolor' },
    { id: 'u2', role: 'user', turn_id: 't2', content: 'Plain message' },
  ];
  const store = { getSession: () => ({ messages: rows }) };
  const drawn = { width: 1024, height: 1024, prompt: 'Exact words, verbatim' };
  assert.deepEqual(resolveTurnImagePrompt(store, 's', { userMessageId: 'u1', turnId: 't1' }), drawn);
  // An answered ask_user continues the same logical turn from a new user row.
  assert.deepEqual(resolveTurnImagePrompt(store, 's', { userMessageId: 'u1b', turnId: 't1' }), drawn);
  assert.equal(resolveTurnImagePrompt(store, 's', { userMessageId: 'u2', turnId: 't2' }), null);
  assert.equal(resolveTurnImagePrompt(store, 's', { userMessageId: 'missing' }), null);
  assert.equal(resolveTurnImagePrompt(store, 's', {}), null);
  assert.equal(resolveTurnImagePrompt({ getSession() { throw new Error('gone'); } }, 's', { userMessageId: 'u1' }), null);
  // The cheap read-only view wins over getSession when the store has it.
  const peeked = { peekSessionMessages: () => rows, getSession() { throw new Error('not used'); } };
  assert.deepEqual(resolveTurnImagePrompt(peeked, 's', { userMessageId: 'u1' }), drawn);
});

test('the ledger remembers drawn turns per service, bounded', () => {
  const service = {};
  const turn = { turnId: 't1', userMessageId: 'u1' };
  assert.equal(claimPinnedRender(service, 's', { userMessageId: 'u1' }), false, 'no turn identity, no claim');
  assert.equal(hasPinnedRender(service, 's', turn), false);
  assert.equal(claimPinnedRender(service, 's', turn), true);
  assert.equal(claimPinnedRender(service, 's', turn), false, 'a second image call in the turn is refused');
  assert.equal(claimPinnedRender(service, 's', { turnId: 't1', userMessageId: 'u1b' }), false, 'also after an ask_user continuation');
  assert.equal(hasPinnedRender(service, 's', turn), true);
  assert.equal(hasPinnedRender({}, 's', turn), false);
  releasePinnedRender(service, 's', turn);
  assert.equal(claimPinnedRender(service, 's', turn), true, 'a failed render gives the claim back');
  for (let index = 0; index < 64; index += 1) claimPinnedRender(service, 's', { turnId: `t${index + 2}`, userMessageId: 'u' });
  assert.equal(hasPinnedRender(service, 's', turn), false, 'the oldest turn falls out past the bound');
});
