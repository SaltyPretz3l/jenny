'use strict';

// The closed table behind the `team.*` IPC methods. Every payload is checked in
// main before anything is sent: a plain object (or nothing, for `status`), only
// the listed fields, the team id pattern, the host's id patterns and bounded
// strings and integers; names and labels follow the host's own text rule. Each
// host-facing method maps to exactly one host
// operation; `join`, `status` and `removeTeam` are local. The host decides who
// may do what: nothing here knows a role. The `host*` methods (slice 1f-2) are
// handled in main by the team host controller (services/team/host/): this
// Jenny's own host, never a command sent to a host.
//
// The `chat*` methods (slice 2a-4b) go to the team's chat client
// (services/team/chat-client.js): nine mirror one team.chat.* operation each
// (team.chat.sync is internal to main), three are local (drafts, discarding a
// failed outbox entry). Text, refs and ids use the host's own validators.
//
// Slice 2a-4c adds three more that mirror one host operation each, with the
// host's own bounds: chatSearch, chatTyping and presenceSet (team.presence.set,
// the one chat method outside team.chat.*).
//
// Four more: chatReact and chatPin (marks, one host operation each, queued per key in
// chat-marks.js), chatEdits and chatPins (reads). They are online only and never enter the outbox; `emoji` must be on
// the host's list (services/host/team-chat-emoji.js) or nothing is sent.
//
// Slice 5-3 adds the two reconnect-code methods (services/team/reconnect-code.js):
// `teamReconnectCode { team_id, code }` (local: it rewrites that team's client
// file and restarts its manager, never reaches the host; reconnect-apply.js) and
// `hostReconnectCode` (no payload; the owner's code for this Jenny's host,
// answered read-only by the host controller). RECONNECT_METHODS names the pair.
//
// `hostInternet`: only the shape is checked here, the values in the host
// controller. Its token is a secret: never logged or answered.
//
// Slice 6-7: `hostModelRelay { flowing }` (0 off, 1 to 4 at once): the owner's model relay setting for this Jenny's
// own host (services/team/host/host-model-relay.js). Local to the host controller; never a host operation.
// Row 201 (OD-5): `hostPoolContext { context_cap }`: the owner's cap on the pool's context length for the team this Jenny
// hosts (null is Auto); like hostFileTools it is main's own, never a host operation. Row 201 (OD-4): `shareOllamaModels
// { team_id, names? }`: the Ollama models this PC shares (a list sets them, null returns to the default, no `names` reads).
// Row 123: `hostFileTools { on }`: the owner's project files setting for this Jenny's own host
// (services/team/host/host-file-tools.js). Local to the host controller; never a host operation.
//
// Slice 2d: chatDmOpen { member_ids } (team.chat.dm_open, services/team/chat-dm.js): the other participants, 1 to 7
// distinct member ids, the host's own bound; main cannot know the caller's id here, the client refuses nothing more.
//
// Row 173: channel management (services/team/chat-channels.js), one host operation each, online only, never queued:
// chatChannelCreate { name, topic? }, chatChannelUpdate { channel_id, name?, topic?, expected_rev } (at least one of
// name and topic), chatChannelArchive { channel_id, on } and chatChannelDelete { channel_id }. Only the shape and the
// wire bounds are checked here; the host applies the name and topic rules and decides who may.
//
// Slice 4e: the GPU sharing methods. Four are local to this Jenny (services/team/node/team-sharing.js): shareStatus,
// shareSet { team_id, on, confirmed? }, sharePause { team_id, on, stop_running? } and shareStop { team_id } (stop now). Three mirror one host
// operation each (services/team/node/pool-view.js, which rebuilds the answer): gpuList, gpuUse (owner) and teamModelSet
// (owner; null is Automatic). The host's node.share and owner rows decide who may.
//
// Slice 5-6: LIFECYCLE_METHODS, the owner's whole-team operations on the host this Jenny runs: hostInventory,
// hostDelete { name }, hostStartNew { name, display_name, label }, hostOldDelete { set_aside_id, name? },
// hostOldShow { set_aside_id }, hostExport { password }, hostRestorePick, hostRestore { password, display_name, label,
// name? }. The host controller checks who may (the owner, or a lost key) and the typed names; the folder and the
// file are picked in main, never sent by the renderer.
//
// Slice 3-9: the shared project methods (services/team/team-projects.js), each mirroring one host operation
// (PROJECT_OPERATIONS; the ones marked local there send what their client decides). Project ids use the host's
// `isProjectId`, conversation ids `isSessionId`. `uploadFolder` and `downloadProject` carry no path: the folder is
// picked in main. Row 175 wave 5: projectFiles { project_id, cursor?, dir? } and projectFileRead { project_id, path }
// (the reader view); `dir` and `path` are relative to the project and pass the host's upload path rules here first.
//
// Slice 2c renderer: chat attachments (services/team/chat-attachments.js). `chatPost` may carry `attachment_ids` (1 to 8
// distinct ids in the host's pattern); such a post is sent only online and never queued. chatUpload { channel_id,
// upload_id, name, type?, bytes } (bytes an ArrayBuffer or typed array; the 4 MiB cap and the host's name rule are
// checked by the module before any request), chatUploadCancel { upload_id }, chatAttachPick { room } (the file dialog
// opens in main), chatAttachmentImage, chatAttachmentCopy, chatAttachmentText { channel_id, attachment_id, peek?, name? }
// (a text file as UTF-8 text, or with peek its first lines; name, when sent, is checked against the text extensions)
// and chatAttachmentSave { channel_id, attachment_id, name }
// (the save dialog opens in main) and chatAttachmentReveal { attachment_id }. No answer carries a path.
//
// Slice 6-5: the `model…` methods of model sharing (services/team/model-ipc.js holds their table and MODEL_OPERATIONS;
// services/team/team-models.js answers them). A model is named by its discovery tag, a root by its index.
// Slice 3-10: the "Always allowed" rules (team.project.rules.*, 3-12): projectRules { project_id }, projectRuleAdd
// { project_id, tool_name, folder }, projectRuleRemove { project_id, rule_seq } and projectRuleAnswer { project_id,
// request_seq, outcome, tool_name?, folder?, reason? }, where an outcome takes only its own fields (allow none, change
// tool_name and folder?, decline reason). conversationDecide may carry `always` ('rule' or 'ask') with approved: true.
// Row 175: conversationPreferences may carry `plan_mode`; conversationDecide `plan_decision` and `feedback` (at most 800)
// with approved: true and no `always` (the host takes them for an exit_plan_mode approval only).
// Tools, folders and the reason use the host's own validators (project-rules-match.js, isInputText at 200).

