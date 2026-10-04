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

function authorityFor(root) {
  return {
    captureSession() { return { project_id: 'project_test', root_path: root, root_id: 'root_test', root_revision: 1 }; },
    requireCurrent(authority) { assert.equal(authority.root_path, root); },
  };
}

function backendFor(messages, root) {
  return {
    projectAuthority: authorityFor(root),
    async getSessionMessages(sessionId) {
      return { data: messages[sessionId] || [] };
    },
  };
}

async function createCanonicalArtifact(root, messages, options = {}) {
  const configService = configFor(root);
  const writer = new ArtifactWorkspaceService({ configService, projectAuthorityProvider: authorityFor(root) });
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

test('artifact reads use the bound session project instead of the global workspace', async (t) => {
  const root = makeTemp(t);
  const projectRoot = path.join(root, 'project');
  fs.mkdirSync(projectRoot);
  const messages = {};
  const { metadata } = await createCanonicalArtifact(projectRoot, messages);
  const backend = backendFor(messages, root);
  backend.projectAuthority = {
    captureSession(sessionId) {
      assert.equal(sessionId, 'session_1');
      return { project_id: 'project_a', root_path: projectRoot, root_id: 'root_a', root_revision: 1 };
    },
    requireCurrent(authority) { assert.equal(authority.root_path, projectRoot); },
  };
  const commands = createArtifactCommands({ backend, configService: configFor(root) });
  const result = await commands.read('session_1', metadata.artifact_id);
  assert.equal(result.ok, true, 'project-scoped canonical artifact must resolve');
  assert.equal(result.bytes.toString(), 'artifact body');
  backend.projectAuthority.captureSession = () => { throw new Error('session_unbound'); };
  assert.equal((await commands.read('session_1', metadata.artifact_id)).ok, false);
});

test('artifact reads fail closed when backend project authority is missing', async (t) => {
  const root = makeTemp(t);
  const messages = {};
  const { configService, metadata } = await createCanonicalArtifact(root, messages);
  const backend = backendFor(messages, root);
  delete backend.projectAuthority;
  const commands = createArtifactCommands({ backend, configService });
  assert.equal((await commands.read('session_1', metadata.artifact_id)).ok, false);
});

test('artifact routes preserve the shared semantic failure envelope for each host code', async () => {
  const { ERROR_CODES, hostFailure } = require('../../server/api-contract');
  const statuses = { invalid: 400, unauthorized: 401, forbidden: 403, conflict: 409,
    limit: 429, persistence: 503, unavailable: 503 };
  for (const kind of Object.keys(ERROR_CODES)) {
    const result = hostFailure(kind, 'artifact_test_failure', '', kind === 'persistence');
    const response = responseStub();
    const routes = createArtifactRoutes({ commands: { async read() { return result; } } });
    await routes(context(response, '/api/v1/sessions/session_1/artifacts/artifact_1'));
    assert.equal(response.statusCode, statuses[kind]);
    assert.deepEqual(JSON.parse(response.body), hostFailure(kind, 'artifact_test_failure', 'request_1', kind === 'persistence'));
  }
});

test('read resolves a canonical ArtifactWorkspaceService row and returns bounded metadata plus bytes', async (t) => {
  const root = makeTemp(t);
  const messages = {};
  const { configService, metadata } = await createCanonicalArtifact(root, messages);
  const commands = createArtifactCommands({ backend: backendFor(messages, root), configService });
  const result = await commands.read('session_1', metadata.artifact_id);
  assert.deepEqual(result.artifact, {
    artifact_id: metadata.artifact_id,
    title: metadata.title,
    file_name: metadata.file_name,
    mime_type: 'text/markdown',
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
  const commands = createArtifactCommands({ backend: backendFor(messages, root), configService });
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
  const commands = createArtifactCommands({ backend: backendFor(messages, root), configService });
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

function rawArtifact(scratch, fileName, language = 'plaintext') {
  return { artifact_id: `artifact_${fileName.replace(/[^A-Za-z0-9]/gu, '_')}`, artifact_kind: 'document',
    title: fileName, file_name: fileName, display_path: `.jenny/artifacts/session_1/${fileName}`,
    absolute_path: path.join(scratch, fileName), language, status: 'available', editable: false };
}

test('read allocates a buffer sized to the file, not the 10 MiB maximum', async (t) => {
  const root = makeTemp(t);
  const scratch = path.join(root, '.jenny', 'artifacts', 'session_1');
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'small.txt'), Buffer.alloc(16, 97));
  const art = rawArtifact(scratch, 'small.txt');
  const commands = createArtifactCommands({ backend: backendFor({ session_1: [{ tool_result: { generated_artifacts: [art] } }] }, root),
    configService: configFor(root) });
  const result = await commands.read('session_1', art.artifact_id);
  assert.equal(result.bytes.length, 16);
  assert.ok(result.bytes.buffer.byteLength <= 17, `backing store ${result.bytes.buffer.byteLength}`);
});

test('read enforces the size limit at exactly MAX and rejects MAX+1', async (t) => {
  const root = makeTemp(t);
  const scratch = path.join(root, '.jenny', 'artifacts', 'session_1');
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(path.join(scratch, 'max.bin'), Buffer.alloc(MAX_ARTIFACT_BYTES));
  fs.writeFileSync(path.join(scratch, 'over.bin'), Buffer.alloc(MAX_ARTIFACT_BYTES + 1));
  const arts = [rawArtifact(scratch, 'max.bin'), rawArtifact(scratch, 'over.bin')];
  const commands = createArtifactCommands({ backend: backendFor({ session_1: [{ tool_result: { generated_artifacts: arts } }] }, root),
    configService: configFor(root) });
  const ok = await commands.read('session_1', arts[0].artifact_id);
  assert.equal(ok.ok, true);
  assert.equal(ok.bytes.length, MAX_ARTIFACT_BYTES);
  assert.equal((await commands.read('session_1', arts[1].artifact_id)).error.reason, 'artifact_size_limit');
});

test('read rejects a file that grows during the read', async (t) => {
  const root = makeTemp(t);
  const scratch = path.join(root, '.jenny', 'artifacts', 'session_1');
  fs.mkdirSync(scratch, { recursive: true });
  const file = path.join(scratch, 'grow.txt');
  fs.writeFileSync(file, 'abcd');
  const art = rawArtifact(scratch, 'grow.txt');
  const realOpen = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await realOpen.apply(fs.promises, args);
    const realRead = handle.read.bind(handle);
    handle.read = async (...a) => { fs.appendFileSync(file, 'more'); return realRead(...a); };
    return handle;
  });
  const commands = createArtifactCommands({ backend: backendFor({ session_1: [{ tool_result: { generated_artifacts: [art] } }] }, root),
    configService: configFor(root) });
  const result = await commands.read('session_1', art.artifact_id);
  assert.equal(result.ok, false);
  assert.ok(['artifact_changed_during_read', 'artifact_size_limit'].includes(result.error.reason));
});

test('read projects MIME from a narrow filename-extension allowlist when the producer gives none', async (t) => {
  const root = makeTemp(t);
  const scratch = path.join(root, '.jenny', 'artifacts', 'session_1');
  fs.mkdirSync(scratch, { recursive: true });
  const cases = [['notes.md', 'markdown', 'text/markdown'], ['x.html', 'html', 'text/html'],
    ['d.json', 'json', 'application/json'], ['v.svg', 'svg', 'image/svg+xml'],
    ['x.bin', 'plaintext', 'application/octet-stream'], ['x.md.exe', 'markdown', 'application/octet-stream'],
    ['a.txt', 'html', 'text/plain'], ['noext', 'html', 'application/octet-stream']];
  const arts = cases.map(([name, lang]) => { fs.writeFileSync(path.join(scratch, name), 'x'); return rawArtifact(scratch, name, lang); });
  const commands = createArtifactCommands({ backend: backendFor({ session_1: [{ tool_result: { generated_artifacts: arts } }] }, root),
    configService: configFor(root) });
  for (let i = 0; i < cases.length; i += 1) {
    const result = await commands.read('session_1', arts[i].artifact_id);
    assert.equal(result.artifact.mime_type, cases[i][2], cases[i][0]);
  }
});
