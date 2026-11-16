'use strict';

// Pinning to a board from outside the Board page (row 150 slice C5, plan PROJECT_BOARD_2026-11-13 section 7.7):
// a chat message, a sketch drawing, a picture, a file or a piece of selected text becomes one card on a board the person
// picked, placed in free space (a card.add with no x or y), applied through the board service as the owner in one batch
// (one undo step). The Board page is not opened and does not need to be up: the page hears the service's own
// `changed` event.
//
// - pin({ boardId, item }): item is one of
//     { kind: 'note', text }                              a note; text past LIMITS.note_chars is cut and ends in `…`
//     { kind: 'chat', sessionId, messageId, title, excerpt }   a chat card; title cut to 200, excerpt to 400
//     { kind: 'diagram', scene, title }                   a diagram card; a scene past the model's limit is refused, not cut
//     { kind: 'file', path }                              a file card, only through files.resolveFile (the project folder check)
//     { kind: 'image', ref }                              a picture card: resolvePicture(ref) -> { ok, bytes }, assets.add(bytes)
//   A key the kind does not list, a missing field, a wrong type or an id that is not a plain token is `invalid` and
//   changes nothing. Every string is length-checked before it is used. The answer is { ok: true, boardId, boardName,
//   cardId } or { ok: false, reason } (the model's `limit` name rides along on `limit`). Nothing here throws.
// - chatRefs({ projectId, sessionId }): every chat card of this session on the project's boards, for the
//   "On board: <name>" line of a pinned message. A board that cannot be read is skipped; at most REFS_MAX.
// - createPictureResolver(backendService): the picture reader. It reuses the two resolvers the main process already
//   uses for a chat picture's Copy and Save as: artifactService.resolveArtifact (a generated picture) and
//   resolveToolResultAttachmentPath (a tool-output picture). The renderer names a picture by session and id only;
//   the size is read from the file's stat before any byte is read. A user-attached picture has no exported resolver
//   (chat-image-file-actions.js keeps it private), so it answers `unavailable`.

const crypto = require('crypto');
const fs = require('fs');
const model = require('./board-model');
const ids = require('./board-ids');

const { LIMITS } = model;
const TITLE_MAX = 200; // the model's FIELD_MAX.title (not exported)
const EXCERPT_MAX = 400; // the model's FIELD_MAX.excerpt (not exported)
const DIAGRAM_TITLE_MAX = 120;
const PATH_MAX = 1024;
const INPUT_MAX = 1024 * 1024; // the most of any text field read at all
const REF_ID_MAX = 256;
const REF_SESSION_MAX = 128;
const REFS_MAX = 200;
const BOARDS_SCANNED_MAX = LIMITS.boards_per_project;
const TOKEN_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const PICTURE_KINDS = new Set(['artifact', 'tool', 'attachment']);
const KEYS = Object.freeze({
  note: ['kind', 'text'],
  chat: ['kind', 'sessionId', 'messageId', 'title', 'excerpt'],
  diagram: ['kind', 'scene', 'title'],
  file: ['kind', 'path'],
  image: ['kind', 'ref'],
});
// Single-line text: control characters and line separators out. Note text keeps \n and \t, like the model.
// eslint-disable-next-line no-control-regex -- refusing control characters is the point.
const LINE_BAD_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
// eslint-disable-next-line no-control-regex -- refusing control characters is the point.
const TEXT_BAD_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g;

const fail = (reason, extra) => (extra ? { ok: false, reason, ...extra } : { ok: false, reason });
const INVALID = () => fail('invalid');
const isPlainObject = (v) => v !== null && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Object]';
const hasOnly = (value, keys) => isPlainObject(value) && Object.keys(value).every((key) => keys.includes(key));
const isString = (v, max) => typeof v === 'string' && v.length <= max;
const isToken = (v) => typeof v === 'string' && TOKEN_RE.test(v);
// The first `max` characters of a text, never ending in the middle of a surrogate pair (a lone half is not text).
function cutAt(text, max) {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}
const oneLine = (text, max) => cutAt(text.replace(LINE_BAD_RE, ' ').replace(/\s+/g, ' ').trim(), max);