const { isReactionEmoji } = require('../host/team-chat-emoji');
const { MODEL_METHODS, MODEL_OPERATIONS, isModelMethod } = require('./model-ipc');
// Row 151 T3: the `board…` methods of team boards (services/team/board-ipc.js; team-board-clients.js answers them).
const { BOARD_METHODS, BOARD_OPERATIONS, isBoardMethod } = require('./board-ipc');
const boardIds = require('../boards/board-ids');
const { LIMITS } = require('../host/team-chat-schema');
const { isCursor } = require('./chat-answers');
const { cleanShareSet } = require('./node/sharing-file');
const { ATTACHMENT_METHODS, UPLOAD_ID, isAttachmentIds, isByteContainer } = require('./chat-attachments');
const { PRESENCE_REPORTS } = require('./chat-live');
const { isId, isSessionId } = require('../../server/team/ids');
const { isCleanText, isInputText, isProjectId, isTeamModel } = require('../../server/team/member-schema');
const { sensitiveSegment, validateRelativePath } = require('../../server/team/path-segments');
const { RULE_TOOL_NAMES, validateFolder } = require('../../server/team/project-rules-match');
const {
  ENTRY_ID, isChannelId, isDraftText, isMessageId, isMessageText, isNotify, isRefList,
} = require('./chat-shapes');

// Version 2 invites (slice 5-3) reach 489 characters; the parser refuses anything past 512 before decoding.
const MAX_INVITE = 512;
const CONTROL = /\p{Cc}/u;

const inviteText = (value) => typeof value === 'string' && value.length >= 1 && value.length <= MAX_INVITE
  && !CONTROL.test(value);
// A reconnect code: the same bound and rule as an invite (the parser refuses past 512 before decoding).
const codeText = inviteText;
// Display names, device labels and the team name: the host's rule (NFC, nothing invisible, 1 to 40 characters).
const name = (value) => isCleanText(value);
const id = (kind) => (value) => isId(kind, value);
const role = (value) => value === 'member' || value === 'read_only';
const integer = (min, max) => (value) => Number.isSafeInteger(value) && value >= min && value <= max;

const TEAM = { team_id: id('team') };
const boolean = (value) => typeof value === 'boolean';
const CHANNEL = { ...TEAM, channel_id: isChannelId };
// A seq or rev the host may answer 0 for (nothing read yet), and one that names a real message or revision.
const COUNT = integer(0, Number.MAX_SAFE_INTEGER);
const POSITIVE = integer(1, Number.MAX_SAFE_INTEGER);
const entryId = (value) => typeof value === 'string' && ENTRY_ID.test(value);
// A search query: the host's bound (1 to 200 characters), counted in UTF-16 units so it never passes the host's.
const searchQuery = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 200
  && (typeof value.isWellFormed !== 'function' || value.isWellFormed());
