const RECALL_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'have',
  'what',
  'when',
  'where',
  'your',
  'about',
  'should',
  'would',
  'could',
  'there',
  'their',
  'them',
  'then',
  'into',
  'user',
]);

const GENERIC_CAPTURE_VALUES = new Set(['it', 'that', 'this', 'them', 'things', 'stuff', 'something']);
const PERSON_NAME_TOKEN_PATTERN = String.raw`(?!and\b|or\b|is\b|are\b|was\b|were\b|am\b|has\b|have\b|had\b|will\b|would\b|could\b|should\b|can\b|did\b|do\b|does\b|from\b|with\b|for\b)[a-z][a-z0-9'-]*`;
const PERSON_NAME_PATTERN = String.raw`${PERSON_NAME_TOKEN_PATTERN}(?:\s+${PERSON_NAME_TOKEN_PATTERN}){0,2}`;
const PERSON_NAME_AFTER_RELATION_PATTERN = String.raw`${PERSON_NAME_TOKEN_PATTERN}(?:\s+${PERSON_NAME_TOKEN_PATTERN}){0,2}`;
const CAPITALIZED_PERSON_NAME_PATTERN = String.raw`[A-Z][a-z0-9'-]*(?:\s+[A-Z][a-z0-9'-]*){0,2}`;
const IMPORTANT_PERSON_EXPLICIT_RELATIONSHIP_PATTERN = String.raw`(?:friend|partner|mom|dad|sister|brother)`;
const IMPORTANT_PERSON_GENERIC_RELATIONSHIP_PATTERN = String.raw`[a-z]+(?:\s+(?!is\b)[a-z]+)?`;
const IMPORTANT_PERSON_RELATIONSHIP_PATTERN = String.raw`(?:${IMPORTANT_PERSON_EXPLICIT_RELATIONSHIP_PATTERN}|${IMPORTANT_PERSON_GENERIC_RELATIONSHIP_PATTERN})`;

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeCapture(value) {
  return normalizeSpaces(String(value || '').replace(/\b(?:please|thanks|thank you)\b/gi, ''))
    .replace(/^[\s.,!?;:-]+|[\s.,!?;:-]+$/g, '');
}