function cutNote(text) {
  const clean = text.replace(/\r\n?/g, '\n').replace(TEXT_BAD_RE, ' ').trim();
  return clean.length > LIMITS.note_chars ? `${cutAt(clean, LIMITS.note_chars - 1)}…` : clean;
}

/** The card's kind and data for an item that needs nothing read from disk, or { failure }. */
function plainCard(item) {
  switch (item.kind) {
    case 'note': {
      if (!isString(item.text, INPUT_MAX)) return { failure: INVALID() };
      const text = cutNote(item.text);
      return text ? { kind: 'note', data: { text } } : { failure: INVALID() };
    }
    case 'chat': {
      if (!isToken(item.sessionId) || !isToken(item.messageId)) return { failure: INVALID() };
      if (!isString(item.title, INPUT_MAX) || !isString(item.excerpt, INPUT_MAX)) return { failure: INVALID() };
      return { kind: 'chat', data: { session_id: item.sessionId, message_id: item.messageId, title: oneLine(item.title, TITLE_MAX), excerpt: oneLine(item.excerpt, EXCERPT_MAX) } };
    }
    case 'diagram': {
      if (!isString(item.scene, LIMITS.diagram_chars + 1) || !isString(item.title, INPUT_MAX)) return { failure: INVALID() };
      if (item.scene.length > LIMITS.diagram_chars) return { failure: fail('invalid', { limit: 'diagram_chars' }) };
      if (!item.scene.trim()) return { failure: INVALID() };
      return { kind: 'diagram', data: { scene: item.scene, title: oneLine(item.title, DIAGRAM_TITLE_MAX) } };
    }
    default: return { failure: INVALID() };
  }
}

function readItem(item) {
  if (!isPlainObject(item) || typeof item.kind !== 'string' || !Object.prototype.hasOwnProperty.call(KEYS, item.kind)) return { failure: INVALID() };
  const keys = KEYS[item.kind];
  if (!hasOnly(item, keys) || Object.keys(item).length !== keys.length) return { failure: INVALID() };
  if (item.kind === 'file') return isString(item.path, PATH_MAX) && item.path ? { kind: 'file' } : { failure: INVALID() };
  if (item.kind === 'image') {
    const ref = item.ref;
    const valid = hasOnly(ref, ['kind', 'id', 'sessionId']) && Object.keys(ref).length === 3 && PICTURE_KINDS.has(ref.kind)
      && isString(ref.id, REF_ID_MAX) && ref.id !== '' && isString(ref.sessionId, REF_SESSION_MAX) && ref.sessionId !== '';
    return valid ? { kind: 'image' } : { failure: INVALID() };
  }
  return plainCard(item);
}