const presenceReport = (value) => PRESENCE_REPORTS.includes(value);
// An internet setting field before the controller's own check: null, or a string within a loose bound.
const settingText = (value) => value === null || (typeof value === 'string' && value.length <= 512);
// A direct conversation's other participants: 1 to 7 distinct member ids.
// A team model id (member-schema.js isTeamModel), or null for Automatic.
const modelOrNull = (value) => value === null || isTeamModel(value);
// Row 201 (OD-4): this PC's Ollama share set, or null for the default: the share set's own rule (sharing-file.js: 1 to 64 distinct printable names).
const shareNames = (value) => value === null || (Array.isArray(value) && cleanShareSet(value)?.length === value.length);
// Row 201 (OD-5): the owner's cap on the pool's context length in whole tokens, or null for Auto. The bounds are
// host-layout.js POOL_CONTEXT_MIN and POOL_CONTEXT_AUTO, restated: a member's call loads no host module (tests/team-host-off.test.js).
const poolCap = integer(2048, 1048576);
const poolCapOrNull = (value) => value === null || poolCap(value);
// Slice 5-6: an old team's id (its 17 UTC digits) and a backup password (its length rule is the controller's;
// a password is never logged or answered).
const setAsideId = (value) => typeof value === 'string' && /^\d{17}$/u.test(value);
const passwordText = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 1024;
// A channel name or topic on the wire: well-formed, within the host's schema bounds in UTF-16 units.
const wireText = (min, max) => (value) => typeof value === 'string' && value.length >= min && value.length <= max
  && (typeof value.isWellFormed !== 'function' || value.isWellFormed());
const memberIds = (value) => Array.isArray(value) && value.length >= 1 && value.length <= 7
  && value.every(id('member')) && new Set(value).size === value.length;
// Slice 3-9: the host's own bounds (server/api-contract.js) for project and conversation fields.
const PROJECT = { ...TEAM, project_id: isProjectId };
// Row 175 wave 5: a relative path or folder in a team project, by the host's own upload path rules.
const projectPath = (value) => validateRelativePath(value).ok && sensitiveSegment(value) === null;
const CONVERSATION = { ...TEAM, session_id: isSessionId };
// A conversation box's text on its way to this PC's draft file: the box's own bound (100,000), well-formed; the file keeps 32,000.
const draftBody = (value) => typeof value === 'string' && value.length <= 100_000 && (typeof value.isWellFormed !== 'function' || value.isWellFormed());
const bounded = (min, max) => (value) => typeof value === 'string' && value.length >= min && value.length <= max
  && !CONTROL.test(value);
const projectName = bounded(1, 80);
const projectRole = (value) => value === 'admin' || value === 'writer' || value === 'reader';
const hostId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const longRef = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,512}$/u.test(value);
const approvalId = (value) => typeof value === 'string' && /^[!-~]{1,512}$/u.test(value);
const messageRef = (value) => typeof value === 'string' && /^[!-~]{1,256}$/u.test(value); // row 175 item 6: the host's rule
const prompt =(value) => typeof value === 'string' && value.length >= 1 && value.length <= 100_000;
const controlAction = (value) => value === 'take' || value === 'takeover' || value === 'release';
const planDecision = (value) => value === 'approved' || value === 'accepted' || value === 'rejected'; // row 175 (D14)
// Row 172: a conversation's model (null: the team default), thinking effort and tool switches, in the host's bounds
// (server/api-contract.js `sessions.preferences`); the host checks the model against what the pool offers.
const conversationModel = (value) => value === null || (typeof value === 'string' && value.length <= 256
  && /^[!-~][ -~]*$/u.test(value));
const conversationEffort = (value) => ['default', 'low', 'medium', 'high'].includes(value);
const teamTools = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length >= 1
  && Object.entries(value).every(([key, on]) => (key === 'read' || key === 'write') && typeof on === 'boolean');
const answerValue = (value) => (typeof value === 'string' && value.length <= 8000)
  || (Array.isArray(value) && value.length <= 8 && new Set(value).size === value.length
    && value.every((item) => typeof item === 'string' && item.length <= 240));
const questionAnswers = (value) => Array.isArray(value) && value.length <= 8 && value.every((entry) => entry
  && typeof entry === 'object' && !Array.isArray(entry)
  && Object.keys(entry).every((key) => ['question_id', 'answer', 'other'].includes(key))
  && typeof entry.question_id === 'string' && entry.question_id.length <= 512 && answerValue(entry.answer)
  && (entry.other === undefined || (typeof entry.other === 'string' && entry.other.length <= 8000)));

// Slice 3-10: a rule's tool, its folder (null: anywhere in the project), a decline reason (the store's 200), the outcome.
const ruleTool = (value) => RULE_TOOL_NAMES.includes(value);
const ruleFolder = (value) => value === null || (typeof value === 'string' && value.length >= 1 && value.length <= 255
  && validateFolder(value).ok);
