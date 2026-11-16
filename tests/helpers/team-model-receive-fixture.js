'use strict';

// Shared fixture for the team model receiver tests (row 123 slice 6-4): real
// files in a temp model root, a fake transport, a manifest validator that runs
// the real 6-1 rules with a small injected segment size, and the real
// discovery scan.

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateModelManifest } = require('../../server/team/model-manifest');
const { getBridgeChannel } = require('../../services/ipc-contract');
const { registerLlamaServerIpcHandlers } = require('../../services/main/llama-server-ipc-handlers');

const PART = 16 * 1024;
const SEG = 64 * 1024;
const GIB = 1024 ** 3;
const LIMITS = Object.freeze({ partBytes: PART, segmentBytes: SEG });

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// Deterministic bytes; `gguf` puts a minimal valid GGUF header (v3, no tensors, no keys) in front.
function makeBytes(size, seed, { gguf = true } = {}) {
  const out = Buffer.alloc(size);
  let block = Buffer.from(String(seed));
  for (let offset = 0; offset < size; offset += 32) {
    block = crypto.createHash('sha256').update(block).digest();
    block.copy(out, offset, 0, Math.min(32, size - offset));
  }
  if (gguf) {
    const header = Buffer.alloc(24);
    header.write('GGUF', 0, 'latin1');
    header.writeUInt32LE(3, 4);
    header.copy(out, 0, 0, Math.min(24, size));
  }
  return out;
}

const segmentsOf = (bytes, seg = SEG) => {
  const out = [];
  for (let offset = 0; offset < bytes.length; offset += seg) out.push(sha(bytes.subarray(offset, offset + seg)));
  return out;
};

const MODEL_FILES = Object.freeze([
  { name: 'Qwen3-8B-Q4_K_M.gguf', size: 3 * SEG + SEG / 2 },
  { name: 'mmproj-Qwen3-8B-F16.gguf', size: 40 * 1024 },
  { name: 'mtp-Qwen3-8B-Q8_0.gguf', size: SEG + 6 * 1024 },
]);

const SHARD_FILES = Object.freeze([
  { name: 'Big-Q4_K_M-00001-of-00003.gguf', size: SEG + 100 },
  { name: 'Big-Q4_K_M-00002-of-00003.gguf', size: SEG },
  { name: 'Big-Q4_K_M-00003-of-00003.gguf', size: 5000 },
]);
const FILE_SETS = Object.freeze({ model: MODEL_FILES, shards: SHARD_FILES });

function buildOffer(specs = MODEL_FILES, overrides = {}) {
  const bytes = specs.map((spec, index) => spec.bytes || makeBytes(spec.size, `${spec.name}:${index}`, spec));
  const manifest = {
    request_id: 'req_1',
    audience: { kind: 'team' },
    display_name: overrides.displayName || 'Qwen three',
    files: specs.map((spec, index) => ({
      name: spec.name, size: bytes[index].length, sha256: sha(bytes[index]), segments: segmentsOf(bytes[index]),
    })),
    provenance: {
      licence: overrides.licence ?? 'Apache-2.0',
      source_url: overrides.sourceUrl ?? 'https://example.test/qwen',
      note: overrides.note ?? 'From my library',
    },
  };
  const offer = {
    offerId: overrides.offerId || 'offer_abc',
    teamId: 'team_t1',
    sender: { memberId: 'member_m1', displayName: 'Sam' },
    manifest,
  };
  return { offer, bytes };
}

// The real 6-1 rules, with `segments` counted at the test's segment size.
function testValidator(seg = SEG) {
  return (manifest) => {
    try {
      if (!manifest.files.every((file) => Array.isArray(file.segments) && file.segments.length === Math.ceil(file.size / seg))) {
        return { ok: false, reason: 'segments_invalid' };
      }
      const copy = {
        ...manifest,
        files: manifest.files.map((file) => ({ ...file, segments: Array(Math.ceil(file.size / GIB)).fill(file.sha256) })),
      };
      const checked = validateModelManifest(copy);
      if (!checked.ok) return checked;
      return {
        ok: true,
        manifest: Object.freeze({
          ...checked.manifest,
          files: Object.freeze(manifest.files.map((file) => Object.freeze({ ...file, segments: Object.freeze([...file.segments]) }))),
        }),
      };
    } catch (_error) {
      return { ok: false, reason: 'manifest_not_object' };
    }
  };
}

