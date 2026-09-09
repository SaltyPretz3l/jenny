'use strict';

const { EventStream } = require('./event-stream');

const LIVE_CHAR_LIMIT = 262_144;
const LIVE_REASONING_LIMIT = 65_536;
const MAX_LIVE_SESSIONS = 8;
const STREAM_TYPES = new Set(['user_questions_requested', 'user_questions_resolved', 'started', 'delta', 'thinking_status', 'phase_started', 'phase_completed',
  'stream_reset', 'tool_use', 'tool_result', 'tool_output_chunk', 'message_updated',
  'tool_approval_needed', 'question_batch', 'complete', 'error', 'context_compacted', 'context_usage']);

const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function wireReasoning(entry) {
  if (!entry || typeof entry !== 'object' || !entry.id) return null;
  if (typeof entry.append === 'string') {
    return { id: String(entry.id).slice(0, 256), append: entry.append.slice(0, LIVE_REASONING_LIMIT),
      base_length: Number.isSafeInteger(entry.baseLength) ? entry.baseLength : -1,
      base_tail: String(entry.baseTail || '').slice(-256) };
  }
  return {
    id: String(entry.id || '').slice(0, 256), text: String(entry.text || '').slice(0, LIVE_REASONING_LIMIT),
    timestamp: String(entry.timestamp || '').slice(0, 40), thinking_id: String(entry.thinkingId || '').slice(0, 256),
  };
}

// Explicit desktop-event to browser-wire boundary. Tool bodies and canonical
// message patches are retrieved via the canonical snapshot instead of copied
// from arbitrary runtime event fields into transport metadata.
function streamEventDto(event) {
  if (!event || !STREAM_TYPES.has(event.type) || !validId(event.sessionId) || !validId(event.streamId)) return null;
  const type = event.type === 'user_questions_requested' ? 'question_batch'
    : event.type === 'user_questions_resolved' ? 'message_updated' : event.type;
  const dto = { session_id: event.sessionId, stream_id: event.streamId, type };
  if (event.type === 'error') return { ...dto, reason: 'turn_failed' };
  for (const key of ['content', 'aggregate', 'text', 'summary', 'status', 'reason']) {
    if (typeof event[key] === 'string') dto[key] = event[key].slice(0, LIVE_CHAR_LIMIT);
  }
  if (Array.isArray(event.reasoning?.entriesDelta)) {
    dto.reasoning = event.reasoning.entriesDelta.slice(-128).map(wireReasoning).filter(Boolean);
  }
  for (const [source, target, limit] of [['thinkingId', 'thinking_id', 256], ['callId', 'call_id', 128],
    ['toolName', 'tool_name', 128], ['messageId', 'message_id', 256], ['approvalId', 'approval_id', 512]]) {
    if (typeof event[source] === 'string') dto[target] = event[source].slice(0, limit);
  }
  if (event.type === 'tool_output_chunk') {
    dto.lines = (Array.isArray(event.lines) ? event.lines : []).slice(0, 50)
      .filter((line) => line && typeof line.text === 'string')
      .map((line) => ({ stream: line.stream === 'stderr' ? 'stderr' : 'stdout', text: line.text.slice(0, 4000) }));
    dto.partial = typeof event.partial === 'string' ? event.partial.slice(0, 4000) : '';
    for (const [source, target] of [['sequence', 'sequence'], ['emittedLines', 'emitted_lines'],
      ['droppedLines', 'dropped_lines'], ['elapsedMs', 'elapsed_ms']]) {
      if (Number.isSafeInteger(event[source]) && event[source] >= 0) dto[target] = event[source];
    }
  }
  return dto;
}

class BackendEvents {
  constructor({ backend, bootEpoch, now = Date.now }) {
    this.backend = backend;
    this.events = new EventStream({ bootEpoch, now });
    this.live = new Map();
    this.onStream = (event) => {
      const dto = streamEventDto(event);
      if (!dto) return;
      const current = this.live.get(dto.session_id);
      if (dto.type !== 'started' && current?.stream_id !== dto.stream_id) return;
      this._updateLive(dto);
      this.events.publish('chat_stream', { session_id: dto.session_id, stream_id: dto.stream_id, event: dto });
    };
    backend.on('chat-stream', this.onStream);
  }

  get cursor() { return this.events.cursor; }

  _updateLive(event) {
    if (event.type === 'started') {
      this.live.set(event.session_id, { stream_id: event.stream_id, content: '', reasoning: [], status: '', truncated: false });
      if (this.live.size > MAX_LIVE_SESSIONS) this.live.delete(this.live.keys().next().value);
      return;
    }
    if (event.type === 'complete' || event.type === 'error') { this.live.delete(event.session_id); return; }
    if (!['delta', 'thinking_status', 'stream_reset'].includes(event.type)) return;
    const current = this.live.get(event.session_id);
    if (!current || current.stream_id !== event.stream_id) return;
    if (event.type === 'stream_reset') { current.content = ''; current.reasoning = []; return; }
    if (event.type === 'thinking_status') { current.status = event.text || ''; return; }
    const next = typeof event.aggregate === 'string' ? event.aggregate : current.content + (event.content || '');
    current.truncated ||= next.length >= LIVE_CHAR_LIMIT;
    current.content = next.slice(0, LIVE_CHAR_LIMIT);
    for (const entry of event.reasoning || []) {
      const index = current.reasoning.findIndex((existing) => existing.id === entry.id);
      if (typeof entry.append === 'string') {
        const previous = current.reasoning[index]?.text?.trim();
        if (previous === undefined || previous.length !== entry.base_length || !previous.endsWith(entry.base_tail)) {
          current.truncated = true;
          continue;
        }
        current.reasoning[index] = { ...current.reasoning[index], text: previous + entry.append };
        continue;
      }
      if (index < 0) current.reasoning.push(entry);
      else current.reasoning[index] = entry;
    }
    let length = current.reasoning.reduce((sum, entry) => sum + entry.text.length, 0);
    while (current.reasoning.length > 128 || length > LIVE_REASONING_LIMIT) {
      length -= current.reasoning.shift().text.length;
      current.truncated = true;
    }
    if (event.reasoning) event.reasoning = structuredClone(current.reasoning);
  }

  snapshot(sessionId) { return structuredClone(this.live.get(sessionId) || null); }
  publish(type, payload) { this.events.publish(type, payload); }
  subscribe(options) { return this.events.subscribe(options); }
  heartbeat() { this.events.heartbeat(); }
  revokeDevice(deviceId) { this.events.revokeDevice(deviceId); }

  dispose() {
    this.backend.off('chat-stream', this.onStream);
    this.live.clear();
    this.events.dispose();
  }
}

module.exports = { BackendEvents, streamEventDto };
