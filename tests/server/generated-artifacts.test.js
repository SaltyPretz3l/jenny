'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ArtifactWorkspaceService } = require('../../services/artifact-workspace-service');
const {
  MAX_ARTIFACT_BYTES,
  createArtifactCommands,
} = require('../../services/host/artifact-commands');
const { createArtifactRoutes } = require('../../server/artifact-routes');

function makeTemp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-host-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function configFor(root) {
  return { getState: () => ({ toolsWorkspaceRoot: root }) };
}

function backendFor(messages) {
  return {
    async getSessionMessages(sessionId) {
      return { data: messages[sessionId] || [] };
    },
  };
}

async function createCanonicalArtifact(root, messages, options = {}) {
  const configService = configFor(root);
  const writer = new ArtifactWorkspaceService({ configService });
  const sessionId = options.sessionId || 'session_1';
  const created = options.binary
    ? await writer.createBinaryArtifact(sessionId, options.binary)
    : await writer.createArtifact(sessionId, options.document || {
      artifactKind: 'document', fileName: 'notes.md', content: 'artifact body',
    });
  messages[sessionId] = [{ id: 'tool_result_1', tool_result: { generated_artifacts: [created.metadata] } }];
  return { configService, metadata: created.metadata };
}

function responseStub() {
  return {
    headers: {}, statusCode: null, body: null, destroyed: false, writableEnded: false,
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers); },
    end(body) { this.body = body; this.writableEnded = true; },
  };
}

function context(response, pathname, authorized = true) {
  return { request: { method: 'GET', headers: {} }, response, pathname,
    authorized, deviceId: 'device_1', clientId: 'client_1', requestId: 'request_1' };
}

test('read resolves a canonical ArtifactWorkspaceService row and returns bounded metadata plus bytes', async (t) => {
  const root = makeTemp(t);
  const messages = {};
  const { configService, metadata } = await createCanonicalArtifact(root, messages);
  const commands = createArtifactCommands({ backend: backendFor(messages), configService });
  const result = await commands.read('session_1', metadata.artifact_id);
  assert.deepEqual(result.artifact, {
    artifact_id: metadata.artifact_id,
    title: metadata.title,
    file_name: metadata.file_name,
    mime_type: 'application/octet-stream',
    language: 'markdown',
    artifact_kind: 'document',
  });
  assert.equal(result.bytes.toString(), 'artifact body');
  assert.equal(JSON.stringify(result).includes('absolute_path'), false);
});

test('read requires the exact canonical session reference and rejects traversal metadata', async (t) => {
  const root = makeTemp(t);
  const messages = {};
  const { configService, metadata } = await createCanonicalArtifact(root, messages);
  const commands = createArtifactCommands({ backend: backendFor(messages), configService });
  assert.equal((await commands.read('session_2', metadata.artifact_id)).error.reason, 'artifact_reference_not_found');
  const outside = path.join(root, 'outside.md');
  fs.writeFileSync(outside, 'private', 'utf8');
  messages.session_1 = [{ tool_result: { generated_artifacts: [{ ...metadata,
    artifact_id: 'artifact_traversal', display_path: '../outside.md', absolute_path: outside }] } }];
  assert.equal((await commands.read('session_1', 'artifact_traversal')).error.reason, 'artifact_reference_not_found');
});

