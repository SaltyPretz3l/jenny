'use strict';

const { readPngStructure } = require('./backend/png-validator');
const modelSets = require('./image-model-sets');
const path = require('node:path');
const { MAX_BINARY_ARTIFACT_BYTES: MAX_BYTES } = require('./artifact-workspace-service');
const MAX_PIXELS = 4 * 1024 * 1024;
const ID = /^[a-zA-Z0-9_-]{1,240}$/;

function validateRegion(region, width, height) {
  if (region === undefined || region === null) return null;
  if (!region || !['box', 'ellipse', 'freehand'].includes(region.kind) || !Array.isArray(region.points)
    || region.points.length < (region.kind === 'freehand' ? 3 : 2)
    || region.points.length > (region.kind === 'freehand' ? 128 : 2)) throw new Error('image_edit_invalid_region');
  const points = region.points.map((point) => {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)
      || point[0] < 0 || point[1] < 0 || point[0] > width || point[1] > height) throw new Error('image_edit_invalid_region');
    return point.map(Math.round);
  });
  const xs = points.map((p) => p[0]); const ys = points.map((p) => p[1]);
  if (Math.max(...xs) - Math.min(...xs) < 4 || Math.max(...ys) - Math.min(...ys) < 4) throw new Error('image_edit_invalid_region');
  return { kind: region.kind, points };
}

function outline(region) {
  if (region.kind === 'freehand') return [...region.points, region.points[0]];
  const [[x1, y1], [x2, y2]] = region.points;
  if (region.kind === 'box') return [[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]];
  return Array.from({ length: 129 }, (_, index) => {
    const angle = index * Math.PI / 64;
    return [(x1 + x2) / 2 + (x2 - x1) / 2 * Math.cos(angle), (y1 + y2) / 2 + (y2 - y1) / 2 * Math.sin(angle)];
  });
}

function markRegion(image, region, nativeImage) {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  if (bitmap.length !== width * height * 4) throw new Error('image_edit_source_invalid');
  const points = outline(region);
  const radius = Math.max(1, Math.round(Math.min(width, height) / 400));
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]; const b = points[index];
    const count = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))) || 1;
    for (let step = 0; step <= count; step++) {
      const x = Math.round(a[0] + (b[0] - a[0]) * step / count);
      const y = Math.round(a[1] + (b[1] - a[1]) * step / count);
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
        if (x + dx < 0 || y + dy < 0 || x + dx >= width || y + dy >= height) continue;
        const at = ((y + dy) * width + x + dx) * 4;
        // Opaque magenta has identical RGBA/BGRA channel order.
        bitmap[at] = 255; bitmap[at + 1] = 0; bitmap[at + 2] = 255; bitmap[at + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width, height }).toPNG();
}

async function readEditReference({ artifactService, sessionId, artifactId, region, nativeImage }) {
  if (!ID.test(artifactId || '')) throw new Error('image_edit_source_invalid');
  const result = await artifactService.readArtifact(sessionId, artifactId);
  const prefix = 'data:image/png;base64,';
  const data = result?.asset_data_url;
  if (result?.artifact?.artifact_kind !== 'image' || typeof data !== 'string' || !data.startsWith(prefix)
    || data.length > Math.ceil(MAX_BYTES / 3) * 4 + prefix.length) throw new Error('image_edit_source_invalid');
  const bytes = Buffer.from(data.slice(prefix.length), 'base64');
  const structure = readPngStructure(bytes);
  if (!structure.ok || bytes.length > MAX_BYTES || structure.width * structure.height > MAX_PIXELS) throw new Error('image_edit_source_invalid');
  const selection = validateRegion(region, structure.width, structure.height);
  const image = nativeImage.createFromBuffer(bytes);
  const size = image.getSize();
  if (image.isEmpty() || size.width !== structure.width || size.height !== structure.height) throw new Error('image_edit_source_invalid');
  const buffer = selection ? markRegion(image, selection, nativeImage) : bytes;
  if (buffer.length > MAX_BYTES) throw new Error('image_edit_source_invalid');
  return { buffer, width: size.width, height: size.height, artifactId, region: selection };
}

const capabilityCache = new WeakMap();
async function imageEditingAvailable(backendService) {
  if (!backendService) return { imageEditing: false, imageEditSizes: [] };
  const cached = capabilityCache.get(backendService);
  if (cached && Date.now() < cached.expires) return cached.value;
  const value = await resolveEditingCapabilities(backendService);
  capabilityCache.set(backendService, { value, expires: Date.now() + 1000 });
  return value;
}
async function resolveEditingCapabilities(backendService) {
  try {
    const storePath = path.join(backendService.options.userDataPath, 'image-models.json');
    const id = modelSets.listModelSets({ storePath }).default_id;
    const resolved = modelSets.resolveModelSet(id, { storePath });
    const family = resolved.ok && modelSets.loadFamilies().families[resolved.set.family];
    const available = Boolean(family?.vision_flag && resolved.paths.vision_projector && (await backendService.imageEngine.resolveExecutable())?.ok);
    return { imageEditing: available, imageEditSizes: available ? family.resolutions : [] };
  } catch (_error) { return { imageEditing: false, imageEditSizes: [] }; }
}

module.exports = { MAX_BYTES, validateRegion, outline, markRegion, readEditReference, imageEditingAvailable };
