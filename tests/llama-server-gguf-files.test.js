'use strict';

// GGUF file discovery (services/llama-server-gguf-files.js): which files in a
// model directory are the main model, the MTP drafters and the vision
// projectors, which projector pairs with which model, and what that pairing
// does to a launch. The lifecycle re-exports these names; the listLocalGgufs
// view of the same rules is covered in tests/llama-server-ipc-handlers.test.js.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ggufFiles = require('../services/llama-server-gguf-files');
const lifecycle = require('../services/llama-server-lifecycle');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');
const {
  FakeChildProcess,
  closeServer,
  getClosedPort,
  listen,
  makeUserDataDir,
} = require('./helpers/llama-server-lifecycle-fixtures');

const { pairProjector, resolveGgufPath, resolveProjectorPath, splitGgufFiles } = ggufFiles;

// PrismML's layout: the model and its vision projector, named infix-style.
const BONSAI_MODEL = 'Ternary-Bonsai-2-27B-PQ2_0.gguf';
const BONSAI_PROJECTOR = 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf';
// A text-only model with no projector of its own.
const QWEN = 'Qwen3-8B-Q4_K_M.gguf';

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// `<userData>/models/<tag>/` holding an empty file per name.
function makeModelDir(tag, names) {
  const userDataPath = makeUserDataDir('jenny-gguf-files-');
  const dir = path.join(userDataPath, 'models', tag);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) {
    fs.writeFileSync(path.join(dir, name), '');
  }
  return { userDataPath, dir, repoRoot: path.join(userDataPath, 'repo') };
}

// The projector file name resolveProjectorPath pairs with `model` in a real
// directory holding `names` ('' = none).
function pairingIn(names) {
  const { dir } = makeModelDir('pairing', names);
  return (model) => {
    const projectorPath = resolveProjectorPath({ modelPath: path.join(dir, model) });
    if (projectorPath) {
      assert.equal(path.dirname(projectorPath), dir);
    }
    return projectorPath ? path.basename(projectorPath) : '';
  };
}

// Same, over a stubbed listing returned in exactly this order: a real NTFS
// readdir always comes back sorted, so directory order cannot be forced on disk.
function pairedInListing(names, model) {
  const projectorPath = resolveProjectorPath({
    modelPath: path.join('models', model),
    fsImpl: { readdirSync: () => [...names] },
  });
  return projectorPath ? path.basename(projectorPath) : '';
}

test('a Bonsai-style folder splits into one main model and one infix projector that pair', () => {
  const { userDataPath, dir, repoRoot } = makeModelDir('ternary-bonsai-2-27b', [BONSAI_MODEL, BONSAI_PROJECTOR]);

  assert.deepEqual(splitGgufFiles(fs.readdirSync(dir)), {
    main: [BONSAI_MODEL],
    drafters: [],
    projectors: [BONSAI_PROJECTOR],
  });
  assert.deepEqual(resolveGgufPath({ modelTag: 'ternary-bonsai-2-27b', userDataPath, repoRoot }), {
    path: path.join(dir, BONSAI_MODEL),
    projectorPath: path.join(dir, BONSAI_PROJECTOR),
    reason: 'resolved',
  });
  assert.equal(resolveProjectorPath({ modelPath: path.join(dir, BONSAI_MODEL) }), path.join(dir, BONSAI_PROJECTOR));
  assert.equal(
    pairProjector(dir, BONSAI_MODEL, splitGgufFiles([BONSAI_MODEL, BONSAI_PROJECTOR])),
    path.join(dir, BONSAI_PROJECTOR),
  );
});

test('infix projector names are recognised on the base name, whatever the separator or case', () => {
  assert.deepEqual(splitGgufFiles([
    'x-mmproj-Q8_0.gguf',
    'x.mmproj-f16.gguf',
    'mmproj-x-f16.gguf',
    'x_mmproj.gguf',
    'Model-MMPROJ-F16.GGUF',
    'x-mmproj-f16.bin',
  ]), {
    main: [],
    drafters: [],
    projectors: ['Model-MMPROJ-F16.GGUF', 'mmproj-x-f16.gguf', 'x-mmproj-Q8_0.gguf', 'x.mmproj-f16.gguf', 'x_mmproj.gguf'],
  });
});

