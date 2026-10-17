(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnRowInteractiveCards = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Tool rows that render as an interactive card instead of the generic tool row:
  // the ask_user question block and receipt, and the session proposal cards
  // (propose_git_action, propose_command, propose_session; renderer-proposal-cards.js). Split out of
  // renderer-turn-row-render-utils.js, which sits at the file-size cap.
  function createInteractiveCards(deps) {
    const { escapeHtml, normalizeId, renderUserQuestionsBlock, renderUserQuestionsReceipt } = deps;

    function buildUserQuestionsMarkup(toolCallMessage, row) {
      const toolCall = toolCallMessage && toolCallMessage.tool_call && typeof toolCallMessage.tool_call === 'object'
        ? toolCallMessage.tool_call : {};
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const status = normalizeId(payload.state || toolCall.status);
      const toolName = normalizeId(payload.tool_name || toolCall.tool_name);
      const questions = Array.isArray(payload.user_questions) ? payload.user_questions : toolCall.user_questions;
      if (toolName !== 'ask_user') {
        return '';
      }
      // Stale demotion is client-side (dead waiter) — no tool_result event ever
      // lands, so the projector keeps deriving payload.state='pending_user_input'
      // from the unsettled event stream. The persisted stale mark must therefore
      // outrank the pending state, or a full row re-render (scroll recycle,
      // resize, later stream event) resurrects the interactive dead card.
      const staleKind = normalizeId(payload.user_questions_result_kind || toolCall.user_questions_result_kind);
      if (status === 'pending_user_input' && staleKind !== 'user_questions_stale') {
        return renderUserQuestionsBlock ? renderUserQuestionsBlock({
          toolCallId: normalizeId(payload.tool_call_id || toolCall.call_id),
          questionRef: normalizeId(payload.question_ref || toolCall.question_ref),
          questions: Array.isArray(questions) ? questions : [],
        }, { escapeHtml }) : '';
      }
      if (staleKind === 'user_questions_stale') {
        return renderUserQuestionsReceipt && Array.isArray(questions) ? renderUserQuestionsReceipt({
          toolCallId: normalizeId(payload.tool_call_id || toolCall.call_id),
          questions,
          stale: true,
        }, { escapeHtml }) : '';
      }
      const resultKind = normalizeId(payload.user_questions_result_kind);
      const answered = resultKind === 'user_questions_answered';
      if (!renderUserQuestionsReceipt
        || !Array.isArray(questions)
        || (answered && !Array.isArray(payload.user_questions_answers))
        || (!answered && resultKind !== 'user_questions_declined')) {
        return '';
      }
      return renderUserQuestionsReceipt({
        toolCallId: normalizeId(payload.tool_call_id || toolCall.call_id),
        questions,
        resultKind,
        answers: Array.isArray(payload.user_questions_answers) ? payload.user_questions_answers : [],
      }, { escapeHtml });
    }

    // A paired propose_* result becomes the card; anything else (running, errored) keeps the tool row.
    function buildProposalMarkup(row, messages, renderOptions) {
      const cards = (typeof globalThis !== 'undefined' && globalThis.rendererProposalCards)
        || (typeof require === 'function' ? (() => { try { return require('./renderer-proposal-cards'); } catch (_error) { return null; } })() : null);
      return cards ? cards.buildProposalRowMarkup(row, messages, renderOptions, { escapeHtml }) : '';
    }

    function buildInteractiveCardMarkup(toolCallMessage, row, messages, renderOptions) {
      return buildUserQuestionsMarkup(toolCallMessage, row) || buildProposalMarkup(row, messages, renderOptions);
    }

    return { buildUserQuestionsMarkup, buildProposalMarkup, buildInteractiveCardMarkup };
  }

  return { createInteractiveCards };
});