const ruleReason = (value) => isInputText(value, 200);
const ruleOutcome = (value) => value === 'allow' || value === 'change' || value === 'decline';
// The fields each answer outcome may carry besides project_id, request_seq and outcome (team-project-rules.js).
const answerShape = (value) => {
  const has = (name) => Object.hasOwn(value, name);
  if (value.outcome === 'allow') return !has('tool_name') && !has('folder') && !has('reason');
  if (value.outcome === 'change') return has('tool_name') && !has('reason');
  return has('reason') && !has('tool_name') && !has('folder');
};

// Slice 2c renderer: an attachment's id in the host's pattern, a file name and type as the renderer sends them (the
// module applies the host's own name rule, and sends `application/octet-stream` for a type outside its pattern).
const attachmentId = (value) => typeof value === 'string' && /^att_[0-9A-HJKMNP-TV-Z]{26}$/u.test(value);
const uploadId = (value) => typeof value === 'string' && UPLOAD_ID.test(value);
const fileName = (value) => typeof value === 'string' && value.length >= 1 && value.length <= LIMITS.ATTACHMENT_NAME_MAX_CHARS;
const fileType = (value) => typeof value === 'string' && value.length <= 127;
const ATTACHMENT = { ...CHANNEL, attachment_id: attachmentId };