test('an infix mmproj must stand as its own token, while a leading mmproj keeps the prefix rule', () => {
  assert.deepEqual(splitGgufFiles(['x-mmprojector.gguf', 'x-mmproj.gguf', 'xmmproj-f16.gguf', 'mmprojector.gguf']), {
    // Infix needs a separator on BOTH sides of the token.
    main: ['x-mmprojector.gguf', 'xmmproj-f16.gguf'],
    drafters: [],
    // A trailing "-mmproj" with nothing after it is a projector. A LEADING
    // mmproj keeps today's boundary-free rule, so no file that was a projector
    // before becomes a main model now.
    projectors: ['mmprojector.gguf', 'x-mmproj.gguf'],
  });
});

test('mtp-*.gguf is a drafter even with an mmproj token, never a main model or a projector', () => {
  assert.deepEqual(splitGgufFiles(['mtp-Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf', 'MTP-x.gguf', BONSAI_MODEL]), {
    main: [BONSAI_MODEL],
    drafters: ['MTP-x.gguf', 'mtp-Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf'],
    projectors: [],
  });
});

test('a directory of only projectors and drafters resolves not_found and never serves a projector', () => {
  for (const names of [
    [BONSAI_PROJECTOR],
    [BONSAI_PROJECTOR, 'mtp-Ternary-Bonsai-2-27B-Q8_0.gguf'],
    ['mmproj-F16.gguf', 'mtp-x.gguf'],
  ]) {
    const { userDataPath, repoRoot } = makeModelDir('aux-only', names);
    assert.deepEqual(
      resolveGgufPath({ modelTag: 'aux-only', userDataPath, repoRoot }),
      { path: '', projectorPath: '', reason: 'not_found' },
      names.join(', '),
    );
  }
});

test('an infix projector pairs only with the model its stem names, as a separator-bounded prefix', () => {
  const twoMains = pairingIn([BONSAI_MODEL, 'gemma-3-4b-it-Q4_K_M.gguf', BONSAI_PROJECTOR]);
  assert.equal(twoMains(BONSAI_MODEL), BONSAI_PROJECTOR);
  assert.equal(twoMains('gemma-3-4b-it-Q4_K_M.gguf'), '');

  const paired = pairingIn([
    BONSAI_MODEL,
    'Ternary-Bonsai-2-27B-Q4_K_M.gguf', // same model, another quant: shares the projector
    'Ternary-Bonsai-2-27BX-Q4_0.gguf', // continues the stem without a separator
    'My-Ternary-Bonsai-2-27B-Q4_0.gguf', // contains the stem but does not start with it
    BONSAI_PROJECTOR,
  ]);
  assert.equal(paired(BONSAI_MODEL), BONSAI_PROJECTOR);
  assert.equal(paired('Ternary-Bonsai-2-27B-Q4_K_M.gguf'), BONSAI_PROJECTOR);
  assert.equal(paired('Ternary-Bonsai-2-27BX-Q4_0.gguf'), '');
  assert.equal(paired('My-Ternary-Bonsai-2-27B-Q4_0.gguf'), '');
});

test('infix stems drop the token and its tail, trim trailing separators, and ignore case', () => {
  // "<model>.mmproj-<quant>" naming, beside a sibling size of the same family.
  const llava = pairingIn(['llava-v1.5-7b.Q4_K_M.gguf', 'llava-v1.5-13b.Q4_K_M.gguf', 'llava-v1.5-7b.mmproj-f16.gguf']);
  assert.equal(llava('llava-v1.5-7b.Q4_K_M.gguf'), 'llava-v1.5-7b.mmproj-f16.gguf');
  assert.equal(llava('llava-v1.5-13b.Q4_K_M.gguf'), '');

  // "ternary-bonsai-2-27b_" trims to the model's own stem; no quant suffix needed.
  const exact = pairingIn(['TERNARY-BONSAI-2-27B.gguf', 'Other-Model-Q4_0.gguf', 'ternary-bonsai-2-27b_.mmproj-f16.gguf']);
  assert.equal(exact('TERNARY-BONSAI-2-27B.gguf'), 'ternary-bonsai-2-27b_.mmproj-f16.gguf');
  assert.equal(exact('Other-Model-Q4_0.gguf'), '');
});

