'use strict';

const path = require('node:path');
const zlib = require('node:zlib');
const { BackendService } = require('../../services/backend/backend-service');
const { ArtifactWorkspaceService } = require('../../services/artifact-workspace-service');
const { createFakeSafeStorage } = require('./fake-safe-storage');

// Real, decodable colored pixels for Chromium layout/zoom and byte-fidelity checks.
function makeViewerPng(width = 1024, height = 768) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      pixels[offset] = Math.round(x / width * 255);
      pixels[offset + 1] = Math.round(y / height * 255);
      pixels[offset + 2] = 120;
      pixels[offset + 3] = x < width / 4 ? 0 : x < width / 2 ? 128 : 255;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

async function seedImageViewerSession(profile, workspace, { width = 1024, height = 768 } = {}) {
  const service = new BackendService({ userDataPath: profile, repoRoot: path.resolve(__dirname, '../..'),
    pythonExecutable: process.execPath, safeStorage: createFakeSafeStorage(), defaultModel: 'replay' });
  try {
    const project = service.projectService.create({ name: 'Image viewer verification' }).project;
    const binding = service.projectService.bindRoot(project.id, workspace, { expectedRevision: 0 });
    if (!binding.ok) throw new Error('image_fixture_project_binding_failed');
    const session = (await service.createSession({ projectId: project.id })).data;
    service.artifactService = new ArtifactWorkspaceService({
      projectAuthorityProvider: () => service.projectAuthority,
      sessionMessageReader: (id) => service.sessionStore.getSession(id)?.messages || [],
    });
    const png = makeViewerPng(width, height);
    const artifact = (await service.artifactService.createBinaryArtifact(session.id, {
      content: png, artifactKind: 'image', mimeType: 'image/png', title: 'Viewer fixture', fileName: 'viewer-fixture.png',
    })).metadata;
    const timestamp = new Date().toISOString();
    const turn_id = 'viewer-fixture-turn';
    const messages = [
      { id: 'viewer-user', role: 'user', content: 'Generate an image for viewer verification.', timestamp, turn_id },
      { id: 'viewer-call', role: 'assistant', kind: 'tool_use', content: '', timestamp, turn_id,
        tool_call: { call_id: 'viewer-call-id', tool_name: 'image_generate', status: 'completed', input: { prompt: 'Colored gradient' } } },
      { id: 'viewer-result', role: 'tool', kind: 'tool_result', content: 'Image generated.', timestamp, turn_id,
        tool_result: { call_id: 'viewer-call-id', tool_name: 'image_generate', output_text: 'Image generated.', is_error: false,
          generated_artifacts: [artifact], metadata: { result_kind: 'image_generated', provenance: { width, height, seed: 42 } } } },
      { id: 'viewer-answer', role: 'assistant', content: `Done! Here's your image:\n\n![image](${artifact.display_path})`,
        timestamp, finalizedAt: timestamp, status: 'complete', turn_id, model_used: 'replay' },
    ];
    for (const message of messages) {
      if (!service.sessionStore.appendMessage(session.id, message)) throw new Error('image_fixture_message_failed');
    }
    service.sessionStore.updateSession(session.id, { title: 'Image viewer smoke' });
    return { sessionId: session.id, artifact, png };
  } finally {
    service.dispose();
  }
}

module.exports = { makeViewerPng, seedImageViewerSession };