test('read rejects symlink escapes, hardlinks, and files over 10 MiB', async (t) => {
  const root = makeTemp(t);
  const configService = configFor(root);
  const scratch = path.join(root, '.jenny', 'artifacts', 'session_1');
  fs.mkdirSync(scratch, { recursive: true });
  const outside = path.join(root, 'outside.txt');
  fs.writeFileSync(outside, 'outside', 'utf8');
  const linked = path.join(scratch, 'linked.txt');
  let hasSymlink = true;
  try { fs.symlinkSync(outside, linked, 'file'); } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    hasSymlink = false;
  }
  const hardlinked = path.join(scratch, 'hardlinked.txt');
  fs.writeFileSync(hardlinked, 'hardlink', 'utf8');
  const hardlinkAlias = path.join(root, 'hardlink-alias.txt');
  fs.linkSync(hardlinked, hardlinkAlias);
  const huge = path.join(scratch, 'huge.bin');
  fs.writeFileSync(huge, Buffer.alloc(MAX_ARTIFACT_BYTES + 1));
  const base = (id, filePath, fileName) => ({ artifact_id: id, artifact_kind: 'document', title: id,
    file_name: fileName, display_path: `.jenny/artifacts/session_1/${fileName}`,
    absolute_path: filePath, language: 'plaintext', status: 'available', editable: false });
  const artifacts = [base('artifact_hardlink', hardlinked, 'hardlinked.txt'),
    base('artifact_huge', huge, 'huge.bin')];
  if (hasSymlink) artifacts.unshift(base('artifact_linked', linked, 'linked.txt'));
  const messages = { session_1: [{ tool_result: { generated_artifacts: artifacts } }] };
  const commands = createArtifactCommands({ backend: backendFor(messages), configService });
  if (hasSymlink) {
    assert.equal((await commands.read('session_1', 'artifact_linked')).error.reason, 'artifact_path_rejected');
  }
  assert.equal((await commands.read('session_1', 'artifact_hardlink')).error.reason, 'artifact_file_rejected');
  assert.equal((await commands.read('session_1', 'artifact_huge')).error.reason, 'artifact_size_limit');
});

test('artifact route rechecks authorization after read and never emits a body after revocation', async () => {
  let checks = 0;
  const routes = createArtifactRoutes({ commands: { async read() {
    await new Promise((resolve) => setTimeout(resolve, 1));
    return { ok: true, bytes: Buffer.from('secret'), artifact: {
      artifact_id: 'artifact_1', title: 'Artifact', file_name: 'artifact.txt',
      mime_type: 'text/plain', language: 'plaintext', artifact_kind: 'document',
    } };
  } } });
  const response = responseStub();
  const handled = await routes(context(response, '/api/v1/sessions/session_1/artifacts/artifact_1', () => ++checks < 2));
  assert.equal(handled, true);
  assert.equal(response.statusCode, 403);
  assert.match(response.body, /client_required/u);
});

test('artifact route downloads with nosniff, octet stream, trusted MIME, and safe Unicode filename headers', async () => {
  const routes = createArtifactRoutes({ commands: { async read() {
    return { ok: true, bytes: Buffer.from('<h1>safe</h1>'), artifact: {
      artifact_id: 'artifact_1', title: 'Artifact', file_name: 'résumé.html',
      mime_type: 'text/html', language: 'html', artifact_kind: 'document',
    } };
  } } });
  const response = responseStub();
  await routes(context(response, '/api/v1/sessions/session_1/artifacts/artifact_1'));
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Content-Type'], 'application/octet-stream');
  assert.equal(response.headers['X-Artifact-Mime-Type'], 'text/html');
  assert.equal(response.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.match(response.headers['Content-Disposition'], /filename="r_sum_\.html"/u);
  assert.match(response.headers['Content-Disposition'], /filename\*=UTF-8''r%C3%A9sum%C3%A9.html/u);
  assert.equal(response.body.toString(), '<h1>safe</h1>');
});

test('artifact route keeps the route closed for invalid ids and unauthenticated clients', async () => {
  let reads = 0;
  const routes = createArtifactRoutes({ commands: { read: async () => { reads += 1; return { ok: false }; } } });
  const invalid = responseStub();
  assert.equal(await routes(context(invalid, `/api/v1/sessions/${'s'.repeat(129)}/artifacts/a`)), false);
  const unauthorized = responseStub();
  assert.equal(await routes(context(unauthorized, '/api/v1/sessions/session_1/artifacts/artifact_1', false)), true);
  assert.equal(unauthorized.statusCode, 403);
  assert.equal(reads, 0);
});
