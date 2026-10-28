# Run modes and approvals

Run modes decide how much Jenny asks before it acts. Approvals are the individual yes-or-no decisions you make on tool calls. Both are in your hands, and neither is hidden: the current run mode is always visible in the composer.

## The four run modes

The run-mode chip in the composer shows the current mode. Click it for a menu, or press Shift+Tab in the message box to cycle Ask, Auto, Plan, Propose. Alt+P toggles Plan directly. You can change mode while a reply is streaming. Pending approvals stay pending and are decided under the mode they were raised in; the new mode applies to later calls.

- Ask (the default): Jenny asks before running tools that change things. Read-only inspection does not necessarily ask; each tool's approval policy decides.
- Auto: tools run without asking. Python, blocked commands and explicit denies still prompt, and destructive shell commands still ask. Turning on Auto shows a confirmation dialog ("Turn on Auto run?") that also states your inactivity-pause setting.
- Plan: read-only. Jenny plans first and presents the plan before acting.
- Propose: Jenny suggests exact changes for you to review. Nothing in your files changes until you accept.

New chats start in the mode set at Settings > Tools > Permissions > Default run mode. Each chat can then change its own mode.

Auto is not permission to leave the app unattended. Supervise the results. The first time you use it, Jenny asks you to acknowledge a warning, and remembers that acknowledgement in the app profile.

## Safety guards around Auto

All of these live in Settings > Tools > Permissions:

- Safety mode: Normal, Strict or Paranoid. Normal lets the run mode decide which tools ask. Strict also removes web search and browsing. Paranoid asks on every tool call, even in Auto. It applies from the next turn.
- Pause Auto when you are away: off by default. When on (choices run from 1 minute up to 1 or 2 hours, or Never), after that long with no keyboard or mouse activity the next action asks first. A paused turn stays in Ask until you change its run mode or resume it. Unanswered approvals eventually stop the turn without running the tool.
- Auto-approval limit: in Auto, Jenny asks once after this many approvals in a single reply (the default is 50; empty or 0 means no limit).

Ordinary approvals wait about ten minutes for an answer before timing out.

## Approvals

When a tool needs permission, an approval card appears in the timeline, and the chat shows up in Needs you. The card names the tool and its target. Your choices:

- Allow once (Approve): run just this call.
- Always allow: run this call and stop asking for this tool.
- Deny: refuse the call.

When several approvals wait in the same turn, a banner offers Allow all once, Always allow all and Deny all.

Approval is bound to the exact request. If the tool call, its arguments, the model or the surrounding context changes between the request and your answer, Jenny shows what changed and asks again. Truncated tool arguments are never repaired into a side-effecting call.

### Approval rules

Always allow saves a rule. For a call that targets a path, the rule covers that tool and that path; for a call with no path (running a command, fetching a URL) it can cover the whole tool, so read the scope on the card. Every saved rule is listed under Settings > Tools > Approval rules with a Remove button; after removal Jenny asks again. A tool that "used to run" and now asks is usually a new target, or a destructive command, which always asks.

## Plan mode

Plan mode lets Jenny read and propose without changing your project. It can still write inert scratch documents such as Markdown, text and JSON notes as artifacts. When the plan is ready Jenny submits it for review (the chat appears in Needs you as "Plan ready for review"), and you pick one of:

- Build it: leave Plan and return to the mode you had before.
- Build it, auto mode: switch the chat to Auto and build without asking again.
- Keep planning: stay in Plan with your feedback.

Plan mode works best with larger models; Jenny warns when the active model may not follow a multi-step plan reliably.

## Propose mode and the Changes review

In Propose mode Jenny does not edit files. It offers suggested changes, each with a plain-language title, what changes, why, and what to watch for. They collect in the Changes view of the side panel:

- Accept applies a change (Alt+Enter). Reject declines it, with an optional reason. Review later sets it aside.
- Comment sends feedback; comments queue and go to Jenny as one revision request when you press Send. Sending needs the chat to be in Propose.
- A change that depends on another says so ("Accept change 2 first"), and Apply anyway is available if you rejected the one it needs. Grouped changes apply together once all are accepted.
- If the file changed since the suggestion, the change re-anchors to the file as it is now or is marked out of date; you can comment to ask for a new version.
- Leaving Propose while suggestions are waiting asks whether to Keep them or Discard them. Nothing has been applied either way.

History in the same view lists changes Jenny has already made to your files, including edits made through scripts. Undo Jenny's change shows what would be reverted and asks you to confirm; undone changes can be redone. Change tracking needs a Git folder. Undo cannot cover everything: the sheet lists what it cannot undo.

## Other decisions Jenny can hand you

- Questions: ask_user presents up to four questions as a card; you can answer or decline.
- Git decisions: after finished changes in a Git workspace, a card offers Commit, Test first or dismiss. Test first never commits by itself.
- Proposed commands: a card shows the exact command with Copy and Run. Copy only copies. Run executes that command through the normal approval path.

## Commands and the Docker sandbox

Terminal commands are off by default (Settings > Tools > Terminal commands). An optional sandbox runs foreground commands in a disposable Linux Docker copy with no network; see tools-overview.
