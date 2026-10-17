'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { trackDirectory } = require('./resource-cleanup');
const { crc32 } = require('../../services/backend/png-validator');
const { TOOL_ERROR_CODES } = require('../../services/backend/error-codes');
const { createImageGenerateTool } = require('../../services/tools/builtin/image-generate-tool');
const ID = 'abcdef123456';
const UUID = '01234567-89ab-4cde-8fab-0123456789ab';
const FAMILY = {
  diffusion_flag: '--diffusion-model', encoder_flag: '--llm', vae_flag: '--vae',
  defaults: { steps: 20, cfg_scale: 2.5, sampler: 'euler', flow_shift: 3 },
  resolutions: ['1024x1024', '1472x1120'], extra_args: ['--fa', '--offload-to-cpu'],
  min_total_vram_mb: 8000, free_vram_headroom_mb: 3000,
};

function png(width = 1024, height = 1024) {
  const chunk = (type, data) => {
    const buffer = Buffer.alloc(data.length + 12);
    buffer.writeUInt32BE(data.length);
    buffer.write(type, 4);
    data.copy(buffer, 8);
    buffer.writeUInt32BE(crc32(buffer.subarray(4, -4)), buffer.length - 4);
    return buffer;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.alloc(height * (width + 1)))), chunk('IEND', Buffer.alloc(0))]);
}

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-image-tool-'));
  trackDirectory(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const set = { id: ID, family: 'test_family', files: { diffusion: { name: 'diffusion-Q4_K.gguf', size_bytes: 1048577 } } };
  const paths = Object.fromEntries(['diffusion', 'text_encoder', 'vae'].map((slot) => [slot, path.join(root, `${slot}.gguf`)]));
  const artifact = { artifact_id: 'artifact-1', artifact_kind: 'image', display_path: 'artifacts/generated.png' };
  const handoff = {
    async suspend(...args) { calls.push(['suspend', ...args]); return { leaseId: 'lease-1' }; },
    registerRender(render) { calls.push(['register', render]); },
    async restoreAndRelease(options) { calls.push(['restore', options]); return { restored: true, released: true, reason: options.reason }; },
    closing: false,
  };
  const context = {
    backendService: { options: { userDataPath: root }, chatGpuHandoff: handoff,
      imageEngine: { resolveExecutable() { calls.push(['engine']); return { ok: true, path: path.join(root, 'sd-cli.exe'), tag: 'test-tag' }; } } },
    artifactService: { async createBinaryArtifact(...args) { calls.push(['artifact', ...args]); return { output: 'saved', metadata: artifact }; } },
    sessionId: 'session-1', streamId: 'stream-1', callId: 'call-1', workingDirectory: root, logger: () => {},
  };
  const dependencies = {
    async runImageGeneration(options) {
      calls.push(['run', options]);
      const buffer = png(options.expectedWidth, options.expectedHeight);
      await fs.promises.writeFile(options.outputPath, buffer);
      return { status: 'ok', exitCode: 0, seconds: { load: 1, sample: 2, total: 3 }, png: { width: options.expectedWidth, height: options.expectedHeight, buffer }, stderrTail: [] };
    },
    resolveModelSet(id, options) { calls.push(['resolve', id, options]); return { ok: true, set, paths }; },
    listModelSets(options) { calls.push(['list', options]); return { sets: [set], default_id: ID }; },
    loadFamilies() { return { families: { test_family: FAMILY } }; },
    randomUUID: () => UUID, now: () => 1000, fs,
    createNativeImage: () => { throw new Error('no image encoder in this fixture'); },
    ...overrides,
  };
  return { root, calls, set, paths, artifact, handoff, context, dependencies,
    tool: createImageGenerateTool(dependencies), input: { prompt: 'A quiet garden', seed: 42 } };
}

function failed(result, reason, restored) {
  assert.equal(result.isError, true);
  assert.equal(result.errorCode, TOOL_ERROR_CODES.EXECUTION_FAILED);
  assert.equal(result.metadata.result_kind, 'image_generate');
  assert.equal(result.metadata.status, 'failed');
  assert.equal(result.metadata.reason, reason);
  if (restored !== undefined) assert.equal(result.metadata.chat_restore, restored);
}

module.exports = { ID, UUID, FAMILY, png, fixture, failed };
