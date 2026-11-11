'use strict';

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FLOOR_CONTEXT,
  fitToolPath,
  memoryDefaultArgs,
  parseFitOutput,
  planLaunchMemory,
} = require('../services/backend/llama-server-memory-fit');

const BINARY = path.join('G:', 'runtime', 'llama-server.exe');
const TOOL = path.join('G:', 'runtime', 'llama-fit-params.exe');
const MODEL = 'G:/models/qwen/model.gguf';
const PROJECTOR = 'G:/models/qwen/mmproj-F16.gguf';
const MIB = 1024 * 1024;

function makeFs(files = { [TOOL]: 1 }) {
  return {
    statSync(filePath) {
      if (!Object.prototype.hasOwnProperty.call(files, filePath)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return { size: files[filePath], isFile: () => true };
    },
  };
}

function makeExec(stdout, error = null) {
  const calls = [];
  const execFileImpl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    setImmediate(() => callback(error, stdout, ''));
  };
  return { calls, execFileImpl };
}

function plan(overrides = {}) {
  return planLaunchMemory({
    binaryPath: BINARY,
    modelPath: MODEL,
    requestedContext: 262_144,
    platform: 'win32',
    fsImpl: makeFs(),
    ...overrides,
  });
}

test('one slot and a q8_0 KV cache are the defaults unless the profile names them', () => {
  assert.deepEqual(memoryDefaultArgs([]), ['-np', '1', '-ctk', 'q8_0', '-ctv', 'q8_0']);
  assert.deepEqual(memoryDefaultArgs(['-ctk', 'f16', '--parallel', '2']), ['-ctv', 'q8_0']);
  assert.deepEqual(memoryDefaultArgs(['-np', '4', '--cache-type-k=q4_0', '--cache-type-v', 'q4_0']), []);
  assert.deepEqual(memoryDefaultArgs(null), ['-np', '1', '-ctk', 'q8_0', '-ctv', 'q8_0']);
});

test('the fit tool is the build sibling of the server binary', () => {
  assert.equal(fitToolPath(BINARY, { platform: 'win32', fsImpl: makeFs() }), TOOL);
  assert.equal(fitToolPath(BINARY, { platform: 'win32', fsImpl: makeFs({}) }), '');
  assert.equal(fitToolPath('', { platform: 'win32', fsImpl: makeFs() }), '');
});

test('parseFitOutput reads the last argument line', () => {
  assert.deepEqual(parseFitOutput('log noise\n-c 220928 -ngl -1\n'), { contextSize: 220_928, gpuLayers: -1, overrides: false });
  assert.deepEqual(parseFitOutput('-c 4096 -ngl 30 -ot blk.40=CPU\r\n'), { contextSize: 4096, gpuLayers: 30, overrides: true });
  assert.equal(parseFitOutput('no arguments here'), null);
  assert.equal(parseFitOutput(''), null);
});

test('a context that does not fit is capped where every layer stays on the GPU', async () => {
  const exec = makeExec('-c 194048 -ngl -1\n');
  const result = await plan({
    headroomMb: 2048,
    projectorPath: PROJECTOR,
    fsImpl: makeFs({ [TOOL]: 1, [PROJECTOR]: 885 * MIB }),
    profileExtraArgs: ['--flash-attn', 'on', '-ub', '1024', '--jinja'],
    execFileImpl: exec.execFileImpl,
  });

  assert.equal(result.reason, 'context_reduced');
  assert.equal(result.contextSize, 194_048);
  assert.equal(result.marginMb, 1024 + 2048 + 885);
  // The server counts the MTP draft itself: its margin leaves the headroom out.
  assert.deepEqual(result.extraArgs, ['-np', '1', '-ctk', 'q8_0', '-ctv', 'q8_0', '--fit-target', '1909']);
  assert.equal(exec.calls[0].file, TOOL);
  assert.deepEqual(exec.calls[0].args, [
    '-m', MODEL, '-np', '1', '-ctk', 'q8_0', '-ctv', 'q8_0', '--flash-attn', 'on', '-ub', '1024',
    '--fit-target', '3957', '--fit-ctx', String(FLOOR_CONTEXT),
  ]);
  assert.equal(exec.calls[0].options.windowsHide, true);
  assert.equal(Object.hasOwn(exec.calls[0].options, 'signal'), false, 'no signal, no option');
});

test('a requested context inside the fit is kept', async () => {
  const exec = makeExec('-c 194048 -ngl -1\n');
  const result = await plan({ requestedContext: 65_536, execFileImpl: exec.execFileImpl });
  assert.equal(result.reason, 'fits');
  assert.equal(result.contextSize, 65_536);
  assert.equal(result.fittedContext, 194_048);
});

test('the cap never drops below the floor context', async () => {
  const exec = makeExec('-c 8192 -ngl -1\n');
  const result = await plan({ requestedContext: 131_072, execFileImpl: exec.execFileImpl });
  assert.equal(result.contextSize, FLOOR_CONTEXT);
  const small = await plan({ requestedContext: 16_384, execFileImpl: makeExec('-c 8192 -ngl -1\n').execFileImpl });
  assert.equal(small.contextSize, 16_384, 'a request below the floor is the user\'s');
});

test('a model whose layers still spill reports spill at the fitted context', async () => {
  const exec = makeExec('-c 32768 -ngl 40\n');
  const result = await plan({ execFileImpl: exec.execFileImpl });
  assert.equal(result.reason, 'spill');
  assert.equal(result.contextSize, 32_768);
  assert.equal(result.gpuLayers, 40);
});

test('a profile that places layers or turns fit off owns placement', async () => {
  for (const profileExtraArgs of [['-ngl', '30'], ['--fit=off'], ['--fit', 'off'], ['-ot', 'exps=CPU']]) {
    const exec = makeExec('-c 1 -ngl -1');
    const result = await plan({ profileExtraArgs, execFileImpl: exec.execFileImpl });
    assert.equal(result.reason, 'profile_owns_placement');
    assert.equal(result.contextSize, 262_144);
    assert.equal(exec.calls.length, 0);
  }
});

test('every fit failure keeps the requested context and the KV defaults', async () => {
  const missing = await plan({ fsImpl: makeFs({}) });
  assert.equal(missing.reason, 'fit_tool_missing');
  assert.equal(missing.contextSize, 262_144);
  assert.deepEqual(missing.extraArgs, ['-np', '1', '-ctk', 'q8_0', '-ctv', 'q8_0']);

  const failed = await plan({ execFileImpl: makeExec('', new Error('timeout')).execFileImpl });
  assert.equal(failed.reason, 'fit_failed');
  assert.equal(failed.contextSize, 262_144);

  const unparsed = await plan({ execFileImpl: makeExec('error: unknown argument\n').execFileImpl });
  assert.equal(unparsed.reason, 'fit_unparsed');
  assert.equal(unparsed.contextSize, 262_144);
  assert.deepEqual(unparsed.extraArgs, ['-np', '1', '-ctk', 'q8_0', '-ctv', 'q8_0']);
});

test('an abort signal is handed to the fit tool', async () => {
  const exec = makeExec('-c 194048 -ngl -1\n');
  const controller = new AbortController();
  await plan({ execFileImpl: exec.execFileImpl, signal: controller.signal });
  assert.equal(exec.calls[0].options.signal, controller.signal);
});