test('several projectors for one model rank quantized, then F16/BF16, then F32, then the rest', () => {
  // Q8_0 wins in either listing order, and whether it sorts before or after BF16.
  for (const listing of [
    ['model.gguf', 'mmproj-BF16.gguf', 'mmproj-Q8_0.gguf'],
    ['mmproj-Q8_0.gguf', 'mmproj-BF16.gguf', 'model.gguf'],
  ]) {
    assert.equal(pairedInListing(listing, 'model.gguf'), 'mmproj-Q8_0.gguf', listing.join(', '));
  }
  for (const bf16 of ['Model-mmproj-BF16.gguf', 'Model-mmproj-bf16.gguf']) {
    // A second main model: only the stem-matched projectors compete.
    const listing = ['Model-Q4_K_M.gguf', 'Other-Q4_K_M.gguf', bf16, 'Model-mmproj-Q8_0.gguf'];
    assert.equal(pairedInListing(listing, 'Model-Q4_K_M.gguf'), 'Model-mmproj-Q8_0.gguf', bf16);
    assert.equal(pairedInListing([...listing].reverse(), 'Model-Q4_K_M.gguf'), 'Model-mmproj-Q8_0.gguf', bf16);
    assert.equal(pairedInListing(listing, 'Other-Q4_K_M.gguf'), '', bf16);
  }

  // The full order, peeling the winner off one tier at a time.
  const tiers = ['mmproj.gguf', 'mmproj-F32.gguf', 'mmproj-F16.gguf', 'mmproj-Q4_1.gguf'];
  for (let count = tiers.length; count > 0; count -= 1) {
    const present = tiers.slice(0, count);
    assert.equal(pairedInListing(['model.gguf', ...present], 'model.gguf'), present[count - 1], present.join(', '));
  }

  // A tie goes to the case-folded name: "bf16" sorts before "f16".
  assert.equal(pairedInListing(['model.gguf', 'mmproj-F16.gguf', 'mmproj-BF16.gguf'], 'model.gguf'), 'mmproj-BF16.gguf');
  // The precision is the LAST precision token after mmproj: "a-q4_0-f16" is an F16 file.
  assert.equal(
    pairedInListing(['model.gguf', 'mmproj-a-q4_0-f16.gguf', 'mmproj-b-Q8_0.gguf'], 'model.gguf'),
    'mmproj-b-Q8_0.gguf',
  );
});

test('stem evidence beats the lone-main fallback, which still pairs a lone projector', () => {
  // The projector naming the model wins over a better-ranked one naming another.
  const own = [BONSAI_MODEL, 'Ternary-Bonsai-2-27B-mmproj-BF16.gguf', 'gemma-3-4b-it-mmproj-Q8_0.gguf'];
  assert.equal(pairedInListing(own, BONSAI_MODEL), 'Ternary-Bonsai-2-27B-mmproj-BF16.gguf');

  // One main + one projector still pair when the names disagree (koboldcpp-style).
  assert.equal(
    pairedInListing(['gemma-3-4b-it-Q4_K_M.gguf', 'gemma3-4b-mmproj.gguf'], 'gemma-3-4b-it-Q4_K_M.gguf'),
    'gemma3-4b-mmproj.gguf',
  );

  // With two mains, a projector that names neither pairs with neither, and a
  // generic prefix projector keeps today's no-match verdict.
  for (const listing of [
    ['gemma-3-4b-it-Q4_K_M.gguf', 'qwen3-8b-Q4_K_M.gguf', BONSAI_PROJECTOR],
    ['gemma-3-4b-it-Q4_K_M.gguf', 'qwen3-8b-Q4_K_M.gguf', 'mmproj-F16.gguf'],
  ]) {
    assert.equal(pairedInListing(listing, 'gemma-3-4b-it-Q4_K_M.gguf'), '', listing.join(', '));
    assert.equal(pairedInListing(listing, 'qwen3-8b-Q4_K_M.gguf'), '', listing.join(', '));
  }
});

test('the lifecycle re-exports every moved helper as the very same function', () => {
  for (const name of [
    'normalizeModelTagForFilename',
    'pairProjector',
    'resolveGgufPath',
    'resolveProjectorPath',
    'splitGgufFiles',
  ]) {
    assert.equal(typeof ggufFiles[name], 'function', name);
    assert.equal(lifecycle[name], ggufFiles[name], name);
  }
});

// ---------------------------------------------------------------------------
// W2 review regressions. F1: the lone-main fallback must never hand a model a
// projector that names another model, nor launch or keep a server with one
// (F1d-F1g). F3-F7: ranking and classification edges. F2 (listLocalGgufs)
// lives in tests/llama-server-ipc-handlers.test.js.
// ---------------------------------------------------------------------------