// method -> { fields: { name: check }, optional: [names], exclusive: [[names never sent together]], refine(value) }
const METHODS = Object.freeze({
  join: { fields: { invite: inviteText, display_name: name, label: name } },
  status: { fields: {} },
  leave: { fields: { ...TEAM } },
  removeTeam: { fields: { ...TEAM } },
  members: { fields: { ...TEAM } },
  inviteCreate: { fields: { ...TEAM, role, ttl_ms: integer(60_000, 604_800_000) }, optional: ['ttl_ms'] },
  inviteReveal: { fields: { ...TEAM, invite_id: id('invite') } },
  inviteRevoke: { fields: { ...TEAM, invite_id: id('invite') } },
  inviteList: { fields: { ...TEAM } },
  deviceInvite: { fields: { ...TEAM } },
  deviceList: { fields: { ...TEAM } },
  deviceRevoke: { fields: { ...TEAM, device_id: id('device') } },
  memberAdmit: { fields: { ...TEAM, member_id: id('member') } },
  memberSetRole: { fields: { ...TEAM, member_id: id('member'), role } },
  memberRevoke: { fields: { ...TEAM, member_id: id('member') } },
  ownerTransfer: { fields: { ...TEAM, member_id: id('member') } },
  auditRead: { fields: { ...TEAM, cursor: integer(0, Number.MAX_SAFE_INTEGER), limit: integer(1, 100) },
    optional: ['cursor', 'limit'] },
  rename: { fields: { ...TEAM, name } },
  // Row 170: a member changes their own name, the label of the device they are on, or both.
  profileSet: { fields: { ...TEAM, display_name: name, label: name }, optional: ['display_name', 'label'],
    refine: (value) => value.display_name !== undefined || value.label !== undefined },
  hostDeploy: { fields: { name, display_name: name, label: name } },
  hostStop: { fields: {} },
  hostStatus: { fields: {} },
  hostRecover: { fields: { display_name: name, label: name } },
  chatOverview: { fields: { ...TEAM } },
  chatHistory: { fields: { ...CHANNEL, before_seq: POSITIVE, limit: integer(1, LIMITS.HISTORY_LIMIT_MAX) },
    optional: ['before_seq', 'limit'] },
  chatThread: { fields: { ...CHANNEL, root_id: isMessageId, after_seq: COUNT, limit: integer(1, LIMITS.THREAD_LIMIT_MAX) },
    optional: ['after_seq', 'limit'] },
  chatPost: { fields: { ...CHANNEL, text: isMessageText, thread_root_id: isMessageId, refs: isRefList, attachment_ids: isAttachmentIds },
    optional: ['thread_root_id', 'refs', 'attachment_ids'] },
  chatEdit: { fields: { ...CHANNEL, message_id: isMessageId, text: isMessageText, expected_rev: POSITIVE } },
  chatDelete: { fields: { ...CHANNEL, message_id: isMessageId } },
  chatMarkRead: { fields: { ...CHANNEL, seq: COUNT, unread: boolean, thread_root_id: isMessageId }, optional: ['unread', 'thread_root_id'],
    exclusive: [['unread', 'thread_root_id']] },
  chatSetNotify: { fields: { ...CHANNEL, level: isNotify } },
  chatFollow: { fields: { ...CHANNEL, root_id: isMessageId, on: boolean } },
  chatDraftGet: { fields: { ...CHANNEL, thread_root_id: isMessageId }, optional: ['thread_root_id'] },
  chatDraftSet: { fields: { ...CHANNEL, thread_root_id: isMessageId, text: isDraftText }, optional: ['thread_root_id'] },
  chatOutboxDiscard: { fields: { ...TEAM, entry_id: entryId } },
  chatSearch: { fields: { ...TEAM, query: searchQuery, channel_id: isChannelId, cursor: isCursor, limit: integer(1, 50) },
    optional: ['channel_id', 'cursor', 'limit'] },
  chatTyping: { fields: { ...CHANNEL, thread_root_id: isMessageId }, optional: ['thread_root_id'] },
  presenceSet: { fields: { ...TEAM, state: presenceReport } },
  chatReact: { fields: { ...CHANNEL, message_id: isMessageId, emoji: isReactionEmoji, on: boolean } },
  chatPin: { fields: { ...CHANNEL, message_id: isMessageId, on: boolean } },
  chatEdits: { fields: { ...CHANNEL, message_id: isMessageId } },
  chatPins: { fields: { ...CHANNEL } },
  chatDmOpen: { fields: { ...TEAM, member_ids: memberIds } },
  chatChannelCreate: { fields: { ...TEAM, name: wireText(1, 160), topic: wireText(0, 1000) }, optional: ['topic'] },
  chatChannelUpdate: { fields: { ...CHANNEL, name: wireText(1, 160), topic: wireText(0, 1000), expected_rev: COUNT },
    optional: ['name', 'topic'], refine: (value) => value.name !== undefined || value.topic !== undefined },
  chatChannelArchive: { fields: { ...CHANNEL, on: boolean } },
  chatChannelDelete: { fields: { ...CHANNEL } },
  // Slice 2c renderer: chat attachments (services/team/chat-attachments.js).
  chatUpload: { fields: { ...CHANNEL, upload_id: uploadId, name: fileName, type: fileType, bytes: isByteContainer }, optional: ['type'] },
  chatUploadCancel: { fields: { ...TEAM, upload_id: uploadId } },
  chatAttachPick: { fields: { ...TEAM, room: integer(1, LIMITS.ATTACHMENTS_MAX) } },
  chatAttachmentImage: { fields: { ...ATTACHMENT } },
  chatAttachmentText: { fields: { ...ATTACHMENT, peek: boolean, name: fileName }, optional: ['peek', 'name'] },
  chatAttachmentCopy: { fields: { ...ATTACHMENT } },
  chatAttachmentSave: { fields: { ...ATTACHMENT, name: fileName } },
  chatAttachmentReveal: { fields: { ...TEAM, attachment_id: attachmentId } },
  teamReconnectCode: { fields: { ...TEAM, code: codeText } },
  hostReconnectCode: { fields: {} },
  hostInternet: { fields: { enabled: boolean, public_address: settingText, relay_url: settingText, token: settingText },
    optional: ['public_address', 'relay_url', 'token'] },
  hostModelRelay: { fields: { flowing: integer(0, 4) } },
  hostFileTools: { fields: { on: boolean } },
  hostPoolContext: { fields: { context_cap: poolCapOrNull } },
  shareStatus: { fields: {} },
  shareSet: { fields: { ...TEAM, on: boolean, confirmed: boolean }, optional: ['confirmed'] },
  sharePause: { fields: { ...TEAM, on: boolean, stop_running: boolean }, optional: ['stop_running'] },
  shareStop: { fields: { ...TEAM } },
  shareOllamaModels: { fields: { ...TEAM, names: shareNames }, optional: ['names'] },
  gpuList: { fields: { ...TEAM } },
  gpuUse: { fields: { ...TEAM, cursor: COUNT, limit: integer(1, 50) }, optional: ['cursor', 'limit'] },
  teamModelSet: { fields: { ...TEAM, model: modelOrNull } },
  hostInventory: { fields: { set_aside_id: setAsideId }, optional: ['set_aside_id'] },
  hostDelete: { fields: { name } },
  hostStartNew: { fields: { name, display_name: name, label: name } },
  hostOldDelete: { fields: { set_aside_id: setAsideId, name }, optional: ['name'] },
  hostOldShow: { fields: { set_aside_id: setAsideId } },
  hostExport: { fields: { password: passwordText } },
  hostRestorePick: { fields: {} },
  hostRestore: { fields: { password: passwordText, display_name: name, label: name, name }, optional: ['name'] },
  // Row 170: the server page. Start with Jenny, the facts of a stopped server, and its folder.
  hostAutostart: { fields: { enabled: boolean } },
  hostSummary: { fields: {} },
  hostOpenFolder: { fields: {} },
  // Slice 3-9: shared projects and their conversations (services/team/team-projects.js).
  projectList: { fields: { ...TEAM } },
  projectCreate: { fields: { ...TEAM, name: projectName } },
  projectRename: { fields: { ...PROJECT, name: projectName } },
  projectDelete: { fields: { ...PROJECT } },
  projectMembers: { fields: { ...PROJECT } },
  projectAddMember: { fields: { ...PROJECT, member_id: id('member'), role: projectRole } },
  projectSetMember: { fields: { ...PROJECT, member_id: id('member'), role: projectRole } },
  projectRemoveMember: { fields: { ...PROJECT, member_id: id('member') } },
  projectLeave: { fields: { ...PROJECT } },
  projectUnjoined: { fields: { ...TEAM } },
  projectJoin: { fields: { ...PROJECT, role: projectRole } },
  // `before_seq`: the newest page below it, oldest first (the tail in one call; `next_cursor` is then the next `before_seq`).
  projectAudit: { fields: { ...PROJECT, after_seq: COUNT, before_seq: POSITIVE, limit: integer(1, 100) },
    optional: ['after_seq', 'before_seq', 'limit'] },
  projectConversations: { fields: { ...PROJECT } },
  conversationCreate: { fields: { ...PROJECT, title: bounded(0, 80) }, optional: ['title'] },
  // Row 169: `before_message_id` reads the page before that message for a conversation already open.
  conversationOpen: { fields: { ...CONVERSATION, before_message_id: bounded(1, 256) }, optional: ['before_message_id'] },
  conversationClose: { fields: { ...CONVERSATION } },
  conversationCloseAll: { fields: { ...TEAM } },
  // Row 151 T5: `board_id` names the team board the turn is about; the host checks it and builds the board section.
  conversationSend: { fields: { ...CONVERSATION, prompt, board_id: boardIds.isBoardId }, optional: ['board_id'] },
  conversationCancel: { fields: { ...CONVERSATION, stream_id: hostId } },
  conversationRename: { fields: { ...CONVERSATION, title: bounded(1, 80) } },
  conversationDelete: { fields: { ...CONVERSATION } },
  conversationPreferences: { fields: { ...CONVERSATION, preferred_model: conversationModel, reasoning_effort: conversationEffort,
    team_tools: teamTools, plan_mode: boolean }, optional: ['preferred_model', 'reasoning_effort', 'team_tools', 'plan_mode'],
  refine: (value) => ['preferred_model', 'reasoning_effort', 'team_tools', 'plan_mode'].some((key) => Object.hasOwn(value, key)) },
  conversationControl: { fields: { ...CONVERSATION, action: controlAction } },
  conversationDecide: { fields: { ...CONVERSATION, stream_id: hostId, approval_id: approvalId, decision_revision: hostId,
    approved: boolean, always: (value) => value === 'rule' || value === 'ask', plan_decision: planDecision,
    feedback: (value) => typeof value === 'string' && value.length <= 800 }, optional: ['always', 'plan_decision', 'feedback'],
  refine: (value) => (value.always === undefined || value.approved === true) && (value.feedback === undefined
    || value.plan_decision !== undefined) && (value.plan_decision === undefined || (value.approved === true && !value.always)) },
  conversationAnswer: { fields: { ...CONVERSATION, stream_id: hostId, question_ref: longRef, answers: questionAnswers } },
  conversationDecline: { fields: { ...CONVERSATION, stream_id: hostId, question_ref: longRef } },
  uploadFolder: { fields: { ...PROJECT } },
  uploadCancel: { fields: { ...TEAM } },
  downloadProject: { fields: { ...PROJECT } },
  downloadCancel: { fields: { ...TEAM } },
  // Row 175 wave 5: the reader view (a page of a project's files, one file as text).
  projectFiles: { fields: { ...PROJECT, cursor: COUNT, dir: projectPath }, optional: ['cursor', 'dir'] },
  projectFileRead: { fields: { ...PROJECT, path: projectPath } },
  // Row 175 item 6, F13, F18 (server/command-router-redo.js): the latest turn redone, a branch, a teammate asked, the seat handed.
  projectRegenerate: { fields: { ...PROJECT, session_id: isSessionId, message_id: messageRef } },
  projectEditResend: { fields: { ...PROJECT, session_id: isSessionId, message_id: messageRef, prompt } },
  projectBranch: { fields: { ...PROJECT, session_id: isSessionId, message_id: messageRef } },
  projectAskTeammate: { fields: { ...PROJECT, session_id: isSessionId, member_id: id('member'), approval_id: approvalId }, optional: ['approval_id'] },
  projectHandDriver: { fields: { ...PROJECT, session_id: isSessionId, member_id: id('member') } },
  // Row 175 F6: the member's unsent conversation box text, kept on this PC only (services/team/project-drafts.js); '' clears it.
  projectDraftGet: { fields: { ...CONVERSATION } },
  projectDraftSet: { fields: { ...CONVERSATION, text: draftBody } },
  // Slice 6-5: model sharing (services/team/model-ipc.js, team-models.js).
  ...MODEL_METHODS,
  ...BOARD_METHODS,
  // Slice 3-10: "Always allowed" (team.project.rules.*).
  projectRules: { fields: { ...PROJECT } },
  projectRuleAdd: { fields: { ...PROJECT, tool_name: ruleTool, folder: ruleFolder } },
  projectRuleRemove: { fields: { ...PROJECT, rule_seq: POSITIVE } },
  projectRuleAnswer: { fields: { ...PROJECT, request_seq: POSITIVE, outcome: ruleOutcome, tool_name: ruleTool, folder: ruleFolder,
    reason: ruleReason }, optional: ['tool_name', 'folder', 'reason'], refine: answerShape },
});

