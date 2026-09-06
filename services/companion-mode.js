const { normalizeString } = require('./backend/path-utils');

const DEFAULT_COMPANION_MODE = 'planner';

const COMPANION_MODES = Object.freeze({
  planner: Object.freeze({
    label: 'Planner',
    description: 'Jenny leans toward structure, priorities, and gentle sequencing.',
    homePrompt: 'Help me turn today into a simple plan with the right next steps.',
    secondaryPrompts: Object.freeze([
      'What are the most important things I should focus on this week?',
      'Help me break down my biggest task into smaller steps.',
    ]),
  }),
  listener: Object.freeze({
    label: 'Listener',
    description: 'Jenny stays present, reflective, and low-pressure before trying to solve things.',
    homePrompt: 'Help me think out loud about what is on my mind today.',
    secondaryPrompts: Object.freeze([
      'Help me make sense of what feels heavy today without jumping to solutions.',
      'Can you help me untangle what I am feeling and what I need?',
    ]),
  }),
  researcher: Object.freeze({
    label: 'Researcher',
    description: 'Jenny frames the day around questions, evidence, and what still needs clarity.',
    homePrompt: 'Help me sort through the open questions I should answer today.',
    secondaryPrompts: Object.freeze([
      'What assumptions am I making that I should verify first?',
      'Help me compare the strongest options before I decide.',
    ]),
  }),
  coach: Object.freeze({
    label: 'Coach',
    description: 'Jenny emphasizes encouragement, accountability, and keeping momentum visible.',
    homePrompt: 'Help me choose the most encouraging next move for today.',
    secondaryPrompts: Object.freeze([
      'Help me regain momentum on the thing I have been avoiding.',
      'What is one realistic win I can create today?',
    ]),
  }),
  builder: Object.freeze({
    label: 'Builder',
    description: 'Jenny focuses on execution, shipping, and turning intent into visible progress.',
    homePrompt: 'Help me pick one thing I can build or finish next.',
    secondaryPrompts: Object.freeze([
      'What is the smallest useful version I can ship today?',
      'Help me turn this idea into a concrete execution checklist.',
    ]),
  }),
});

function normalizeCompanionMode(value) {
  const normalized = normalizeString(value).toLowerCase();
  return Object.prototype.hasOwnProperty.call(COMPANION_MODES, normalized)
    ? normalized
    : DEFAULT_COMPANION_MODE;
}

function getCompanionModeMeta(mode) {
  return COMPANION_MODES[normalizeCompanionMode(mode)] || COMPANION_MODES[DEFAULT_COMPANION_MODE];
}

module.exports = {
  COMPANION_MODES,
  DEFAULT_COMPANION_MODE,
  getCompanionModeMeta,
  normalizeCompanionMode,
};