test('a lone text model never pairs a projector whose infix stem names another model [F1a]', () => {
  // Downloads: Qwen3 and Bonsai's projector are done, the Bonsai model is not.
  assert.equal(pairedInListing([QWEN, BONSAI_PROJECTOR, `${BONSAI_MODEL}.crdownload`], QWEN), '');
});

test('the lone-main fallback keeps the generic projector over a better-ranked foreign one [F1b]', () => {
  const listing = ['model-Q4_K_M.gguf', 'mmproj-F16.gguf', 'Other-Model-mmproj-Q8_0.gguf'];
  assert.equal(pairedInListing(listing, 'model-Q4_K_M.gguf'), 'mmproj-F16.gguf');
});

test('beside a koboldcpp projector collection a lone model keeps only the one naming it [F1c]', () => {
  const listing = [
    'gemma-3-4b-it-Q4_K_M.gguf',
    'gemma3-4b-mmproj.gguf',
    'LLaMA3-8B_mmproj-Q4_1.gguf',
    'mistral-7b-mmproj-v1.5-Q4_1.gguf',
    'pixtral-12b-mmproj-f16.gguf',
  ];
  assert.equal(pairedInListing(listing, 'gemma-3-4b-it-Q4_K_M.gguf'), 'gemma3-4b-mmproj.gguf');
});

test('the fallback still pairs the Bonsai pair and a copy renamed with other separators [F1 guard]', () => {
  assert.equal(pairedInListing([BONSAI_MODEL, BONSAI_PROJECTOR], BONSAI_MODEL), BONSAI_PROJECTOR);
  const renamed = 'Ternary_Bonsai_2_27B-PQ2_0.gguf';
  assert.equal(pairedInListing([renamed, BONSAI_PROJECTOR], renamed), BONSAI_PROJECTOR);
});

test('a lone text model beside a foreign projector launches without --mmproj [F1d]', async () => {
  const { dir, userDataPath } = makeModelDir('qwen3-8b', [QWEN, BONSAI_PROJECTOR]);
  const port = await getClosedPort();
  const spawns = [];
  await assert.rejects(lifecycle.startLlamaServer({
    modelTag: 'qwen3-8b',
    binaryPath: path.join(userDataPath, 'llama-server.exe'),
    modelPath: path.join(dir, QWEN),
    userDataPath,
    port,
    readinessTimeoutMs: 1,
    readinessPollIntervalMs: 1,
    platform: 'win32',
    spawnImpl: (_binary, args) => {
      spawns.push(args);
      return new FakeChildProcess(45001);
    },
    spawnSyncImpl: () => ({ status: 0 }),
    isProcessAliveImpl: () => false,
  }), /llama_server_readiness_timeout/);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].includes('--mmproj'), false, spawns[0].join(' '));
});

test('a user-run text-only server is still reused beside a foreign projector [F1f]', async () => {
  const server = http.createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3-8b' }] }));
  });
  const baseUrl = await listen(server);
  const { dir, userDataPath } = makeModelDir('qwen3-8b', [QWEN, BONSAI_PROJECTOR]);
  try {
    const handle = await lifecycle.startLlamaServer({
      modelTag: 'qwen3-8b',
      modelPath: path.join(dir, QWEN),
      userDataPath,
      port: Number(new URL(baseUrl).port),
      spawnImpl: () => { throw new Error('a reused server must not spawn'); },
      // The running server's /props: text only.
      fetchImpl: async () => ({ ok: true, json: async () => ({ modalities: { vision: false } }) }),
    });
    assert.equal(handle.reused, true);
  } finally {
    await closeServer(server);
  }
});

test('a foreign projector landing beside a running text model gives the relaunch check nothing [F1e, F1g]', () => {
  // The manager's preflight relaunch check (needsRelaunch -> resolveSpecProjector)
  // asks exactly this, so '' keeps a working text-only server running.
  const { dir } = makeModelDir('qwen3-8b', [QWEN]);
  const modelPath = path.join(dir, QWEN);
  assert.equal(resolveProjectorPath({ modelPath }), '');
  fs.writeFileSync(path.join(dir, BONSAI_PROJECTOR), '');
  assert.equal(resolveProjectorPath({ modelPath }), '');
});

test('the F16/BF16 tie-break does not change with letter case [F3]', () => {
  assert.equal(pairedInListing(['model.gguf', 'mmproj-F16.gguf', 'mmproj-bf16.gguf'], 'model.gguf'), 'mmproj-bf16.gguf');
  assert.equal(pairedInListing(['model.gguf', 'mmproj-f16.gguf', 'mmproj-BF16.gguf'], 'model.gguf'), 'mmproj-BF16.gguf');
});