// Methods that may be called with no payload (nothing, `null` or `{}`).
const EMPTY_PAYLOAD_METHODS = new Set(['status', 'hostStop', 'hostStatus', 'hostReconnectCode', 'shareStatus', 'hostInventory',
  'hostRestorePick', 'hostSummary', 'hostOpenFolder']);

// The one host operation each method sends: a command operation, or the raw route for leave.
const HOST_OPERATIONS = Object.freeze({
  leave: 'POST /api/v1/team/leave',
  members: 'team.members.list',
  inviteCreate: 'team.invite.create',
  inviteReveal: 'team.invite.reveal',
  inviteRevoke: 'team.invite.revoke',
  inviteList: 'team.invite.list',
  deviceInvite: 'team.device.invite',
  deviceList: 'team.device.list',
  deviceRevoke: 'team.device.revoke',
  memberAdmit: 'team.member.admit',
  memberSetRole: 'team.member.setRole',
  memberRevoke: 'team.member.revoke',
  ownerTransfer: 'team.owner.transfer',
  auditRead: 'team.audit.read',
  rename: 'team.rename',
  profileSet: 'team.member.profile',
});

// The chat methods that mirror a host operation (the chat client sends them; post, edit and delete through the outbox).
const CHAT_OPERATIONS = Object.freeze({
  chatOverview: 'team.chat.overview',
  chatHistory: 'team.chat.history',
  chatThread: 'team.chat.thread',
  chatPost: 'team.chat.post',
  chatEdit: 'team.chat.edit',
  chatDelete: 'team.chat.delete',
  chatMarkRead: 'team.chat.mark_read',
  chatSetNotify: 'team.chat.set_notify',
  chatFollow: 'team.chat.follow',
  chatSearch: 'team.chat.search',
  chatTyping: 'team.chat.typing',
  presenceSet: 'team.presence.set',
  chatReact: 'team.chat.react',
  chatPin: 'team.chat.pin',
  chatEdits: 'team.chat.edits',
  chatPins: 'team.chat.pins',
  chatDmOpen: 'team.chat.dm_open',
  chatChannelCreate: 'team.chat.channel_create',
  chatChannelUpdate: 'team.chat.channel_update',
  chatChannelArchive: 'team.chat.channel_archive',
  chatChannelDelete: 'team.chat.channel_delete',
});
const CHAT_LOCAL_METHODS = Object.freeze(['chatDraftGet', 'chatDraftSet', 'chatOutboxDiscard']);
const isChatMethod = (method) => Object.hasOwn(CHAT_OPERATIONS, method) || CHAT_LOCAL_METHODS.includes(method)
  || ATTACHMENT_METHODS.includes(method);

