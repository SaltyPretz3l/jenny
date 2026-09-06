'use strict';

const { normalizeString: normalizeToken } = require('./shared/normalize');

const DEFAULT_MAX_STREAMS = 128;

function normalizeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function normalizeChannels(channels) {
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) {
    return null;
  }
  const result = {};
  const channelKeys = Object.keys(channels);
  if (channelKeys.length > 8) {
    return null;
  }
  for (const channel of channelKeys.sort()) {
    const source = channels[channel];
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
      return null;
    }
    const count = normalizeInteger(source.count);
    const sequenceStart = normalizeInteger(source.sequenceStart ?? source.sequence_start);
    const sequenceEnd = normalizeInteger(source.sequenceEnd ?? source.sequence_end);
    if (
      !normalizeToken(channel)
      || channel.length > 30
      || count == null
      || count < 1
      || sequenceStart == null
      || sequenceEnd == null
    ) {
      return null;
    }
    result[channel] = { count, sequenceStart, sequenceEnd };
  }
  return result;
}

function channelsMatch(left, right) {
  const leftKeys = Object.keys(left || {}).sort();
  const rightKeys = Object.keys(right || {}).sort();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key, index) => (
    key === rightKeys[index]
    && left[key].count === right[key].count
    && left[key].sequenceStart === right[key].sequenceStart
    && left[key].sequenceEnd === right[key].sequenceEnd
  ));
}