test('a precision-only prefix projector names no model, whatever the model quant [F4]', () => {
  // The unsloth trio keeps the pre-W2 pick beside an F32, F16 or quantized model.
  const trio = ['mmproj-BF16.gguf', 'mmproj-F16.gguf', 'mmproj-F32.gguf'];
  for (const model of ['gemma-3-4b-it-F32.gguf', 'gemma-3-4b-it-F16.gguf', 'gemma-3-4b-it-Q4_K_M.gguf']) {
    assert.equal(pairedInListing([model, ...trio], model), 'mmproj-BF16.gguf', model);
  }
  // ggml-org's "mmproj-model-f16" names no model either: beside two mains it pairs with neither.
  const generic = ['model.gguf', 'other.gguf', 'mmproj-model-f16.gguf'];
  assert.equal(pairedInListing(generic, 'model.gguf'), '');
  assert.equal(pairedInListing(generic, 'other.gguf'), '');
});

test('IQ, TQ and bare Q<n> projectors rank with the quantized tier [F5]', () => {
  for (const quant of ['mmproj-IQ4_XS.gguf', 'mmproj-TQ2_0.gguf', 'mmproj-Q8.gguf']) {
    assert.equal(pairedInListing(['model.gguf', 'mmproj-F32.gguf', quant], 'model.gguf'), quant, quant);
  }
});

test('a browser or Explorer duplicate of an infix projector is a projector, never the model [F6]', () => {
  const duplicates = ['gemma3-4b-mmproj (1).gguf', 'gemma3-4b-mmproj - Copy.gguf'];
  assert.deepEqual(splitGgufFiles(duplicates), { main: [], drafters: [], projectors: duplicates });
  const { userDataPath, repoRoot } = makeModelDir('gemma3-4b', duplicates);
  assert.deepEqual(
    resolveGgufPath({ modelTag: 'gemma3-4b', userDataPath, repoRoot }),
    { path: '', projectorPath: '', reason: 'not_found' },
  );
});

test('a space-separated projector name is a projector that pairs and ranks like any other [F7]', () => {
  assert.deepEqual(
    splitGgufFiles(['Model mmproj Q8_0.gguf', 'x mmprojector.gguf', 'x-mmprojector.gguf', 'xmmproj-f16.gguf']),
    {
      main: ['x mmprojector.gguf', 'x-mmprojector.gguf', 'xmmproj-f16.gguf'],
      drafters: [],
      projectors: ['Model mmproj Q8_0.gguf'],
    },
  );
  // Whitespace also bounds the model stem and the precision token: Q8_0 beats
  // F32 here only because " Q8_0" reads as a precision.
  const listing = ['Model Q4_K_M.gguf', 'Other Q4_K_M.gguf', 'Model mmproj F32.gguf', 'Model mmproj Q8_0.gguf'];
  assert.equal(pairedInListing(listing, 'Model Q4_K_M.gguf'), 'Model mmproj Q8_0.gguf');
  assert.equal(pairedInListing(listing, 'Other Q4_K_M.gguf'), '');
  // A run of whitespace before the token is trimmed off the stem.
  const spaced = ['Model Q4_K_M.gguf', 'Other Q4_K_M.gguf', 'Model  mmproj.gguf'];
  assert.equal(pairedInListing(spaced, 'Model Q4_K_M.gguf'), 'Model  mmproj.gguf');
});

// ---------------------------------------------------------------------------
// W2 review round 3. R1: a folder of several quants or shards of ONE model
// pairs a projector that names no model with each of them. Before W2 only the
// BF16/F16 quant paired, by accident. A folder of different models still pairs
// by name only. G1-G5 pin the whitespace rules and the named-projector preference.
// ---------------------------------------------------------------------------

// unsloth's gemma-3-4b-it-GGUF snapshot: four quants of one model, three projectors.
const UNSLOTH = [
  'gemma-3-4b-it-BF16.gguf',
  'gemma-3-4b-it-Q4_K_M.gguf',
  'gemma-3-4b-it-Q8_0.gguf',
  'gemma-3-4b-it-UD-Q4_K_XL.gguf',
  'mmproj-BF16.gguf',
  'mmproj-F16.gguf',
  'mmproj-F32.gguf',
];