const LOCAL_METHODS = Object.freeze(['join', 'status', 'removeTeam', 'teamReconnectCode']);
// Slice 5-6: the owner's whole-team operations (services/team/host/host-lifecycle.js).
const LIFECYCLE_METHODS = Object.freeze(['hostInventory', 'hostDelete', 'hostStartNew', 'hostOldDelete', 'hostOldShow',
  'hostExport', 'hostRestorePick', 'hostRestore', 'hostAutostart', 'hostSummary', 'hostOpenFolder']);
const HOST_METHODS = Object.freeze(['hostDeploy', 'hostStop', 'hostStatus', 'hostRecover', 'hostReconnectCode',
  'hostInternet', 'hostModelRelay', 'hostFileTools', 'hostPoolContext', ...LIFECYCLE_METHODS]);
const RECONNECT_METHODS = Object.freeze(['teamReconnectCode', 'hostReconnectCode']);
// Slice 4e: sharing this PC's GPU (local) and the team's GPUs (one host operation each, pool-view.js).
const SHARE_METHODS = Object.freeze(['shareStatus', 'shareSet', 'sharePause', 'shareStop', 'shareOllamaModels']);
const PROJECT_DRAFT_METHODS = Object.freeze(['projectDraftGet', 'projectDraftSet']); // row 175 F6: local, no host operation
const POOL_OPERATIONS = Object.freeze({ gpuList: 'team.node.list', gpuUse: 'team.pool.usage', teamModelSet: 'team.pool.model.set' });
// Slice 3-9: the host operation each project method sends (services/team/team-projects.js). Marked local: a close
// releases a lease this client holds, a control `release` sends control.release, a cancel stops a transfer (an
// upload's then discarded), and an upload or a download starts with its begin or its first manifest page.
const PROJECT_OPERATIONS = Object.freeze({
  projectList: 'projects.list',
  projectCreate: 'team.project.create',
  projectRename: 'team.project.rename',
  projectDelete: 'team.project.delete',
  projectMembers: 'team.project.members.list',
  projectAddMember: 'team.project.members.add',
  projectSetMember: 'team.project.members.setRole',
  projectRemoveMember: 'team.project.members.remove',
  projectLeave: 'team.project.leave',
  projectUnjoined: 'team.project.unjoined',
  projectJoin: 'team.project.join',
  projectAudit: 'team.project.audit.read',
  projectConversations: 'sessions.list',
  conversationCreate: 'sessions.create',
  conversationOpen: 'sessions.snapshot',
  conversationClose: 'control.release', // local: only when this client holds the lease
  conversationCloseAll: null, // local: every open conversation of the team (a renderer reload), held leases released
  conversationSend: 'chat.send',
  conversationCancel: 'chat.cancel',
  conversationRename: 'sessions.rename',
  conversationDelete: 'sessions.delete',
  conversationControl: 'control.acquire', // `release` sends control.release
  conversationDecide: 'approval.resolve',
  conversationAnswer: 'questions.answer',
  conversationDecline: 'questions.decline',
  uploadFolder: 'team.project.upload.begin', // local: walk, hash, parts, commit
  uploadCancel: 'team.project.upload.discard', // local: stops the upload, then discards it
  downloadProject: 'team.project.download.manifest', // local: manifest pages, parts, writes
  downloadCancel: null, // local: stops the download, removes its partial file
  projectRules: 'team.project.rules.list',
  projectRuleAdd: 'team.project.rules.add',
  projectRuleRemove: 'team.project.rules.remove',
  projectRuleAnswer: 'team.project.rules.answer',
  conversationPreferences: 'sessions.preferences', // row 172: leased, as conversationSend
  projectFiles: 'team.project.files.list', // row 175 wave 5
  projectFileRead: 'team.project.files.read',
  projectRegenerate: 'team.project.regenerate', // row 175 item 6, F13, F18: plain host calls (team-projects.js)
  projectEditResend: 'team.project.edit_resend',
  projectBranch: 'team.project.branch',
  projectAskTeammate: 'team.project.ask',
  projectHandDriver: 'team.project.hand_driver',
});

