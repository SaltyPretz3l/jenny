(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnRowInteractiveCards = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Tool rows that render as an interactive card instead of the generic tool row:
  // the ask_user question block and receipt, the session proposal cards
  // (propose_git_action, propose_command, propose_session; renderer-proposal-cards.js) and the
  // suggest_next_step card (renderer-next-step-card.js). Split out of
  // renderer-turn-row-render-utils.js, which sits at the file-size cap.
  function createInteractiveCards(deps) {
    const { escapeHtml, normalizeId, renderUserQuestionsBlock, renderUserQuestionsReceipt } = deps;

    // The live user_questions_requested event is not saved, so a settled or reloaded card falls back
    // to the questions the model asked: the tool_use input, then the saved call's input_json.
    function askedQuestions(payload, toolCall) {
      for (const input of [payload.input, toolCall.input]) {
        if (input && Array.isArray(input.questions) && input.questions.length) return input.questions;
      }
      for (const json of [payload.input_json, toolCall.input_json]) {
        if (typeof json !== 'string' || !json.includes('"questions"')) continue;
        try {
          const parsed = JSON.parse(json);
          if (parsed && Array.isArray(parsed.questions) && parsed.questions.length) return parsed.questions;
        } catch (_error) { /* not JSON: keep looking */ }
      }
      return undefined;
    }

    function buildUserQuestionsMarkup(toolCallMessage, row) {
      const toolCall = toolCallMessage && toolCallMessage.tool_call && typeof toolCallMessage.tool_call === 'object'
        ? toolCallMessage.tool_call : {};
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const status = normalizeId(payload.state || toolCall.status);
      const toolName = normalizeId(payload.tool_name || toolCall.tool_name);
      const questions = Array.isArray(payload.user_questions) ? payload.user_questions
        : (Array.isArray(toolCall.user_questions) ? toolCall.user_questions : askedQuestions(payload, toolCall));
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
      // A reply typed in the composer settles as answered with no per-question answers.
      const reply = answered && typeof payload.user_questions_reply === 'string' ? payload.user_questions_reply : '';
      if (!renderUserQuestionsReceipt
        || !Array.isArray(questions)
        || (answered && !reply && !Array.isArray(payload.user_questions_answers))
        || (!answered && resultKind !== 'user_questions_declined')) {
        return '';
      }
      return renderUserQuestionsReceipt({
        toolCallId: normalizeId(payload.tool_call_id || toolCall.call_id),
        questions,
        resultKind,
        answers: Array.isArray(payload.user_questions_answers) ? payload.user_questions_answers : [],
        ...(reply ? { reply } : {}),
      }, { escapeHtml });
    }

    // A paired propose_* result becomes the card; anything else (running, errored) keeps the tool row.
    function buildProposalMarkup(row, messages, renderOptions) {
      const cards = (typeof globalThis !== 'undefined' && globalThis.rendererProposalCards)
        || (typeof require === 'function' ? (() => { try { return require('./renderer-proposal-cards'); } catch (_error) { return null; } })() : null);
      // Row 76: the primary chat's offer card carries the Always-allow row; the predicate and flag travel with the markup deps.
      const flags = typeof deps.getFeatureFlags === 'function' ? deps.getFeatureFlags() || {} : {};
      return cards ? cards.buildProposalRowMarkup(row, messages, renderOptions, { escapeHtml, isPrimarySession: deps.isPrimarySession, launchPermissionEnabled: flags.primary_launch_permission !== false }) : '';
    }

    // A successful suggest_next_step result becomes the next-step card; anything else keeps the tool row.
    function buildNextStepMarkup(row, messages, renderOptions) {
      const card = (typeof globalThis !== 'undefined' && globalThis.rendererNextStepCard)
        || (typeof require === 'function' ? (() => { try { return require('./renderer-next-step-card'); } catch (_error) { return null; } })() : null);
      return card ? card.buildNextStepMarkup(row, messages, renderOptions, { escapeHtml }) : '';
    }

    function buildInteractiveCardMarkup(toolCallMessage, row, messages, renderOptions) {
      return buildUserQuestionsMarkup(toolCallMessage, row) || buildProposalMarkup(row, messages, renderOptions)
        || buildNextStepMarkup(row, messages, renderOptions);
    }

    return { buildUserQuestionsMarkup, buildProposalMarkup, buildNextStepMarkup, buildInteractiveCardMarkup };
  }

  return { createInteractiveCards };
});