function titleCaseWords(value) {
  return normalizeSpaces(value)
    .split(' ')
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function parseImportantPersonValue(value) {
  const normalizedValue = normalizeCapture(value);
  let match = normalizedValue.match(
    new RegExp(`^(?<relationship>${IMPORTANT_PERSON_RELATIONSHIP_PATTERN})\\s+(?<name>${PERSON_NAME_PATTERN})$`, 'i')
  );
  if (match?.groups?.relationship && match?.groups?.name) {
    return {
      name: titleCaseWords(match.groups.name),
      relationship: normalizeSpaces(match.groups.relationship).toLowerCase(),
    };
  }

  match = normalizedValue.match(
    new RegExp(`^(?<name>${PERSON_NAME_PATTERN})\\s+is\\s+my\\s+(?<relationship>${IMPORTANT_PERSON_RELATIONSHIP_PATTERN})$`, 'i')
  );
  if (match?.groups?.relationship && match?.groups?.name) {
    return {
      name: titleCaseWords(match.groups.name),
      relationship: normalizeSpaces(match.groups.relationship).toLowerCase(),
    };
  }

  return {
    name: titleCaseWords(normalizedValue),
    relationship: 'important person',
  };
}

function formatImportantPerson(value) {
  const parsed = parseImportantPersonValue(value);
  return {
    title: `Important person: ${parsed.name} (${parsed.relationship})`,
    lesson_text: `The user's ${parsed.relationship} is ${parsed.name}.`,
  };
}

const MEMORY_PATTERNS = [
  {
    lessonKind: 'profile',
    confidence: 0.99,
    pattern: new RegExp(`\\bmy name is\\s+(?<value>${PERSON_NAME_PATTERN})\\b`, 'i'),
    formatter: (value) => ({
      title: `Preferred name: ${value}`,
      lesson_text: `The user's name is ${value}.`,
    }),
  },
  {
    lessonKind: 'profile',
    confidence: 0.98,
    pattern: new RegExp(`\\bcall me\\s+(?<value>${PERSON_NAME_PATTERN})\\b`, 'i'),
    formatter: (value) => ({
      title: `Preferred address: ${value}`,
      lesson_text: `Call the user ${value}.`,
    }),
  },
  {
    lessonKind: 'preference',
    confidence: 0.95,
    pattern: /\bi prefer\s+(?<value>[^.!?\n]+)/i,
    formatter: (value) => ({
      title: `Preference: ${value}`,
      lesson_text: `The user prefers ${value}.`,
    }),
  },
  {
    lessonKind: 'preference',
    confidence: 0.9,
    pattern: /\bi (?:like|love)\s+(?<value>[^.!?\n]+)/i,
    formatter: (value) => ({
      title: `Likes: ${value}`,
      lesson_text: `The user likes ${value}.`,
    }),
  },
  {
    lessonKind: 'preference',
    confidence: 0.9,
    pattern: /\bi (?:dislike|hate)\s+(?<value>[^.!?\n]+)/i,
    formatter: (value) => ({
      title: `Dislikes: ${value}`,
      lesson_text: `The user dislikes ${value}.`,
    }),
  },
];

const ROUTINE_CANDIDATES = [
  {
    pattern: /\bmy\s+morning\s+routine\s+is\s+(?<value>[^.!?\n]+)/i,
    title: 'Routine: morning routine',
    lesson_text: "The user's morning routine includes {value}.",
    confidence: 0.94,
  },
  {
    pattern: /\bevery\s+morning\s+i\s+(?<value>[^.!?\n]+)/i,
    title: 'Routine: morning routine',
    lesson_text: "The user's morning routine includes {value}.",
    confidence: 0.94,
  },
  {
    pattern: /\bmy\s+daily\s+routine\s+includes\s+(?<value>[^.!?\n]+)/i,
    title: 'Routine: daily routine',
    lesson_text: "The user's daily routine includes {value}.",
    confidence: 0.93,
  },
  {
    pattern: /\bmy\s+evening\s+routine\s+is\s+(?<value>[^.!?\n]+)/i,
    title: 'Routine: evening routine',
    lesson_text: "The user's evening routine includes {value}.",
    confidence: 0.94,
  },
  {
    pattern: /\bbefore\s+bed\s+i\s+(?<value>[^.!?\n]+)/i,
    title: 'Routine: evening routine',
    lesson_text: "The user's evening routine includes {value}.",
    confidence: 0.93,
  },
  {
    pattern: /\bevery\s+week\s+i\s+(?<value>[^.!?\n]+)/i,
    title: 'Routine: weekly routine',
    lesson_text: "The user's weekly routine includes {value}.",
    confidence: 0.92,
  },
  {
    pattern: /\bon\s+(?<day>mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\s+i\s+(?<value>[^.!?\n]+)/i,
    title: 'Routine: {day} routine',
    lesson_text: "The user's {day} routine includes {value}.",
    confidence: 0.92,
  },
];

const GOAL_CANDIDATES = [
  {
    pattern: /\bmy\s+goal\s+is\s+to\s+(?<value>[^.!?\n]+)/i,
    title: 'Goal: {value}',
    lesson_text: "The user's goal is to {value}.",
    confidence: 0.93,
  },
  {
    pattern: /\bmy\s+goal\s+is\s+(?<value>[^.!?\n]+)/i,
    title: 'Goal: {value}',
    lesson_text: "The user's goal is {value}.",
    confidence: 0.92,
  },
  {
    pattern: /\bi['’]m\s+trying\s+to\s+(?<value>[^.!?\n]+)/i,
    title: 'Goal: {value}',
    lesson_text: "The user's goal is to {value}.",
    confidence: 0.92,
  },
  {
    pattern: /\bi\s+want\s+to\s+achieve\s+(?<value>[^.!?\n]+)/i,
    title: 'Goal: {value}',
    lesson_text: "The user's goal is to achieve {value}.",
    confidence: 0.92,
  },
  {
    pattern: /\bi['’]m\s+working\s+toward\s+(?<value>[^.!?\n]+)/i,
    title: 'Goal: {value}',
    lesson_text: "The user's goal is {value}.",
    confidence: 0.91,
  },
  {
    pattern: /\bby\s+(?<month>january|february|march|april|may|june|july|august|september|october|november|december)\s+i\s+want\s+to\s+(?<value>[^.!?\n]+)/i,
    title: 'Goal: {value}',
    lesson_text: "By {month}, the user's goal is to {value}.",
    confidence: 0.91,
  },
];

const IMPORTANT_PERSON_CANDIDATES = [
  {
    lessonKind: 'important_person',
    confidence: 0.92,
    pattern: new RegExp(`\\bmy\\s+(?<value>${IMPORTANT_PERSON_EXPLICIT_RELATIONSHIP_PATTERN}\\s+${PERSON_NAME_AFTER_RELATION_PATTERN})\\b`, 'i'),
    formatter: formatImportantPerson,
  },
  {
    lessonKind: 'important_person',
    confidence: 0.91,
    pattern: new RegExp(`\\b(?<value>${PERSON_NAME_PATTERN}\\s+is\\s+my\\s+${IMPORTANT_PERSON_EXPLICIT_RELATIONSHIP_PATTERN})\\b`, 'i'),
    formatter: formatImportantPerson,
  },
  {
    lessonKind: 'important_person',
    confidence: 0.9,
    pattern: new RegExp(`\\b(?:my|My)\\s+(?<value>${IMPORTANT_PERSON_GENERIC_RELATIONSHIP_PATTERN}\\s+${CAPITALIZED_PERSON_NAME_PATTERN})\\b`),
    formatter: formatImportantPerson,
  },
  {
    lessonKind: 'important_person',
    confidence: 0.9,
    pattern: new RegExp(`\\b(?<value>${CAPITALIZED_PERSON_NAME_PATTERN}\\s+(?:is|Is)\\s+my\\s+${IMPORTANT_PERSON_GENERIC_RELATIONSHIP_PATTERN})\\b`),
    formatter: formatImportantPerson,
  },
];

const RESPONSE_STYLE_CANDIDATES = [
  {
    pattern: /\b(?:be concise|keep it brief|short answers?)\b/i,
    title: 'Response style: concise',
    lesson_text: 'Use concise answers unless the user asks for more detail.',
    confidence: 0.93,
  },
  {
    pattern: /\b(?:be direct|straight to the point|no fluff)\b/i,
    title: 'Response style: direct',
    lesson_text: 'Be direct and avoid extra fluff unless the user asks for a softer tone.',
    confidence: 0.92,
  },
  {
    pattern: /\b(?:step by step|walk me through|show me step by step)\b/i,
    title: 'Response style: step-by-step',
    lesson_text: 'Explain things step by step when helping the user.',
    confidence: 0.91,
  },
];

const WORKING_PREFERENCE_CANDIDATES = [
  {
    pattern: /\b(?:diagnose|find|debug)\s+(?:the\s+)?root\s+cause(?:\s+first)?\b/i,
    title: 'Working preference: diagnose root cause first',
    lesson_text: 'Diagnose root cause before proposing fixes; avoid quick patches unless explicitly requested.',
    confidence: 0.94,
  },
  {
    pattern: /\b(?:keep|put|route)\s+(?:all\s+)?external\s+api\s+calls?\s+behind\s+(?:a\s+)?service\s+layer\b/i,
    title: 'Working preference: service-layer external APIs',
    lesson_text: 'Keep external API calls behind a service layer so retries, caching, and provider swaps stay localized.',
    confidence: 0.93,
  },
  {
    pattern: /\b(?:treat|handle)\s+schema\s+changes?\s+as\s+migrations?\b/i,
    title: 'Working preference: schema changes are migrations',
    lesson_text: 'Treat schema changes as migrations with explicit upgrade intent.',
    confidence: 0.92,
  },
  {
    pattern: /\b(?:prioriti[sz]e\s+observability|structured\s+logs?|request\s+ids?)\b/i,
    title: 'Working preference: prioritize observability',
    lesson_text: 'Prioritize observability with structured logs, request IDs, and appropriate log levels.',
    confidence: 0.9,
  },
  {
    pattern: /\b(?:clarify\s+ambiguous\s+scope|clarify\s+scope\s+before\s+implementation|ask\s+clarifying\s+questions\s+only\s+when\s+it\s+changes\s+the\s+outcome)\b/i,
    title: 'Working preference: clarify ambiguous scope first',
    lesson_text: 'Clarify ambiguous scope before implementation; ask clarifying questions only when the answer materially changes the outcome.',
    confidence: 0.89,
  },
  {
    pattern: /\b(?:update\s+the\s+plan\s+document\s+when\s+(?:the\s+)?task\s+or\s+batch\s+is\s+completed|if\s+following\s+a\s+plan\s+document,\s*update\s+the\s+plan\s+document)\b/i,
    title: 'Working preference: update plan docs after completion',
    lesson_text: 'When following a plan document, update it after the task or batch is completed.',
    confidence: 0.88,
  },
];

const TOOL_STRATEGY_CANDIDATES = [
  {
    pattern: /\b(?:use|prefer)\s+(?:rg|ripgrep)\b/i,
    title: 'Tool strategy: prefer ripgrep',
    lesson_text: 'For repository text search tasks, prefer rg/ripgrep when it is available.',
    confidence: 0.9,
  },
  {
    pattern: /\b(?:use|prefer)\s+apply_patch\b/i,
    title: 'Tool strategy: use apply_patch',
    lesson_text: 'Prefer apply_patch for small manual file edits when practical.',
    confidence: 0.89,
  },
  {
    pattern: /\b(?:(?:don't|do not|dont)\s+run\s+tests?\s+unless\s+i\s+ask(?:\s+you)?|skip\s+tests?\s+unless\s+requested)\b/i,
    title: 'Tool strategy: avoid unrequested tests',
    lesson_text: 'Do not run tests unless the user explicitly asks for them.',
    confidence: 0.91,
  },
  {
    pattern: /\b(?:keep\s+diffs?\s+small|small\s+reviewable\s+diffs?)\b/i,
    title: 'Tool strategy: keep diffs small',
    lesson_text: 'Keep changes small and reviewable.',
    confidence: 0.88,
  },
  {
    pattern: /\b(?:plan\s+first|define\s+architecture\s+first|plan\s+before\s+implementation)\b/i,
    title: 'Tool strategy: plan before implementation',
    lesson_text: 'Plan the approach before implementing non-trivial work.',
    confidence: 0.87,
  },
];

const PROJECT_CONTEXT_CANDIDATES = [
  {
    pattern: /\b(?:workspace|repo|repository)\b[^.!?\n]{0,80}\bno\s+\.git\s+metadata\b/i,
    title: 'Project context: workspace has no git metadata',
    lesson_text: 'This workspace has no .git metadata, so branch and status information are unavailable.',
    confidence: 0.95,
  },
  {
    pattern: /\belectron\s+owns\s+(?:the\s+)?canonical\s+conversation\s+history\b/i,
    title: 'Project context: Electron owns canonical history',
    lesson_text: 'Electron owns canonical conversation history and persistence.',
    confidence: 0.94,
  },
  {
    pattern: /\bsidecar\s+is\s+stateless\s+per\s+request\b/i,
    title: 'Project context: sidecar is stateless per request',
    lesson_text: 'The sidecar is stateless per request.',
    confidence: 0.94,
  },
  {
    pattern: /\bapproved\s+memories?\b[^.!?\n]{0,80}\bsidecar\s+sqlite\b/i,
    title: 'Project context: approved memories live in sidecar SQLite',
    lesson_text: 'Approved memories are stored canonically in the sidecar SQLite database only.',
    confidence: 0.93,
  },
  {
    pattern: /\b(?:no\s+vector\s+db|do\s+not\s+use\s+(?:a\s+)?vector\s+db)\b/i,
    title: 'Project context: no vector DB',
    lesson_text: 'Do not introduce a vector database for memory; keep recall deterministic and cheap.',
    confidence: 0.92,
  },
  {
    pattern: /\btools?\b[^.!?\n]{0,80}\bblocked\s+until\b[^.!?\n]{0,80}\bworkspace\s+root\b/i,
    title: 'Project context: tools require explicit workspace root',
    lesson_text: 'Tools remain blocked until a workspace root is explicitly configured.',
    confidence: 0.91,
  },
];

const TOOL_STRATEGY_FAMILY_BY_FINGERPRINT = {
  'tool_strategy:for-repository-text-search-tasks-prefer-rg-ripgrep-when-it-is-available': 'ripgrep',
  'tool_strategy:prefer-apply-patch-for-small-manual-file-edits-when-practical': 'apply_patch',
  'tool_strategy:do-not-run-tests-unless-the-user-explicitly-asks-for-them': 'skip_tests',
  'tool_strategy:keep-changes-small-and-reviewable': 'small_diffs',
  'tool_strategy:plan-the-approach-before-implementing-non-trivial-work': 'plan_first',
};

const TOOL_STRATEGY_QUERY_PATTERNS = {
  ripgrep: [
    /\b(?:rg|ripgrep)\b/i,
    /\b(?:search|find|grep|look(?:ing)?\s+for|scan)\b.*\b(?:repo|repository|code|codebase|text|file|files|source)\b/i,
    /\b(?:repo|repository|code|codebase|text|file|files|source)\b.*\b(?:search|find|grep|scan)\b/i,
  ],
  apply_patch: [
    /\bapply_patch\b/i,
    /\b(?:edit|patch|modify|update|change|rewrite)\b.*\b(?:file|files|text|line|lines)\b/i,
    /\b(?:file|files|text|line|lines)\b.*\b(?:edit|patch|modify|update|change|rewrite)\b/i,
  ],
  skip_tests: [
    /\b(?:test|tests|testing|pytest|vitest|jest)\b/i,
  ],
  small_diffs: [
    /\b(?:small|minimal|reviewable)\b.*\b(?:diff|diffs|change|changes|patch|patches)\b/i,
    /\b(?:diff|diffs|change|changes|patch|patches)\b.*\b(?:small|minimal|reviewable)\b/i,
  ],
  plan_first: [
    /\b(?:plan|approach|architecture|design)\b.*\b(?:implement|implementation|build|code|coding|change|changes|patch|feature|refactor)\b/i,
    /\b(?:implement|implementation|build|code|coding|change|changes|patch|feature|refactor)\b.*\b(?:plan|approach|architecture|design)\b/i,
    /\bplan\s+before\s+implementation\b/i,
    /\bdefine\s+architecture\s+first\b/i,
  ],
};

const WORKING_PREFERENCE_FAMILY_BY_LESSON_TEXT = {
  'diagnose root cause before proposing fixes; avoid quick patches unless explicitly requested.': 'diagnose_root_cause_first',
  'keep external api calls behind a service layer so retries, caching, and provider swaps stay localized.': 'service_layer_external_apis',
  'treat schema changes as migrations with explicit upgrade intent.': 'schema_changes_are_migrations',
  'prioritize observability with structured logs, request ids, and appropriate log levels.': 'prioritize_observability',
  'clarify ambiguous scope before implementation; ask clarifying questions only when the answer materially changes the outcome.': 'clarify_scope_first',
  'when following a plan document, update it after the task or batch is completed.': 'update_plan_docs_after_completion',
};

const WORKING_PREFERENCE_FAMILY_PATTERNS = {
  diagnose_root_cause_first: [
    /\b(?:root\s+cause|diagnos(?:e|ing)|debug)\b/i,
    /\b(?:fix|bug|issue|problem|regression|failure)\b/i,
  ],
  service_layer_external_apis: [
    /\b(?:service\s+layer|service)\b/i,
    /\b(?:external\s+api|provider|retry|cache|caching)\b/i,
  ],
  schema_changes_are_migrations: [
    /\b(?:schema|database|migration|migrate)\b/i,
  ],
  prioritize_observability: [
    /\b(?:observability|structured\s+logs?|request\s+ids?|diagnostics?|telemetry|logging)\b/i,
  ],
  clarify_scope_first: [
    /\b(?:scope|requirements?|clarify|clarifying)\b/i,
  ],
  update_plan_docs_after_completion: [
    /\b(?:plan\s+document|next[_\s-]?steps|handoff|rebuild\s+plan|batch)\b/i,
    /\b(?:update|updated|refresh|record|document)\b/i,
  ],
};

const PROJECT_CONTEXT_FAMILY_PATTERNS = {
  workspace_has_no_git_metadata: [
    /\b(?:git|branch|status|\.git)\b/i,
  ],
  electron_owns_canonical_history: [
    /\b(?:history|session|conversation|persistence)\b/i,
    /\belectron\b/i,
  ],
  sidecar_stateless_per_request: [
    /\b(?:sidecar|request|stateless)\b/i,
  ],
  approved_memories_sidecar_sqlite_only: [
    /\b(?:memory|memories|sqlite|sidecar)\b/i,
    /\b(?:canonical|approved|store|storage)\b/i,
  ],
  no_vector_db: [
    /\b(?:vector|embedding|semantic|recall|search)\b/i,
  ],
  tools_require_workspace_root: [
    /\b(?:tool|tools|workspace\s+root|tools_workspace_root)\b/i,
  ],
  do_not_reopen_feature_f: [
    /\bfeature\s+f\b/i,
    /\b(?:reopen|required|scope)\b/i,
  ],
};

const PROJECT_CONTEXT_FAMILY_BY_LESSON_TEXT = {
  'this workspace has no .git metadata, so branch and status information are unavailable.': 'workspace_has_no_git_metadata',
  'electron owns canonical conversation history and persistence.': 'electron_owns_canonical_history',
  'the sidecar is stateless per request.': 'sidecar_stateless_per_request',
  'approved memories are stored canonically in the sidecar sqlite database only.': 'approved_memories_sidecar_sqlite_only',
  'do not introduce a vector database for memory; keep recall deterministic and cheap.': 'no_vector_db',
  'tools remain blocked until a workspace root is explicitly configured.': 'tools_require_workspace_root',
  'do not reopen feature f unless it is required for the current task.': 'do_not_reopen_feature_f',
};

module.exports = {
  GENERIC_CAPTURE_VALUES,
  GOAL_CANDIDATES,
  IMPORTANT_PERSON_CANDIDATES,
  MEMORY_PATTERNS,
  PROJECT_CONTEXT_CANDIDATES,
  PROJECT_CONTEXT_FAMILY_BY_LESSON_TEXT,
  PROJECT_CONTEXT_FAMILY_PATTERNS,
  RECALL_STOPWORDS,
  RESPONSE_STYLE_CANDIDATES,
  ROUTINE_CANDIDATES,
  TOOL_STRATEGY_CANDIDATES,
  TOOL_STRATEGY_FAMILY_BY_FINGERPRINT,
  TOOL_STRATEGY_QUERY_PATTERNS,
  WORKING_PREFERENCE_FAMILY_BY_LESSON_TEXT,
  WORKING_PREFERENCE_CANDIDATES,
  WORKING_PREFERENCE_FAMILY_PATTERNS,
};