/** { ok: true, value } with exactly the allowed fields, or { ok: false }. */
function validatePayload(method, payload) {
  if (!Object.hasOwn(METHODS, method)) return { ok: false };
  const { fields, optional = [], exclusive = [], refine = null } = METHODS[method];
  if (EMPTY_PAYLOAD_METHODS.has(method) && (payload === undefined || payload === null)) return { ok: true, value: {} };
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false };
  if (Object.getPrototypeOf(payload) !== Object.prototype && Object.getPrototypeOf(payload) !== null) return { ok: false };
  const names = Object.keys(payload);
  if (names.some((name) => !Object.hasOwn(fields, name))) return { ok: false };
  const value = {};
  for (const [name, check] of Object.entries(fields)) {
    if (!Object.hasOwn(payload, name)) {
      if (optional.includes(name)) continue;
      return { ok: false };
    }
    if (!check(payload[name])) return { ok: false };
    value[name] = payload[name];
  }
  if (exclusive.some((names) => names.every((name) => Object.hasOwn(value, name)))) return { ok: false };
  if (refine && !refine(value)) return { ok: false };
  return { ok: true, value };
}

/** The host params for a command method: the validated payload without the team id. */
function hostParams(value) {
  const { team_id: _teamId, ...params } = value;
  return params;
}

module.exports = {
  CHAT_LOCAL_METHODS, CHAT_OPERATIONS, HOST_METHODS, HOST_OPERATIONS, LIFECYCLE_METHODS, LOCAL_METHODS, METHODS, POOL_OPERATIONS, RECONNECT_METHODS,
  BOARD_OPERATIONS, MODEL_OPERATIONS, PROJECT_DRAFT_METHODS, PROJECT_OPERATIONS, SHARE_METHODS, hostParams, isBoardMethod, isChatMethod, isModelMethod,
  validatePayload,
};