function createBoardPins({ service, getFiles, getAssets, resolvePicture } = {}) {
  const makeId = () => crypto.randomUUID();

  async function pictureCard(boardId, ref) {
    if (typeof resolvePicture !== 'function') return { failure: fail('unavailable') };
    const picture = await resolvePicture(ref);
    if (!picture || picture.ok !== true) return { failure: fail(picture && typeof picture.reason === 'string' ? picture.reason : 'unavailable') };
    const bytes = picture.bytes;
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) return { failure: INVALID() };
    if ((bytes.byteLength || 0) > LIMITS.image_asset_bytes) return { failure: fail('too_large') };
    const stored = getAssets().add(bytes);
    if (!stored || stored.ok !== true) return { failure: fail(stored && stored.reason ? stored.reason : 'io') };
    return { kind: 'image', data: { asset: stored.asset, width: stored.width, height: stored.height, alt: '' } };
  }

  async function fileCard(boardId, path) {
    const resolved = await getFiles().resolveFile({ boardId, path });
    if (!resolved || resolved.ok !== true) return { failure: fail(resolved && resolved.reason ? resolved.reason : 'io') };
    return { kind: 'file', data: { path: resolved.path, title: resolved.title } };
  }

  async function pin(raw) {
    try {
      if (!hasOnly(raw, ['boardId', 'item']) || !ids.isBoardId(raw.boardId)) return INVALID();
      const { boardId, item } = raw;
      const read = readItem(item);
      if (read.failure) return read.failure;
      const found = await service.get({ boardId });
      if (!found || found.ok !== true) return fail(found && typeof found.reason === 'string' ? found.reason : 'not_found');
      if (found.readOnly || !found.board) return fail('read_only');
      let card = read;
      if (item.kind === 'file') card = await fileCard(boardId, item.path);
      else if (item.kind === 'image') card = await pictureCard(boardId, item.ref);
      if (card.failure) return card.failure;
      const cardId = makeId();
      const applied = await service.apply({ boardId, batch: {
        batch_id: `pin-${makeId()}`, board_id: boardId, ops: [{ op: 'card.add', card: { id: cardId, kind: card.kind, data: card.data } }],
      } });
      if (!applied || applied.ok !== true || !applied.board) {
        return fail(applied && typeof applied.reason === 'string' ? applied.reason : 'io', applied && typeof applied.limit === 'string' ? { limit: applied.limit } : undefined);
      }
      return { ok: true, boardId, boardName: applied.board.name, cardId };
    } catch (_error) {
      return fail('io');
    }
  }

  async function chatRefs(raw) {
    try {
      if (!hasOnly(raw, ['projectId', 'sessionId']) || !ids.isProjectId(raw.projectId) || !isToken(raw.sessionId)) return INVALID();
      const listed = await service.list({ projectId: raw.projectId });
      if (!listed || listed.ok !== true || !Array.isArray(listed.boards)) return fail(listed && listed.reason ? listed.reason : 'io');
      const refs = [];
      for (const entry of listed.boards.slice(0, BOARDS_SCANNED_MAX)) {
        let got = null;
        try { got = await service.get({ boardId: entry.id }); } catch (_error) { got = null; }
        if (!got || got.ok !== true || got.readOnly || !got.board || !isPlainObject(got.board.cards)) continue;
        for (const card of Object.values(got.board.cards)) {
          if (refs.length >= REFS_MAX) break;
          if (card && card.kind === 'chat' && card.data && card.data.session_id === raw.sessionId) {
            refs.push({ messageId: card.data.message_id, boardId: entry.id, boardName: got.board.name, cardId: card.id });
          }
        }
        if (refs.length >= REFS_MAX) break;
      }
      return { ok: true, refs };
    } catch (_error) {
      return fail('io');
    }
  }

  return Object.freeze({ pin, chatRefs });
}

/**
 * resolvePicture({ kind, id, sessionId }) -> { ok: true, bytes } | { ok: false, reason }. `fsApi` is for tests.
 * A picture over LIMITS.image_asset_bytes is `too_large` and is never read.
 */
function createPictureResolver(backendService, fsApi = fs) {
  async function locate(ref) {
    if (ref.kind === 'artifact') {
      const service = backendService && backendService.artifactService;
      if (!service || typeof service.resolveArtifact !== 'function') return null;
      const artifact = await service.resolveArtifact(ref.sessionId, ref.id);
      return artifact && artifact.status === 'available' && artifact.artifact_kind === 'image' && typeof artifact.absolute_path === 'string' ? artifact.absolute_path : null;
    }
    if (ref.kind === 'tool') {
      const resolved = require('../backend/tool-result-attachments').resolveToolResultAttachmentPath(backendService, ref.sessionId, ref.id);
      return resolved && resolved.ok === true && typeof resolved.path === 'string' ? resolved.path : null;
    }
    return null;
  }
  return async function resolvePicture(ref) {
    try {
      const located = await locate(ref);
      if (!located) return fail('unavailable');
      const stat = fsApi.statSync(located);
      if (!stat.isFile()) return fail('unavailable');
      if (stat.size > LIMITS.image_asset_bytes) return fail('too_large');
      return { ok: true, bytes: new Uint8Array(fsApi.readFileSync(located)) };
    } catch (_error) {
      return fail('unavailable');
    }
  };
}

module.exports = { REFS_MAX, createBoardPins, createPictureResolver };
