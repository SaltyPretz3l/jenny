---
name: Claude Code Delegation
description: Prepare clear, bounded handoff prompts for external Claude Code or similar coding sessions.
command: handoff
whenToUse: Use when the user asks to delegate coding work, prepare a Claude Code prompt, split implementation slices, or write a handoff for another coding agent.
---
# Claude Code Delegation

## Purpose and boundary
Prepare a self-contained prompt for an external coding assistant. Do not start sub-agents, background work, or implementation. Return the prompt in chat unless the user requests a saved document.

## Steps
1. Identify the goal, relevant context, constraints, and receiving environment. Ask if the goal is unclear; do not require every environmental detail before drafting.
2. Separate confirmed facts from assumptions. Inspect relevant files when available and useful. Label unverified paths, commands, and architecture as `To validate`; do not invent repository details.
3. Define narrow write ownership and explicit non-goals. Require the worker to preserve unrelated user changes and follow applicable project instructions. A handoff is not authorization to commit, push, deploy, or expand scope.
4. Write ordered tasks with observable acceptance criteria and targeted verification. Distinguish proposed commands from checks actually run. Jenny's available tools do not establish the receiving agent's capabilities; require it to validate needed tooling before use.
5. If splitting work, name dependencies, file ownership, integration ownership, and order. Do not propose simultaneous writes to shared files without an explicit coordination plan. Keep sequential work sequential when slices overlap.
6. Check that the worker can understand the prompt without this conversation. Replace references such as "as discussed above" with the necessary context, but omit secrets and irrelevant private information.

## If blocked or uncertain
List assumptions and unresolved questions. Tell the worker to stop and ask when a required contract is unclear, an unexpected ownership conflict appears, or completion requires changing protected scope. Do not turn guesses into mandatory implementation instructions.

## Output
Provide one copy-ready handoff, or clearly separated handoffs for requested slices:
- Goal and observable acceptance criteria.
- Context: confirmed files, current behavior, constraints, and assumptions to validate.
- Boundaries: allowed write scope, non-goals, and behavior to preserve.
- Tasks: ordered steps; dependencies and integration owner when applicable.
- Verification: targeted commands or manual checks, expected outcomes, and known execution limits.
- Stop conditions and open questions.
- Worker return format: changed files, behavior summary, checks run with results, blockers, and remaining risks.