test('a one-model snapshot pairs its BF16 quant with mmproj-BF16, as before W2 [R1a]', () => {
  assert.equal(pairedInListing(UNSLOTH, 'gemma-3-4b-it-BF16.gguf'), 'mmproj-BF16.gguf');
});

test('the tag resolve serves that snapshot as its BF16 quant plus mmproj-BF16 [R1b]', () => {
  const { userDataPath, dir, repoRoot } = makeModelDir('gemma-3-4b-it', UNSLOTH);
  assert.deepEqual(resolveGgufPath({ modelTag: 'gemma-3-4b-it', userDataPath, repoRoot }), {
    path: path.join(dir, 'gemma-3-4b-it-BF16.gguf'),
    projectorPath: path.join(dir, 'mmproj-BF16.gguf'),
    reason: 'resolved',
  });
});

test('a BF16 and a Q4_K_M quant of one model pair its generic projector [R1c]', () => {
  const listing = ['Qwen2.5-VL-7B-Instruct-BF16.gguf', 'Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf', 'mmproj-F16.gguf'];
  assert.equal(pairedInListing(listing, 'Qwen2.5-VL-7B-Instruct-BF16.gguf'), 'mmproj-F16.gguf');
});

test('openbmb\'s ggml-model quants pair the generic mmproj-model-f16 [R1d]', () => {
  const listing = ['ggml-model-Q4_K_M.gguf', 'ggml-model-f16.gguf', 'mmproj-model-f16.gguf'];
  assert.equal(pairedInListing(listing, 'ggml-model-f16.gguf'), 'mmproj-model-f16.gguf');
  assert.equal(pairedInListing(listing, 'ggml-model-Q4_K_M.gguf'), 'mmproj-model-f16.gguf');
});

test('every other quant of that snapshot pairs mmproj-BF16 too [R1 siblings]', () => {
  for (const model of ['gemma-3-4b-it-Q4_K_M.gguf', 'gemma-3-4b-it-Q8_0.gguf', 'gemma-3-4b-it-UD-Q4_K_XL.gguf']) {
    assert.equal(pairedInListing(UNSLOTH, model), 'mmproj-BF16.gguf', model);
  }
});

test('a folder of different models still pairs a generic projector with none of them [R1 guard]', () => {
  for (const listing of [
    ['Qwen3-8B-F16.gguf', 'gemma-3-4b-it-Q4_K_M.gguf', 'mmproj-F16.gguf'],
    ['gemma-3-4b-it-BF16.gguf', 'gemma-3-12b-it-Q4_K_M.gguf', 'mmproj-BF16.gguf'], // another size
    ['model.gguf', 'other.gguf', 'mmproj-model-f16.gguf'],
    ['gemma-3-4b-it-F16.gguf', 'gemma-3-4b-pt-Q4_K_M.gguf', 'mmproj-F16.gguf'], // another checkpoint
  ]) {
    assert.equal(pairedInListing(listing, listing[0]), '', listing.join(', '));
    assert.equal(pairedInListing(listing, listing[1]), '', listing.join(', '));
  }
});

test('quants of one model never take a projector that names another model [R1 guard]', () => {
  // A one-model folder owns only the projectors that name no model.
  const listing = [QWEN, 'Qwen3-8B-Q8_0.gguf', 'mmproj-gemma-3-4b-it-f16.gguf'];
  assert.equal(pairedInListing(listing, QWEN), '');
  assert.equal(pairedInListing(listing, 'Qwen3-8B-Q8_0.gguf'), '');
});

test('quants, UD and i1 quants and shards of one model are one model; a QAT build or another size is not [R1 family]', () => {
  for (const mains of [
    ['gemma-3-4b-it-BF16.gguf', 'gemma-3-4b-it-Q4_K_M.gguf', 'gemma-3-4b-it-UD-Q4_K_XL.gguf'], // unsloth
    [ // mradermacher
      'Qwen2.5-VL-7B-Instruct.Q4_K_M.gguf',
      'Qwen2.5-VL-7B-Instruct.i1-IQ4_XS.gguf',
      'Qwen2.5-VL-7B-Instruct.f16.gguf',
    ],
    ['google_gemma-3-4b-it-Q4_K_M.gguf', 'google_gemma-3-4b-it-Q8_0.gguf', 'google_gemma-3-4b-it-bf16.gguf'], // bartowski
    ['gemma-3-27b-it-Q4_K_M-00001-of-00002.gguf', 'gemma-3-27b-it-Q4_K_M-00002-of-00002.gguf'], // one sharded quant
    ['ggml-model-Q4_K_M.gguf', 'ggml-model-f16.gguf'], // openbmb
    ['Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf', 'qwen2.5-vl-7b-instruct-q8_0.gguf'], // letter case differs
  ]) {
    for (const model of mains) {
      assert.equal(pairedInListing([...mains, 'mmproj-F16.gguf'], model), 'mmproj-F16.gguf', model);
    }
  }
  for (const mains of [
    ['gemma-3-4b-it-Q4_K_M.gguf', 'gemma-3-4b-it-qat-Q4_0.gguf'],
    ['Ternary_Bonsai_2_27B-PQ2_0.gguf', 'Ternary_Bonsai_2_8B-PQ2_0.gguf'],
  ]) {
    assert.equal(pairedInListing([...mains, 'mmproj-F16.gguf'], mains[0]), '', mains.join(', '));
  }
});

