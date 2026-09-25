'use strict';

const { validateTurnEvent } = require('./canonical-turn-event');

// Older canonical-primary captures kept the base assistant ID after the stream
// persisted segmented messages. Resolve only a unique, exact content match in
// the same logical turn and physical attempt. Comparing through the canonical
// sanitizer accounts for redacted paths without fuzzy matching or lost content.
function resolveCanonicalTextMessageOwners(events, messages) {
  const source = Array.isArray(events) ? events : [];
  const saved = Array.isArray(messages) ? messages : [];
  const messageIds = new Set(saved.map(message => message?.id));
  const groups = new Map();
  const pending = new Map();
  for (const event of source) {
    const streamId = event?.payload?.trace_id;
    const text = event?.payload?.text;
    if (event?.kind !== 'assistant_text_segment'
      || event.payload?.canonical_event_type !== 'text_part_completed'
      || !streamId || !text || event.payload?.truncated
      || event.primary_message_id !== `assistant_${streamId}`
      || messageIds.has(event.primary_message_id)) continue;
    const key = JSON.stringify([event.turn_id, streamId]);
    if (!groups.has(key)) groups.set(key, new Map());
    pending.set(event, key);
  }
  if (!pending.size) return source;
  for (const message of saved) {
    const streamId = message?.parent_stream_id;
    const group = groups.get(JSON.stringify([message?.turn_id, streamId]));
    const prefix = `assistant_${streamId}_seg`;
    if (!group || message?.role !== 'assistant' || message.kind
      || typeof message.content !== 'string' || !message.content
      || !String(message.id).startsWith(prefix)
      || !/^\d+$/.test(message.id.slice(prefix.length))) continue;
    const normalized = validateTurnEvent({
      v: 1, type: 'text_part_completed', turn_id: message.turn_id, seq: 1,
      payload: { text: message.content },
    });
    // A truncated candidate cannot establish that the entire message is covered.
    if (normalized.status !== 'accepted' || normalized.diagnostics.length) continue;
    const text = normalized.event.payload.text;
    group.set(text, group.has(text) ? null : message.id);
  }
  return source.map(event => {
    const key = pending.get(event);
    const messageId = key && groups.get(key).get(event.payload.text);
    if (!messageId) return event;
    const priorIds = Array.isArray(event.source_message_ids) ? event.source_message_ids : [];
    return {
      ...event,
      primary_message_id: messageId,
      source_message_ids: [...new Set([
        ...priorIds.filter(id => id !== event.primary_message_id), messageId,
      ])],
    };
  });
}

module.exports = { resolveCanonicalTextMessageOwners };
