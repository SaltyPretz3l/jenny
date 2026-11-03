'use strict';

// Row 91: on a /image turn the user's text and options replace the model's
// arguments; only a valid model title survives, and provenance names the source.

const test = require('node:test');
const assert = require('node:assert/strict');

const { fixture } = require('../helpers/image-generate-fixture');

test('a pinned turn draws the user text at the pinned size and seed, ignoring the model', async (t) => {
  const f = fixture(t);
  const context = { ...f.context, imagePromptPin: { prompt: 'Exact user words, painterly', width: 1472, height: 1120, seed: 9 } };
  const result = await f.tool.execute({ prompt: 'A model rewrite, cinematic, highly detailed', title: 'Model title',
    negative_prompt: 'blur', width: 1024, height: 1024, seed: 42, steps: 50, cfg_scale: 9, model_set_id: 'ffffffffffff' }, context);
  assert.equal(result.isError, false);
  const { argv } = f.calls.find(([kind]) => kind === 'run')[1];
  assert.equal(argv[argv.indexOf('-p') + 1], 'Exact user words, painterly');
  assert.equal(argv.includes('-n'), false, 'the model negative prompt is dropped');
  assert.deepEqual([argv[argv.indexOf('-W') + 1], argv[argv.indexOf('-H') + 1]], ['1472', '1120']);
  assert.equal(argv[argv.indexOf('-s') + 1], '9');
  assert.equal(argv[argv.indexOf('--steps') + 1], '20', 'family default steps, not the model value');
  assert.equal(argv[argv.indexOf('--cfg-scale') + 1], '2.5');
  assert.equal(f.calls.find(([kind]) => kind === 'resolve')[1], 'abcdef123456', 'the default set, not the model pick');
  const { provenance } = result.metadata;
  assert.equal(provenance.image_prompt, 'Exact user words, painterly');
  assert.equal(provenance.prompt_source, 'user');
  assert.equal(f.calls.find(([kind]) => kind === 'artifact')[2].title, 'Model title');
});

test('a pinned turn falls back to the prompt title when the model title is invalid', async (t) => {
  const f = fixture(t);
  const context = { ...f.context, imagePromptPin: { prompt: 'A quiet harbour' } };
  const result = await f.tool.execute({ prompt: 'x', title: 'T'.repeat(140) }, context);
  assert.equal(result.isError, false);
  assert.equal(f.calls.find(([kind]) => kind === 'artifact')[2].title, 'A quiet harbour');
  const { argv } = f.calls.find(([kind]) => kind === 'run')[1];
  assert.deepEqual([argv[argv.indexOf('-W') + 1], argv[argv.indexOf('-H') + 1]], ['1024', '1024']);
});

test('without a pin the model prompt is drawn and recorded as the model\'s', async (t) => {
  const f = fixture(t);
  const result = await f.tool.execute(f.input, f.context);
  assert.equal(result.isError, false);
  assert.equal(result.metadata.provenance.image_prompt, 'A quiet garden');
  assert.equal(result.metadata.provenance.prompt_source, 'model');
});