test('only a quant of the folder\'s one model owns its generic projector [R1 residual]', () => {
  // Beside another model's quants: a deleted model, and an Ollama blob (not a .gguf).
  const blob = `sha256-${'0123456789abcdef'.repeat(4)}`;
  const paired = pairingIn(['gemma-3-4b-it-Q8_0.gguf', 'gemma-3-4b-it-Q4_K_M.gguf', 'mmproj-F16.gguf', blob]);
  assert.deepEqual({
    deleted: paired(QWEN),
    blob: paired(blob),
    q4: paired('gemma-3-4b-it-Q4_K_M.gguf'),
    q8: paired('gemma-3-4b-it-Q8_0.gguf'),
  }, { deleted: '', blob: '', q4: 'mmproj-F16.gguf', q8: 'mmproj-F16.gguf' });
});

test('a duplicate\'s " (1)" does not hide its projector\'s precision [G1]', () => {
  const listing = ['model.gguf', 'mmproj-F32.gguf', 'mmproj-F16 (1).gguf'];
  assert.equal(pairedInListing(listing, 'model.gguf'), 'mmproj-F16 (1).gguf');
});

test('a space after "model" still makes a prefix stem generic [G2]', () => {
  assert.equal(pairedInListing(['model.gguf', 'other.gguf', 'mmproj-model f16.gguf'], 'model.gguf'), '');
});

test('the lone-model name match ignores whitespace like any other separator [G3]', () => {
  const listing = ['gemma 3 4b it Q4_K_M.gguf', 'gemma3-4b-mmproj.gguf'];
  assert.equal(pairedInListing(listing, 'gemma 3 4b it Q4_K_M.gguf'), 'gemma3-4b-mmproj.gguf');
});

test('the lone-model name match must start the model name, not sit inside it [G4]', () => {
  const listing = ['My-Gemma-3-4B-it-Q4_K_M.gguf', 'gemma3-4b-mmproj.gguf'];
  assert.equal(pairedInListing(listing, 'My-Gemma-3-4B-it-Q4_K_M.gguf'), '');
});

test('a projector naming the lone model beats a better-ranked generic one [G5]', () => {
  const listing = [BONSAI_MODEL, 'Ternary-Bonsai-2-27B-mmproj-BF16.gguf', 'mmproj-Q8_0.gguf'];
  assert.equal(pairedInListing(listing, BONSAI_MODEL), 'Ternary-Bonsai-2-27B-mmproj-BF16.gguf');
});

// ---------------------------------------------------------------------------
// W2 review round 5: the rules behind R3-1 and R3-2 (the real repos they came
// from are in tests/llama-server-gguf-files-realworld.test.js), and G6-G10.
// ---------------------------------------------------------------------------

test('MXFP4, MXFP4_MOE and NVFP4 files are quants of the folder\'s one model [R3-1]', () => {
  for (const quant of ['MXFP4', 'MXFP4_MOE', 'NVFP4']) {
    const listing = ['gemma-3-4b-it-BF16.gguf', `gemma-3-4b-it-${quant}.gguf`, 'mmproj-F16.gguf'];
    assert.equal(pairedInListing(listing, 'gemma-3-4b-it-BF16.gguf'), 'mmproj-F16.gguf', quant);
    assert.equal(pairedInListing(listing, `gemma-3-4b-it-${quant}.gguf`), 'mmproj-F16.gguf', quant);
  }
});

