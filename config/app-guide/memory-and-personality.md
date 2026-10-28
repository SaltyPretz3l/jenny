# Memory and personality

Jenny remembers in two layers. Your personality files are small, always-on text that you write and own. Memories are individual notes that Jenny can save, correct, forget and recall across chats, each visible to you and reversible.

## Memory: what it is

A memory is a short note, up to 400 characters, with a kind:

- Preference, Fact (the default), Decision, Convention, Person, Routine and Lesson.

Each memory has a scope:

- Project: the default inside a project chat. Only that project recalls it.
- Global: lands in General and applies everywhere. Jenny uses it only when you say something applies everywhere.
- Chat: this conversation only.

Scope is set by Jenny's trusted context, not by what the model claims. A project's memories do not leak into another project.

## How memories get made

- You ask. Tell Jenny "remember that ..." in a chat, or type /remember followed by the text. /remember is your explicit action, so it works even when saving is paused or the chat is opted out.
- Jenny's memory tool. Jenny can remember, update, forget, recall and list memories on its own. Each change shows in the chat as a "Memory updated" receipt with Undo. It is allowed in Plan mode for remembering, and the memory tool is not available to helper tasks or in offline lockdown.
- Jenny takes notes automatically. When this is on and Jenny is idle, your local model reads your recent messages and saves lasting facts and preferences. It only runs on local engines, never on a cloud engine, waits for a quiet moment so it does not slow a chat, and each note shows in the chat with Undo. Diagnostics shows a Note taking line (Off, Idle, Taking notes, Waiting for a quiet moment, and run counts).
- Other composer commands: /forget removes a memory by id or unique text, and /memory shows what Jenny remembers here.

Always on: a short, stable memory can be marked Always on so it rides in every prompt. The budget is small (about 1,200 characters across global and project), and a full budget refuses the change with a toast.

## Recall

Each turn, Jenny recalls the memories that look relevant to what you asked and adds them as background data, never as instructions. Memory text cannot grant approval, change permissions or override your request. If a small model never calls the tool, /remember still works.

Settings > Context has Approved memories (let Jenny recall memories) and Personality and notes switches. Settings > Memory has Use memory in chats, which hides memory from every chat when off (you can still ask Jenny to look something up).

## The Memory page

Settings > Context and memory > Memory (not a top-level tab).

- Tabs: General first, then each project with memories. Rows show the memory text, then kind, origin (You, Jenny, or Jenny's note) and date, and a "This chat only" label for chat notes. Why did Jenny remember this? opens the source chat and scrolls to the message.
- Filters: search and a kind filter.
- Always on switch per row, and a meter of how much of the always-on budget is used.
- Row menu: Edit (inline; saving marks the row protected, shown as "Edited by you", so Jenny cannot change or forget it later), Forget and Erase now.
- Forget archives the memory at once with an Undo toast. It also tells Jenny not to resave it. Erase now asks first and cannot be undone.
- Forgotten fold: archived rows with Restore (or Restore to a project, if its project was deleted) and Erase now, plus Clear forgotten list. A restore can be refused if the memory is already remembered, memory is full, or its chat or project was deleted.
- History fold: the last 50 changes with Undo where possible.
- Export as Markdown, and Open USER.md and Open MEMORY.md under Your notes files.
- How Jenny remembers (four switches): Jenny takes notes automatically; Ask before Jenny saves (new memories wait under "Waiting for your OK" with Save and Dismiss); Pause saving (nothing new is saved; /remember still works); Use memory in chats.
- Per chat: Don't remember this chat keeps Jenny from taking notes from that chat. /remember still works there.

Deleting a project archives that project's memories with it, restorable. Deleting a chat removes its chat notes.

## Earlier chats

Jenny can look back through earlier chats in the same project: conversations_recent lists them, conversation_open reads a window of one, and conversations_search finds text across them. The caller chat, opted-out chats and lockdown chats are hidden, and what Jenny reads is treated as background data. The Jenny chat can search across every project.

## Personality

Settings > Personality has one Save for:

- Name: what Jenny calls itself.
- Voice: Balanced, Concise, Creative or Mentor. These are templates that fill the note below with a starting point, not runtime modes; the control shows Custom once your note no longer matches one.
- Personality note: tone and behavior only. Tools, dates and formatting are handled by the app.
- About you: your name, how to address you, what you do, how you like to work.

Counters under each box show use against its budget: 1,500 characters for the personality note, 1,000 for About you, 1,500 for long-term notes. Over-budget text is clipped with a trailing marker for that section only. Show exact text reveals what the model receives. Headings and comments you type stay on disk but are not sent.

The files live in personality/default-workspace in Jenny's data folder: PERSONALITY.md (the note), USER.md (About you) and MEMORY.md (long-term notes). Open folder reveals them. Long-term notes in MEMORY.md are the older, hand-written notes; they are sent only in General-project chats, while Voice and About you are shared across projects.

The Personality and notes switch in Settings > Context omits the whole block from chats; the assistant name still reaches the model. Personality shapes tone, not facts: the current request and the runtime, workspace and tool rules outrank it. A custom name or voice never overrides the fact that Jenny is software.

Jenny's voice is model-bound. If the persona suddenly feels different, check which model is active before editing the personality files.