// A fake of the transport slice 6-5 provides. `corrupt(file, offset, bytes, pull)` may change a part;
// `gate` (a promise) holds every takePart until it settles; an aborted signal rejects a held call. `hang`
// names calls that never answer; `reject` maps a call name to the error it throws. Each record is
// `[name, payload without the signal, whether a signal came]`.
function fakeTransport(bytes, { corrupt = null, gate = null, hang = [], reject = {} } = {}) {
  const calls = [];
  const pulls = new Map();
  const transport = { calls, gate };
  const record = (name, { signal, ...payload }) => {
    calls.push([name, JSON.parse(JSON.stringify(payload)), Boolean(signal)]);
    if (hang.includes(name)) return new Promise(() => {});
    if (reject[name]) throw reject[name];
    return null;
  };
  for (const name of ['accept', 'resume', 'pause', 'cancel', 'complete']) {
    transport[name] = async (payload) => {
      await record(name, payload);
      return { ok: true };
    };
  }
  transport.takePart = async (payload) => {
    const { file, offset, signal } = payload;
    await record('takePart', payload);
    if (transport.gate) {
      await new Promise((resolve, reject) => {
        if (signal.aborted) reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })), { once: true });
        transport.gate.then(resolve);
      });
    }
    const key = `${file}:${offset}`;
    const pull = (pulls.get(key) || 0) + 1;
    pulls.set(key, pull);
    let part = Buffer.from(bytes[file].subarray(offset, offset + PART));
    if (corrupt) part = corrupt(file, offset, part, pull) || part;
    return part;
  };
  transport.count = (name) => calls.filter((entry) => entry[0] === name).length;
  return transport;
}

// A hasher that reads the file on the main thread (the real worker hasher is exercised in one test).
function fakeHasher({ wrong = null } = {}) {
  let running = 0;
  return {
    async hash(file, { signal } = {}) {
      running += 1;
      try {
        if (signal?.aborted) throw Object.assign(new Error('model_hash_aborted'), { code: 'model_hash_aborted' });
        const bytes = fs.readFileSync(file);
        const result = { size: bytes.length, sha256: sha(bytes), segments: [] };
        return wrong ? wrong(result) : result;
      } finally {
        running -= 1;
      }
    },
    resources: () => ({ running }),
  };
}

function makeRoot(t, label = 'jenny-model-receive-') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), label));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'models');
  fs.mkdirSync(root);
  return { base, root: fs.realpathSync.native(root) };
}

async function discover(root, base) {
  const handlers = new Map();
  registerLlamaServerIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler), on() {} }, {
    getManager: () => null,
    userDataPath: path.join(base, 'user-data'),
    repoRoot: path.join(base, 'repo'),
    getLibraryRoots: () => [root],
  });
  const result = await handlers.get(getBridgeChannel('llamaServer.listLocalGgufs', 'invoke'))();
  return result.entries;
}

// A link to a directory: a junction on Windows, a symbolic link elsewhere; `kind` 'dir' asks for a symbolic link.
function linkDir(target, link, kind = process.platform === 'win32' ? 'junction' : 'dir') {
  try {
    fs.symlinkSync(target, link, kind);
    return true;
  } catch (_error) {
    return false;
  }
}

// Waits for `check()` to hold, at most `ms`.
async function until(check, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Runs the cut child (team-model-receive-cut-child.js): `{ cut: true }`, or its result with the move count.
function runCutChild(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'team-model-receive-cut-child.js'), JSON.stringify(args)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`cut child exited ${code}: ${err.slice(0, 400)}`));
      else resolve(out ? JSON.parse(out) : { cut: true });
    });
  });
}

const listTree = (dir) => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map((name) => String(name).split(path.sep).join('/')).sort();
};

module.exports = {
  FILE_SETS, GIB, LIMITS, MODEL_FILES, PART, SEG, SHARD_FILES, buildOffer, discover, fakeHasher, fakeTransport, linkDir,
  listTree, makeBytes, makeRoot, runCutChild, segmentsOf, sha, testValidator, until,
};
