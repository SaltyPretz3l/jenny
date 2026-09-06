/* comet/sentiment-utils.js – lightweight text→sentiment heuristic for the comet personality system (UMD) */
/* Pure text-to-sentiment heuristic used by Comet. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.cometSentimentUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var SENTIMENT_CLARIFICATION_PATTERN =
    /\?|clarify|unclear|not sure|which|what kind|what outcome|could you|can you|need more|help me narrow/i;
  var SENTIMENT_NEGATIVE_PATTERN =
    /sorry|can't|cannot|unable|failed|failure|error|issue|problem|blocked|concern|warning|denied|cancelled/i;
  var SENTIMENT_POSITIVE_PATTERN =
    /glad|happy|great|nice|done|complete|completed|fixed|resolved|helpful|absolutely|sure thing|let's|can do|thanks|thank you|perfect|excellent|awesome|wonderful/i;

  function inferSentimentFromText(text) {
    var normalized = String(text || '').trim().toLowerCase();
    if (!normalized) {
      return { sentiment: 'neutral', expression: 'idle' };
    }

    if (SENTIMENT_NEGATIVE_PATTERN.test(normalized)) {
      return { sentiment: 'negative', expression: 'concerned' };
    }
    if (SENTIMENT_POSITIVE_PATTERN.test(normalized)) {
      return { sentiment: 'positive', expression: 'warm' };
    }
    if (SENTIMENT_CLARIFICATION_PATTERN.test(normalized)) {
      return { sentiment: 'neutral', expression: 'confused' };
    }
    return { sentiment: 'neutral', expression: 'idle' };
  }

  return {
    inferSentimentFromText: inferSentimentFromText,
  };
});