test('an imatrix data file is no model, but an "<m>-imatrix-<quant>" file is one [R3-1]', () => {
  for (const data of ['imatrix.gguf', 'imatrix_unsloth.gguf', 'gemma-3-4b-it-imatrix.gguf', 'gemma-3-4b-it.imatrix.gguf']) {
    const listing = ['gemma-3-4b-it-BF16.gguf', 'gemma-3-4b-it-Q4_K_M.gguf', data, 'mmproj-F16.gguf'];
    assert.equal(pairedInListing(listing, 'gemma-3-4b-it-Q4_K_M.gguf'), 'mmproj-F16.gguf', data);
  }
  // Another model's imatrix quant, whole or sharded, or "imatrix" inside a word, is another model.
  for (const other of [
    'LFM2.5-VL-450M-imatrix-IQ2_M.gguf',
    'Qwen3-VL-235B-A22B-imatrix-Q4_K_M-00001-of-00003.gguf',
    'Phi-2-OmniMatrix.gguf',
  ]) {
    const listing = ['gemma-3-4b-it-Q4_K_M.gguf', other, 'mmproj-F16.gguf'];
    assert.equal(pairedInListing(listing, 'gemma-3-4b-it-Q4_K_M.gguf'), '', other);
  }
});

test('a "mmproj-<model>-<precision>" projector names <model> as a separator-bounded prefix [R3-2]', () => {
  const projector = 'mmproj-Ternary-Bonsai-2-27B-F16.gguf';
  const listing = [BONSAI_MODEL, 'Ternary-Bonsai-2-27BX-Q4_0.gguf', 'My-Ternary-Bonsai-2-27B-Q4_0.gguf', projector];
  assert.equal(pairedInListing(listing, BONSAI_MODEL), projector);
  assert.equal(pairedInListing(listing, 'Ternary-Bonsai-2-27BX-Q4_0.gguf'), '');
  assert.equal(pairedInListing(listing, 'My-Ternary-Bonsai-2-27B-Q4_0.gguf'), '');
});

test('only a trailing quant leaves the family; a precision inside the name stays [G6]', () => {
  const listing = ['Llama-3-f16-merge-Q4_K_M.gguf', 'Llama-3-f16-merge-Q8_0.gguf', 'mmproj-F16.gguf'];
  assert.equal(pairedInListing(listing, 'Llama-3-f16-merge-Q4_K_M.gguf'), 'mmproj-F16.gguf');
  const mixed = ['Llama-3-f16-merge-Q4_K_M.gguf', 'Llama-3-8B-Q8_0.gguf', 'mmproj-F16.gguf'];
  assert.equal(pairedInListing(mixed, 'Llama-3-8B-Q8_0.gguf'), '');
});

test('space-separated quants of one model are one model [G7]', () => {
  const listing = ['gemma 3 4b it BF16.gguf', 'gemma 3 4b it Q4_K_M.gguf', 'mmproj-F16.gguf'];
  assert.equal(pairedInListing(listing, 'gemma 3 4b it Q4_K_M.gguf'), 'mmproj-F16.gguf');
});

test('a model gone from a folder of projectors only pairs nothing [G9]', () => {
  assert.equal(pairedInListing(['mmproj-F16.gguf'], 'gemma-3-4b-it-Q4_K_M.gguf'), '');
});

test('a sharded quant and a plain quant of one model are one model [G10]', () => {
  const listing = [
    'gemma-3-27b-it-Q4_K_M-00001-of-00002.gguf',
    'gemma-3-27b-it-Q4_K_M-00002-of-00002.gguf',
    'gemma-3-27b-it-Q2_K.gguf',
    'mmproj-F16.gguf',
  ];
  assert.equal(pairedInListing(listing, 'gemma-3-27b-it-Q2_K.gguf'), 'mmproj-F16.gguf');
});

test('a projector naming a longer model never outranks the one naming this model [R6 specificity]', () => {
  // "mmproj-GLM-4.6V-Flash" contains the quant-less "GLM-4.6V" but names
  // another model, so it counts for nothing.
  const listing = ['GLM-4.6V.gguf', 'GLM-4.6V-Flash-Q4_K_M.gguf', 'mmproj-GLM-4.6V-Q8_0.gguf', 'mmproj-GLM-4.6V-Flash-Q8_0.gguf'];
  assert.equal(pairedInListing(listing, 'GLM-4.6V.gguf'), 'mmproj-GLM-4.6V-Q8_0.gguf');
  assert.equal(pairedInListing(listing, 'GLM-4.6V-Flash-Q4_K_M.gguf'), 'mmproj-GLM-4.6V-Flash-Q8_0.gguf');
});
