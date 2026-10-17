(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatMessagesCopy = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Words, escaping and formatting shared by the addressed-message surfaces (Send dialog,
  // composer strip, Review dialog). Titles, project names and bodies come from other chats
  // and are untrusted: they reach the DOM only through escapeHtml or textContent. A failure
  // reason is never shown verbatim; it is mapped to the closed phrases below.

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  const MAX_BODY_BYTES = 16384;
  const CODE_REASONS = {
    'CMP-MESSAGE-0001': 'invalid_request',
    'CMP-MESSAGE-0002': 'unavailable',
    'CMP-MESSAGE-0003': 'authorization_required',
    'CMP-MESSAGE-0004': 'authorization_revoked',
    'CMP-MESSAGE-0005': 'idempotency_conflict',
    'CMP-MESSAGE-0006': 'recipient_archived',
    'CMP-MESSAGE-0007': 'recipient_deleted',
    'CMP-MESSAGE-0008': 'sender_backpressure',
    'CMP-MESSAGE-0009': 'recipient_backpressure',
    'CMP-MESSAGE-0010': 'context_budget',
    'CMP-MESSAGE-0011': 'persistence_failure',
    'CMP-MESSAGE-0012': 'stale_operation',
  };

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  // The shared escaper; renderer/shared/string-utils.js loads before this module in index.html.
  const escapeHtml = (globalThis.stringUtils && globalThis.stringUtils.escapeHtml)
    || (typeof require === 'function' ? require('../shared/string-utils').escapeHtml : null);

  function byteLength(text) {
    const value = String(text == null ? '' : text);
    if (typeof TextEncoder === 'function') return new TextEncoder().encode(value).length;
    return unescape(encodeURIComponent(value)).length;
  }

  const GRANT_PURPOSE_MAX_BYTES = 512;

  /** A directional grant's expiry as a short date and time ("Oct 22, 3:38 PM"); '' for an unreadable value. */
  function formatGrantExpiry(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.valueOf())) return '';
    try {
      const tag = globalThis.jennyI18n && typeof globalThis.jennyI18n.tag === 'function' ? globalThis.jennyI18n.tag() : undefined;
      return new Intl.DateTimeFormat(tag, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
    } catch (_error) {
      return date.toISOString().slice(0, 16).replace('T', ' ');
    }
  }

  function formatTime(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.valueOf())) return '';
    try {
      const tag = globalThis.jennyI18n && typeof globalThis.jennyI18n.tag === 'function' ? globalThis.jennyI18n.tag() : undefined;
      return new Intl.DateTimeFormat(tag, { hour: 'numeric', minute: '2-digit' }).format(date);
    } catch (_error) {
      return date.toISOString().slice(11, 16);
    }
  }

  function clip(text, max) {
    const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    return value.length <= max ? value : `${value.slice(0, max - 1).trim()}…`;
  }

  /** A chat's display title; null titles (deleted or unnamed) never print "null". */
  function chatTitle(title, available) {
    if (available === false) return jt('chat.messages.deletedChat', 'Deleted chat');
    const text = clip(title, 120);
    return text || jt('chat.messages.untitledChat', 'Untitled chat');
  }

  function projectName(name) {
    return clip(name, 80);
  }

  /** The reason token of a failure envelope or an outbox last_error (alias codes map to their token). */
  function reasonToken(failure) {
    if (!isObject(failure)) return '';
    if (typeof failure.reason === 'string' && /^[a-z_]+$/.test(failure.reason)) return failure.reason;
    return CODE_REASONS[failure.code] || '';
  }

  /** The detail after "Couldn't deliver ·". */
  function deliveryFailureDetail(failure) {
    switch (reasonToken(failure)) {
      case 'recipient_archived': return jt('chat.messages.failure.archived', 'that chat is archived');
      case 'recipient_deleted': return jt('chat.messages.failure.deleted', 'that chat was deleted');
      case 'recipient_backpressure': return jt('chat.messages.failure.recipientFull', "that chat's inbox is full");
      case 'sender_backpressure': return jt('chat.messages.failure.senderFull', 'too many unsent messages');
      case 'authorization_required': return jt('chat.messages.failure.authorizationRequired', 'it was not approved');
      case 'authorization_revoked': return jt('chat.messages.failure.authorizationRevoked', 'permission to send was revoked or expired');
      case 'turn_send_limit': return jt('chat.messages.failure.turnSendLimit', 'too many messages in one reply');
      case 'stale_operation': return jt('chat.messages.failure.expired', 'this send expired');
      case 'persistence_failure': return jt('chat.messages.failure.persistence', "it couldn't be saved");
      case 'unavailable': return jt('chat.messages.failure.unavailable', 'messaging is unavailable');
      case 'invalid_request': return jt('chat.messages.failure.invalid', 'that chat or message is no longer valid');
      default: return jt('chat.messages.failure.generic', 'something went wrong');
    }
  }

  /** A full sentence for a failed Send or action answer (dialog error line, action notices). */
  function actionFailureText(failure) {
    switch (reasonToken(failure)) {
      case 'busy': return jt('chat.messages.action.busy', "This chat is replying right now. Try again when it's done.");
      case 'recipient_archived': return jt('chat.messages.send.archived', "That chat is archived, so it can't receive messages.");
      case 'recipient_deleted': return jt('chat.messages.send.deleted', 'That chat was deleted.');
      case 'recipient_backpressure': return jt('chat.messages.send.recipientFull', "That chat's inbox is full. Try again later.");
      case 'sender_backpressure': return jt('chat.messages.send.senderFull', 'Too many messages are waiting to be delivered from this chat.');
      case 'authorization_required': return jt('chat.messages.send.authorizationRequired', 'This message needs your approval before it can be sent.');
      case 'authorization_revoked': return jt('chat.messages.send.authorizationRevoked', 'Permission to send in this direction was revoked or has expired.');
      case 'turn_send_limit': return jt('chat.messages.send.turnSendLimit', 'This chat has reached its message limit for one reply.');
      case 'capacity': return jt('chat.messages.grant.capacity', 'Too many directions are already allowed from this chat. Revoke one first.');
      case 'stale_operation': return jt('chat.messages.send.expired', 'This send expired. Press Send to try again.');
      case 'invalid_request': return jt('chat.messages.send.invalid', "That chat or message isn't valid any more.");
      case 'idempotency_conflict': return jt('chat.messages.send.conflict', 'This message conflicts with one already sent. Edit it and try again.');
      default: return jt('chat.messages.send.failed', "Couldn't send the message. Try again.");
    }
  }

  /** The sentence for a failed Review and send confirmation (archive restore); never the raw reason. */
  function restoreFailureText(failure) {
    switch (reasonToken(failure)) {
      case 'idempotency_conflict': return jt('chat.messages.restore.changed', 'This message changed after you reviewed it. Close this and review it again.');
      case 'recipient_archived': return jt('chat.messages.restore.archived', "That chat is archived, so it can't receive messages.");
      case 'recipient_deleted': return jt('chat.messages.restore.deleted', 'That chat was deleted.');
      case 'stale_operation': return jt('chat.messages.restore.stale', 'This message is no longer waiting for your confirmation.');
      case 'source_ineligible': return jt('chat.messages.restore.sourceIneligible', "This chat can't send messages right now.");
      case 'recipient_ineligible': return jt('chat.messages.restore.recipientIneligible', "That chat can't receive messages right now.");
      case 'unavailable': return jt('chat.messages.restore.unavailable', 'Messaging is unavailable right now. Try again.');
      default: return jt('chat.messages.restore.failed', "Couldn't send the message. Try again.");
    }
  }

  const restoredStripWord = () => jt('chat.messages.restore.stripWord', 'Not sent');
  const restoredStripDetail = () => jt('chat.messages.restore.stripDetail', 'Restored from a backup');
  const reviewAndSendLabel = () => jt('chat.messages.restore.reviewAndSend', 'Review and send');

  /** The first 12 hex characters of a full-envelope hash, the short check code the dialog shows. */
  function shortHash(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) ? value.slice(0, 12) : '';
  }

  /** True for the envelope of a linked child's terminal report (cp5b-1), false for every other message. */
  function isReportEnvelope(envelope) {
    return isObject(envelope) && envelope.kind === 'terminal_report';
  }

  /** The outcome word and tone of a report envelope; an unknown outcome has no word (never a guess). */
  function reportOutcome(envelope) {
    const report = isObject(envelope) && isObject(envelope.report) ? envelope.report : {};
    switch (report.outcome) {
      case 'completed': return { outcome: 'completed', tone: 'ok', word: jt('chat.messages.report.completed', 'turn finished') };
      case 'failed': return { outcome: 'failed', tone: 'error', word: jt('chat.messages.report.failed', 'turn failed') };
      case 'cancelled': return { outcome: 'cancelled', tone: 'muted', word: jt('chat.messages.report.cancelled', 'turn cancelled') };
      case 'awaiting_decision': return { outcome: 'awaiting_decision', tone: 'warn', word: jt('chat.messages.report.awaitingDecision', 'waiting for a decision') };
      default: return { outcome: '', tone: 'muted', word: '' };
    }
  }

  /** True when the report's answer was clipped to fit the report slot. */
  function isReportClipped(envelope) {
    return isReportEnvelope(envelope) && isObject(envelope.report) && envelope.report.clipped === true;
  }

  const reportFromLabel = () => jt('chat.messages.report.from', 'Report from');
  const reportCardAria = (title) => jt('chat.messages.report.cardAria', 'Report from {title}', { title });
  const reportClippedText = () => jt('chat.messages.report.clipped', 'Clipped · open the chat for the full answer');
  const reportOpenChatLabel = () => jt('chat.messages.report.openChat', 'Open chat');
  const reportToLine = (title) => jt('chat.messages.report.reportTo', 'Report to “{title}”', { title });
  const reportDiscardLabel = () => jt('chat.messages.report.discard', 'Discard report');

  return {
    jt, jtn, MAX_BODY_BYTES, GRANT_PURPOSE_MAX_BYTES, isObject, escapeHtml, byteLength, formatTime, formatGrantExpiry, clip, chatTitle, projectName,
    reasonToken, deliveryFailureDetail, actionFailureText, restoreFailureText, restoredStripWord, restoredStripDetail, reviewAndSendLabel, shortHash,
    isReportEnvelope, reportOutcome, isReportClipped, reportFromLabel, reportCardAria, reportClippedText, reportOpenChatLabel, reportToLine, reportDiscardLabel,
  };
});