function createStreamEnvelopeReceiptGate({ log = () => {}, maxStreams = DEFAULT_MAX_STREAMS } = {}) {
  const sentProofByStream = new Map();
  const streamCap = Math.max(1, normalizeInteger(maxStreams) || DEFAULT_MAX_STREAMS);
  let rendererEpoch = 0;
  let subscriptionMode = 'legacy';
  let proven = false;

  function emit(level, event, details) {
    try {
      log(level, event, details);
    } catch (_error) {
      // Observability must not change delivery semantics.
    }
  }

  function revoke(reason, details = {}) {
    const legacyReopened = proven;
    proven = false;
    emit('WARN', 'chat.stream_envelope_v2_proof_revoked', {
      reason: normalizeToken(reason).slice(0, 80) || 'unknown',
      legacyReopened,
      ...details,
    });
    return { ok: false, reason, legacy_reopened: true, rehydrate_required: true };
  }

  function beginSubscription(record) {
    const epoch = normalizeInteger(record?.rendererEpoch ?? record?.renderer_epoch);
    const mode = normalizeToken(record?.mode);
    if (epoch == null || epoch < 1 || (mode !== 'envelope' && mode !== 'legacy')) {
      return revoke('invalid_subscription_epoch');
    }
    if (rendererEpoch > 0 && epoch <= rendererEpoch) {
      return revoke('stale_subscription_epoch', { rendererEpoch: epoch });
    }
    sentProofByStream.clear();
    proven = false;
    rendererEpoch = epoch;
    subscriptionMode = mode;
    emit('INFO', 'chat.stream_envelope_v2_subscription_epoch', {
      rendererEpoch,
      mode,
    });
    return { ok: true, reason: null, renderer_epoch: rendererEpoch, proven: false };
  }

  function getOrCreateProof(streamId) {
    let proof = sentProofByStream.get(streamId);
    if (!proof) {
      proof = {
        count: 0,
        sequenceStart: null,
        sequenceEnd: null,
        nextSequence: 1,
        contiguous: true,
        channels: {},
        terminalType: '',
        terminalKind: '',
      };
      sentProofByStream.set(streamId, proof);
      while (sentProofByStream.size > streamCap) {
        const oldest = sentProofByStream.keys().next().value;
        sentProofByStream.delete(oldest);
      }
    }
    return proof;
  }

  function noteSent(envelope = {}) {
    const streamId = normalizeToken(envelope.streamId);
    if (!streamId) {
      return;
    }
    const proof = getOrCreateProof(streamId);
    proof.count += 1;
    const sequence = normalizeInteger(envelope.sequence);
    const sequenceEnd = normalizeInteger(envelope.sequenceEnd) ?? sequence;
    if (sequence != null) {
      if (sequence !== proof.nextSequence || sequenceEnd < sequence) {
        proof.contiguous = false;
      }
      proof.sequenceStart = proof.sequenceStart == null ? sequence : Math.min(proof.sequenceStart, sequence);
      proof.sequenceEnd = proof.sequenceEnd == null ? sequenceEnd : Math.max(proof.sequenceEnd, sequenceEnd);
      proof.nextSequence = Math.max(proof.nextSequence, sequenceEnd + 1);
    }
    const channel = normalizeToken(envelope.channel);
    const channelSequence = normalizeInteger(envelope.channelSequence);
    const channelSequenceEnd = normalizeInteger(envelope.channelSequenceEnd) ?? channelSequence;
    if (channel && channelSequence != null) {
      const channelProof = proof.channels[channel] || {
        count: 0,
        sequenceStart: channelSequence,
        sequenceEnd: channelSequenceEnd,
        nextSequence: 1,
        contiguous: true,
      };
      if (channelSequence !== channelProof.nextSequence || channelSequenceEnd < channelSequence) {
        channelProof.contiguous = false;
        proof.contiguous = false;
      }
      channelProof.count += 1;
      channelProof.sequenceStart = Math.min(channelProof.sequenceStart, channelSequence);
      channelProof.sequenceEnd = Math.max(channelProof.sequenceEnd, channelSequenceEnd);
      channelProof.nextSequence = Math.max(channelProof.nextSequence, channelSequenceEnd + 1);
      proof.channels[channel] = channelProof;
    }
    if (normalizeToken(envelope.eventKind) === 'terminal') {
      proof.terminalKind = 'terminal';
      proof.terminalType = normalizeToken(envelope.payload?.type) || 'terminal';
    }
  }

  function publicChannels(proof) {
    const result = {};
    for (const channel of Object.keys(proof.channels).sort()) {
      const source = proof.channels[channel];
      result[channel] = {
        count: source.count,
        sequenceStart: source.sequenceStart,
        sequenceEnd: source.sequenceEnd,
      };
    }
    return result;
  }

  function record(record = {}) {
    const recordType = normalizeToken(record.recordType || record.record_type);
    if (recordType === 'subscription_started') {
      return beginSubscription(record);
    }
    const epoch = normalizeInteger(record.rendererEpoch ?? record.renderer_epoch);
    if (epoch == null || epoch !== rendererEpoch) {
      return revoke('stale_or_missing_renderer_epoch', { rendererEpoch: epoch || 0 });
    }
    const streamId = normalizeToken(record.streamId || record.stream_id);
    if (!streamId) {
      return revoke('invalid_stream_id');
    }
    if (recordType === 'stream_fault') {
      sentProofByStream.delete(streamId);
      return {
        ...revoke(normalizeToken(record.reason) || 'renderer_stream_fault', {
        streamId: streamId.slice(0, 30),
        }),
        record_accepted: true,
      };
    }
    if (recordType !== 'terminal_receipt') {
      return revoke('invalid_receipt_type', { streamId: streamId.slice(0, 30) });
    }
    const expected = sentProofByStream.get(streamId);
    sentProofByStream.delete(streamId);
    if (!expected || subscriptionMode !== 'envelope') {
      return revoke('missing_sent_proof', { streamId: streamId.slice(0, 30) });
    }
    const receivedCount = normalizeInteger(record.receivedCount ?? record.received_count);
    const sequenceStart = normalizeInteger(record.sequenceStart ?? record.sequence_start);
    const sequenceEnd = normalizeInteger(record.sequenceEnd ?? record.sequence_end);
    const channels = normalizeChannels(record.channels);
    const eventKind = normalizeToken(record.eventKind || record.event_kind);
    const terminalType = normalizeToken(record.terminalType || record.terminal_type);
    const expectedChannels = publicChannels(expected);
    const exact = expected.contiguous
      && receivedCount === expected.count
      && sequenceStart === expected.sequenceStart
      && sequenceEnd === expected.sequenceEnd
      && channels != null
      && channelsMatch(channels, expectedChannels)
      && eventKind === expected.terminalKind
      && terminalType === expected.terminalType;
    if (!exact) {
      emit('WARN', 'chat.stream_envelope_v2_ack_mismatch', {
        streamId: streamId.slice(0, 30),
        sentCount: expected.count,
        receivedCount: receivedCount ?? 0,
        contiguous: expected.contiguous,
      });
      return revoke('terminal_receipt_mismatch', { streamId: streamId.slice(0, 30) });
    }
    proven = true;
    emit('INFO', 'chat.stream_envelope_v2_ack_proven', {
      streamId: streamId.slice(0, 30),
      rendererEpoch,
    });
    return { ok: true, reason: null, proven: true, renderer_epoch: rendererEpoch };
  }

  return {
    isProven: () => proven,
    noteSent,
    record,
    revoke,
    deleteStream(streamId) {
      sentProofByStream.delete(normalizeToken(streamId));
    },
  };
}

module.exports = { createStreamEnvelopeReceiptGate };
