'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FAMILY, png, fixture } = require('../helpers/image-generate-fixture');

const PREVIEW_FAMILY = { ...FAMILY, preview: 'proj' };

// A runner that reports phases like sd-cli does and writes two preview frames.
function progressRunner(calls) {
  return async (options) => {
    calls.push(['run', options]);
    const frame = (index) => path.join(options.scratchDir, `${options.opId}-preview-00${index}.png`);
    options.onProgress({ phase: 'load' });
    fs.writeFileSync(frame(0), png(4, 4));
    options.onProgress({ phase: 'sample', step: 2, steps: 20, fraction: 0.1 });
    options.onProgress({ phase: 'sample', step: 3, steps: 20, fraction: 0.15 });
    fs.writeFileSync(frame(1), png(4, 4));
    options.onProgress({ phase: 'sample', step: 4, steps: 20, fraction: 0.2 });
    options.onProgress({ phase: 'decode' });
    // The runner's closing report after the PNG check must not step back to sampling.
    options.onProgress({ phase: 'sample', step: 20, steps: 20, fraction: 1 });
    const buffer = png(options.expectedWidth, options.expectedHeight);
    await fs.promises.writeFile(options.outputPath, buffer);
    return { status: 'ok', exitCode: 0, seconds: { load: 1, sample: 2, total: 3 },
      png: { width: options.expectedWidth, height: options.expectedHeight, buffer }, stderrTail: [] };
  };
}

function managed(f) {
  f.context.backendService.imageEngine.resolveExecutable = () => ({ ok: true, path: path.join(f.root, 'sd-cli.exe'), source: 'managed', tag: 'test-tag' });
}

test('a managed render reports phases in order with each new preview frame once, then removes the frames', async (t) => {
  const calls = [];
  const f = fixture(t, { runImageGeneration: progressRunner(calls), loadFamilies: () => ({ families: { test_family: PREVIEW_FAMILY } }) });
  managed(f);
  const events = [];
  const result = await f.tool.execute(f.input, { ...f.context, onProgress: (event) => events.push(event) });
  assert.equal(result.isError, false);

  assert.deepEqual(events.map(({ phase, step }) => [phase, step]),
    [['gpu', undefined], ['load', undefined], ['sample', 2], ['sample', 3], ['sample', 4], ['decode', undefined]]);
  assert.ok(events[2].preview.startsWith('data:image/png;base64,'));
  assert.equal(events[3].preview, undefined, 'no new frame, no preview');
  assert.ok(events[4].preview.startsWith('data:image/png;base64,'));
  assert.ok(!('fraction' in events[2]));

  const { argv, scratchDir, opId } = calls[0][1];
  const at = argv.indexOf('--preview');
  assert.deepEqual(argv.slice(at, at + 6), ['--preview', 'proj', '--preview-interval', '2', '--preview-path',
    path.join(scratchDir, `${opId}-preview-%03d.png`)]);
  assert.equal(argv.at(-2), '-o');
  assert.deepEqual(fs.readdirSync(scratchDir).filter((name) => name.includes('-preview-')), []);
});

test('a custom engine, a family without a preview method, or a missing listener get no previews and still render', async (t) => {
  for (const [label, setup] of [
    ['custom engine', (f) => f],
    ['no preview family', (f) => { managed(f); f.dependencies.loadFamilies = () => ({ families: { test_family: FAMILY } }); }],
  ]) {
    const calls = [];
    const f = fixture(t, { runImageGeneration: progressRunner(calls), loadFamilies: () => ({ families: { test_family: PREVIEW_FAMILY } }) });
    setup(f);
    const tool = require('../../services/tools/builtin/image-generate-tool').createImageGenerateTool(f.dependencies);
    const events = [];
    const result = await tool.execute(f.input, { ...f.context, onProgress: (event) => events.push(event) });
    assert.equal(result.isError, false, label);
    assert.equal(calls[0][1].argv.includes('--preview'), false, label);
    assert.ok(events.every((event) => !event.preview), label);
  }
  const calls = [];
  const f = fixture(t, { runImageGeneration: progressRunner(calls), loadFamilies: () => ({ families: { test_family: PREVIEW_FAMILY } }) });
  managed(f);
  assert.equal((await f.tool.execute(f.input, f.context)).isError, false);
  const throwing = await f.tool.execute(f.input, { ...f.context, onProgress: () => { throw new Error('listener'); } });
  assert.equal(throwing.isError, false, 'a failing listener never interrupts the render');
});
