'use strict';

/* services/backend/chat-skill-command-projection.js — how a skill invocation
 * reads to the model. A stored row keeps the typed text in `content` and the
 * picked skill in `skill_invocation`; the model only ever sees the projection,
 * so the slash command the user typed is restored. The live turn's prompt
 * projects through the same helper, so turn N sends exactly the text turn N+1
 * replays from history (prefix-cache stable). Pure and deterministic. */

const SKILL_COMMAND_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function withSkillCommand(content, skillInvocation) {
  const command = skillInvocation?.command;
  if (typeof command !== 'string' || !SKILL_COMMAND_PATTERN.test(command)) return content;
  return content ? `/${command} ${content}` : `/${command}`;
}

// Only plain user rows: kinded rows (recaps, question batches) keep their text.
function projectUserSkillInvocation(message, content) {
  if (message.role !== 'user' || String(message.kind || '').trim()) return content;
  return withSkillCommand(content, message.skill_invocation);
}

module.exports = { projectUserSkillInvocation, withSkillCommand };
