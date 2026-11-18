'use strict';

const { HOST_ERROR_CODES } = require('../services/backend/error-codes');
const { RULE_TOOL_NAMES } = require('./team/project-rules-match');

const Ajv = require('ajv');

const API_VERSION = 1;
const EXECUTION_POLICY_VERSION = 1;
const ERROR_CODES = Object.freeze({
  invalid: HOST_ERROR_CODES.INVALID,
  unauthorized: HOST_ERROR_CODES.UNAUTHORIZED,
  forbidden: HOST_ERROR_CODES.FORBIDDEN,
  conflict: HOST_ERROR_CODES.CONFLICT,
  unavailable: HOST_ERROR_CODES.UNAVAILABLE,
  persistence: HOST_ERROR_CODES.PERSISTENCE,
  limit: HOST_ERROR_CODES.LIMIT,
});

const id = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$' };
const projectId = { type: 'string', minLength: 9, maxLength: 136, pattern: '^project_[A-Za-z0-9_-]{1,128}$' };
const authorityKey = { type: 'string', pattern: '^authority_[a-f0-9]{64}$' };
const text = (maxLength) => ({ type: 'string', maxLength });
const object = (properties, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const positiveRevision = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const teamRole = { enum: ['member', 'read_only'] };
const projectRole = { enum: ['admin', 'writer', 'reader'] };
const projectName = { type: 'string', minLength: 1, maxLength: 80 };
// Row 151 slice T2. The board model checks a name's characters and every operation of a batch; these bound them.
const boardId = { type: 'string', pattern: '^board_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const boardName = { type: 'string', minLength: 1, maxLength: 200 };
const boardBatch = object({ batch_id: { type: 'string', maxLength: 200, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:@-]*$' },
  ops: { type: 'array', maxItems: 4096, items: { type: 'object' } } }, ['batch_id', 'ops']);
const teamCount = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
// A conversation message id as the session store keeps it (printable, no space).
const messageRef = { type: 'string', minLength: 1, maxLength: 256, pattern: '^[!-~]+$' };
// Row 151 slices T4 and T5: a card, a pointer and a proposal on a team board.
const boardRef = { project_id: projectId, board_id: boardId };
const boardKeys = ['project_id', 'board_id'];
const boardCardId = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' };
const boardCoordinate = { type: 'number', minimum: -10_000_000, maximum: 10_000_000 };
const boardProposalId = { type: 'string', minLength: 1, maxLength: 500 };
const boardDecision = object({ ...boardRef, proposal_id: boardProposalId, n: { type: 'integer', minimum: 1, maximum: 100_000 } },
  [...boardKeys, 'proposal_id']);
// Slice 3-12: the tools a project rule may cover, and its folder (null: anywhere in the project).
const ruleTool = { enum: [...RULE_TOOL_NAMES] };
const ruleFolder = { anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 255 }] };
const runtimeControl = { work_id: id, expected_revision: positiveRevision };
// Team chat (TEAM_CHAT_SPEC "API and realtime"): the chat store re-validates every id, text and ref.
const channelId = { type: 'string', minLength: 6, maxLength: 160, pattern: '^chan_[A-Za-z0-9_-]+$' };
const chatText = { type: 'string', minLength: 1, maxLength: 32_000 };
const chatLimit = (maximum) => ({ type: 'integer', minimum: 1, maximum });
// Row 173: a channel's name and topic on the wire. The host normalizes both and holds a name to 40 code points and
// a topic to 250 (team-chat-names.js); these bound the raw strings at four UTF-16 units per code point.
const channelName = { type: 'string', minLength: 1, maxLength: 160 };
const channelTopic = { type: 'string', maxLength: 1000 };
// The team chat search cursor (slice 2a-3b): opaque base64url, bounded. The
// search module checks the same bound and alphabet when it decodes one.
const CHAT_CURSOR_MAX_CHARS = 512;
const CHAT_CURSOR_PATTERN = '^[A-Za-z0-9_-]+$';
const chatRef = { anyOf: [
  object({ kind: { const: 'conversation' }, session_id: id }, ['kind', 'session_id']),
  object({ kind: { const: 'file' }, project_id: projectId, path: { ...text(1024), minLength: 1 },
    line: { anyOf: [positiveRevision, { type: 'null' }] } }, ['kind', 'project_id', 'path', 'line']),
  object({ kind: { const: 'message' }, channel_id: channelId, message_id: id }, ['kind', 'channel_id', 'message_id']),
] };
// Slice 4c host (node protocol spec N6): a node's register. The bounds agree with the
// scheduler's planRegister and normalizeModels, which stay the authority (a model's
// `name` becomes its id; duplicate names are refused there).
const printable = (maxLength) => ({ type: 'string', minLength: 1, maxLength, pattern: '^[\\x21-\\x7e][\\x20-\\x7e]*$' });
const nodeModel = object({
  name: printable(128),
  context_length: { anyOf: [{ type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, { type: 'null' }] },
  vision: { type: 'boolean' }, thinking: { type: 'boolean' }, quantization: printable(64),
  size_bytes: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
}, ['name', 'context_length', 'vision', 'thinking']);
const laneLimits = { runnable_turns: { type: 'integer', minimum: 1, maximum: 16 },
  inference_requests: { type: 'integer', minimum: 1, maximum: 64 },
  descendants: { type: 'integer', minimum: 0, maximum: 512 },
  descendant_depth: { type: 'integer', minimum: 0, maximum: 8 } };
const resourceLimits = { tool_operations: { type: 'integer', minimum: 1, maximum: 64 },
  native_processes: { type: 'integer', minimum: 1, maximum: 64 },
  tests: { type: 'integer', minimum: 1, maximum: 16 } };
// Slice 6-3 (TEAM_MODEL_SHARING_SPEC "Host operations"): the model relay's ids, and the offer manifest closed at
// every level with loose bounds, so model-manifest.js (6-1) stays the authority and answers its own reasons.
const modelOfferId = { type: 'string', pattern: '^offer_[A-Za-z0-9_-]{22}$' };
const modelTransferId = { type: 'string', pattern: '^mxfer_[A-Za-z0-9_-]{22}$' };
const modelText = (maxLength) => ({ type: 'string', maxLength });
const modelManifest = {
  request_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
  audience: { anyOf: [object({ kind: { const: 'member' }, member_id: id }, ['kind', 'member_id']),
    object({ kind: { const: 'team' } }, ['kind'])] },
  display_name: modelText(1024),
  files: { type: 'array', maxItems: 16, items: object({ name: modelText(1024), size: { type: 'integer' },
    sha256: modelText(128), segments: { type: 'array', maxItems: 128, items: modelText(128) } },
  ['name', 'size', 'sha256', 'segments']) },
  provenance: object({ licence: modelText(16_384), source_url: { anyOf: [modelText(2048), { type: 'null' }] },
    note: modelText(8192) }, ['licence', 'source_url', 'note']),
};
const modelTransfer = object({ transfer_id: modelTransferId }, ['transfer_id']);
// Every reason a model operation or part route answers (the relay's and the routes'), closed: no free text.
const TEAM_MODEL_REASONS = Object.freeze(['team_model_manifest_invalid', 'team_model_name_invalid',
  'team_model_request_invalid', 'team_not_found', 'role_forbidden', 'member_pending', 'member_revoked',
  'client_required', 'team_model_transfer_stale', 'team_model_offer_taken', 'team_model_request_reused',
  'team_model_sharing_off', 'team_model_sender_offline', 'host_unavailable', 'team_model_size_limit',
  'team_model_offer_limit', 'team_model_relay_busy', 'team_rate_limit']);
const runtimeLimits = full => object({ local: object(laneLimits, full ? Object.keys(laneLimits) : []),
  cloud: object(laneLimits, full ? Object.keys(laneLimits) : []),
  resources: object(resourceLimits, full ? Object.keys(resourceLimits) : []) }, full ? ['local', 'cloud', 'resources'] : []);
// This is an explicit service vocabulary, not a reflection of Electron IPC.
const PARAM_SCHEMAS = Object.freeze({
  'sessionRuntime.getSnapshot': object({ project_id: projectId, session_id: id, cursor: { anyOf: [text(4096), { type: 'null' }] },
    limit: { type: 'integer', minimum: 1, maximum: 100 }, view: { enum: ['runs'] }, finished_since: text(40) }),
  'sessionRuntime.getWork': object({ work_id: id, child_offset: { type: 'integer', minimum: 0, maximum: 512 },
    lineage_revision: positiveRevision }, ['work_id']),
  'sessionRuntime.getResult': object({ work_id: id }, ['work_id']),
  'sessionRuntime.start': object({ purpose: { ...text(256), minLength: 1 }, prompt: { ...text(100000), minLength: 1 },
    limits: object(Object.fromEntries(['inference_requests', 'input_tokens', 'output_tokens'].map(key =>
      [key, { type: 'integer', minimum: 1, maximum: 1000000000000 }])), ['inference_requests', 'input_tokens', 'output_tokens']) },
  ['purpose', 'prompt', 'limits']),
  'sessionRuntime.pause': object(runtimeControl, ['work_id', 'expected_revision']),
  'sessionRuntime.resume': object(runtimeControl, ['work_id', 'expected_revision']),
  'sessionRuntime.cancel': object(runtimeControl, ['work_id', 'expected_revision']),
  'sessionRuntime.updatePending': object({ ...runtimeControl, prompt: { ...text(100000), minLength: 1 } },
    ['work_id', 'expected_revision', 'prompt']),
  'sessionRuntime.updateLimits': object({ expected_limits: runtimeLimits(true), patch: runtimeLimits(false) },
    ['expected_limits', 'patch']),
  'sessions.list': object({}),
  'requests.status': object({ request_id: id }, ['request_id']),
  'sessions.create': object({ title: text(80), project_id: projectId }),
  'sessions.rename': object({ title: { ...text(80), minLength: 1 } }, ['title']),
  'sessions.delete': object({}),
  'sessions.snapshot': object({
    before_message_id: text(256), max_messages: { type: 'integer', minimum: 1, maximum: 100 },
  }),
  // allowed_nodes: size bounds only; the router decides (server/command-router-preferences.js). Row 172: the team host
  // alone takes the model (null: the team default), the effort and the tool switches (server/team-conversation-preferences.js).
  'sessions.preferences': { ...object({ plan_mode: { type: 'boolean' }, run_mode: { enum: ['ask', 'auto', 'plan', 'propose'] },
    allowed_nodes: { anyOf: [{ type: 'null' }, { type: 'array', maxItems: 64, items: text(128) }] },
    preferred_model: { anyOf: [{ type: 'null' }, printable(256)] }, reasoning_effort: { enum: ['default', 'low', 'medium', 'high'] },
    team_tools: { ...object({ read: { type: 'boolean' }, write: { type: 'boolean' } }), minProperties: 1 } }), minProperties: 1 },
  // Propose mode (row 35): the suggestion record of the command's session.
  'suggestedChanges.list': object({}),
  'suggestedChanges.decide': object({
    id, decision: { enum: ['reject', 'later', 'restore', 'ungroup'] }, reason: text(400),
  }, ['id', 'decision']),
  'suggestedChanges.comment': object({ id, text: { ...text(2000), minLength: 1 } }, ['id', 'text']),
  'suggestedChanges.sendComments': object({
    undo: object({ ids: { type: 'array', maxItems: 200, uniqueItems: true, items: id }, sent_at: { ...text(40), minLength: 1 } }, ['ids', 'sent_at']),
  }),
  'suggestedChanges.discardPending': object({}),
  // Consent is for the revision the person saw; `force` is the confirmed "Apply anyway".
  'suggestedChanges.accept': object({ id, revision: positiveRevision, force: { type: 'boolean' } }, ['id', 'revision']),
  'projects.list': object({}),
  'projects.create': object({ name: { ...text(80), minLength: 1 } }, ['name']),
  'projects.rename': object({
    project_id: projectId, name: { ...text(80), minLength: 1 },
  }, ['project_id', 'name']),
  'projects.bindRoot': object({
    project_id: projectId,
    root_path: { anyOf: [{ type: 'null' }, { ...text(4096), minLength: 1, pattern: '^/' }] },
    expected_root_revision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  }, ['project_id', 'root_path', 'expected_root_revision']),
  'projects.assignSession': object({ project_id: projectId }, ['project_id']),
  'permissionReview.getState': object({}),
  'permissionReview.resolve': {
    oneOf: [
      object({
        review_id: id,
        decision: { enum: ['ask', 'deny', 'dismiss'] },
      }, ['review_id', 'decision']),
      object({
        review_id: id,
        decision: { const: 'auto' },
        project_id: projectId,
        expected_root_revision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        expected_authority_key: authorityKey,
      }, [
        'review_id', 'decision', 'project_id', 'expected_root_revision', 'expected_authority_key',
      ]),
    ],
  },
  'control.acquire': object({ takeover: { type: 'boolean' } }),
  'control.heartbeat': object({}),
  'control.release': object({}),
  'chat.send': object({
    prompt: { ...text(100_000), minLength: 1 },
    attachment_ids: { type: 'array', maxItems: 8, uniqueItems: true, items: id },
    // Row 151 slice T5: the turn was sent from beside this team board. An id only: the host builds the board
    // section from its own copy, and resolves the id as (the conversation's project, board id) or not at all.
    board_id: boardId,
  }, ['prompt']),
  'chat.cancel': object({ stream_id: id }, ['stream_id']),
  // Slice 3-12: `always` (team host only, with approved: true) also saves a rule (`rule`, a project admin) or files a
  // request for one (`ask`, a writer or admin) for write_file or edit_file in the conversation's project.
  // Row 175 (D14): `plan_decision` and `feedback` answer an exit_plan_mode approval (approved: true only; the router
  // refuses anything else with `plan_decision_invalid`).
  'approval.resolve': object({
    stream_id: id, approval_id: text(512), decision_revision: id,
    approved: { type: 'boolean' }, always: { enum: ['rule', 'ask'] },
    plan_decision: { enum: ['approved', 'accepted', 'rejected'] }, feedback: text(800),
  }, ['stream_id', 'approval_id', 'decision_revision', 'approved']),
  'questions.answer': object({
    stream_id: id, question_ref: { ...id, maxLength: 512 },
    answers: { type: 'array', maxItems: 8, items: object({
      question_id: text(512),
      answer: { anyOf: [text(8000), { type: 'array', maxItems: 8, uniqueItems: true, items: text(240) }] },
      other: text(8000),
    }, ['question_id', 'answer']) },
  }, ['stream_id', 'question_ref', 'answers']),
  'questions.decline': object({ stream_id: id, question_ref: { ...id, maxLength: 512 } }, ['stream_id', 'question_ref']),
  // Slice 3-6b: the team host's viewing heartbeat (a single-owner host answers unsupported_operation).
  'session.view': object({}),
  // Team host commands (TEAM_MEMBERSHIP_SPEC). Each has a row in server/team/operation-registry.js.
  'team.members.list': object({}),
  'team.invite.create': object({ role: teamRole, ttl_ms: { type: 'integer', minimum: 60_000, maximum: 604_800_000 } },
    ['role']),
  'team.invite.reveal': object({ invite_id: id }, ['invite_id']),
  'team.invite.revoke': object({ invite_id: id }, ['invite_id']),
  'team.invite.list': object({}),
  'team.device.invite': object({}),
  'team.device.list': object({}),
  'team.device.revoke': object({ device_id: id }, ['device_id']),
  'team.member.admit': object({ member_id: id }, ['member_id']),
  'team.member.setRole': object({ member_id: id, role: teamRole }, ['member_id', 'role']),
  'team.member.revoke': object({ member_id: id }, ['member_id']),
  'team.audit.read': object({ cursor: teamCount, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  'team.rename': object({ name: { ...text(128), minLength: 1 } }, ['name']),
  // Row 170: the caller's own display name and the label of the device the request comes from; never an id.
  'team.member.profile': { ...object({ display_name: { ...text(128), minLength: 1 }, label: { ...text(128), minLength: 1 } }),
    minProperties: 1 },
  'team.owner.transfer': object({ member_id: id }, ['member_id']),
  // Shared projects (slice 3-4a); the member store re-checks every id against the project.
  'team.project.create': object({ name: projectName }, ['name']),
  'team.project.rename': object({ project_id: projectId, name: projectName }, ['project_id', 'name']),
  'team.project.members.list': object({ project_id: projectId }, ['project_id']),
  'team.project.members.add': object({ project_id: projectId, member_id: id, role: projectRole },
    ['project_id', 'member_id', 'role']),
  'team.project.members.setRole': object({ project_id: projectId, member_id: id, role: projectRole },
    ['project_id', 'member_id', 'role']),
  'team.project.members.remove': object({ project_id: projectId, member_id: id }, ['project_id', 'member_id']),
  'team.project.leave': object({ project_id: projectId }, ['project_id']),
  'team.project.unjoined': object({}),
  'team.project.join': object({ project_id: projectId, role: projectRole }, ['project_id', 'role']),
  'team.project.delete': object({ project_id: projectId }, ['project_id']),
  // Slice 3-6b: a page of one project's audit log, after a seq.
  'team.project.audit.read': object({ project_id: projectId, after_seq: teamCount,
    limit: { type: 'integer', minimum: 1, maximum: 100 } }, ['project_id']),
  // Slice 3-8b: a project's files. begin names one new top-level folder; project-files.js re-checks the
  // count (2,000), every path, size and hash. A manifest page names the manifest and a cursor.
  'team.project.upload.begin': object({ project_id: projectId, folder_name: { type: 'string', minLength: 1, maxLength: 255 },
    files: { type: 'array', minItems: 1, items: object({ path: { type: 'string', minLength: 1, maxLength: 512 },
      size: teamCount, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } }, ['path', 'size', 'sha256']) } },
  ['project_id', 'folder_name', 'files']),
  'team.project.upload.status': object({ project_id: projectId, upload_id: id }, ['project_id', 'upload_id']),
  'team.project.upload.commit': object({ project_id: projectId, upload_id: id }, ['project_id', 'upload_id']),
  'team.project.upload.discard': object({ project_id: projectId, upload_id: id }, ['project_id', 'upload_id']),
  'team.project.download.manifest': object({ project_id: projectId, manifest_id: id, cursor: teamCount }, ['project_id']),
  // Row 175 wave 5: a page of a team project's files (under one folder) and one file as text; project-files.js applies
  // the upload path rules to `dir` and `path`.
  'team.project.files.list': object({ project_id: projectId, cursor: teamCount,
    dir: { type: 'string', minLength: 1, maxLength: 512 } }, ['project_id']),
  'team.project.files.read': object({ project_id: projectId, path: { type: 'string', minLength: 1, maxLength: 512 } },
    ['project_id', 'path']),
  // Row 175 item 6 (D7), F13 (D8), F18 (server/command-router-redo.js): a project conversation's latest turn redone
  // (`message_id` is the latest prompt the caller saw), a branch at a message, a teammate asked, the driver seat handed.
  'team.project.regenerate': object({ project_id: projectId, session_id: id, message_id: messageRef },
    ['project_id', 'session_id', 'message_id']),
  'team.project.edit_resend': object({ project_id: projectId, session_id: id, message_id: messageRef,
    prompt: { ...text(100_000), minLength: 1 } }, ['project_id', 'session_id', 'message_id', 'prompt']),
  'team.project.branch': object({ project_id: projectId, session_id: id, message_id: messageRef },
    ['project_id', 'session_id', 'message_id']),
  'team.project.ask': object({ project_id: projectId, session_id: id, member_id: id, approval_id: text(512) },
    ['project_id', 'session_id', 'member_id']),
  'team.project.hand_driver': object({ project_id: projectId, session_id: id, member_id: id },
    ['project_id', 'session_id', 'member_id']),
  // Slice 3-12: a project's "Always allowed" rules (team-project-rules.js re-checks the folder and the reason).
  'team.project.rules.list': object({ project_id: projectId }, ['project_id']),
  'team.project.rules.add': object({ project_id: projectId, tool_name: ruleTool, folder: ruleFolder },
    ['project_id', 'tool_name', 'folder']),
  'team.project.rules.answer': object({ project_id: projectId, request_seq: positiveRevision,
    outcome: { enum: ['allow', 'change', 'decline'] }, tool_name: ruleTool, folder: ruleFolder,
    reason: { type: 'string', minLength: 1, maxLength: 400 } }, ['project_id', 'request_seq', 'outcome']),
  'team.project.rules.remove': object({ project_id: projectId, rule_seq: positiveRevision }, ['project_id', 'rule_seq']),
  // Row 151 slice T2: a team project's boards (server/team/boards/board-commands.js). A board is named by its
  // project and its id together; the acting member is never a parameter.
  'team.board.list': object({ project_id: projectId }, ['project_id']),
  'team.board.trash': object({ project_id: projectId }, ['project_id']),
  'team.board.create': object({ project_id: projectId, name: boardName }, ['project_id', 'name']),
  'team.board.rename': object({ project_id: projectId, board_id: boardId, name: boardName },
    ['project_id', 'board_id', 'name']),
  'team.board.apply': object({ project_id: projectId, board_id: boardId, batch: boardBatch },
    ['project_id', 'board_id', 'batch']),
  'team.board.delete': object({ project_id: projectId, board_id: boardId }, ['project_id', 'board_id']),
  'team.board.restore': object({ project_id: projectId, board_id: boardId }, ['project_id', 'board_id']),
  // Row 151 slice T3: the batches after a rev, in the host's order.
  'team.board.sync': object({ project_id: projectId, board_id: boardId, after_rev: teamCount },
    ['project_id', 'board_id', 'after_rev']),
  // Slice T4: who is viewing, a pointer with its selection, and a note's lock (board-presence-ops.js).
  'team.board.view': object(boardRef, boardKeys),
  'team.board.leave': object(boardRef, boardKeys),
  'team.board.cursor': object({ ...boardRef, x: boardCoordinate, y: boardCoordinate,
    selected: { type: 'array', maxItems: 64, items: boardCardId } }, [...boardKeys, 'x', 'y', 'selected']),
  'team.board.lock': object({ ...boardRef, card_id: boardCardId }, [...boardKeys, 'card_id']),
  'team.board.unlock': object({ ...boardRef, card_id: boardCardId }, [...boardKeys, 'card_id']),
  // Slice T5: Jenny's proposals (accept without `n`: every addition; with `n`: that one edit or removal) and the
  // revert of the batch that made a rev.
  'team.board.proposal.list': object(boardRef, boardKeys),
  'team.board.proposal.accept': boardDecision,
  'team.board.proposal.reject': boardDecision,
  'team.board.revert': object({ ...boardRef, rev: positiveRevision }, [...boardKeys, 'rev']),
  // Slice T9: who changed a board and how, newest first, in counts.
  'team.board.history': object(boardRef, boardKeys),
  // Team chat (slice 2a-3a). Each has a row in server/team/operation-registry.js.
  'team.chat.overview': object({}),
  'team.chat.history': object({ channel_id: channelId, before_seq: positiveRevision, limit: chatLimit(100) },
    ['channel_id', 'limit']),
  'team.chat.sync': object({ channel_id: channelId, after_rev: teamCount, limit: chatLimit(200) },
    ['channel_id', 'after_rev', 'limit']),
  'team.chat.thread': object({ channel_id: channelId, root_id: id, after_seq: teamCount, limit: chatLimit(100) },
    ['channel_id', 'root_id', 'limit']),
  'team.chat.post': object({ channel_id: channelId, text: chatText, thread_root_id: id,
    refs: { type: 'array', maxItems: 8, items: chatRef },
    attachment_ids: { type: 'array', maxItems: 8, uniqueItems: true,
      items: { type: 'string', pattern: '^att_[0-9A-HJKMNP-TV-Z]{26}$' } } }, ['channel_id', 'text']),
  'team.chat.edit': object({ channel_id: channelId, message_id: id, text: chatText, expected_rev: positiveRevision },
    ['channel_id', 'message_id', 'text', 'expected_rev']),
  'team.chat.delete': object({ channel_id: channelId, message_id: id }, ['channel_id', 'message_id']),
  'team.chat.mark_read': object({ channel_id: channelId, seq: teamCount, unread: { type: 'boolean' }, thread_root_id: id },
    ['channel_id', 'seq']),
  'team.chat.set_notify': object({ channel_id: channelId, level: { enum: ['all', 'mentions', 'none'] } },
    ['channel_id', 'level']),
  'team.chat.follow': object({ channel_id: channelId, root_id: id, on: { type: 'boolean' } },
    ['channel_id', 'root_id', 'on']),
  // Slice 2a-3b. The cursor is opaque; the search module validates it in full.
  'team.chat.search': object({ query: { type: 'string', minLength: 1, maxLength: 200 }, channel_id: channelId,
    cursor: { type: 'string', minLength: 1, maxLength: CHAT_CURSOR_MAX_CHARS, pattern: CHAT_CURSOR_PATTERN },
    limit: chatLimit(50) },
  ['query', 'limit']),
  'team.chat.typing': object({ channel_id: channelId, thread_root_id: id }, ['channel_id']),
  // Slice 2b-1. The emoji is checked against the host allowlist (team-chat-emoji.js), not here.
  'team.chat.react': object({ channel_id: channelId, message_id: id, emoji: { type: 'string', minLength: 1, maxLength: 16 },
    on: { type: 'boolean' } }, ['channel_id', 'message_id', 'emoji', 'on']),
  'team.chat.pin': object({ channel_id: channelId, message_id: id, on: { type: 'boolean' } },
    ['channel_id', 'message_id', 'on']),
  'team.chat.edits': object({ channel_id: channelId, message_id: id }, ['channel_id', 'message_id']),
  // The channel's pinned messages.
  'team.chat.pins': object({ channel_id: channelId }, ['channel_id']),
  // Slice 2d: the other members of a direct conversation, 1 to 7 distinct (the caller is the eighth).
  'team.chat.dm_open': object({ member_ids: { type: 'array', minItems: 1, maxItems: 7, uniqueItems: true, items: id } },
    ['member_ids']),
  // Row 173: custom channels (team-chat-channel-ops.js). An update names at least one of `name` and `topic`.
  'team.chat.channel_create': object({ name: channelName, topic: channelTopic }, ['name']),
  'team.chat.channel_update': { ...object({ channel_id: channelId, name: channelName, topic: channelTopic,
    expected_rev: teamCount }, ['channel_id', 'expected_rev']), anyOf: [{ required: ['name'] }, { required: ['topic'] }] },
  'team.chat.channel_archive': object({ channel_id: channelId, on: { type: 'boolean' } }, ['channel_id', 'on']),
  'team.chat.channel_delete': object({ channel_id: channelId }, ['channel_id']),
  'team.presence.set': object({ state: { enum: ['active', 'idle'] } }, ['state']),
  // Slice 4c host: sharing a GPU. No operation takes a node id: the node is the caller's device.
  'team.node.register': object({
    protocol_version: { type: 'integer', minimum: 0, maximum: 2_147_483_647 },
    engine: object({ kind: printable(64), version: printable(64) }, ['kind', 'version']),
    slots: { type: 'integer', minimum: 1, maximum: 4 },
    models: { type: 'array', maxItems: 64, items: nodeModel },
  }, ['protocol_version', 'engine', 'slots', 'models']),
  'team.node.claim': object({ claim_seq: teamCount, wait_ms: { type: 'integer', minimum: 0, maximum: 25_000 } },
    ['claim_seq', 'wait_ms']),
  // The reason list is the scheduler's (node_fail_reason_invalid): the schema only bounds the word.
  'team.node.fail': object({ job_id: id, reason: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' } },
    ['job_id', 'reason']),
  'team.node.pause': object({ on: { type: 'boolean' }, stop_running: { type: 'boolean' } }, ['on']),
  'team.node.unregister': object({}),
  'team.node.list': object({}),
  // Slice 4e: the owner's GPU use (a page newest first; the cursor is the last row's seq) and the team model.
  'team.pool.usage': object({ cursor: teamCount, limit: { type: 'integer', minimum: 1, maximum: 50 } }),
  'team.pool.model.set': object({ model: { anyOf: [{ type: 'null' }, printable(128)] } }, ['model']),
  // Slice 6-3: model sharing. The offer's params are its manifest; `request_id` makes it idempotent (MS6).
  'team.model.offer': object(modelManifest, Object.keys(modelManifest)),
  'team.model.withdraw': object({ offer_id: modelOfferId }, ['offer_id']),
  'team.model.offers': object({}),
  'team.model.offer.read': object({ offer_id: modelOfferId }, ['offer_id']),
  'team.model.accept': object({ offer_id: modelOfferId, resume: { type: 'array', maxItems: 8,
    items: object({ index: { type: 'integer', minimum: 0, maximum: 7 },
      offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }, ['index', 'offset']) } }, ['offer_id']),
  'team.model.decline': object({ offer_id: modelOfferId }, ['offer_id']),
  'team.model.pause': modelTransfer,
  'team.model.resume': modelTransfer,
  'team.model.cancel': modelTransfer,
  'team.model.complete': object({ transfer_id: modelTransferId, ok: { type: 'boolean' },
    reason: { enum: ['model_no_space', 'model_destination_invalid', 'model_exists', 'model_hash_mismatch', 'model_not_gguf',
      'model_staging_failed', 'model_journal_invalid'] } }, ['transfer_id', 'ok']),
});

const schema = object({
  api_version: { const: API_VERSION },
  operation: { enum: Object.keys(PARAM_SCHEMAS) },
  request_id: id,
  client_id: id,
  boot_epoch: id,
  session_id: id,
  control_generation: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  expected_revision: text(160),
  params: { type: 'object' },
}, ['api_version', 'operation', 'request_id', 'client_id', 'boot_epoch', 'params']);

const ajv = new Ajv({ allErrors: false, coerceTypes: false, removeAdditional: false });
const validateEnvelope = ajv.compile(schema);
const validators = new Map(Object.entries(PARAM_SCHEMAS).map(([operation, params]) => [operation, ajv.compile(params)]));
const WITHOUT_SESSION = new Set([
  'sessionRuntime.getSnapshot', 'sessionRuntime.getWork', 'sessionRuntime.getResult', 'sessionRuntime.updateLimits',
  'sessions.list', 'sessions.create', 'requests.status',
  'projects.list', 'projects.create', 'projects.rename', 'projects.bindRoot',
  'permissionReview.getState', 'permissionReview.resolve',
  'team.members.list', 'team.invite.create', 'team.invite.reveal', 'team.invite.revoke', 'team.invite.list',
  'team.device.invite', 'team.device.list', 'team.device.revoke', 'team.member.admit', 'team.member.setRole',
  'team.member.revoke', 'team.audit.read', 'team.rename', 'team.member.profile', 'team.owner.transfer',
  'team.chat.overview', 'team.chat.history', 'team.chat.sync', 'team.chat.thread', 'team.chat.post',
  'team.chat.edit', 'team.chat.delete', 'team.chat.mark_read', 'team.chat.set_notify', 'team.chat.follow',
  'team.chat.search', 'team.chat.typing', 'team.presence.set', 'team.chat.react', 'team.chat.pin', 'team.chat.edits',
  'team.chat.pins', 'team.chat.dm_open', 'team.chat.channel_create', 'team.chat.channel_update',
  'team.chat.channel_archive', 'team.chat.channel_delete', 'team.project.create', 'team.project.rename', 'team.project.members.list',
  'team.project.members.add', 'team.project.members.setRole', 'team.project.members.remove', 'team.project.leave',
  'team.project.unjoined', 'team.project.join', 'team.project.delete', 'team.project.audit.read', 'team.node.register',
  'team.node.claim', 'team.node.fail', 'team.node.pause', 'team.node.unregister', 'team.node.list', 'team.pool.usage',
  'team.pool.model.set',
  'team.project.upload.begin', 'team.project.upload.status', 'team.project.upload.commit', 'team.project.upload.discard',
  'team.project.download.manifest', 'team.project.files.list', 'team.project.files.read',
  'team.project.regenerate', 'team.project.edit_resend', 'team.project.branch', 'team.project.ask', 'team.project.hand_driver',
  'team.model.offer', 'team.model.withdraw', 'team.model.offers', 'team.model.offer.read', 'team.model.accept',
  'team.model.decline', 'team.model.pause', 'team.model.resume', 'team.model.cancel', 'team.model.complete',
  'team.project.rules.list', 'team.project.rules.add', 'team.project.rules.answer', 'team.project.rules.remove',
  'team.board.list', 'team.board.trash', 'team.board.create', 'team.board.rename', 'team.board.apply',
  'team.board.delete', 'team.board.restore', 'team.board.sync', 'team.board.view', 'team.board.leave', 'team.board.cursor',
  'team.board.lock', 'team.board.unlock', 'team.board.proposal.list', 'team.board.proposal.accept',
  'team.board.proposal.reject', 'team.board.revert', 'team.board.history',
]);

function validateCommand(value) {
  if (!validateEnvelope(value)) return { ok: false, reason: 'invalid_command_envelope' };
  if (!validators.get(value.operation)(value.params)) return { ok: false, reason: 'invalid_command_parameters' };
  if (!WITHOUT_SESSION.has(value.operation) && !value.session_id) {
    return { ok: false, reason: 'session_required' };
  }
  return { ok: true, value };
}

function hostFailure(kind, reason, requestId = '', retryable = false) {
  return {
    ok: false,
    error: {
      code: ERROR_CODES[kind] || ERROR_CODES.unavailable,
      reason: /^[a-z][a-z0-9_]{0,79}$/.test(reason) ? reason : 'host_unavailable',
      retryable: retryable === true,
      ...(typeof requestId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(requestId)
        ? { request_id: requestId } : {}),
    },
  };
}

module.exports = {
  API_VERSION, CHAT_CURSOR_MAX_CHARS, CHAT_CURSOR_PATTERN, EXECUTION_POLICY_VERSION, ERROR_CODES, PARAM_SCHEMAS,
  TEAM_MODEL_REASONS, validateCommand, hostFailure,
};
